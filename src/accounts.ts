import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { CodexAccountService, accountEntries, chatgptSignedIn, type AccountEntry, type OpenAIAccount, type AccountUsage } from "./account.js";
import { HomeError, identifier } from "./home.js";
import { ScopedCodexEngine } from "./scopes.js";
import type { Store } from "./store.js";
import type { CodexEngine } from "./types.js";
import { AccountUnavailableError, isOpenAIAuthenticationError } from "./account-errors.js";
import { resolveModelSelection, followsDeviceModel, readModelFallbacks } from "./model-settings.js";
import { ProviderIncident, providerConnected, providerFailure, providerInfo, providerInfos, providerKey, providerModels, providerNotConnected, subscriptionModels, type ProviderInfo } from "./providers.js";
import { ClaudeEngine } from "./claude.js";
import { AcpEngine, AcpSessionLost, ProviderSignInError } from "./acp.js";
import { GrokLogin } from "./acp-login.js";

export class Accounts {
  private services = new Map<string, CodexAccountService>();
  readonly active = new Map<string, number>();
  private readonly changing = new Set<string>();
  private consolidating?: Promise<void>;
  private readonly merged = new Map<string, string>();
  onChange?: (id: string) => void;
  /** The Grok subscription's sign-in on this device. */
  readonly grok: GrokLogin;
  private quotaTimer?: ReturnType<typeof setInterval>;
  private quotaReading?: Promise<unknown>;
  /** Refresh read-only account state independently of queued work, including purchased resets. */
  startQuotaChecks() {
    if (this.quotaTimer) return;
    const refresh = () => { if (!this.quotaReading) this.quotaReading = Promise.allSettled(this.entries().filter(a => !this.changing.has(a.id) && !this.get(a.id).loginPending)
      .flatMap(a => [this.get(a.id).read(true), this.get(a.id).usage(true)])).finally(()=>{this.quotaReading=undefined;}); };
    this.quotaTimer = setInterval(refresh, 30_000); this.quotaTimer.unref(); refresh();
  }
  async stopQuotaChecks() { clearInterval(this.quotaTimer); this.quotaTimer=undefined; await this.quotaReading; }
  constructor(readonly store: Store, readonly root: string, readonly primary: CodexAccountService) { this.services.set("default", primary); this.watch("default", primary); this.grok = new GrokLogin(store, root); }
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
  entries(): AccountEntry[] { return accountEntries(this.store); }
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
  rename(id: string, name: string) {
    this.get(id);
    name = name.trim();
    if (!name || name.length > 80) throw new HomeError("Use a name between 1 and 80 characters.");
    this.store.setSetting("codex.accounts", JSON.stringify(this.entries().map(entry => entry.id === id ? { ...entry, name, customName: true } : entry)));
  }
  /** Old releases allowed several independent refresh-token stores for the
   * same person/workspace. Collapse them once idle, retaining history/policies. */
  private consolidate(): Promise<void> {
    if (this.consolidating) return this.consolidating;
    this.consolidating = this.consolidateDuplicates().finally(() => { this.consolidating = undefined; });
    return this.consolidating;
  }
  private async consolidateDuplicates() {
    const groups = new Map<string, AccountEntry[]>();
    for (const entry of this.entries()) {
      const identity = this.get(entry.id).identityKey();
      if (identity) groups.set(identity, [...groups.get(identity) ?? [], entry]);
    }
    for (const group of groups.values()) {
      if (group.length < 2 || group.some(entry => this.active.get(entry.id) || this.changing.has(entry.id) || this.get(entry.id).loginPending)) continue;
      const keep = group.find(entry => entry.id === "default") ?? group[0]!;
      const duplicates = group.filter(entry => entry.id !== keep.id);
      for (const entry of group) this.changing.add(entry.id);
      try {
        const newest = [...group].sort((a, b) => this.get(b.id).credentialsUpdatedAt() - this.get(a.id).credentialsUpdatedAt())[0]!;
        if (newest.id !== keep.id) await this.get(keep.id).adoptCredentials(this.get(newest.id));
        const removed = new Set(duplicates.map(entry => entry.id));
        this.store.db.exec("BEGIN IMMEDIATE");
        try {
          // Keep the group's priority even if the built-in default slot was later.
          let inserted = false;
          const entries = this.entries().flatMap(entry => {
            if (!group.some(item => item.id === entry.id)) return [entry];
            if (inserted) return []; inserted = true;
            return [this.entries().find(item => item.id === keep.id)!];
          });
          this.store.setSetting("codex.accounts", JSON.stringify(entries));
          for (const row of this.store.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'agent.accounts.%'").all() as Array<{ key: string; value: string }>) {
            const ids: string[] | null = JSON.parse(row.value);
            if (ids?.some(id => removed.has(id))) this.store.setSetting(row.key, JSON.stringify([...new Set(ids.map(id => removed.has(id) ? keep.id : id))]));
          }
          for (const conversation of this.store.listConversations()) {
            const ownerKey = "codex.threadOwner." + conversation.id;
            if (removed.has(this.store.getSetting(ownerKey) ?? "")) {
              this.store.setConversationThread(conversation.id, null);
              this.store.deleteSetting(ownerKey);
            }
          }
          this.store.db.exec("COMMIT");
        } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
        for (const entry of duplicates) {
          this.merged.set(entry.id, keep.id);
          await this.services.get(entry.id)!.forgetDuplicate();
        }
      } finally { for (const entry of group) this.changing.delete(entry.id); }
    }
  }
  async loginStatus(id: string, loginId: string) {
    // A polling client may still use the temporary slot after it was merged.
    const service = this.services.get(id) ?? this.get(id);
    const status = await service.status(loginId);
    if (status.status !== "completed") return status;
    await this.consolidate();
    let accountId = id;
    while (this.merged.has(accountId)) accountId = this.merged.get(accountId)!;
    return { ...status, accountId, alreadyConnected: accountId !== id, account: await this.get(accountId).read() };
  }
  async list(refresh = false): Promise<Array<AccountEntry & { displayName: string; account: OpenAIAccount; usage: AccountUsage; activeRuns: number; loginPending: boolean }>> {
    await this.consolidate();
    const entries = this.entries();
    const result = await Promise.all(entries.map(async entry => {
      const service = this.get(entry.id);
      const [account, usage] = await Promise.all([service.read(refresh), service.usage(refresh)]);
      const generic = !entry.customName && ["Основной", "Аккаунт", "OpenAI", "Account", "ChatGPT", ""].includes(entry.name);
      return { ...entry, displayName: generic ? account.email ?? "ChatGPT" : entry.name, account, usage, activeRuns: this.active.get(entry.id) ?? 0, loginPending: service.loginPending };
    }));
    // Another client may rename/add/merge while usage is loading. Never return
    // an older catalogue that makes an account appear to vanish or reappear.
    return JSON.stringify(entries) === JSON.stringify(this.entries()) ? result : this.list();
  }
  async statusFor(agent: string, refresh = false, conversationId?: string) {
    // A client may still ask about an employee removed elsewhere; that keeps the device's own account.
    const provider = agent === "main" || this.store.getProfile(agent) ? resolveModelSelection(this.store, agent, undefined, conversationId).provider! : "chatgpt";
    if (provider !== "chatgpt") return { account: { connected: providerConnected(this.store, provider), email: null, planType: null, provider, providerName: providerInfo(provider)?.name ?? provider }, accountId: "provider-" + provider, loginPending: false };
    await this.consolidate();
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
  async choose(agent: string, checkQuota = true, excluded: ReadonlySet<string> = new Set()): Promise<{ id: string; service: CodexAccountService }> {
    await this.consolidate();
    const ids = this.policy(agent) ?? this.entries().map(a => a.id);
    let limited = false, signingIn = false;
    for (const id of ids) {
      const service = this.get(id);
      if (excluded.has(id)) { limited = true; continue; }
      if (this.changing.has(id) || service.loginPending) { signingIn = true; continue; }
      const usage = checkQuota ? await service.usage(false,true) : null;
      if (usage?.ordinaryUsageAllowed === false) { limited = true; continue; }
      const account = await service.read(false,true);
      if (account.issue === "unavailable") throw new AccountUnavailableError("unavailable");
      if (!account.connected) continue;
      // Only backend permission can block ordinary usage. A local clock and a
      // percentage are not proof of quota recovery or permission to spend credits.
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
  close() { clearInterval(this.quotaTimer); for (const service of this.services.values()) service.close(); this.grok.close(); }
}

/** Account choice is fixed for a whole turn. No retry of a partly executed turn.
 * A key provider is an account-shaped route `provider-<id>` with its own engine processes. */
export class AccountEngines implements CodexEngine {
  private engines = new Map<string, ScopedCodexEngine>();
  private providers = new Map<string, { engine: CodexEngine; scope: ScopedCodexEngine }>();
  private directoryEngine?: CodexEngine;
  private limited = new Map<string, { until: number; failedAt: number; failures: number; error: unknown }>();
  get connectionNotice() { return this.directoryEngine?.connectionNotice; }
  constructor(private readonly accounts: Accounts) { accounts.onChange = id => { this.engines.get(id)?.close(); this.engines.delete(id); }; }
  private scoped(id: string, service: CodexAccountService): ScopedCodexEngine {
    const existing = this.engines.get(id);
    if (existing) return existing;
    const engine = new ScopedCodexEngine(this.accounts.root, service.executionHome(), refresh => service.authTokens(refresh), id === "default" ? undefined : resolve(this.accounts.root, ".data/accounts", id, "contexts"));
    this.engines.set(id, engine);
    return engine;
  }
  /** A Claude or Grok route keeps its MCP services in the context's Codex scope; skills and plugins there apply only to Codex routes. */
  private keyed(id: string): { info: ProviderInfo; engine: CodexEngine; scope: ScopedCodexEngine } {
    const info = providerInfo(id), store = this.accounts.store, root = this.accounts.root;
    if (!info || !providerConnected(store, id)) throw providerNotConnected(id);
    let route = this.providers.get(id);
    if (!route) {
      const key = () => providerKey(store, id);
      const scope = new ScopedCodexEngine(root, undefined, undefined, resolve(root, ".data/providers", id, "contexts"), { info, key });
      route = { scope, engine: info.engine === "claude" ? new ClaudeEngine({ root, provider: info, key })
        : info.engine === "acp" ? new AcpEngine({ root, provider: info, onModels: models => store.setSetting(`providers.${id}.models`, JSON.stringify(models)) }) : scope };
      this.providers.set(id, route);
    }
    return { info, ...route };
  }
  forAgent(agent: string, context: string, conversationId?: string): CodexEngine {
    let locked: { id: string; service: CodexAccountService } | undefined;
    let connectionEngine: CodexEngine | undefined;
    let runningEngine: CodexEngine | undefined;
    let runningProvider: string | undefined;
    const providerForChat = () => runningProvider ?? resolveModelSelection(this.accounts.store, agent, undefined, conversationId).provider!;
    const selection = () => locked ? Promise.resolve(locked) : this.accounts.choose(agent, false);
    /** The context's Codex scope, which also keeps a Claude route's services. */
    const current = async () => {
      const provider = providerForChat();
      if (provider !== "chatgpt") return this.keyed(provider).scope.forContext(context);
      const selected = await selection(); return this.scoped(selected.id, selected.service).forContext(context);
    };
    const attempt = async (input: string, options: NonNullable<Parameters<CodexEngine["run"]>[1]>, excluded: ReadonlySet<string>, chosen: (id: string) => void): ReturnType<CodexEngine["run"]> => {
        const provider = options?.provider ?? providerForChat();
        const keyed = provider !== "chatgpt" ? this.keyed(provider) : undefined;
        // A subscription serves its subscriber: the owner's own chats and schedules, never colleagues or groups.
        if (keyed?.info.engine === "acp" && ((options?.groupChat ?? options?.groupContext) || !(options?.byOwner || options?.scheduled)))
          throw new ProviderIncident(`Подписка ${keyed.info.name} работает только в чатах владельца. Для коллег и групп выберите модель xAI с ключом API.`, 409, "policy:" + provider);
        const { id, service } = keyed ? { id: "provider-" + provider, service: undefined } : await this.accounts.choose(agent, true, excluded);
        chosen(id);
        if (service) locked = { id, service };
        // A sender without access gets a thread of their own, which never had the listed people's services or memories.
        const route = options?.access === false ? id + ".guest" : id;
        const threadKey = options?.conversationId ? `codex.thread.${route}.${options.conversationId}` : undefined;
        const saved = threadKey ? this.accounts.store.getSetting(threadKey) : undefined;
        this.accounts.active.set(id, (this.accounts.active.get(id) ?? 0) + 1);
        runningProvider = provider;
        try {
          const ownerKey = options?.conversationId ? "codex.threadOwner." + options.conversationId : undefined;
          const owner = ownerKey ? this.accounts.store.getSetting(ownerKey) : null;
          const threadId = saved ?? (route === "default" && (!owner || owner === route) ? options?.threadId : undefined);
          // A new thread is seeded with the chat. A thread resumed after another route answered gets the turns made since its last one.
          const checkpointKey = options?.conversationId ? `codex.threadCheckpoint.${route}.${options.conversationId}` : undefined;
          const resumedElsewhere = threadId && owner && owner !== route;
          const checkpoint = resumedElsewhere && checkpointKey ? this.accounts.store.getSetting(checkpointKey) : null;
          const recent = options?.conversationId && (!threadId || resumedElsewhere) ? this.accounts.store.listMessages(options.conversationId, 200) : [];
          const history = recent.slice(recent.findIndex(m => m.id === checkpoint) + 1).filter(m => m.kind !== "notice" && m.status === "completed" && (!checkpoint || m.replyToId !== checkpoint))
            // Who said what, and the files: a group's seed otherwise reads as one anonymous user with empty lines.
            .map(m => `${m.direction === "inbound" ? m.author || "User" : "Assistant"}: ${[m.text, m.attachments?.length ? `[${m.attachments.map(f => f.name).join(", ")}]` : ""].filter(Boolean).join(" ")}`).join("\n");
          const engine = keyed ? keyed.engine.forContext!(context) : this.scoped(id, service!).forContext(context);
          runningEngine = engine;
          const result = await engine.run(history ? `Earlier chat (context only):\n${history}\n\nCurrent message:\n${input}` : input, { ...options, threadId,
            // Codex's automatic reviewer exists only for ChatGPT; it would deny everything elsewhere.
            approvalMode: keyed && options?.approvalMode === "auto" ? "ask" : options?.approvalMode,
            // A native role runs on its parent's provider, so only employees on this route are offered.
            employees: options?.employees?.filter(employee => (employee.provider ?? "chatgpt") === provider),
            onEvent: event => {
              if (threadKey && event.type === "thread.started") this.accounts.store.setSetting(threadKey, (event.payload as any).threadId);
              if (ownerKey && event.type === "thread.started") this.accounts.store.setSetting(ownerKey, route);
              options?.onEvent?.(event);
            } });
          if (threadKey) this.accounts.store.setSetting(threadKey, result.threadId);
          if (ownerKey) this.accounts.store.setSetting(ownerKey, route);
          if (checkpointKey && options?.messageId) this.accounts.store.setSetting(checkpointKey, options.messageId);
          return result;
        } catch (error) {
          // Grok no longer knows the saved session, or Claude failed before writing it:
          // a new one starts, seeded with the chat, once.
          const lost = error instanceof AcpSessionLost || keyed?.info.engine === "claude" && /No conversation found with session ID/.test(error instanceof Error ? error.message : "");
          if (lost && saved) { this.accounts.store.deleteSetting(threadKey!); return await attempt(input, options, excluded, chosen); }
          // A lost sign-in needs the owner; Accounts offers it again.
          if (error instanceof ProviderSignInError) this.accounts.store.deleteSetting(`providers.${provider}.signedIn`);
          if (keyed) throw providerFailure(keyed.info, error);
          if (isOpenAIAuthenticationError(error)) service!.invalidate(); throw error;
        }
        finally { locked = undefined; runningEngine = undefined; runningProvider = undefined; this.accounts.active.set(id, Math.max(0, (this.accounts.active.get(id) ?? 1) - 1)); }
    };
    const run: CodexEngine["run"] = async (input, options = {}) => {
      const store = this.accounts.store, chat = options.conversationId ?? conversationId;
      const preferred = options.provider ? { provider:options.provider,model:options.model ?? null,serviceTier:options.serviceTier ?? null,reasoningEffort:options.reasoningEffort }
        : resolveModelSelection(store,agent,undefined,chat);
      const candidates = [preferred, ...followsDeviceModel(store,agent,chat) ? readModelFallbacks(store) : []];
      const tried = new Set<string>();
      let last: unknown = new AccountUnavailableError("limits");
      for (const [index, candidate] of candidates.entries()) {
        options.signal?.throwIfAborted();
        const provider = candidate.provider!, ref = JSON.stringify([provider,candidate.model]);
        if (tried.has(ref)) continue; tried.add(ref);
        // A personal subscription in the reserve cannot serve a group or a colleague.
        if (index && providerInfo(provider)?.engine === "acp" && ((options.groupChat ?? options.groupContext) || !(options.byOwner || options.scheduled))) continue;
        const excluded = new Set<string>();
        for (const [id, limit] of this.limited) {
          const usage = !id.startsWith("provider-") && this.accounts.entries().some(a=>a.id===id) ? this.accounts.get(id).usageSnapshot() : undefined;
          if (usage?.ordinaryUsageAllowed === true && Date.parse(usage.checkedAt) > limit.failedAt || limit.until <= Date.now()) continue;
          excluded.add(id); last = limit.error;
        }
        if (excluded.has("provider-" + provider)) continue;
        while (true) {
          options.signal?.throwIfAborted();
          let id: string | undefined, progressed = false;
          try {
            const result = await attempt(input, { ...options,...candidate,reasoningEffort:candidate.reasoningEffort ?? null,
              tools:options.tools && {...options.tools,call:(name,args)=>{progressed=true;return options.tools!.call(name,args);}},
              onRequest:options.onRequest && ((method,params)=>{progressed=true;return options.onRequest!(method,params);}),
              onEvent:event=>{
                if (event.type === "turn.progress" || /^item\/(?:started|completed)$/.test(event.type) && (event.payload as any)?.item?.type !== "userMessage"
                  || /^item\/.+\/delta$/.test(event.type)) progressed=true;
                options.onEvent?.(event);
              },
            }, excluded, selected=>{id=selected;});
            if (id) this.limited.delete(id);
            return result;
          } catch (error) {
            const quota = error instanceof AccountUnavailableError ? error.reason === "limits"
              : error instanceof ProviderIncident ? error.reason.startsWith("limits:")
              : /\b429\b|rate[_ -]?limit|quota|usage limit|too many requests/i.test(error instanceof Error ? error.message : "");
            if (!quota) throw error;
            if (id) {
              const failures = (this.limited.get(id)?.failures ?? 0) + 1;
              this.limited.set(id,{failedAt:Date.now(),until:Date.now()+Math.min(60_000*5**(failures-1),900_000),failures,error});
              if (provider === "chatgpt") this.accounts.get(id).recordQuotaLimit();
            }
            if (progressed || options.signal?.aborted) throw error;
            last = error;
            if (provider !== "chatgpt" || !id) break;
            excluded.add(id);
          }
        }
      }
      if (candidates.length > 1) throw new ProviderIncident("Лимиты основной и резервных моделей исчерпаны. Запрос сохранён; повторите его после восстановления лимита.",429,"limits:all");
      throw last;
    };
    return {
      steer: async (input, options) => runningEngine?.steer?.(input, options) ?? false,
      run,
      get connectionNotice() { return connectionEngine?.connectionNotice; },
      /** Every connected provider's models, so the picker can switch an agent between them. */
      models: async refresh => {
        const chatgpt = chatgptSignedIn(this.accounts.store) ? await selection().then(selected => this.scoped(selected.id, selected.service).forContext(context).models!(refresh))
          .catch(error => { if (error instanceof AccountUnavailableError) return []; throw error; }) : [];
        const keyed = await Promise.all(providerInfos().filter(p => providerConnected(this.accounts.store, p.id))
          .map(p => p.engine === "acp" ? this.subscriptionModels(p.id) : p.id === "anthropic" ? this.keyed(p.id).engine.models!(refresh).catch(() => providerModels(p)) : p.models.length ? providerModels(p) : this.keyed(p.id).scope.forContext(context).models!(refresh)));
        return [...chatgpt, ...keyed.flat()];
      },
      connections: async refresh => {
        connectionEngine = await current();
        const all = await connectionEngine.connections?.(refresh) ?? [];
        // Computer Use is a Codex plugin; the Claude and Grok engines never load it.
        return [undefined, "codex"].includes(providerInfo(providerForChat())?.engine) ? all : all.filter(c => c.id !== "mcp:cua_repl");
      },
      connect: async (name, options) => {
        // Codex keeps a browser sign-in in its own home, where the Claude and Grok engines cannot use it.
        const info = providerInfo(providerForChat());
        if (info && info.engine !== "codex") throw new HomeError(`С ${info.name} вход в сервисы через браузер недоступен. Добавьте сервис с ключом доступа в «Сервисы и навыки».`, 409);
        return (await current()).connect!(name, options);
      },
      isConnected: async name => (await current()).isConnected!(name),
      extensions: async () => (await current()).extensions!(),
    };
  }
  /** A subscription's catalog as its agent last reported it; until there is one, the agent is asked once per request. */
  private async subscriptionModels(id: string) {
    const stored = subscriptionModels(this.accounts.store, id);
    if (stored.length) return stored;
    const models = await this.keyed(id).engine.models!().catch(() => []);
    if (models.length) this.accounts.store.setSetting(`providers.${id}.models`, JSON.stringify(models));
    return models;
  }
  forContext(context: string): CodexEngine { return this.forAgent("main", context); }
  run: CodexEngine["run"] = (input, options) => this.forAgent("main", "personal").run(input, options);
  connections: NonNullable<CodexEngine["connections"]> = refresh => {
    this.directoryEngine = this.forAgent("main", "personal");
    return this.directoryEngine.connections!(refresh);
  };
  connect: NonNullable<CodexEngine["connect"]> = (id, options) => this.forAgent("main", "personal").connect!(id, options);
  close() {
    for (const engine of this.engines.values()) engine.close();
    for (const route of this.providers.values()) { route.engine.close?.(); route.scope.close(); }
    this.engines.clear(); this.providers.clear();
  }
}
