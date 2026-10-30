import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { CodexAccountService } from "../src/account.js";
const engines = vi.hoisted(() => ({ run: vi.fn(), models: vi.fn(), closed: [] as string[] }));
vi.mock("../src/scopes.js", () => ({ ScopedCodexEngine: class {
  readonly account: string;
  constructor(_root: string, account: string, _tokens?: unknown, readonly contexts?: string, readonly provider?: { info: { id: string }; key: () => string | null }) { this.account = provider ? "provider-" + provider.info.id : account; }
  forContext(context: string) { return { run: (input: string, options: any) => engines.run(this.account, context, input, options), connections: async () => [this.account],
    models: async () => [{ id: this.provider ? "api-model" : "chat-model", provider: this.provider?.info.id ?? "chatgpt" }], extensions: () => ({ scope: this.account, context }),
    isConnected: async (id: string) => id === "mcp:ready", connect: async (id: string) => ({ url: `https://sign-in.invalid/${this.account}/${id}` }) }; }
  close() { engines.closed.push(this.account); }
} }));
vi.mock("../src/claude.js", async original => ({ ...await original<object>(), ClaudeEngine: class {
  constructor(readonly options: { provider: { id: string }; key: () => string | null }) {}
  forContext(context: string) { return { run: (input: string, options: any) => engines.run("claude-" + this.options.provider.id, context, input, options) }; }
} }));
vi.mock("../src/acp.js", async original => ({ ...await original<object>(), AcpEngine: class {
  constructor(readonly options: { provider: { id: string } }) {}
  forContext(context: string) { return { run: (input: string, options: any) => engines.run("acp-" + this.options.provider.id, context, input, options) }; }
  models() { return engines.models(this.options.provider.id); }
} }));
import { Accounts, AccountEngines } from "../src/accounts.js";
import { MessageService } from "../src/messages.js";
import { ProviderKeyError } from "../src/providers.js";
import { AcpSessionLost, ProviderSignInError } from "../src/acp.js";
import { saveModelSelection, saveConversationModelSelection } from "../src/model-settings.js";
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks(); engines.run.mockReset(); engines.models.mockReset(); engines.closed.length = 0; });
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const primary = new CodexAccountService(store, "/unused-test"); const accounts = new Accounts(store, "/unused-test", primary);
  const second = accounts.add("Other").id;
  for (const id of ["default", second]) {
    vi.spyOn(accounts.get(id), "read").mockResolvedValue({ connected: true, email: id + "@example.invalid", planType: "plus", managed: true });
    vi.spyOn(accounts.get(id), "usage").mockResolvedValue({ checkedAt: new Date().toISOString(), ordinaryUsageAllowed: true, windows: [] });
    vi.spyOn(accounts.get(id), "executionHome").mockReturnValue(id);
  }
  return { store, accounts, second, pool: new AccountEngines(accounts) };
}

