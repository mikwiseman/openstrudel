import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { Store } from "./store.js";
import { CodexRpc, type RpcMessage } from "./rpc.js";
import { isOpenAIAuthenticationError, openAILoginError } from "./account-errors.js";

export type OpenAIAccount = {
  connected: boolean;
  email: string | null;
  planType: string | null;
  managed: boolean;
  issue?: "sign_in_required" | "unavailable";
};

export type CodexAuthTokens = { accessToken: string; chatgptAccountId: string; chatgptPlanType?: string };

export type LoginStart =
  | { type: "browser"; loginId: string; authUrl: string }
  | { type: "device"; loginId: string; verificationUrl: string; userCode: string };

export type LoginStatus = {
  loginId: string;
  status: "pending" | "completed" | "failed" | "canceled";
  error?: string;
  account?: OpenAIAccount;
};

type LoginSession = {
  rpc: CodexRpc;
  loginId: string;
  status: LoginStatus["status"];
  error?: string;
  start: LoginStart;
  expiresAt: number;
  previousAccountID: string | undefined;
};

export class CodexAccountService {
  private readonly codexHome: string;
  private readonly sessions = new Map<string, LoginSession>();
  private onChange?: (identityChanged: boolean) => void;
  private reading?: Promise<OpenAIAccount>;
  private cached?: { account: OpenAIAccount; until: number };
  private starting?: Promise<LoginStart>;
  private generation = 0;
  private loginGeneration = 0;
  private authQueue: Promise<void> = Promise.resolve();
  private refreshing?: Promise<CodexAuthTokens>;

  constructor(private readonly store: Store, rootDirectory = resolve(".data")) {
    this.codexHome = process.env.OPENSTRUDEL_CODEX_HOME ?? resolve(rootDirectory, "codex");
  }

  setOnChange(handler: (identityChanged: boolean) => void): void {
    this.onChange = handler;
  }

  executionHome(): string | undefined {
    return this.store.getSetting("codex.auth.mode") === "managed" ? this.codexHome : undefined;
  }

  read(force = false): Promise<OpenAIAccount> {
    if (!force && this.cached && this.cached.until > Date.now()) return Promise.resolve(this.cached.account);
    if (!this.reading) {
      const generation = this.generation;
      const reading = this.readAccount().then(account => {
        if (generation === this.generation) this.cached = { account, until: Date.now() + (account.issue ? 5_000 : 30_000) };
        return account;
      }).finally(() => { if (this.reading === reading) this.reading = undefined; });
      this.reading = reading;
    }
    return this.reading;
  }

  invalidate(): void {
    this.generation++;
    this.cached = undefined;
    this.reading = undefined;
  }

  get loginPending(): boolean {
    this.expireLogins();
    return Boolean(this.starting) || [...this.sessions.values()].some(session => session.status === "pending");
  }

  private async readAccount(): Promise<OpenAIAccount> {
    const managed = this.store.getSetting("codex.auth.mode") === "managed";
    const disconnected: OpenAIAccount = { connected: false, email: null, planType: null, managed };
    // A Codex installation on the same computer is not consent to connect it.
    // Only our completed OAuth flow grants access to this Home's account.
    if (!managed) return disconnected;
    try {
      const result = await this.withAuthRpc(rpc => rpc.request("account/read", { refreshToken: false }));
      const account = result.account;
      return {
        connected: Boolean(account),
        email: account?.type === "chatgpt" ? account.email ?? null : null,
        planType: account?.type === "chatgpt" ? account.planType ?? null : null,
        managed,
      };
    } catch (error) {
      // OpenAI availability and login state must never make the Home itself
      // unreachable. Keep credentials and history intact so login can recover.
      return { ...disconnected, issue: isOpenAIAuthenticationError(error) ? "sign_in_required" : "unavailable" };
    }
  }

  /** Only the Home renews OAuth. Worker contexts never receive a refresh token. */
  authTokens(refresh = false): Promise<CodexAuthTokens> {
    if (!this.executionHome()) return Promise.reject(new Error("Войдите в OpenAI в приложении OpenStrudel."));
    if (this.refreshing) return this.refreshing;
    const operation = this.withAuthRpc(async rpc => {
      const result = await rpc.request("account/read", { refreshToken: refresh });
      const saved = JSON.parse(readFileSync(resolve(this.codexHome, "auth.json"), "utf8"));
      const accessToken = saved.tokens?.access_token;
      const chatgptAccountId = saved.tokens?.account_id;
      if (!result.account || typeof accessToken !== "string" || !accessToken || typeof chatgptAccountId !== "string" || !chatgptAccountId) {
        throw new Error("Authentication required");
      }
      return { accessToken, chatgptAccountId, chatgptPlanType: result.account.planType };
    }).finally(() => { if (refresh) { this.refreshing = undefined; this.invalidate(); } });
    if (refresh) this.refreshing = operation;
    return operation;
  }

