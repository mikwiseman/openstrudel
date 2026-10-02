import { resolve } from "node:path";
import type { Store } from "./store.js";
import { CodexRpc, type RpcMessage } from "./rpc.js";

export type OpenAIAccount = {
  connected: boolean;
  email: string | null;
  planType: string | null;
  managed: boolean;
};

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
};

export class CodexAccountService {
  private readonly codexHome: string;
  private readonly inheritedHome: string | undefined;
  private readonly sessions = new Map<string, LoginSession>();
  private onChange?: () => void;

  constructor(private readonly store: Store, rootDirectory = resolve(".data")) {
    this.codexHome = process.env.OPENSTRUDEL_CODEX_HOME ?? resolve(rootDirectory, "codex");
    this.inheritedHome = process.env.CODEX_HOME;
  }

  setOnChange(handler: () => void): void {
    this.onChange = handler;
  }

  executionHome(): string | undefined {
    return this.store.getSetting("codex.auth.mode") === "managed" ? this.codexHome : this.inheritedHome;
  }

  async read(): Promise<OpenAIAccount> {
    const managed = this.store.getSetting("codex.auth.mode") === "managed";
    const rpc = new CodexRpc(managed ? this.codexHome : this.inheritedHome);
    try {
      await rpc.initialize();
      const result = (await rpc.request("account/read", { refreshToken: false })) as { account?: { type?: string; email?: string | null; planType?: string } | null; requiresOpenaiAuth?: boolean };
      const account = result.account;
      return {
        connected: Boolean(account),
        email: account?.type === "chatgpt" ? account.email ?? null : null,
        planType: account?.type === "chatgpt" ? account.planType ?? null : null,
        managed,
      };
    } finally {
      rpc.close();
    }
  }

  async startLogin(method: "browser" | "device" = "browser"): Promise<LoginStart> {
    for (const session of this.sessions.values()) session.rpc.close();
    this.sessions.clear();
    const rpc = new CodexRpc(this.codexHome, (message) => this.handleNotification(message));
    await rpc.initialize();
    const params = method === "device"
      ? { type: "chatgptDeviceCode" }
      : { type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "chatgpt" };
    try {
      const result = (await rpc.request("account/login/start", params)) as Record<string, unknown>;
      const loginId = String(result.loginId ?? "");
      if (!loginId) throw new Error("Codex did not return a login id");
      this.sessions.set(loginId, { rpc, loginId, status: "pending" });
      if (result.type === "chatgptDeviceCode") {
        return { type: "device", loginId, verificationUrl: String(result.verificationUrl), userCode: String(result.userCode) };
      }
      return { type: "browser", loginId, authUrl: String(result.authUrl) };
    } catch (error) {
      rpc.close();
      throw error;
    }
  }

  async status(loginId: string): Promise<LoginStatus> {
    const session = this.sessions.get(loginId);
    if (!session) return { loginId, status: "canceled" };
    if (session.status === "completed") {
      const account = await this.read();
      session.rpc.close();
      this.sessions.delete(loginId);
      return { loginId, status: "completed", account };
    }
    if (session.status === "failed") {
      const error = session.error;
      session.rpc.close();
      this.sessions.delete(loginId);
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
    const rpc = new CodexRpc(this.codexHome);
    try {
      await rpc.initialize();
      await rpc.request("account/logout");
    } finally {
      rpc.close();
    }
    this.store.setSetting("codex.auth.mode", "managed");
    this.onChange?.();
  }

  close(): void {
    for (const session of this.sessions.values()) session.rpc.close();
    this.sessions.clear();
  }

  private handleNotification(message: RpcMessage): void {
    if (message.method !== "account/login/completed") return;
    const params = (message.params ?? {}) as { loginId?: string; success?: boolean; error?: string | null };
    const loginId = String(params.loginId ?? "");
    const session = this.sessions.get(loginId);
    if (!session) return;
    if (params.success) {
      session.status = "completed";
      this.store.setSetting("codex.auth.mode", "managed");
      this.onChange?.();
    } else {
      session.status = "failed";
      session.error = params.error ?? "Вход в OpenAI не завершён";
    }
  }
}