it("returns to the preferred subscription as soon as a fresh quota read confirms a purchased reset", async () => {
  const {accounts,pool}=fixture();
  engines.run.mockImplementation(async(account)=>{if(account==="default")throw new Error("429 usage limit");return{threadId:"reserve",response:"reserve",events:[]};});
  await pool.run("one");
  engines.run.mockClear();
  await pool.run("two");
  expect(engines.run.mock.calls.map(c=>c[0])).not.toContain("default");
  vi.spyOn(accounts.get("default"),"usageSnapshot").mockReturnValue({checkedAt:new Date(Date.now()+1).toISOString(),ordinaryUsageAllowed:true,windows:[]});
  engines.run.mockImplementation(async(account)=>({threadId:account,response:account,events:[]}));
  expect((await pool.run("three")).response).toBe("default");
});
describe("per-device Codex subscriptions", () => {
  it("uses the conversation provider for account status, services and execution, without changing employee defaults", async () => {
    const {store,accounts,pool}=fixture(),chat=store.primaryConversation();
    store.setSetting("providers.openai.key","test-key");
    saveModelSelection(store,{provider:"chatgpt",model:"chat-model",serviceTier:"default"},"main");
    saveConversationModelSelection(store,chat.id,{provider:"openai",model:"api-model",serviceTier:"default"});
    const route=pool.forAgent("main","personal",chat.id);
    expect(await route.connections!()).toEqual(["provider-openai"]);
    expect(await accounts.statusFor("main",false,chat.id)).toMatchObject({account:{connected:true,provider:"openai"}});
    engines.run.mockResolvedValue({threadId:"api-thread",response:"ok",events:[]});
    await route.run("Hi",{conversationId:chat.id});
    expect(engines.run.mock.calls[0]?.[0]).toBe("provider-openai");
    expect(await pool.forAgent("main","personal").connections!()).toEqual(["default"]);
  });
  it("does not wait for quota checks to open service settings", async () => {
    const { accounts, pool } = fixture();
    expect(await pool.forAgent("main", "personal").connections!()).toEqual(["default"]);
    expect(accounts.get("default").usage).not.toHaveBeenCalled();
  });
  it("uses ordered allowed accounts and backend quota permission without inferring permission from percentages", async () => {
    const { accounts, second } = fixture();
    vi.mocked(accounts.get("default").usage).mockResolvedValue({ checkedAt: "now", ordinaryUsageAllowed: false, windows: [] });
    expect((await accounts.choose("main")).id).toBe(second);
    accounts.setPolicy("main", ["default"]); await expect(accounts.choose("main")).rejects.toMatchObject({ reason: "limits" });
    vi.mocked(accounts.get("default").usage).mockResolvedValue({ checkedAt: "now", ordinaryUsageAllowed: null, windows: [{ name: "unknown", usedPercent: 100, remainingPercent: 0, windowDurationMins: 1, resetsAt: 0 }] });
    expect((await accounts.choose("main")).id).toBe("default");
  });
  it("keeps one account for a running turn and never retries tool effects through another account", async () => {
    const { accounts, second, pool } = fixture();
    let finish!: () => void; const gate = new Promise<void>(resolve => finish = resolve);
    engines.run.mockImplementation(async (account: string) => { await gate; throw new Error("connection failed after an external action"); });
    const pending = pool.forAgent("main", "personal").run("perform action");
    await vi.waitFor(() => expect(accounts.active.get("default")).toBe(1));
    expect(() => accounts.assertIdle("default")).toThrow("выполняет поручение");
    accounts.prioritize(second); finish(); await expect(pending).rejects.toThrow("external action");
    expect(engines.run).toHaveBeenCalledTimes(1); expect(engines.run.mock.calls[0]?.[0]).toBe("default");
    expect((await accounts.choose("main")).id).toBe(second);
  });
  it("separates thread IDs and restores each account's own conversation", async () => {
    const { store, accounts, second, pool } = fixture(), conversation = store.primaryConversation();
    store.addMessage({ channel: "api", conversationId: conversation.id, direction: "outbound", text: "Remember this context" });
    engines.run.mockImplementation(async (account, _context, _input, options) => ({ threadId: account + "-thread", response: "ok", events: [] }));
    await pool.run("one", { conversationId: conversation.id });
    expect(engines.run.mock.calls[0]?.[2]).toContain("Remember this context");
    accounts.prioritize(second); await pool.run("two", { conversationId: conversation.id, threadId: "default-thread" });
    expect(engines.run.mock.calls[1]?.[3].threadId).toBeUndefined(); expect(engines.run.mock.calls[1]?.[2]).toContain("Remember this context");
    accounts.prioritize("default"); await pool.run("three", { conversationId: conversation.id, threadId: second + "-thread" });
    expect(engines.run.mock.calls[2]?.[3].threadId).toBe("default-thread");
  });
  it("does not resurrect an account's old tool catalog after the runtime renews execution threads",async()=>{
    const {store,pool,second}=fixture(),conversation=store.primaryConversation();
    const messages=new MessageService(store,pool);
    engines.run.mockImplementation(async()=>({threadId:"fresh-thread",response:"ok",events:[]}));
    store.setConversationThread(conversation.id,"public-old-thread");
    store.setSetting("codex.thread.default."+conversation.id,"cached-old-thread");
    store.setSetting("codex.thread."+second+"."+conversation.id,"other-old-thread");
    store.setSetting("codex.threadOwner."+conversation.id,"default");
    store.setSetting("codex.threadCheckpoint.default."+conversation.id,"old-checkpoint");
    store.addMessage({conversationId:conversation.id,channel:"api",direction:"outbound",text:"The previous decision"});
    store.clearConversationThreads();
    await messages.handle({channel:"api",conversationId:conversation.id,text:"Continue"});
    expect(engines.run.mock.calls[0]?.[3].threadId).toBeNull();
    expect(engines.run.mock.calls[0]?.[2]).toContain("The previous decision");
    expect(store.getSetting("codex.thread."+second+"."+conversation.id)).toBeNull();
    expect(store.getSetting("codex.thread.default."+conversation.id)).toBe("fresh-thread");
    await messages.close();
  });
  it("blocks account maintenance during a turn and avoids choosing an account being logged out", async () => {
    const { accounts, second } = fixture(); let done!: () => void;
    const maintenance = accounts.withIdle("default", () => new Promise<void>(resolve => done = resolve));
    expect((await accounts.choose("main")).id).toBe(second);
    await expect(accounts.withIdle("default", async () => {})).rejects.toThrow("обновляется"); done(); await maintenance;
    expect((await accounts.choose("main")).id).toBe("default");
  });
  it("does not treat an OpenAI outage as an invitation to cycle accounts", async () => {
    const { accounts, second } = fixture();
    vi.mocked(accounts.get("default").read).mockResolvedValue({ connected: false, email: null, planType: null, managed: true, issue: "unavailable" });
    await expect(accounts.choose("main")).rejects.toThrow("пока не отвечает");
    expect(accounts.get(second).read).not.toHaveBeenCalled();
  });
  it("distinguishes missing login from exhausted limits", async () => {
    const { accounts, second } = fixture();
    for (const id of ["default", second]) vi.mocked(accounts.get(id).read).mockResolvedValue({ connected: false, email: null, planType: null, managed: false });
    await expect(accounts.choose("main")).rejects.toMatchObject({ reason: "sign_in_required" });
  });
});