  private withAuthRpc<T>(work: (rpc: CodexRpc) => Promise<T>): Promise<T> {
    const operation = this.authQueue.then(async () => {
      const rpc = new CodexRpc(this.codexHome);
      try { await rpc.initialize(); return await work(rpc); }
      finally { rpc.close(); }
    });
    this.authQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  startLogin(method: "browser" | "device" = "browser"): Promise<LoginStart> {
    this.expireLogins();
    const pending = [...this.sessions.values()].find(session => session.status === "pending");
    if (pending) {
      if (pending.start.type !== method) return Promise.reject(new Error("Вход уже открыт на другом устройстве. Завершите или отмените его там."));
      return Promise.resolve(pending.start);
    }
    // A second owner device joins the same login instead of canceling it.
    if (!this.starting) this.starting = this.createLogin(method).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async createLogin(method: "browser" | "device"): Promise<LoginStart> {
    const generation = this.loginGeneration;
    const previousAccountID = this.accountID();
    const rpc = new CodexRpc(this.codexHome, (message) => this.handleNotification(message));
    const params = method === "device"
      ? { type: "chatgptDeviceCode" }
      : { type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "chatgpt" };
    try {
      await rpc.initialize();
      const result = (await rpc.request("account/login/start", params)) as Record<string, unknown>;
      if (generation !== this.loginGeneration) throw new Error("Login was canceled");
      const loginId = String(result.loginId ?? "");
      if (!loginId) throw new Error("Codex did not return a login id");
      const start: LoginStart = result.type === "chatgptDeviceCode"
        ? { type: "device", loginId, verificationUrl: String(result.verificationUrl), userCode: String(result.userCode) }
        : { type: "browser", loginId, authUrl: String(result.authUrl) };
      this.sessions.set(loginId, { rpc, loginId, status: "pending", start, expiresAt: Date.now() + 10 * 60_000, previousAccountID });
      return start;
    } catch (error) {
      rpc.close();
      throw new Error(openAILoginError(error));
    }
  }

  async status(loginId: string): Promise<LoginStatus> {
    this.expireLogins();
    const session = this.sessions.get(loginId);
    if (!session) return { loginId, status: "canceled" };
    if (session.status === "completed") {
      const account = await this.read();
      session.rpc.close();
      return { loginId, status: "completed", account };
    }
    if (session.status === "failed") {
      const error = session.error;
      session.rpc.close();
      return { loginId, status: "failed", ...(error ? { error } : {}) };
    }
    return { loginId, status: session.status, ...(session.error ? { error: session.error } : {}) };
  }

  async cancel(loginId: string): Promise<LoginStatus> {
    const session = this.sessions.get(loginId);
    if (!session) return { loginId, status: "canceled" };
    try {
      await session.rpc.request("account/login/cancel", { loginId });
    } catch {
      // The browser may have completed between the button press and cancel.
    }
    session.status = "canceled";
    session.rpc.close();
    this.sessions.delete(loginId);
    return { loginId, status: "canceled" };
  }

  async logout(): Promise<void> {
    this.loginGeneration++;
    for (const session of this.sessions.values()) session.rpc.close();
    this.sessions.clear();
    const rpc = new CodexRpc(this.codexHome);
    try {
      await rpc.initialize();
      await rpc.request("account/logout");
    } finally {
      rpc.close();
    }
    this.store.setSetting("codex.auth.mode", "signed-out");
    this.invalidate();
    this.onChange?.(true);
  }

  close(): void {
    this.loginGeneration++;
    for (const session of this.sessions.values()) session.rpc.close();
    this.sessions.clear();
    this.invalidate();
  }

  private accountID(): string | undefined {
    try { return JSON.parse(readFileSync(resolve(this.codexHome, "auth.json"), "utf8")).tokens?.account_id; }
    catch { return undefined; }
  }

  private expireLogins(): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt > Date.now()) continue;
      session.rpc.close();
      this.sessions.delete(id);
    }
  }

  private handleNotification(message: RpcMessage): void {
    if (message.method !== "account/login/completed") return;
    const params = (message.params ?? {}) as { loginId?: string; success?: boolean; error?: string | null };
    const loginId = String(params.loginId ?? "");
    const session = this.sessions.get(loginId);
    if (!session || session.status !== "pending") return;
    if (params.success) {
      session.status = "completed";
      this.store.setSetting("codex.auth.mode", "managed");
      this.invalidate();
      this.onChange?.(!session.previousAccountID || session.previousAccountID !== this.accountID());
    } else {
      session.status = "failed";
      session.error = openAILoginError(params.error);
    }
  }
}
