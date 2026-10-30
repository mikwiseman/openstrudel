import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter, type TelegramUpdate } from "../src/telegram.js";
import { authorizationSetting, migrateScopedChat, saveTelegramAuthorization, telegramAuthorization, type TelegramAuthorization } from "../src/authorization.js";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const config = (): TelegramAuthorization => ({ version: 1, revision: 0,
  connectors: { school: { url: "https://school.example/mcp", headers: { Authorization: "Bearer synthetic" } } },
  policies: { school: { connectorId: "school", tools: [{ name: "schedule_read", capability: "read" }, { name: "schedule_move", capability: "move" }] } },
  subjects: { "22": { enabled: true, privatePolicyId: "school", capabilities: ["read", "move"] }, "44": { enabled: false, privatePolicyId: "school", capabilities: [] } },
  chats: { "-100": { enabled: true, policyId: "school", defaultCapabilities: ["read"], members: { "11": ["read", "move"], "22": ["read", "move"] } } },
});
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  store.linkTelegramChat({ chatId: "11", title: "Owner", allowedSenders: ["11"] });
  return store;
}
// Exact admission predicates from pre-policy Home 901615e6. Deliberately do not
// call the new adapter here: these must stay false when the policy is ignored.
function legacyAllowed(store: Store, chatId: string, sender?: number) {
  const actual = sender ?? (Number(chatId) > 0 ? Number(chatId) : undefined), chat = store.getTelegramChat(chatId);
  return actual !== undefined && actual > 0 && Boolean(chat && (chat.allowedSenders.includes(String(actual)) || Number(chatId) < 0 && chat.access === "members"));
}
const legacyOwner = (store: Store, sender: string) => store.getTelegramChat(sender)?.allowedSenders.includes(sender) === true;
function update(id: number, sender = 33, chatId = -100, text = "@strudel_bot расписание"): TelegramUpdate {
  return { update_id: id, message: { message_id: id, chat: { id: chatId, type: chatId < 0 ? "group" : "private", title: chatId < 0 ? "Family renamed" : undefined }, from: { id: sender }, text } };
}
function member(id: number, status = "member"): TelegramUpdate {
  return { update_id: id, my_chat_member: { chat: { id: -100, type: "group", title: "Family" }, from: { id: 11 }, date: 100 + id, old_chat_member: { status: "left" }, new_chat_member: { status } } };
}
function adapterFor(store: Store) {
  const ordinary = vi.fn(async () => ({ threadId: "ordinary", response: "ordinary", events: [] }));
  const scoped = vi.fn(async (_text: string, options: any) => { options.assertCurrent(); return { response: "scoped" }; });
  const messages = new MessageService(store, { run: ordinary }); messages.restrictedExecutor = { run: scoped, close: vi.fn() };
  store.setSetting("telegram.bot_username", "strudel_bot");
  const adapter = new TelegramAdapter("123:synthetic", store, messages);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, result: { message_id: 500 } })));
  return { adapter, messages, ordinary, scoped };
}

it("atomically closes old owner/member grants while preserving existing bindings and history", () => {
  const store = fixture();
  store.linkTelegramChat({ chatId: "22", title: "Mentor", allowedSenders: ["22"] });
  store.linkTelegramChat({ chatId: "-100", title: "Family", allowedSenders: ["11", "22"] });
  store.connectTelegramGroup("-100");
  const employee = store.createProfile({ name: "Wolf" });
  const original = store.bindTelegramChat("-100", employee.id);
  store.addMessage({ channel: "telegram", conversationId: original.conversationId!, direction: "inbound", text: "Keep existing history" });
  expect(legacyAllowed(store, "-100", 33)).toBe(true); expect(legacyOwner(store, "22")).toBe(true);
  saveTelegramAuthorization(store, config());
  // A protected group answers only mentions and replies to the bot, whatever mode it had before.
  expect(original.replies).toBe("instructions");
  expect(store.getTelegramChat("-100")).toMatchObject({ conversationId: original.conversationId, profileId: original.profileId, title: original.title, replies: "mentions", access: "approved", allowedSenders: [] });
  expect(store.listMessages(original.conversationId!)[0]?.text).toBe("Keep existing history");
  for (const sender of [11, 22, 33]) expect(legacyAllowed(store, "-100", sender)).toBe(false);
  for (const sender of ["22", "44"]) { expect(legacyOwner(store, sender)).toBe(false); expect(legacyAllowed(store, sender, Number(sender))).toBe(false); }
  expect(legacyOwner(store, "11")).toBe(true); expect(legacyAllowed(store, "11", 11)).toBe(true);
});

