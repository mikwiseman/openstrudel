import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter } from "../src/telegram.js";
import { employeeTools } from "../src/personality.js";
import { hasAccess, ownerSender } from "../src/telegram-tools.js";
import { authorizationSetting, assertScopedAuthorization, authorizationSummary, migrateScopedChat, resolveScopedAuthorization, saveTelegramAuthorization, telegramAuthorization, type TelegramAuthorization } from "../src/authorization.js";
import type { MessageInput } from "../src/types.js";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.unstubAllGlobals(); });
const config = (): TelegramAuthorization => ({ version: 1, revision: 0,
  connectors: { school: { url: "https://school.example/mcp", headers: { Authorization: "Bearer test-secret" } } },
  policies: {
    mentor: { connectorId: "school", tools: [{ name: "schedule_read", capability: "schedule.read" }, { name: "draft_read", capability: "draft.read" }] },
    family: { connectorId: "school", tools: [{ name: "family_schedule", capability: "schedule.read" }, { name: "family_move", capability: "schedule.move" }] },
  },
  subjects: { "22": { enabled: true, privatePolicyId: "mentor", capabilities: ["schedule.read", "schedule.move", "draft.read"] } },
  chats: { "-100": { enabled: true, policyId: "family", defaultCapabilities: ["schedule.read"], members: { "11": ["schedule.read", "schedule.move"], "22": ["schedule.read", "schedule.move"] } } },
});
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  store.linkTelegramChat({ chatId: "11", title: "Owner", allowedSenders: ["11"] });
  store.linkTelegramChat({ chatId: "22", title: "Mentor", allowedSenders: [] });
  store.linkTelegramChat({ chatId: "-100", title: "Family", allowedSenders: ["11", "22"] });
  const family = store.connectTelegramGroup("-100");
  saveTelegramAuthorization(store, config());
  return { store, family };
}
const input = (sender = "22", chat = "22", id = 1): MessageInput => ({ channel: "telegram", text: "Покажи расписание", telegramSenderId: sender, externalChatId: chat, externalId: `${chat}:${id}` });

it("intersects global subject and family permissions; owner has no draft tools in the family", () => {
  const { store } = fixture();
  expect(resolveScopedAuthorization(store, input())!.tools.map(t => t.name)).toEqual(["schedule_read", "draft_read"]);
  for (const sender of ["11", "22"]) expect(resolveScopedAuthorization(store, input(sender, "-100"))!.tools.map(t => t.name)).toEqual(["family_schedule", "family_move"]);
  expect(resolveScopedAuthorization(store, input("33", "-100"))!.tools.map(t => t.name)).toEqual(["family_schedule"]);
  expect(resolveScopedAuthorization(store, input("11", "11"))).toBeNull();
  const next = telegramAuthorization(store); next.subjects["22"]!.capabilities = ["schedule.read"];
  saveTelegramAuthorization(store, next);
  expect(resolveScopedAuthorization(store, input("22", "-100"))!.tools.map(t => t.name)).toEqual(["family_schedule"]);
});

it("rejects forged, absent and alternate-channel identities and unconfigured groups", () => {
  const { store, family } = fixture();
  for (const change of [
    { telegramSenderId: undefined }, { externalId: "-200:1" }, { channel: "api" as const }, { scheduled: true },
    { telegramSenderId: "33" }, { externalChatId: "-200", externalId: "-200:1" },
  ]) expect(() => resolveScopedAuthorization(store, { ...input(), ...change })).toThrow();
  expect(() => resolveScopedAuthorization(store, { channel: "api", text: "leak", conversationId: family.conversationId!, externalChatId: "home" })).toThrow();
  expect(() => resolveScopedAuthorization(store, { channel: "api", text: "leak", scheduled: true, scheduleTelegramChatId: "-100" })).toThrow();
});

