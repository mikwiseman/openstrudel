import { afterEach, expect, it, vi } from "vitest";
import { deleteEmployee } from "../src/employee-delete.js";
import { Store } from "../src/store.js";
import { TelegramAdapter, type TelegramUpdate } from "../src/telegram.js";
import { MessageService } from "../src/messages.js";
import { Scheduler } from "../src/scheduler.js";
import { employeeTools } from "../src/personality.js";
import { INSTRUCTIONS } from "../src/codex.js";

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

it("leaves commands and replies addressed to another bot alone even in an instruction-driven group", async () => {
  const { store, adapter, profile, run } = setup();
  store.linkTelegramChat({ chatId: "-100", title: "Recipes", allowedSenders: ["42"] });
  store.bindTelegramChat("-100", profile.id);
  const otherBotReply = { reply_to_message: { message_id: 80, from: { id: 999, is_bot: true, username: "recipes_bridge_bot" } } };
  await adapter.processUpdate(message(1, "/ask@recipes_bridge_bot Dinner for two"));
  await adapter.processUpdate(message(2, "Double it", -100, 42, otherBotReply));
  expect(run).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  await adapter.processUpdate(message(3, "/ask@STRUDEL_BOT Dinner for two"));
  await adapter.processUpdate(message(4, "@strudel_bot check this recipe", -100, 42, otherBotReply));
  expect(run).toHaveBeenCalledTimes(2);
});

