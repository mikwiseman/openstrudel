import { afterEach, expect, it, vi } from "vitest";
import { deleteEmployee } from "../src/employee-delete.js";
import { Store } from "../src/store.js";
import { TelegramAdapter, type TelegramUpdate } from "../src/telegram.js";
import { MessageService } from "../src/messages.js";
import { Scheduler } from "../src/scheduler.js";
import { employeeTools } from "../src/personality.js";

const stores: Store[] = [];
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); for (const s of stores.splice(0)) s.close(); });
function setup() {
  const store = new Store(":memory:"); stores.push(store);
  const run = vi.fn(async () => ({ threadId: "fixture", response: "Ready", events: [] }));
  const messages = new MessageService(store, { run });
  const adapter = new TelegramAdapter("123:test", store, messages);
  store.setSetting("telegram.bot_username", "strudel_bot");
  store.linkTelegramChat({ chatId: "42", title: "Owner", allowedSenders: ["42"] });
  const profile = store.createProfile({ name: "Editor" });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, result: { message_id: 999 } })));
  return { store, messages, adapter, profile, run };
}
const message = (id: number, text: string, chatId = -100, sender = 42, extra: Record<string, unknown> = {}): TelegramUpdate => ({ update_id: id, message: { message_id: id, text, chat: { id: chatId, type: chatId < 0 ? "group" : "private", title: "Test group" }, from: { id: sender }, ...extra } });

it("creates independent, one-use links scoped to a group and employee", async () => {
  const { store, adapter, profile } = setup();
  const other = store.createProfile({ name: "Researcher" });
  const a = adapter.createLink(profile.id, "group"), b = adapter.createLink(other.id, "group");
  expect(a.url).toBe(`https://t.me/strudel_bot?startgroup=${a.code}`);
  expect(a.code).not.toBe(b.code); expect(a.code.length).toBeLessThanOrEqual(64);
  await adapter.processUpdate(message(1, `/start@strudel_bot ${a.code}`));
  await adapter.processUpdate(message(2, `/start@strudel_bot ${b.code}`, -200));
  const first = store.getTelegramChat("-100")!, second = store.getTelegramChat("-200")!;
  expect(first).toMatchObject({ profileId: profile.id, access: "members", replies: "mentions" });
  expect(second.profileId).toBe(other.id); expect(second.conversationId).not.toBe(first.conversationId);
  expect(first.conversationId).not.toBe(store.profileConversation(profile.id).id);
  expect(adapter.linkStatus(a.code)).toEqual({ status: "connected" });
  await adapter.processUpdate(message(3, `/start@strudel_bot ${a.code}`, -300));
  expect(store.getTelegramChat("-300")).toBeNull();
});

it("does not accept a group link from strangers, another bot, a topic, or a private chat", async () => {
  const { store, adapter, profile } = setup(); const a = adapter.createLink(profile.id, "group");
  for (const update of [message(1, `/start@strudel_bot ${a.code}`, -100, 77), message(2, `/start@other_bot ${a.code}`), message(3, `/start@strudel_bot ${a.code}`, -100, 42, { is_topic_message: true, message_thread_id: 8 }), message(4, `/start ${a.code}`, 42)]) await adapter.processUpdate(update);
  expect(store.getTelegramChat("-100")).toBeNull(); expect(store.getTelegramChat("42")?.profileId).toBeNull();
  await adapter.processUpdate(message(5, `/start@strudel_bot ${a.code}`));
  expect(store.getTelegramChat("-100")?.profileId).toBe(profile.id);
});

it("rejects expired links and deleted employees without falling through to the model", async () => {
  const { store, adapter, profile, run } = setup(); const a = adapter.createLink(profile.id, "group");
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 11 * 60_000);
  await adapter.processUpdate(message(1, `/start@strudel_bot ${a.code}`));
  expect(store.getTelegramChat("-100")).toBeNull(); expect(run).not.toHaveBeenCalled();
  vi.useRealTimers(); const b = adapter.createLink(profile.id, "group"); deleteEmployee(store, profile.id);
  await adapter.processUpdate(message(2, `/start@strudel_bot ${b.code}`));
  expect(store.getTelegramChat("-100")).toBeNull(); expect(run).not.toHaveBeenCalled();
});

it("keeps owner pairing private and preserves established private recipients", async () => {
  const { store, adapter, profile } = setup(); store.bindTelegramChat("42", profile.id);
  const a = adapter.createLink(), b = adapter.createLink();
  await adapter.processUpdate(message(1, `/start ${a.code}`, -100));
  expect(store.getTelegramChat("-100")).toBeNull();
  await adapter.processUpdate(message(2, `/start ${a.code}`, 42));
  expect(store.getTelegramChat("42")?.profileId).toBe(profile.id);
  await adapter.processUpdate(message(3, `/start ${b.code}`, 77, 77));
  expect(store.getTelegramChat("77")).toMatchObject({ profileId: null, allowedSenders: ["77"] });
});