describe("API key providers", () => {
  it("gives each key provider its own route, threads and transcript bootstrap", async () => {
    const { store, pool } = fixture(), conversation = store.primaryConversation();
    store.setSetting("providers.xai.key", "xai-key"); store.setSetting("providers.anthropic.key", "ant-key");
    store.addMessage({ channel: "api", conversationId: conversation.id, direction: "outbound", text: "Remember this context" });
    engines.run.mockImplementation(async (route: string) => ({ threadId: route + "-thread", response: "ok", events: [] }));
    await pool.run("one", { conversationId: conversation.id, provider: "chatgpt" });
    await pool.run("two", { conversationId: conversation.id, provider: "xai", threadId: "default-thread" });
    expect(engines.run.mock.calls[1]?.[0]).toBe("provider-xai");
    expect(engines.run.mock.calls[1]?.[3].threadId).toBeUndefined(); expect(engines.run.mock.calls[1]?.[2]).toContain("Remember this context");
    expect(store.getSetting("codex.thread.provider-xai." + conversation.id)).toBe("provider-xai-thread");
    expect(store.getSetting("codex.threadOwner." + conversation.id)).toBe("provider-xai");
    await pool.run("three", { conversationId: conversation.id, provider: "chatgpt", threadId: "provider-xai-thread" });
    expect(engines.run.mock.calls[2]?.[3].threadId).toBe("default-thread");
    await pool.run("four", { conversationId: conversation.id, provider: "xai", model: "grok-4.5" });
    expect(engines.run.mock.calls[3]?.[3]).toMatchObject({ threadId: "provider-xai-thread", model: "grok-4.5" });
    await pool.run("five", { conversationId: conversation.id, provider: "anthropic" });
    expect(engines.run.mock.calls[4]?.[0]).toBe("claude-anthropic"); expect(engines.run.mock.calls[4]?.[2]).toContain("Remember this context");
    expect(store.getSetting("codex.thread.provider-anthropic." + conversation.id)).toBe("claude-anthropic-thread");
  });
  it("routes by the agent's own selection and lists models without requiring ChatGPT", async () => {
    const { store, accounts, pool } = fixture();
    store.setSetting("providers.openai.key", "sk-api"); store.setSetting("providers.kimi.key", "kimi-key");
    const employee = store.createProfile({ name: "Researcher" });
    saveModelSelection(store, { provider: "kimi", model: "kimi-k3", serviceTier: "default" }, employee.id);
    engines.run.mockResolvedValue({ threadId: "t", response: "ok", events: [] });
    await pool.forAgent(employee.id, "personal").run("hello");
    expect(engines.run.mock.calls[0]?.[0]).toBe("claude-kimi");
    await pool.forAgent("main", "personal").run("hello");
    expect(engines.run.mock.calls[1]?.[0]).toBe("provider-openai");
    expect((await pool.forAgent("main", "personal").models!()).map(m => [m.provider, m.id])).toEqual([["openai", "api-model"], ["kimi", "kimi-k3"], ["kimi", "kimi-k2.7-code"]]);
    expect(await pool.forAgent("main", "personal").connections!()).toEqual(["provider-openai"]);
    expect(accounts.get("default").read).not.toHaveBeenCalled();
    store.setSetting("codex.auth.mode", "managed");
    expect((await pool.forAgent("main", "personal").models!()).map(m => m.provider)).toEqual(["chatgpt", "openai", "kimi", "kimi"]);
    expect(await accounts.statusFor(employee.id)).toEqual({ account: { connected: true, email: null, planType: null, provider: "kimi", providerName: "Kimi" }, accountId: "provider-kimi", loginPending: false });
    // A Claude route keeps its services in the context's Codex scope: it lists and checks them there,
    // but never signs in through Codex, whose OAuth tokens the Claude engine cannot use.
    const claude = pool.forAgent(employee.id, "personal");
    expect(await claude.extensions!()).toEqual({ scope: "provider-kimi", context: "personal" });
    expect(await claude.connections!()).toEqual(["provider-kimi"]);
    expect(await claude.isConnected!("mcp:ready")).toBe(true);
    await expect(claude.connect!("mcp:notion")).rejects.toMatchObject({ status: 409, message: "С Kimi вход в сервисы через браузер недоступен. Добавьте сервис с ключом доступа в «Сервисы и навыки»." });
    // A Codex key route still signs in through its own Codex scope.
    saveModelSelection(store, { provider: "openai", model: "api-model", serviceTier: "default" }, "main");
    expect(await pool.forAgent("main", "personal").connect!("mcp:notion")).toEqual({ url: "https://sign-in.invalid/provider-openai/mcp:notion" });
  });
  it("catches a resumed route up on the turns another provider made meanwhile", async () => {
    const { store, pool } = fixture(), conversation = store.primaryConversation();
    store.setSetting("providers.xai.key", "xai-key");
    engines.run.mockImplementation(async (route: string, _context: string, input: string) => ({ threadId: route + "-thread", response: `${route} answered ${input.split("\n").at(-1)}`, events: [] }));
    const messages = new MessageService(store, pool);
    const turn = (provider: string, model: string, text: string) => {
      saveModelSelection(store, { provider, model, serviceTier: "default" }, "main");
      return messages.handle({ channel: "api", text, externalChatId: "home" });
    };
    await turn("chatgpt", "chat-model", "Plan A");
    await turn("xai", "grok-4.7", "Settle on Y");
    await turn("chatgpt", "chat-model", "What did we decide?");
    const [route, , input, options] = engines.run.mock.calls[2]!;
    expect(route).toBe("default"); expect(options.threadId).toBe("default-thread");
    expect(input).toBe("Earlier chat (context only):\nUser: Settle on Y\nAssistant: provider-xai answered Settle on Y\n\nCurrent message:\nWhat did we decide?");
    await turn("chatgpt", "chat-model", "And now?");
    expect(engines.run.mock.calls[3]![2]).toBe("And now?");
    await messages.close();
  });
  it("keeps who said what, and their files, when another provider picks up a chat", async () => {
    const { store, pool } = fixture(), conversation = store.primaryConversation();
    store.setSetting("providers.anthropic.key", "ant-key");
    store.addMessage({ channel: "telegram", conversationId: conversation.id, direction: "inbound", text: "Позвоню Веронике да!", author: "Darya" });
    store.addMessage({ channel: "telegram", conversationId: conversation.id, direction: "inbound", text: "", author: "G. O.", attachments: [{ id: "a", conversationId: conversation.id, name: "screen.png", mimeType: "image/png", size: 1 }] });
    store.addMessage({ channel: "telegram", conversationId: conversation.id, direction: "outbound", text: "", attachments: [{ id: "b", conversationId: conversation.id, name: "snoop.gif", mimeType: "image/gif", size: 1 }] });
    store.addMessage({ channel: "api", conversationId: conversation.id, direction: "inbound", text: "Без автора" });
    engines.run.mockResolvedValue({ threadId: "t", response: "ok", events: [] });
    await pool.run("Что дальше?", { conversationId: conversation.id, provider: "anthropic" });
    expect(engines.run.mock.calls[0]![2]).toBe("Earlier chat (context only):\nDarya: Позвоню Веронике да!\nG. O.: [screen.png]\nAssistant: [snoop.gif]\nUser: Без автора\n\nCurrent message:\nЧто дальше?");
  });
  it("gives turns without access their own thread, caught up on the chat, and never resumes the listed one for them", async () => {
    for (const [provider, route] of [["chatgpt", "default"], ["anthropic", "provider-anthropic"]] as const) {
      const { store, pool } = fixture();
      store.setSetting("providers.anthropic.key", "ant-key");
      saveModelSelection(store, { provider, model: provider === "chatgpt" ? "chat-model" : "claude-fable-5-1", serviceTier: "default" }, "main");
      store.linkTelegramChat({ chatId: "42", title: "Owner", allowedSenders: ["42"] });
      let n = 0;
      engines.run.mockImplementation(async (engine: string, _context: string, input: string, options: any) => ({ threadId: options.threadId || `${engine}-${++n}`, response: `answered ${input.split("\n").at(-1)}`, events: [] }));
      const messages = new MessageService(store, pool);
      const turn = (sender: string, text: string, id: number) => messages.handle({ channel: "telegram", text, externalChatId: "-100", externalId: `-100:${id}`, telegramSenderId: sender, author: sender === "42" ? "Owner" : "Guest" });
      const calls = () => engines.run.mock.calls.map(([, , input, options]) => ({ input: input as string, threadId: options.threadId, access: options.access }));
      const engine = provider === "chatgpt" ? "default" : "claude-anthropic";
      await turn("42", "Plan A", 1);
      const conversation = store.getTelegramChat("-100")?.conversationId ?? store.listConversations().find(c => c.externalId === "-100")!.id;
      await turn("77", "Guest B", 2);
      // The guest never receives the conversation's thread, even though it is the listed one.
      expect(store.getConversation(conversation)?.codexThreadId).not.toBeNull();
      expect(calls()[1]).toMatchObject({ threadId: undefined, access: false });
      expect(calls()[1]!.input).toMatch(/^Earlier chat \(context only\):\nOwner: Plan A\nAssistant: answered[^\n]*Plan A\n/);
      expect(store.getSetting(`codex.thread.${route}.guest.${conversation}`)).toBe(`${engine}-2`);
      expect(store.getSetting("codex.threadOwner." + conversation)).toBe(route + ".guest");
      await turn("42", "Listed C", 3);
      expect(calls()[2]).toMatchObject({ threadId: `${engine}-1`, access: true });
      expect(calls()[2]!.input).toContain("Guest: Guest B");
      await turn("77", "Guest D", 4);
      expect(calls()[3]).toMatchObject({ threadId: `${engine}-2`, access: false });
      expect(calls()[3]!.input).toContain("Owner: Listed C");
      expect(store.getSetting(`codex.thread.${route}.${conversation}`)).toBe(`${engine}-1`);
      await messages.close(); engines.run.mockReset();
    }
  });
  it("fails a rejected key with the provider's message and leaves ChatGPT signed in", async () => {
    const { store, accounts, pool } = fixture(), conversation = store.primaryConversation();
    store.setSetting("providers.xai.key", "xai-key");
    const invalidate = vi.spyOn(accounts.get("default"), "invalidate");
    engines.run.mockRejectedValue(new Error("unexpected status 401 Unauthorized: Incorrect API key provided, url: https://api.x.ai/v1/responses"));
    await expect(pool.run("hi", { conversationId: conversation.id, provider: "xai" })).rejects.toBeInstanceOf(ProviderKeyError);
    const messages = new MessageService(store, pool);
    await expect(messages.handle({ channel: "api", text: "Hi", externalChatId: "home" })).rejects.toThrow("xAI не принял ключ. Замените его в настройках аккаунтов.");
    expect(store.listMessages(conversation.id).find(m => m.text === "Hi")?.error).toBe("xAI не принял ключ. Замените его в настройках аккаунтов.");
    engines.run.mockRejectedValue(new Error("unexpected status 429 Too Many Requests: You exceeded your current quota"));
    await expect(messages.handle({ channel: "api", text: "Again", externalChatId: "home" })).rejects.toThrow("У ключа xAI закончился лимит или баланс.");
    expect(invalidate).not.toHaveBeenCalled();
    await messages.close();
  });
  it("names a provider that is not connected on this device and starts nothing", async () => {
    const { store, pool } = fixture();
    const moved = store.createProfile({ name: "Moved" });
    saveModelSelection(store, { provider: "anthropic", model: "claude-opus-5-5", serviceTier: "default" }, moved.id);
    await expect(pool.forAgent(moved.id, "personal").run("hi")).rejects.toMatchObject({ status: 409, message: "Подключите Anthropic на этом устройстве или выберите другую модель." });
    expect(engines.run).not.toHaveBeenCalled();
  });
  it("asks instead of automatic review on key providers and delegates only within the route", async () => {
    const { store, pool } = fixture();
    store.setSetting("providers.xai.key", "xai-key");
    engines.run.mockResolvedValue({ threadId: "t", response: "ok", events: [] });
    const employees: any[] = [{ id: "grok", provider: "xai", model: "grok-4.5" }, { id: "chat", provider: "chatgpt", model: "gpt-6-sol" }];
    await pool.run("hi", { provider: "xai", approvalMode: "auto", employees });
    expect(engines.run.mock.calls[0]?.[3]).toMatchObject({ approvalMode: "ask" });
    expect(engines.run.mock.calls[0]?.[3].employees.map((e: any) => e.id)).toEqual(["grok"]);
    await pool.run("hi", { provider: "chatgpt", approvalMode: "auto", employees });
    expect(engines.run.mock.calls[1]?.[3]).toMatchObject({ approvalMode: "auto" });
    expect(engines.run.mock.calls[1]?.[3].employees.map((e: any) => e.id)).toEqual(["chat"]);
  });
});

