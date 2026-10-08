import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { CodexAccountService } from "./account.js";
import { HomeError, identifier } from "./home.js";
import { ScopedCodexEngine } from "./scopes.js";
import type { Store } from "./store.js";
import type { CodexEngine } from "./types.js";
import { AccountUnavailableError, isOpenAIAuthenticationError } from "./account-errors.js";

type AccountEntry = { id: string; name: string };
export class Accounts {
  private services = new Map<string, CodexAccountService>();
  readonly active = new Map<string, number>();
  private readonly changing = new Set<string>();
  onChange?: (id: string) => void;
  constructor(readonly store: Store, readonly root: string, readonly primary: CodexAccountService) { this.services.set("default", primary); this.watch("default", primary); }
  private watch(id: string, service: CodexAccountService) {
    service.setOnChange(identityChanged => {
      this.onChange?.(id);
      if (!identityChanged) return;
      this.store.db.prepare("DELETE FROM settings WHERE key LIKE ?").run("codex.thread." + id + ".%");
      for (const conversation of this.store.listConversations()) {
        const owner = this.store.getSetting("codex.threadOwner." + conversation.id);
        if (owner === id || id === "default" && !owner) {
          this.store.setConversationThread(conversation.id, null);
          this.store.deleteSetting("codex.threadOwner." + conversation.id);
        }
      }
    });
  }
  entries(): AccountEntry[] { return JSON.parse(this.store.getSetting("codex.accounts") ?? '[{"id":"default","name":"Основной"}]'); }
  get(id: string): CodexAccountService {
    if (!this.entries().some(a => a.id === id)) throw new HomeError("Аккаунт не найден.", 404);
    if (!this.services.has(id)) { const service = new CodexAccountService(this.store, resolve(this.root, ".data"), id); this.watch(id, service); this.services.set(id, service); }
    return this.services.get(id)!;
  }
  add(name: string) {
    if (this.entries().length >= 12) throw new HomeError("Можно подключить до 12 аккаунтов.");
    const entry = { id: randomUUID(), name: String(name || "Аккаунт").trim().slice(0, 80) };
    this.store.setSetting("codex.accounts", JSON.stringify([...this.entries(), entry])); return entry;
  }
  async list(refresh = false) {
    return Promise.all(this.entries().map(async entry => {
      const service = this.get(entry.id);
      const [account, usage] = await Promise.all([service.read(refresh), service.usage(refresh)]);
      return { ...entry, account, usage, activeRuns: this.active.get(entry.id) ?? 0, loginPending: service.loginPending };
    }));
  }
  async statusFor(agent: string, refresh = false) {
    const ids = this.policy(agent) ?? this.entries().map(a => a.id);
    let first: { account: Awaited<ReturnType<CodexAccountService["read"]>>; accountId: string; loginPending: boolean } | undefined;
    for (const id of ids) {
      const service = this.get(id), value = { account: await service.read(refresh), accountId: id, loginPending: service.loginPending };
      first ??= value;
      if (value.account.connected) return value;
    }
    return first;
  }
  prioritize(id: string) { const entries = this.entries(); this.get(id); this.store.setSetting("codex.accounts", JSON.stringify([...entries.filter(a => a.id === id), ...entries.filter(a => a.id !== id)])); }
  policy(agent: string): string[] | null { return JSON.parse(this.store.getSetting("agent.accounts." + agent) ?? "null"); }
  setPolicy(agent: string, ids: unknown) {
    identifier(agent);
    if (agent !== "main" && !this.store.getProfile(agent)) throw new HomeError("Агент не найден.", 404);
    if (ids !== null && (!Array.isArray(ids) || ids.length < 1 || ids.length > 12 || ids.some(id => typeof id !== "string" || !this.entries().some(a => a.id === id)) || new Set(ids).size !== ids.length)) throw new HomeError("Выберите подключённые аккаунты.");
    this.store.setSetting("agent.accounts." + agent, JSON.stringify(ids));
  }
  async choose(agent: string, checkQuota = true): Promise<{ id: string; service: CodexAccountService }> {
    const ids = this.policy(agent) ?? this.entries().map(a => a.id);
    let limited = false, signingIn = false;
    for (const id of ids) {
      const service = this.get(id);
      if (this.changing.has(id) || service.loginPending) { signingIn = true; continue; }
      const account = await service.read();
      if (account.issue === "unavailable") throw new AccountUnavailableError("unavailable");
      if (!account.connected) continue;
      const usage = checkQuota ? await service.usage() : null;
      // Only backend permission can block ordinary usage. A local clock and a
      // percentage are not proof of quota recovery or permission to spend credits.
      if (usage?.ordinaryUsageAllowed === false) { limited = true; continue; }
      if (this.changing.has(id) || service.loginPending) { signingIn = true; continue; }
      return { id, service };
    }
    throw new AccountUnavailableError(signingIn ? "login_pending" : limited ? "limits" : "sign_in_required");
  }
  assertIdle(id: string) { if (this.active.get(id)) throw new HomeError("Аккаунт выполняет поручение. Дождитесь завершения перед выходом или новым входом.", 409); }
  async withIdle<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.assertIdle(id);
    if (this.changing.has(id)) throw new HomeError("Аккаунт уже обновляется. Дождитесь завершения.", 409);
    this.changing.add(id);
    try { return await work(); } finally { this.changing.delete(id); }
  }
  async remove(id: string) {
    this.assertIdle(id);
    if (this.entries().length === 1 || id === "default") throw new HomeError("Основной аккаунт можно отключить кнопкой «Выйти».", 409);
    for (const row of this.store.db.prepare("SELECT value FROM settings WHERE key LIKE 'agent.accounts.%'").all() as any[]) if ((JSON.parse(row.value) ?? []).includes(id)) throw new HomeError("Сначала выберите другой аккаунт у использующих его агентов.", 409);
    await this.withIdle(id, () => this.get(id).logout()); this.get(id).close(); this.services.delete(id);
    this.store.setSetting("codex.accounts", JSON.stringify(this.entries().filter(a => a.id !== id)));
  }
  close() { for (const service of this.services.values()) service.close(); }
}