it("creates independent, one-use links scoped to a group and employee", async () => {
  const { store, adapter, profile } = setup();
  const other = store.createProfile({ name: "Researcher" });
  const a = adapter.createLink(profile.id, "group"), b = adapter.createLink(other.id, "group");
  expect(a.url).toBe(`https://t.me/strudel_bot?startgroup=${a.code}`);
  expect(a.code).not.toBe(b.code); expect(a.code.length).toBeLessThanOrEqual(64);
  await adapter.processUpdate(message(1, `/start@strudel_bot ${a.code}`));
  await adapter.processUpdate(message(2, `/start@strudel_bot ${b.code}`, -200));
  const first = store.getTelegramChat("-100")!, second = store.getTelegramChat("-200")!;
  expect(first).toMatchObject({ profileId: profile.id, access: "approved", replies: "instructions" });
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
  adapter.setGroupReplyAccess("-100","approved",["42","77"]);
  store.db.prepare("UPDATE telegram_chats SET replies='mentions' WHERE chat_id='-100'").run();
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

it("marks only the paired owner's private chat as the owner's turn", async () => {
  const { store, adapter, profile, run } = setup(); const a = adapter.createLink(profile.id, "group");
  store.createProfile({ name: "Researcher" });
  await adapter.processUpdate(message(1, `/start@strudel_bot ${a.code}`));
  adapter.setGroupReplyAccess("-100","approved",["42","77"]);
  await adapter.processUpdate(message(2, "Hello", 42));
  await adapter.processUpdate(message(3, "@strudel_bot hello", -100, 42));
  await adapter.processUpdate(message(4, "@strudel_bot hello", -100, 77));
  const options = () => run.mock.calls.map(call => (call as any[])[1]);
  expect(options().map(o => o.byOwner)).toEqual([true, false, false]);
  // The owner and people on this Home's access list get its services and helpers; anyone else in a group does not.
  expect(options().map(o => o.access)).toEqual([true, true, false]);
  expect(options()[2]).toMatchObject({ employees: [], profile: expect.stringContaining("not on this Strudel's access list") });
  for (const o of options().slice(0, 2)) { expect(o.employees.length).toBeGreaterThan(0); expect(o.profile).not.toContain("access list"); }
  store.setSetting("access.people", JSON.stringify(["77"]));
  await adapter.processUpdate(message(5, "@strudel_bot again", -100, 77));
  expect(options()[3]).toMatchObject({ access: true, byOwner: false, employees: [expect.objectContaining({ name: "Researcher" })] });
  expect(options()[3].profile).not.toContain("access list");
});

it("preserves existing groups and requires explicit replacement in the app", async () => {
  const { store, adapter, profile } = setup(); const original = store.createProfile({ name: "Wolf" });
  store.linkTelegramChat({ chatId: "-100", title: "Test group", allowedSenders: ["42", "77"] });
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
  // The same refusal reaches a private chat, so it does not say «группа».
  expect(() => adapter.bindChat("-100", null)).toThrow("В этом чате ещё идёт ответ. Дождитесь его и повторите.");
  finish(); await turn; adapter.bindChat("-100", null);
  expect(store.getTelegramChat("-100")?.profileId).toBeNull();
});

it("does not grant a group's members delivery into another connected chat", async () => {
  const { store, profile, messages } = setup(); const scheduler = new Scheduler(store, messages);
  store.linkTelegramChat({ chatId: "-100", title: "Group", allowedSenders: ["42"] });
  const chat = store.bindTelegramChat("-100", profile.id);
  const tools = employeeTools(store, { run: vi.fn() }, messages.interactions, { profile, conversationId: chat.conversationId!, messageId: "one", channel: "telegram", scheduler, scope: messages.contextFor(chat.conversationId!) });
  await expect(tools.call("save_schedule", { name: "Leak", prompt: "share", cron: "0 12 * * *", timezone: "UTC", telegramChatId: "42" })).rejects.toThrow("администратор");
});

it("lets the owner see, change and stop any schedule on the Home from any chat, and nobody else", async () => {
  const { store, profile, messages, adapter, run } = setup(); const scheduler = new Scheduler(store, messages); messages.scheduler = scheduler;
  store.linkTelegramChat({ chatId: "-100", title: "Wai Core Team", allowedSenders: ["42", "77"] });
  const group = store.bindTelegramChat("-100", profile.id);
  const scout = store.createProfile({ name: "Офисный разведчик" }), offices = store.profileConversation(scout.id).id;
  const office = scheduler.save({ conversationId: offices, name: "Рассылка офисов", prompt: "Найди офисы", cron: "0 9 * * *", timezone: "Europe/Moscow" });
  const tools = (extra: Record<string, unknown>) => employeeTools(store, { run: vi.fn() }, messages.interactions, { profile, conversationId: group.conversationId!, messageId: "m", channel: "telegram", scheduler, scope: messages.contextFor(group.conversationId!), ...extra });
  const edit = { id: office.id, name: "Рассылка офисов", prompt: "Найди офисы", cron: "0 10 * * *", timezone: "", telegramChatId: null };
  for (const other of [tools({ telegramSenderId: "77" }), tools({ telegramSenderId: "42", scheduled: true }), tools({ channel: "api" })]) {
    await expect(other.call("list_schedules", { scope: "home" })).rejects.toThrow("Все расписания Strudel видит владелец или администратор Home.");
    await expect(other.call("pause_schedule", { id: office.id })).rejects.toThrow();
    await expect(other.call("save_schedule", edit)).rejects.toThrow();
  }
  expect(scheduler.list(offices)).toMatchObject([{ cron: "0 9 * * *", enabled: true }]);
  // The verified owner in the group, as the Telegram adapter delivers him.
  run.mockImplementationOnce(async (_input: string, options: any) => {
    const owner = options.tools;
    expect((await owner.call("list_schedules", {})).schedules).toEqual([]);
    expect((await owner.call("list_schedules", { scope: "home" })).schedules).toEqual([expect.objectContaining({ id: office.id, name: "Рассылка офисов", chat: "Офисный разведчик", employee: "Офисный разведчик", nextRunLocal: expect.any(String) })]);
    expect(await owner.call("save_schedule", { ...edit, telegramChatId: "42" })).toMatchObject({ conversationId: offices, cron: "0 10 * * *", timezone: "Europe/Moscow", telegramChatId: "42" });
    expect(await owner.call("pause_schedule", { id: office.id })).toEqual({ paused: true });
    return { threadId: "fixture", response: "Остановил", events: [] };
  });
  await adapter.processUpdate(message(1, "@strudel_bot останови, пожалуйста, рассылку офисов"));
  expect(run).toHaveBeenCalledOnce();
  expect(scheduler.list(offices)).toMatchObject([{ cron: "0 10 * * *", enabled: false }]);
  expect(scheduler.list(group.conversationId!)).toEqual([]);
  // In the app the owner has the same view.
  expect((await tools({ channel: "api", byOwner: true }).call("list_schedules", { scope: "home" }) as any).schedules).toHaveLength(1);
  // A Codex thread keeps the tool descriptions it started with; the instructions reach it on resume.
  expect(INSTRUCTIONS).toContain('list_schedules with scope "home"');
});

it("requires service access and verified management to set up or pause schedules in a group", async () => {
  const { store, profile, messages } = setup(); const scheduler = new Scheduler(store, messages);
  store.linkTelegramChat({ chatId: "-100", title: "Group", allowedSenders: ["42"] });
  const chat = store.bindTelegramChat("-100", profile.id);
  const tools = (access?: boolean) => employeeTools(store, { run: vi.fn() }, messages.interactions, { profile, conversationId: chat.conversationId!, messageId: "one", channel: "telegram", telegramSenderId: "42", scheduler, scope: messages.contextFor(chat.conversationId!), access });
  const brief = { id: null, name: "Brief", prompt: "brief", cron: "0 7 * * *", timezone: "UTC", telegramChatId: null };
  await expect(tools(false).call("save_schedule", brief)).rejects.toThrow("Расписания в этом чате настраивают люди с доступом к этому Strudel.");
  await expect(tools(false).call("pause_schedule", { id: "any" })).rejects.toThrow("Расписания в этом чате настраивают люди с доступом к этому Strudel.");
  expect(scheduler.list(chat.conversationId!)).toEqual([]);
  const saved = await tools(true).call("save_schedule", brief) as any;
  await tools(undefined).call("save_schedule", { ...brief, name: "Notes" });
  await expect(tools(false).call("pause_schedule", { id: saved.id })).rejects.toThrow("Расписания в этом чате");
  expect(scheduler.list(chat.conversationId!).map(s => [s.name, s.enabled])).toEqual([["Brief", true], ["Notes", true]]);
});

it("brings a schedule asked for in Telegram back to that chat, and keeps an app request in the app", async () => {
  const { store, messages, profile } = setup();
  const scheduler = new Scheduler(store, messages);
  store.linkTelegramChat({ chatId: "-100", title: "Group", allowedSenders: ["42"] });
  const chat = store.bindTelegramChat("-100", profile.id);
  const asked = (channel: string) => employeeTools(store, { run: vi.fn() }, messages.interactions, { profile, conversationId: chat.conversationId!, messageId: "one", channel, telegramSenderId: "42", scheduler, scope: messages.contextFor(chat.conversationId!) });
  const fromTelegram = await asked("telegram").call("save_schedule", { name: "Brief", prompt: "brief", cron: "0 7 * * *", timezone: "Europe/Moscow", telegramChatId: null }) as any;
  expect(fromTelegram).toMatchObject({ delivery: "bound", telegramChatId: null });
  const fromApp = await asked("api").call("save_schedule", { name: "Notes", prompt: "notes", cron: "0 8 * * *", timezone: "Europe/Moscow", telegramChatId: null }) as any;
  expect(fromApp).toMatchObject({ delivery: "app" });
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

it("answers a pairing /start that Telegram delivers twice only once", async () => {
  const { store, adapter } = setup(); const link = adapter.createLink();
  const start = (id: number) => message(id, `/start ${link.code}`, 77, 77, { message_id: 1950 });
  const sent = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/sendMessage")).map(([, init]) => JSON.parse(String(init!.body))).map(({ chat_id, text }) => ({ chat_id, text }));
  await Promise.all([adapter.processUpdate(start(565291610)), adapter.processUpdate(start(565291611))]);
  expect(store.getTelegramChat("77")).toMatchObject({ allowedSenders: ["77"] });
  expect(sent()).toEqual([{ chat_id: "77", text: "Telegram подключён. Здесь отвечает «Общий помощник»." }]);
  // Only the chat that redeemed the link is spared the refusal.
  vi.mocked(fetch).mockClear();
  await adapter.processUpdate(message(565291612, `/start ${link.code}`, 88, 88));
  expect(store.getTelegramChat("88")).toBeNull();
  expect(sent()).toEqual([{ chat_id: "88", text: "Ссылка уже использована или устарела. Откройте новую в OpenStrudel." }]);
});

it("does not re-answer a redeemed pairing when its uncertain update is replayed", async () => {
  const { store, adapter, messages } = setup(); const link = adapter.createLink();
  vi.mocked(fetch).mockRejectedValueOnce(new Error("socket hang up"));
  await expect(adapter.processUpdate(message(7, `/start ${link.code}`, 77, 77))).rejects.toThrow();
  vi.mocked(fetch).mockClear();
  await new TelegramAdapter("123:test", store, messages).processUpdate(message(7, `/start ${link.code}`, 77, 77));
  expect(store.wasTelegramUpdateProcessed(7)).toBe(true); expect(fetch).not.toHaveBeenCalled();
});