describe("Grok subscription", () => {
  const grokModels = [{ id: "grok-4.7", name: "Grok 4.7", description: "", isDefault: true, speeds: [{ id: "default", name: "Обычная", description: "" }], provider: "grok" }];
  const signedIn = (store: Store) => { store.setSetting("providers.grok.signedIn", "2026-10-15T10:00:00.000Z"); store.setSetting("providers.grok.models", JSON.stringify(grokModels)); };
  it("serves only the owner's own chats and schedules; colleagues and groups are told to use an xAI key", async () => {
    const { store, pool } = fixture(); signedIn(store);
    saveModelSelection(store, { provider: "grok", model: "grok-4.7", serviceTier: "default" }, "main");
    engines.run.mockResolvedValue({ threadId: "s-1", response: "ok", events: [] });
    const messages = new MessageService(store, pool);
    await messages.handle({ channel: "api", text: "Hi", externalChatId: "home", byOwner: true });
    expect(engines.run.mock.calls[0]).toEqual(["acp-grok", "personal", "Hi", expect.objectContaining({ provider: "grok", model: "grok-4.7", byOwner: true })]);
    await messages.handle({ channel: "api", text: "Morning digest", externalChatId: "home", scheduled: true });
    expect(engines.run.mock.calls[1]?.[3]).toMatchObject({ scheduled: true });
    const refusal = "Подписка Grok работает только в чатах владельца. Для коллег и групп выберите модель xAI с ключом API.";
    await expect(messages.handle({ channel: "api", text: "From a colleague", externalChatId: "home" })).rejects.toThrow(refusal);
    await expect(pool.run("hi", { provider: "grok", byOwner: true, groupContext: true })).rejects.toMatchObject({ status: 409, reason: "policy:grok", message: refusal });
    expect(engines.run).toHaveBeenCalledTimes(2);
    await messages.close();
  });
  it("serves the owner's employee chat that keeps its files with a Telegram group, but not that group", async () => {
    const { store, pool } = fixture(); signedIn(store);
    const news = store.createProfile({ name: "News" }), chat = store.profileConversation(news.id);
    saveModelSelection(store, { provider: "grok", model: "grok-4.7", serviceTier: "default" }, news.id);
    const workspace = "group-" + "a".repeat(64);
    store.setSetting("conversation.context." + chat.id, workspace);
    store.linkTelegramChat({ chatId: "-100", title: "Wai News", allowedSenders: [] }); store.bindTelegramChat("-100", news.id);
    engines.run.mockResolvedValue({ threadId: "s-1", response: "NO_REPLY", events: [] });
    const messages = new MessageService(store, pool);
    await messages.handle({ channel: "api", conversationId: chat.id, text: "Radar", scheduled: true });
    expect(engines.run.mock.calls[0]).toEqual(["acp-grok", workspace, expect.any(String), expect.objectContaining({ provider: "grok", groupContext: true, groupChat: false })]);
    await expect(messages.handle({ channel: "telegram", externalChatId: "-100", externalId: "1", text: "@News что нового?", telegramSenderId: "139287108", byOwner: true }))
      .rejects.toThrow("Подписка Grok работает только в чатах владельца");
    expect(engines.run).toHaveBeenCalledTimes(1);
    await messages.close();
  });
  it("reads the agent's catalog once when none is stored, so a failed read at sign-in does not hide Grok's models", async () => {
    const { store, pool } = fixture();
    store.setSetting("providers.grok.signedIn", "2026-10-15T10:00:00.000Z");
    const grok = async () => (await pool.forAgent("main", "personal").models!()).filter(m => m.provider === "grok");
    // x.ai is unreachable: the picker still opens, and the next one reads again.
    engines.models.mockRejectedValueOnce(new Error("Grok не отвечает"));
    expect(await grok()).toEqual([]);
    expect(store.getSetting("providers.grok.models")).toBeNull();
    engines.models.mockResolvedValueOnce(grokModels);
    expect(await grok()).toEqual(grokModels);
    expect(JSON.parse(store.getSetting("providers.grok.models")!)).toEqual(grokModels);
    expect(await grok()).toEqual(grokModels);
    expect(engines.models.mock.calls).toEqual([["grok"], ["grok"]]);
  });
  it("starts over once when Claude never saved the session it was asked to resume", async () => {
    const { store, pool } = fixture(), conversation = store.primaryConversation();
    store.setSetting("providers.anthropic.key", "ant-key");
    store.addMessage({ channel: "api", conversationId: conversation.id, direction: "outbound", text: "Remember this context" });
    store.setSetting("codex.thread.provider-anthropic." + conversation.id, "s-lost");
    engines.run.mockImplementation(async (_route, _context, _input, options) => {
      if (options.threadId) throw new Error("Claude Code returned an error result: No conversation found with session ID: s-lost");
      return { threadId: "s-new", response: "ok", events: [] };
    });
    await pool.run("Next", { conversationId: conversation.id, provider: "anthropic", byOwner: true });
    expect(engines.run.mock.calls.map(call => call[3].threadId)).toEqual(["s-lost", undefined]);
    expect(engines.run.mock.calls[1]?.[2]).toContain("Remember this context");
    expect(store.getSetting("codex.thread.provider-anthropic." + conversation.id)).toBe("s-new");
  });
  it("lists the agent's own models, starts over once when Grok lost the session, and forgets a lost sign-in", async () => {
    const { store, accounts, pool } = fixture(), conversation = store.primaryConversation(); signedIn(store);
    store.addMessage({ channel: "api", conversationId: conversation.id, direction: "outbound", text: "Remember this context" });
    store.setSetting("codex.thread.provider-grok." + conversation.id, "s-old");
    expect((await pool.forAgent("main", "personal").models!()).filter(m => m.provider === "grok")).toEqual(grokModels);
    expect(await accounts.statusFor("main")).toEqual({ account: { connected: true, email: null, planType: null, provider: "grok", providerName: "Grok" }, accountId: "provider-grok", loginPending: false });
    engines.run.mockImplementation(async (_route, _context, _input, options) => { if (options.threadId) throw new AcpSessionLost("Session not found"); return { threadId: "s-new", response: "ok", events: [] }; });
    await pool.run("Next", { conversationId: conversation.id, provider: "grok", byOwner: true });
    expect(engines.run.mock.calls.map(call => call[3].threadId)).toEqual(["s-old", undefined]);
    expect(engines.run.mock.calls[1]?.[2]).toContain("Remember this context");
    expect(store.getSetting("codex.thread.provider-grok." + conversation.id)).toBe("s-new");
    engines.run.mockRejectedValue(new ProviderSignInError({ id: "grok", name: "Grok" } as any));
    await expect(pool.run("Again", { conversationId: conversation.id, provider: "grok", byOwner: true })).rejects.toThrow("Войдите в Grok снова в настройках аккаунтов.");
    expect(store.getSetting("providers.grok.signedIn")).toBeNull();
    await expect(pool.run("Again", { provider: "grok", byOwner: true })).rejects.toThrow("Подключите Grok на этом устройстве или выберите другую модель.");
  });
});

