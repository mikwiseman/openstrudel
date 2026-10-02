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

export interface RuntimeOptions {
  dbPath?: string;
  engine?: CodexEngine;
  rootDirectory?: string;
  startTelegram?: boolean;
  apiToken?: string;
}

/** One small Home process. Channels enter here; Codex does the actual work. */
export class OpenStrudelRuntime {
  readonly store: Store;
  readonly engine: CodexEngine;
  readonly account: CodexAccountService;
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
    this.publishLocalConnection = !options.engine;
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? this.store.getSetting("telegram.bot_token") ?? undefined;
    this.engine = options.engine ?? (process.env.OPENSTRUDEL_CODEX_MODE === "mock" ? createEngine({mode:"mock"}) : new ScopedCodexEngine(resolve(options.rootDirectory ?? process.cwd()), this.account.executionHome()));
    this.account.setOnChange(() => {
      const engine = this.engine as CodexEngine & { setCodexHome?: (home?: string) => void };
      engine.setCodexHome?.(this.account.executionHome());
      this.store.clearConversationThreads();
    });
    this.messages = new MessageService(this.store, this.engine,undefined,options.rootDirectory);
    this.telegram = new TelegramAdapter(telegramToken, this.store, this.messages);
    this.scheduler = new Scheduler(this.store,this.messages);
    this.messages.scheduler=this.scheduler;
    this.scheduler.deliver=async(chat,text,key,attachments)=>{
      await this.telegram.sendMessage(chat,text,key);
      await this.telegram.sendFiles(chat,attachments,key);
    };
    this.api = new HttpApi(this.store, this.messages, this.telegram, options.apiToken ?? (options.engine ? null : process.env.OPENSTRUDEL_API_TOKEN), this.account, this.engine);
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
    if (this.store.getSetting("codex.transport.version") !== "app-server-scopes-3") {
      // Preserve old public thread IDs; the chat text bootstraps the new tool-enabled thread.
      this.store.setSetting("codex.previous_threads", JSON.stringify(this.store.listConversations().filter(c => c.codexThreadId).map(c => ({ conversationId: c.id, threadId: c.codexThreadId }))));
      this.store.clearConversationThreads();
      this.store.setSetting("codex.transport.version", "app-server-scopes-3");
    }
    if (this.startTelegram) await this.telegram.start();
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
    this.telegram.stop();
    await this.messages.close();
    await this.scheduler.idle();
    await this.api.close();
    this.account.close();
    this.store.close();
    this.started = false;
  }
}