it("revocation is immediate, malformed policy fails closed and deletion cannot restore legacy access", () => {
  const { store } = fixture(); const original = resolveScopedAuthorization(store, input())!;
  const next = telegramAuthorization(store); next.subjects["22"]!.enabled = false; saveTelegramAuthorization(store, next);
  expect(() => assertScopedAuthorization(store, input(), original)).toThrow();
  const removed = telegramAuthorization(store); delete removed.subjects["22"];
  expect(() => saveTelegramAuthorization(store, removed)).toThrow("enabled:false");
  store.setSetting(authorizationSetting, "not json");
  expect(() => resolveScopedAuthorization(store, input("11", "11"))).toThrow();
});

it("does not treat limited people as owners even if legacy access lists contain them", () => {
  const { store } = fixture();
  store.linkTelegramChat({ chatId: "22", title: "Mentor", allowedSenders: ["22"] });
  store.setSetting("access.people", JSON.stringify(["22"]));
  expect(hasAccess(store, "22")).toBe(false);
  expect(ownerSender(store, { channel: "telegram", conversationId: "x", messageId: "x", telegramSenderId: "22" })).toBe(false);
  expect(hasAccess(store, "11")).toBe(true);
  expect(JSON.stringify(authorizationSummary(telegramAuthorization(store)))).not.toContain("test-secret");
});

it("blocks all ordinary native handlers even for the owner in the family", async () => {
  const { store, family } = fixture();
  const messages = new MessageService(store, { run: vi.fn() });
  const tools = employeeTools(store, { run: vi.fn() }, messages.interactions, { profile: null, conversationId: family.conversationId!, messageId: "m", channel: "telegram", byOwner: true, telegramSenderId: "11" });
  await expect(tools.call("list_employees", {})).rejects.toThrow("недоступно");
  await messages.close();
});

it("starts a separate conversation without old history or the ordinary engine and persists verified sender", async () => {
  const { store, family } = fixture();
  store.addMessage({ conversationId: family.conversationId!, channel: "telegram", direction: "outbound", text: "old private financial information" });
  const legacy = vi.fn(); const run = vi.fn(async (_: string, options: any) => { options.assertCurrent(); return { response: "safe schedule" }; });
  const messages = new MessageService(store, { run: legacy }); messages.restrictedExecutor = { run, close: vi.fn() };
  const result = await messages.handle({ ...input("11", "-100"), conversationId: family.conversationId! });
  expect(result.conversationId).not.toBe(family.conversationId);
  expect(legacy).not.toHaveBeenCalled();
  expect(run.mock.calls[0]![0]).toBe("Покажи расписание");
  expect(store.getConversation(result.conversationId)?.codexThreadId).toBeNull();
  expect(store.db.prepare("SELECT user_id FROM message_authorizations").get()?.user_id).toBe("11");
  messages.assertDelivery(input("11", "-100"), result.messageId);
  const next = telegramAuthorization(store); next.chats["-100"]!.enabled = false; saveTelegramAuthorization(store, next);
  expect(() => messages.assertDelivery(input("11", "-100"), result.messageId)).toThrow();
  await messages.close();
});

it("rechecks queued work and never redelivers a previous draft", async () => {
  const { store } = fixture(); let release!: () => void;
  const blocker = new Promise<void>(r => { release = r; });
  const run = vi.fn(async (_: string, options: any) => { await blocker; options.assertCurrent(); return { response: "draft" }; });
  const messages = new MessageService(store, { run: vi.fn() }); messages.restrictedExecutor = { run, close: vi.fn() };
  const first = await messages.submit(input()); const second = await messages.submit(input("22", "22", 2));
  const a = expect(first.completion).rejects.toThrow(); const b = expect(second.completion).rejects.toThrow();
  const next = telegramAuthorization(store); next.subjects["22"]!.enabled = false; saveTelegramAuthorization(store, next); release();
  await Promise.all([a, b]); expect(run).toHaveBeenCalledTimes(1);
  expect(store.db.prepare("SELECT count(*) n FROM messages WHERE direction='outbound'").get()?.n).toBe(0);
  await messages.close();
});