it("allows colleagues to address the employee but not change the binding", async () => {
  const { store, adapter, profile, run, messages } = setup(); const a = adapter.createLink(profile.id, "group");
  await adapter.processUpdate(message(1, `/start@strudel_bot ${a.code}`));
  vi.mocked(fetch).mockClear();
  await adapter.processUpdate(message(2, "Good morning", -100, 77));
  await adapter.processUpdate(message(3, "@strudel_bot_extra hello", -100, 77));
  await adapter.processUpdate(message(4, "/bind Editor", -100, 77));
  expect(run).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  await adapter.processUpdate(message(5, "@strudel_bot check this", -100, 77));
  await adapter.processUpdate(message(6, "And this?", -100, 77, { reply_to_message: { message_id: 9, from: { id: 123, is_bot: true, username: "strudel_bot" } } }));
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[0]?.[1]).toMatchObject({ telegramActor: { userId: "77", chatId: "-100" }, profile: expect.stringContaining("Editor") });
  expect(store.listMessages(store.profileConversation(profile.id).id)).toHaveLength(0);
  expect(messages.contextFor(store.getTelegramChat("-100")!.conversationId!)).toMatch(/^group-/);
});

it("preserves existing groups and requires explicit replacement in the app", async () => {
  const { store, adapter, profile } = setup(); const original = store.createProfile({ name: "Wolf" });
  store.linkTelegramChat({ chatId: "-100", title: "Core", allowedSenders: ["42", "77"] });
  const before = store.bindTelegramChat("-100", original.id);
  const a = adapter.createLink(profile.id, "group");
  await adapter.processUpdate(message(1, `/start@strudel_bot ${a.code}`));
  expect(store.getTelegramChat("-100")).toEqual(before);
  adapter.bindChat("-100", profile.id);
  expect(store.getTelegramChat("-100")).toMatchObject({ profileId: profile.id, allowedSenders: ["42", "77"], access: "approved", replies: "instructions" });
  expect(store.getConversation(before.conversationId!)).not.toBeNull();
});

it("blocks rebinding until the original answer is delivered", async () => {
  const { store, adapter, profile, run } = setup();
  store.linkTelegramChat({ chatId: "-100", title: "Core", allowedSenders: ["42"] }); store.bindTelegramChat("-100", profile.id);
  let finish!: () => void;
  run.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { threadId: "fixture", response: "Ready", events: [] }; });
  const turn = adapter.processUpdate(message(1, "Please continue"));
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(() => adapter.bindChat("-100", null)).toThrow("ещё отвечает");
  finish(); await turn; adapter.bindChat("-100", null);
  expect(store.getTelegramChat("-100")?.profileId).toBeNull();
});

it("does not grant a group's members delivery into another connected chat", async () => {
  const { store, profile, messages } = setup(); const scheduler = new Scheduler(store, messages);
  store.linkTelegramChat({ chatId: "-100", title: "Group", allowedSenders: ["42"] });
  const chat = store.bindTelegramChat("-100", profile.id);
  const tools = employeeTools(store, { run: vi.fn() }, messages.interactions, { profile, conversationId: chat.conversationId!, messageId: "one", channel: "telegram", scheduler, scope: messages.contextFor(chat.conversationId!) });
  await expect(tools.call("save_schedule", { name: "Leak", prompt: "share", cron: "0 12 * * *", timezone: "UTC", telegramChatId: "42" })).rejects.toThrow("эту же группу");
});

it("confirms selecting an already connected group without broadening its audience", async () => {
  const { store, adapter, profile } = setup();
  store.linkTelegramChat({ chatId: "-100", title: "Test group", allowedSenders: ["42"] });
  const before = store.bindTelegramChat("-100", profile.id);
  const link = adapter.createLink(profile.id, "group");
  await adapter.processUpdate(message(1, `/start@strudel_bot ${link.code}`));
  expect(adapter.linkStatus(link.code).status).toBe("connected");
  expect(store.getTelegramChat("-100")).toEqual(before);
});
it("does not interrupt one-step group setup with a second manual setup instruction", async () => {
  const { store, adapter, profile } = setup();
  const link = adapter.createLink(profile.id, "group");
  await adapter.processUpdate({ update_id: 1, my_chat_member: { chat: { id: -100, title: "Test group", type: "group" }, from: { id: 42 }, date: 100, old_chat_member: { status: "left" }, new_chat_member: { status: "member" } } });
  expect(fetch).not.toHaveBeenCalled();
  await adapter.processUpdate(message(2, `/start@strudel_bot ${link.code}`, -100, 42, { date: 100 }));
  expect(store.getTelegramChat("-100")?.profileId).toBe(profile.id);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("never gives a different bot the old update cursor or membership events", async () => {
  const { store, adapter, profile } = setup();
  store.setSetting("telegram.offset", "999999");
  store.setSetting("telegram.membership.-100", '{"date":99,"id":999999}');
  store.markTelegramUpdate(10);
  const chat = store.profileConversation(profile.id);
  store.addMessage({ conversationId: chat.id, channel: "api", direction: "inbound", text: "Keep history" });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json({ ok: true, result: url.endsWith("getMe") ? { id: 456, is_bot: true, first_name: "New", username: "new_bot" } : [] })));
  vi.spyOn(adapter, "start").mockResolvedValue();
  await expect(adapter.configure("456:new")).rejects.toThrow("Сначала отключите");
  adapter.disconnect(); await adapter.configure("456:new");
  expect(store.getSetting("telegram.offset")).toBeNull();
  expect(store.getSetting("telegram.membership.-100")).toBeNull();
  expect(store.wasTelegramUpdateProcessed(10)).toBe(false);
  expect(store.telegramChats()).toHaveLength(0);
  expect(store.listMessages(chat.id)[0]?.text).toBe("Keep history");
});
