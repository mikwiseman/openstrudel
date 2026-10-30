import { resolve } from "node:path";
import { CodexAccountService } from "./account.js";
import { createEngine } from "./codex.js";
import { MessageService } from "./messages.js";
import { HttpApi } from "./server.js";
import { Store } from "./store.js";
import { TelegramAdapter } from "./telegram.js";
import { Scheduler } from "./scheduler.js";
import type { CodexEngine } from "./types.js";
import { ScopedCodexEngine } from "./scopes.js";
import {homedir} from "node:os";
import {mkdirSync,writeFileSync,renameSync} from "node:fs";
import { createSetupServer } from "./setup.js";
import { Accounts, AccountEngines } from "./accounts.js";
import { RestrictedExecutor } from "./restricted-executor.js";
import { isProtectedTelegramAudience } from "./authorization.js";

export interface RuntimeOptions {
  dbPath?: string;
  engine?: CodexEngine;
  rootDirectory?: string;
  startTelegram?: boolean;
  apiToken?: string;
  mobilePort?: number;
}

/** One small Home process. Channels enter here; Codex does the actual work. */
export class OpenStrudelRuntime {
  readonly store: Store;
  readonly engine: CodexEngine;
  readonly account: CodexAccountService;
  readonly accounts: Accounts;
  readonly messages: MessageService;
  readonly api: HttpApi;
  readonly telegram: TelegramAdapter;
  readonly scheduler: Scheduler;
  private readonly startTelegram: boolean;
  private started = false;
  private readonly publishLocalConnection: boolean;
  private setup?: ReturnType<typeof createSetupServer>;

  constructor(options: RuntimeOptions = {}) {
    this.store = new Store(options.dbPath);
    this.account = new CodexAccountService(this.store, resolve(options.rootDirectory ?? process.cwd(), ".data"));
    this.accounts = new Accounts(this.store, resolve(options.rootDirectory ?? process.cwd()), this.account);
    this.publishLocalConnection = !options.engine;
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? this.store.getSetting("telegram.bot_token") ?? undefined;
    this.engine = options.engine ?? (process.env.OPENSTRUDEL_CODEX_MODE === "mock" ? createEngine({mode:"mock"}) : new AccountEngines(this.accounts));
    if (!(this.engine instanceof AccountEngines)) this.account.setOnChange(identityChanged => {
      const engine = this.engine as CodexEngine & { setCodexHome?: (home?: string) => void };
      engine.setCodexHome?.(this.account.executionHome());
      if (identityChanged) this.store.clearConversationThreads();
    });
    this.messages = new MessageService(this.store, this.engine,options.rootDirectory);
    if (!options.engine) this.messages.restrictedExecutor = new RestrictedExecutor(this.accounts);
    if (!(this.engine instanceof AccountEngines)) this.messages.onAuthenticationError = () => this.account.invalidate();
    this.telegram = new TelegramAdapter(telegramToken, this.store, this.messages);
    this.messages.telegram=this.telegram;
    this.scheduler = new Scheduler(this.store,this.messages);
    this.messages.scheduler=this.scheduler;
    // The scheduler checks its destination before generating; a policy saved meanwhile still stops every chunk and file.
    this.scheduler.deliver=(chat,text,key,attachments)=>this.telegram.sendAnswer(chat,text,attachments,key,undefined,()=>{
      if (isProtectedTelegramAudience(this.store, chat)) throw new Error("Фоновая доставка в чат с ограниченным доступом недоступна.");
    });
    this.api = new HttpApi(this.store, this.messages, this.telegram, options.apiToken ?? (options.engine ? null : process.env.OPENSTRUDEL_API_TOKEN), this.account, this.engine, { mobileDirectory: resolve(options.rootDirectory ?? process.cwd(), ".data/mobile"), mobilePort: options.mobilePort }, this.accounts);
    this.startTelegram = options.startTelegram ?? true;
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.started) throw new Error("runtime already started");
    const address = await this.api.listen();
    if (this.publishLocalConnection) {
      const directory = resolve(".data");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const target = resolve(directory, "LocalConnection.json");
      writeFileSync(target + ".tmp", JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token: this.api.localCredential() }), { mode: 0o600 });
      renameSync(target + ".tmp", target);
    }
    if (this.publishLocalConnection && process.platform === "darwin") {
      const directory=resolve(homedir(),"Library/Application Support/OpenStrudel");
      mkdirSync(directory,{recursive:true,mode:0o700});
      const target=resolve(directory,"LocalConnection.json");
      writeFileSync(target+".tmp",JSON.stringify({url:`http://127.0.0.1:${address.port}`,token:this.api.localCredential()}),{mode:0o600});
      renameSync(target+".tmp",target);
    }
    await this.api.mobile.restore();
    if (process.env.OPENSTRUDEL_SETUP_CODE) {
      this.setup = createSetupServer(this.api.mobile, process.env.OPENSTRUDEL_SETUP_CODE);
      const host = process.env.OPENSTRUDEL_SETUP_HOST ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? "0.0.0.0" : "127.0.0.1");
      await new Promise<void>((done, reject) => {
        this.setup!.once("error", reject);
        this.setup!.listen(Number(process.env.PORT ?? 8080), host, done);
      });
    }
    this.store.interruptUnfinishedMessages();
    if (this.store.getSetting("codex.transport.version") !== "app-server-scopes-6-telegram-delivery") {
      // Codex accepts dynamic tools on thread/start, not thread/resume. Retain
      // the old IDs and all chat messages; only the execution thread is renewed.
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        this.store.setSetting("codex.previous_threads.app-server-scopes-6-telegram-delivery", JSON.stringify(this.store.listConversations().filter(c => c.codexThreadId).map(c => ({ conversationId: c.id, threadId: c.codexThreadId }))));
        this.store.setSetting("codex.previous_thread_routes.app-server-scopes-6-telegram-delivery", JSON.stringify(this.store.db.prepare("SELECT key,value FROM settings WHERE key GLOB 'codex.thread.*' OR key GLOB 'codex.threadOwner.*' OR key GLOB 'codex.threadCheckpoint.*'").all()));
        this.store.clearConversationThreads();
        this.store.setSetting("codex.transport.version", "app-server-scopes-6-telegram-delivery");
        this.store.db.exec("COMMIT");
      } catch(error) { this.store.db.exec("ROLLBACK"); throw error; }
    }
    if (this.startTelegram) await this.telegram.start();
    if (this.engine instanceof AccountEngines) this.accounts.startQuotaChecks();
    this.scheduler.start();
    this.started = true;
    return { host: address.address, port: address.port };
  }

  async stop(): Promise<void> {
    if (this.setup) {
      this.setup.closeAllConnections();
      await new Promise<void>(done => this.setup!.close(() => done()));
      this.setup = undefined;
    }
    this.scheduler.stop();
    await this.accounts.stopQuotaChecks();
    this.telegram.stop();
    await this.messages.close();
    await this.scheduler.idle();
    await this.api.close();
    this.accounts.close();
    this.store.close();
    this.started = false;
  }
}