it("provisions a missing family once, with mention replies and the canonical restricted conversation", () => {
  const store = fixture();
  saveTelegramAuthorization(store, config());
  const family = store.getTelegramChat("-100")!;
  expect(family).toMatchObject({ title: "Telegram -100", allowedSenders: [], access: "approved", replies: "mentions", profileId: null, conversationId: expect.any(String) });
  expect(store.getConversation(family.conversationId!)?.externalId).toBe("-100::restricted");
  const before = store.telegramChats().length;
  saveTelegramAuthorization(store, telegramAuthorization(store));
  expect(store.telegramChats()).toHaveLength(before);
  expect(store.getTelegramChat("-100")!.conversationId).toBe(family.conversationId);
  expect(store.db.prepare("SELECT COUNT(*) n FROM conversations WHERE channel='telegram' AND external_id LIKE '-100%'").get()?.n).toBe(1);
});

it("rolls back both policy and provisioning if any registry operation fails", () => {
  const store = fixture();
  store.linkTelegramChat({ chatId: "22", title: "Previous owner", allowedSenders: ["22"] });
  vi.spyOn(store, "connectTelegramGroup").mockImplementation(() => { throw Error("Synthetic registry failure"); });
  expect(() => saveTelegramAuthorization(store, config())).toThrow("Synthetic registry failure");
  expect(store.getSetting(authorizationSetting)).toBeNull();
  expect(store.telegramChats().map(c => c.chatId)).toEqual(["11", "22"]);
  expect(legacyOwner(store, "22")).toBe(true);
});

it("leaves rows for enabled and disabled DMs so old linked_chats migration cannot restore ownership", () => {
  const store = fixture();
  store.setSetting("telegram.linked_chats", JSON.stringify(["11", "22", "44", "-100"]));
  saveTelegramAuthorization(store, config());
  const recreated: string[] = [];
  // Old Store/TelegramAdapter both create legacy ownership only for a missing
  // registry row. Use old raw SQL so the new Store guard cannot mask a bug.
  for (const id of JSON.parse(store.getSetting("telegram.linked_chats")!)) if (!store.getTelegramChat(id)) {
    recreated.push(id);
    store.db.prepare("INSERT INTO telegram_chats(chat_id,title,allowed_senders_json) VALUES(?,?,?)")
      .run(id, id, JSON.stringify(id.startsWith("-") ? [] : [id]));
  }
  expect(recreated).toEqual([]);
  expect(legacyOwner(store, "22")).toBe(false); expect(legacyOwner(store, "44")).toBe(false); expect(legacyOwner(store, "11")).toBe(true);
});