describe("model priority", () => {
  const reserve = { provider: "xai", model: "grok-4.7", serviceTier: "default" };
  function setup() {
    const f = fixture();
    f.store.setSetting("providers.xai.key", "xai-key");
    saveModelSelection(f.store, { provider: "chatgpt", model: "chat-model", serviceTier: "priority", reasoningEffort: "high" });
    f.store.setSetting("models.fallbacks", JSON.stringify([reserve]));
    engines.run.mockResolvedValue({ threadId: "new-thread", response: "OK", events: [] });
    return f;
  }
  it("uses subscription accounts first, falls back on exhausted quota, and returns after recovery", async () => {
    const { store, accounts, second, pool } = setup();
    for (const id of ["default", second]) vi.mocked(accounts.get(id).usage).mockResolvedValue({ checkedAt: "now", ordinaryUsageAllowed: false, windows: [] });
    await pool.run("Hi");
    expect(engines.run.mock.calls[0]).toEqual(["provider-xai", "personal", "Hi", expect.objectContaining({ ...reserve, reasoningEffort: null })]);
    vi.mocked(accounts.get("default").usage).mockResolvedValue({ checkedAt: "now", ordinaryUsageAllowed: true, windows: [] });
    await pool.run("Next");
    expect(engines.run.mock.calls[1]?.[0]).toBe("default");
    expect(store.getSetting("models.defaults")).toContain('"provider":"chatgpt"');
  });
  it("tries the next subscription then each reserve once on an early quota error", async () => {
    const { store, second, pool } = setup();
    store.setSetting("providers.deepseek.key", "deepseek-key");
    store.setSetting("models.fallbacks", JSON.stringify([reserve, { provider: "deepseek", model: "deepseek-v4-pro", serviceTier: "default" }]));
    engines.run.mockImplementation(async route => {
      if (route !== "claude-deepseek") throw new Error("429 Too Many Requests");
      return { threadId: "deep-thread", response: "OK", events: [] };
    });
    await expect(pool.run("Hi")).resolves.toMatchObject({ response: "OK" });
    expect(engines.run.mock.calls.map(c => c[0])).toEqual(["default", second, "provider-xai", "claude-deepseek"]);
    engines.run.mockClear();
    await pool.run("Next");
    expect(engines.run.mock.calls.map(c => c[0])).toEqual(["claude-deepseek"]);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    engines.run.mockClear();
    engines.run.mockResolvedValue({ threadId: "recovered", response: "OK", events: [] });
    await pool.run("Recovered");
    expect(engines.run.mock.calls.map(c => c[0])).toEqual(["default"]);
  });
  it.each(["item/started", "turn.progress", "tool", "approval"])("never replays a partially executed turn (%s)", async activity => {
    const { pool, accounts } = setup();
    engines.run.mockImplementation(async (_route, _context, _input, o) => {
      if (activity === "tool") await o.tools.call("save_schedule", {});
      else if (activity === "approval") await o.onRequest("item/commandExecution/requestApproval", {});
      else o.onEvent({ type: activity, payload: { item: { type: "commandExecution" } } });
      throw new Error("429 Too Many Requests");
    });
    const call = vi.fn().mockResolvedValue({});
    await expect(pool.run("Do it", { tools: { definitions: [], call }, onRequest: call })).rejects.toThrow();
    expect(engines.run).toHaveBeenCalledTimes(1);
    expect(accounts.active.get("default")).toBe(0);
  });
  it.each(["401 Unauthorized", "network unavailable", "500 Internal Server Error"])("does not spend a reserve on unrelated failures (%s)", async error => {
    const { pool } = setup();
    engines.run.mockRejectedValue(new Error(error));
    await expect(pool.run("Hi")).rejects.toThrow();
    expect(engines.run).toHaveBeenCalledTimes(1);
  });
  it("honours a fixed employee or conversation model and cancellation", async () => {
    const { store, pool } = setup(), e = store.createProfile({ name: "Fixed" });
    saveModelSelection(store, { provider: "chatgpt", model: "chat-model", serviceTier: "default" }, e.id);
    engines.run.mockRejectedValue(new Error("429 Too Many Requests"));
    await expect(pool.forAgent(e.id, "personal").run("Hi")).rejects.toThrow();
    expect(engines.run.mock.calls.every(c => c[0] !== "provider-xai")).toBe(true);
    engines.run.mockClear();
    const abort = new AbortController(); abort.abort();
    await expect(pool.run("Stop", { signal: abort.signal })).rejects.toThrow();
    expect(engines.run).not.toHaveBeenCalled();
  });
  it("keeps account-specific threads and completed history across fallback and recovery", async () => {
    const { store, accounts, second, pool } = setup(), chat = store.primaryConversation();
    const messages = new MessageService(store, pool);
    engines.run.mockImplementation(async route => ({ threadId: route + "-thread", response: route + " reply", events: [] }));
    await messages.handle({ channel: "api", text: "First", conversationId: chat.id });
    for (const id of ["default", second]) vi.mocked(accounts.get(id).usage).mockResolvedValue({ checkedAt: "now", ordinaryUsageAllowed: false, windows: [] });
    await messages.handle({ channel: "api", text: "Reserve", conversationId: chat.id });
    expect(engines.run.mock.calls[1]?.[2]).toContain("default reply");
    expect(engines.run.mock.calls[1]?.[3].threadId).toBeUndefined();
    vi.mocked(accounts.get("default").usage).mockResolvedValue({ checkedAt: "now", ordinaryUsageAllowed: true, windows: [] });
    await messages.handle({ channel: "api", text: "Back", conversationId: chat.id });
    expect(engines.run.mock.calls[2]?.[2]).toContain("provider-xai reply");
    expect(engines.run.mock.calls[2]?.[3].threadId).toBe("default-thread");
    await messages.close();
  });
});