/** Account choice is fixed for a whole turn. No retry of a partly executed turn. */
export class AccountEngines implements CodexEngine {
  private engines = new Map<string, ScopedCodexEngine>();
  private directoryEngine?: CodexEngine;
  get connectionNotice() { return this.directoryEngine?.connectionNotice; }
  constructor(private readonly accounts: Accounts) { accounts.onChange = id => { this.engines.get(id)?.close(); this.engines.delete(id); }; }
  private scoped(id: string, service: CodexAccountService): ScopedCodexEngine {
    const existing = this.engines.get(id);
    if (existing) return existing;
    const engine = new ScopedCodexEngine(this.accounts.root, service.executionHome(), refresh => service.authTokens(refresh), id === "default" ? undefined : resolve(this.accounts.root, ".data/accounts", id, "contexts"));
    this.engines.set(id, engine);
    return engine;
  }
  forAgent(agent: string, context: string): CodexEngine {
    let locked: { id: string; service: CodexAccountService } | undefined;
    let connectionEngine: CodexEngine | undefined;
    const selection = () => locked ? Promise.resolve(locked) : this.accounts.choose(agent, false);
    return {
      run: async (input, options) => {
        const { id, service } = await this.accounts.choose(agent);
        locked = { id, service };
        this.accounts.active.set(id, (this.accounts.active.get(id) ?? 0) + 1);
        try {
          const threadKey = options?.conversationId ? `codex.thread.${id}.${options.conversationId}` : undefined;
          const saved = threadKey ? this.accounts.store.getSetting(threadKey) : undefined;
          const ownerKey = options?.conversationId ? "codex.threadOwner." + options.conversationId : undefined;
          const owner = ownerKey ? this.accounts.store.getSetting(ownerKey) : null;
          const threadId = saved ?? (id === "default" && (!owner || owner === id) ? options?.threadId : undefined);
          const history = !threadId && options?.conversationId && options.threadId ? this.accounts.store.listMessages(options.conversationId, 200).filter(m => m.kind !== "notice" && m.status === "completed").map(m => `${m.direction === "inbound" ? "User" : "Assistant"}: ${m.text}`).join("\n") : "";
          const engine = this.scoped(id, service).forContext(context);
          const result = await engine.run(history ? `Earlier chat (context only):\n${history}\n\nCurrent message:\n${input}` : input, { ...options, threadId,
            onEvent: event => {
              if (threadKey && event.type === "thread.started") this.accounts.store.setSetting(threadKey, (event.payload as any).threadId);
              if (ownerKey && event.type === "thread.started") this.accounts.store.setSetting(ownerKey, id);
              options?.onEvent?.(event);
            } });
          if (threadKey) this.accounts.store.setSetting(threadKey, result.threadId);
          if (ownerKey) this.accounts.store.setSetting(ownerKey, id);
          return result;
        } catch (error) { if (isOpenAIAuthenticationError(error)) service.invalidate(); throw error; }
        finally { locked = undefined; this.accounts.active.set(id, Math.max(0, (this.accounts.active.get(id) ?? 1) - 1)); }
      },
      get connectionNotice() { return connectionEngine?.connectionNotice; },
      connections: async refresh => { const selected = await selection(); connectionEngine = this.scoped(selected.id, selected.service).forContext(context); return connectionEngine.connections?.(refresh) ?? []; },
      connect: async name => { const selected = await selection(); return this.scoped(selected.id, selected.service).forContext(context).connect!(name); },
      isConnected: async name => { const selected = await selection(); return this.scoped(selected.id, selected.service).forContext(context).isConnected!(name); },
      extensions: async () => { const selected = await selection(); return this.scoped(selected.id, selected.service).forContext(context).extensions!(); },
    };
  }
  forContext(context: string): CodexEngine { return this.forAgent("main", context); }
  run: CodexEngine["run"] = (input, options) => this.forAgent("main", "personal").run(input, options);
  connections: NonNullable<CodexEngine["connections"]> = refresh => {
    this.directoryEngine = this.forAgent("main", "personal");
    return this.directoryEngine.connections!(refresh);
  };
  connect: NonNullable<CodexEngine["connect"]> = id => this.forAgent("main", "personal").connect!(id);
  close() { for (const engine of this.engines.values()) engine.close(); this.engines.clear(); }
}