it("reopens the persisted policy and linked-chat registry without creating owners or duplicate conversations", () => {
  const directory = mkdtempSync(join(tmpdir(), "scoped-registry-reopen-")), path = join(directory, "home.db");
  let store = new Store(path);
  try {
    store.linkTelegramChat({ chatId: "11", title: "Owner", allowedSenders: ["11"] });
    store.setSetting("telegram.linked_chats", JSON.stringify(["11", "22", "44", "-100"]));
    saveTelegramAuthorization(store, config());
    const chat = store.getTelegramChat("-100")!, count = store.telegramChats().length;
    store.close(); store = new Store(path);
    expect(telegramAuthorization(store).revision).toBe(1);
    expect(store.telegramChats()).toHaveLength(count);
    expect(store.getTelegramChat("-100")!.conversationId).toBe(chat.conversationId);
    expect(legacyOwner(store, "11")).toBe(true);
    expect(legacyOwner(store, "22")).toBe(false); expect(legacyOwner(store, "44")).toBe(false);
    for (const sender of [11, 22, 33]) expect(legacyAllowed(store, "-100", sender)).toBe(false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it.each([true, false])("migration closes a prediscovered destination even when the old registry exists=%s", sourceExists => {
  const store = fixture();
  if (sourceExists) {
    store.linkTelegramChat({ chatId: "-100", title: "Old family", allowedSenders: ["11"] });
    store.connectTelegramGroup("-100");
  }
  // Model a pre-hardening policy with a legacy member grant, or a removed bot
  // whose source row is gone. The destination was independently discovered.
  store.setSetting(authorizationSetting, JSON.stringify({ ...config(), revision: 1 }));
  store.linkTelegramChat({ chatId: "-200", title: "Discovered target", allowedSenders: ["11"] });
  const target = store.connectTelegramGroup("-200");
  expect(legacyAllowed(store, "-200", 33)).toBe(true);
  expect(migrateScopedChat(store, "-100", "-200")).toBe(true);
  const policy = telegramAuthorization(store);
  expect(policy.chats["-100"]!.enabled).toBe(false); expect(policy.chats["-200"]!.enabled).toBe(false);
  for (const id of ["-100", "-200"]) for (const sender of [11, 22, 33]) expect(legacyAllowed(store, id, sender)).toBe(false);
  expect(store.getTelegramChat("-200")).toMatchObject({ access: "approved", allowedSenders: [] });
  if (!sourceExists) expect(store.getTelegramChat("-200")!.conversationId).toBe(target.conversationId);
});

it("rolls back policy and both registry entries together if migration fails after registry writes", () => {
  const store = fixture(); saveTelegramAuthorization(store, config());
  store.linkTelegramChat({ chatId: "-200", title: "Ordinary discovered target", allowedSenders: ["11"] }); store.connectTelegramGroup("-200");
  const previousPolicy = telegramAuthorization(store), previousChats = store.telegramChats();
  store.db.exec("CREATE TEMP TRIGGER fail_migration BEFORE UPDATE ON conversations BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END");
  expect(() => migrateScopedChat(store, "-100", "-200")).toThrow("synthetic migration failure");
  expect(telegramAuthorization(store)).toEqual(previousPolicy);
  expect(store.telegramChats()).toEqual(previousChats);
  expect(legacyAllowed(store, "-100", 11)).toBe(false);
  expect(legacyAllowed(store, "-200", 33)).toBe(true); // Its ordinary policy was never changed.
});

it("keeps the transport closed when rows are linked, bound, paused/resumed or discovered again", async () => {
  const store = fixture(); saveTelegramAuthorization(store, config());
  const { adapter, messages } = adapterFor(store);
  try {
    store.linkTelegramChat({ chatId: "22", title: "Mentor renamed", allowedSenders: ["22"] });
    store.linkTelegramChat({ chatId: "-100", title: "Family", allowedSenders: ["11", "22"] });
    const profile = store.createProfile({ name: "Wolf" });
    adapter.bindChat("-100", null); adapter.bindChat("-100", profile.id);
    adapter.setGroupEnabled("-100", false); adapter.setGroupEnabled("-100", true);
    await adapter.processUpdate(member(1));
    expect(store.getTelegramChat("-100")).toMatchObject({ access: "approved", allowedSenders: [], replies: "mentions" });
    expect(store.getTelegramChat("22")?.allowedSenders).toEqual([]);
    expect(legacyAllowed(store, "-100", 11)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  } finally { adapter.stop(); await messages.close(); }
});

it("a stale removed-group snapshot cannot reintroduce its legacy grants", async () => {
  const store = fixture();
  store.linkTelegramChat({ chatId: "-100", title: "Old family", allowedSenders: ["11", "22"] });
  const previous = store.connectTelegramGroup("-100");
  store.setSetting("telegram.removed.-100", JSON.stringify(previous));
  saveTelegramAuthorization(store, config());
  store.db.prepare("DELETE FROM telegram_chats WHERE chat_id='-100'").run();
  const { adapter, messages } = adapterFor(store);
  try {
    await adapter.processUpdate(member(1));
    expect(store.getTelegramChat("-100")).toMatchObject({ conversationId: previous.conversationId, access: "approved", allowedSenders: [] });
    expect(fetch).not.toHaveBeenCalled();
  } finally { adapter.stop(); await messages.close(); }
});

it("an owner may reconnect the protected group without creating legacy grants", async () => {
  const store = fixture(); saveTelegramAuthorization(store, config());
  const { adapter, messages } = adapterFor(store);
  try {
    const link = adapter.createLink(undefined, "group");
    await adapter.processUpdate(update(1, 11, -100, `/start ${link.code}`));
    expect(store.getTelegramChat("-100")).toMatchObject({ access: "approved", allowedSenders: [], replies: "mentions" });
    expect(legacyAllowed(store, "-100", 11)).toBe(false);
    expect(store.telegramChats().filter(c => c.chatId === "-100")).toHaveLength(1);
  } finally { adapter.stop(); await messages.close(); }
});

it("admits actual parent/mentor/owner group messages through policy while the old predicate denies them", async () => {
  const store = fixture(); saveTelegramAuthorization(store, config());
  const { adapter, messages, ordinary, scoped } = adapterFor(store);
  try {
    await adapter.processUpdate(update(1, 33, -100, "Без обращения"));
    expect(scoped).not.toHaveBeenCalled();
    for (const [index, sender] of [33, 22, 11].entries()) {
      expect(legacyAllowed(store, "-100", sender)).toBe(false);
      await adapter.processUpdate(update(index + 2, sender));
    }
    expect(scoped).toHaveBeenCalledTimes(3); expect(ordinary).not.toHaveBeenCalled();
    expect(scoped.mock.calls.map(([, o]) => o.authorization.actor.userId)).toEqual(["33", "22", "11"]);
    expect(scoped.mock.calls[0]![1].authorization.tools.map((t: any) => t.name)).toEqual(["schedule_read"]);
    expect(scoped.mock.calls[1]![1].authorization.tools.map((t: any) => t.name)).toEqual(["schedule_read", "schedule_move"]);
    expect(store.getTelegramChat("-100")!.title).toBe("Family renamed");
    expect(store.getConversation(store.getTelegramChat("-100")!.conversationId!)!.title).toBe("Family renamed");
    expect(store.db.prepare("SELECT COUNT(*) n FROM conversations WHERE channel='telegram' AND external_id LIKE '-100%'").get()?.n).toBe(1);
    await adapter.processUpdate(update(5, 22, 22, "Мои ученики"));
    expect(scoped).toHaveBeenCalledTimes(4); expect(legacyOwner(store, "22")).toBe(false);
  } finally { adapter.stop(); await messages.close(); }
});

it("rejects missing, anonymous and bot senders, disabled subjects and disabled or paused groups", async () => {
  const store = fixture(); saveTelegramAuthorization(store, config());
  const { adapter, messages, ordinary, scoped } = adapterFor(store);
  try {
    const absent = update(1); delete absent.message!.from;
    const bot = update(2); bot.message!.from!.is_bot = true;
    const anonymous = update(3); anonymous.message!.sender_chat = { id: -100 };
    for (const item of [absent, bot, anonymous, update(4, 44), update(5, 44, 44)]) await adapter.processUpdate(item);
    const noPrivateSender = update(6, 22, 22); delete noPrivateSender.message!.from;
    await adapter.processUpdate(noPrivateSender);
    adapter.setGroupEnabled("-100", false); await adapter.processUpdate(update(7));
    adapter.setGroupEnabled("-100", true);
    const disabled = telegramAuthorization(store); disabled.chats["-100"]!.enabled = false; saveTelegramAuthorization(store, disabled);
    await adapter.processUpdate(update(8, 11));
    expect(scoped).not.toHaveBeenCalled(); expect(ordinary).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally { adapter.stop(); await messages.close(); }
});

it("preserves ordinary owner pairing and member-group behavior outside configured audiences", async () => {
  const store = fixture();
  store.linkTelegramChat({ chatId: "-200", title: "Ordinary team", allowedSenders: ["11"] }); store.connectTelegramGroup("-200");
  saveTelegramAuthorization(store, config());
  const { adapter, messages, ordinary, scoped } = adapterFor(store);
  try {
    await adapter.processUpdate(update(1, 11, 11, "Личный запрос владельца"));
    await adapter.processUpdate(update(2, 33, -200, "Запрос обычного участника"));
    expect(ordinary).toHaveBeenCalledTimes(2); expect(scoped).not.toHaveBeenCalled();
    expect(legacyOwner(store, "11")).toBe(true); expect(legacyAllowed(store, "-200", 33)).toBe(true);
    expect(store.getTelegramChat("-200")).toMatchObject({ access: "members", allowedSenders: ["11"] });
  } finally { adapter.stop(); await messages.close(); }
});