it("does not allow completed-result replay even if the transport reuses its message id", async () => {
  const { store } = fixture(); const messages = new MessageService(store, { run: vi.fn() });
  messages.restrictedExecutor = { run: vi.fn(async () => ({ response: "draft" })), close: vi.fn() };
  await messages.handle(input());
  await expect(messages.handle(input())).rejects.toThrow("уже обработано");
  await messages.close();
});

it("a migrated family remains protected and disabled pending a new business binding", () => {
  const { store } = fixture(); expect(migrateScopedChat(store, "-100", "-200")).toBe(true);
  expect(telegramAuthorization(store).chats["-200"]!.enabled).toBe(false);
  expect(() => resolveScopedAuthorization(store, input("11", "-200"))).toThrow();
});

it("restricted private Telegram works without owner pairing and cannot redeem an owner link", async () => {
  const { store } = fixture(); const messages = new MessageService(store, { run: vi.fn() });
  const run = vi.fn(async () => ({ response: "school response" })); messages.restrictedExecutor = { run, close: vi.fn() };
  const adapter = new TelegramAdapter("123:test", store, messages);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, result: { message_id: 50 } })));
  await adapter.processUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 22, type: "private" }, from: { id: 22 }, text: "Покажи расписание" } });
  expect(run).toHaveBeenCalledOnce(); expect(hasAccess(store, "22")).toBe(false);
  const link = adapter.createLink(undefined, "private");
  await adapter.processUpdate({ update_id: 2, message: { message_id: 2, chat: { id: 22, type: "private" }, from: { id: 22 }, text: `/start ${link.code}` } });
  expect(store.getTelegramChat("22")?.allowedSenders).toEqual([]);
  adapter.stop(); await messages.close();
});

it("only an authenticated owner can manage grants; public message bodies cannot impersonate Telegram", async () => {
  const { OpenStrudelRuntime } = await import("../src/runtime.js");
  const run = vi.fn(async () => ({ threadId: "owner", response: "ordinary", events: [] }));
  const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", startTelegram: false, apiToken: "owner", engine: { run } });
  const address = await runtime.api.listen("127.0.0.1", 0);
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = { authorization: "Bearer owner" }) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const login = await call("/auth/session", "POST", { key: runtime.api.web.invite(false).key }, {});
    const { csrf } = await login.json();
    const colleague = { cookie: login.headers.get("set-cookie")!.split(";")[0]!, "x-openstrudel-csrf": csrf };
    expect((await call("/v1/settings/telegram-authorization", "GET", undefined, colleague)).status).toBe(403);
    expect((await call("/v1/settings/telegram-authorization", "PUT", config(), colleague)).status).toBe(403);
    const created = await call("/v1/settings/telegram-authorization", "PUT", config());
    expect(created.status).toBe(200); expect(JSON.stringify(await created.json())).not.toContain("test-secret");
    expect(runtime.store.getTelegramChat("22")?.allowedSenders).toEqual([]);
    const provisionedFamily = runtime.store.getTelegramChat("-100")!;
    expect(provisionedFamily).toMatchObject({ access: "approved", allowedSenders: [], replies: "mentions", conversationId: expect.any(String) });
    expect(runtime.store.getConversation(provisionedFamily.conversationId!)?.externalId).toBe("-100::restricted");
    const forged = await call("/v1/messages", "POST", { ...input(), telegramSenderId: "22", byOwner: true });
    expect(forged.status).toBe(403); expect(run).not.toHaveBeenCalled();
    const summary = await (await call("/v1/settings/telegram-authorization")).json();
    expect((await call("/v1/settings/telegram-authorization", "PUT", summary)).status).toBe(200);
    expect(runtime.store.getTelegramChat("-100")!.conversationId).toBe(provisionedFamily.conversationId);
    expect(telegramAuthorization(runtime.store).connectors.school!.headers.Authorization).toBe("Bearer test-secret");
    expect((await call("/v1/settings/telegram-authorization", "PUT", summary)).status).toBe(409);
  } finally { await runtime.stop(); }
});
