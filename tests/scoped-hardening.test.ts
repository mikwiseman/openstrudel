import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter, type TelegramUpdate } from "../src/telegram.js";
import { telegramTools } from "../src/telegram-tools.js";
import { receiveNotification } from "../src/notification-hook.js";
import { onlyDisablesScopedAccess, preserveConnectorHeaders, saveTelegramAuthorization, telegramAuthorization, type TelegramAuthorization } from "../src/authorization.js";
import type { MessageInput } from "../src/types.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.unstubAllGlobals(); });

const config = (): TelegramAuthorization => ({ version: 1, revision: 0,
  connectors: { school: { url: "https://school.example/mcp", headers: { Authorization: "Bearer test-secret" } } },
  policies: {
    family: { connectorId: "school", tools: [{ name: "family_schedule", capability: "schedule.read" }, { name: "family_report", capability: "report.read" }] },
    mentor: { connectorId: "school", tools: [{ name: "schedule_read", capability: "schedule.read" }] },
  },
  subjects: { "22": { enabled: true, privatePolicyId: "mentor", capabilities: ["schedule.read"] } },
  chats: { "-100": { enabled: true, policyId: "family", defaultCapabilities: ["schedule.read"], members: {} } },
});

/** Owner 11, limited mentor 22, a protected family -100 that started as an ordinary
 * instructions-mode group, and an ordinary team group -300. */
function fixture() {
  const store = new Store(":memory:");
  store.setSetting("telegram.bot_username", "strudel_bot");
  store.linkTelegramChat({ chatId: "11", title: "Owner", allowedSenders: ["11"] });
  store.linkTelegramChat({ chatId: "-100", title: "Family", allowedSenders: ["11"] });
  store.connectTelegramGroup("-100");
  store.linkTelegramChat({ chatId: "-300", title: "Team", allowedSenders: ["11"] });
  store.connectTelegramGroup("-300");
  saveTelegramAuthorization(store, config());
  let release!: () => void;
  const gate = { blocked: false, released: new Promise<void>(resolve => { release = resolve; }) };
  const scoped = vi.fn(async (_text: string, options: any) => {
    if (gate.blocked) await gate.released;
    options.assertCurrent();
    return { response: "scoped answer" };
  });
  const ordinary = vi.fn(async () => ({ threadId: "ordinary", response: "ordinary answer", events: [] }));
  const messages = new MessageService(store, { run: ordinary });
  messages.restrictedExecutor = { run: scoped, close: vi.fn() };
  const adapter = new TelegramAdapter("123:synthetic", store, messages);
  messages.telegram = adapter;
  const fetched: Array<{ url: string; body: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    fetched.push({ url: String(url), body });
    if (String(url).includes("/file/")) return new Response("synthetic audio");
    return Response.json({ ok: true, result: String(url).endsWith("/getFile") ? { file_path: "voice.ogg", file_size: 100 } : { message_id: 900 + fetched.length } });
  }));
  cleanups.push(async () => { release(); adapter.stop(); await messages.close(); store.close(); });
  const sentTo = (chatId: string) => fetched.filter(call => call.url.endsWith("/sendMessage") && String(call.body?.chat_id) === chatId).map(call => String(call.body.text));
  const downloads = () => fetched.filter(call => call.url.endsWith("/getFile") || call.url.includes("/file/"));
  return { store, messages, adapter, scoped, ordinary, fetched, sentTo, downloads, gate, release: () => release() };
}

const message = (id: number, text: string, extra: Record<string, unknown> = {}, from = 33, chatId = -100): TelegramUpdate =>
  ({ update_id: id, message: { message_id: id, chat: { id: chatId, type: chatId < 0 ? "group" : "private" }, from: { id: from, first_name: "Parent" }, text, ...extra } } as TelegramUpdate);
const replyToBot = { reply_to_message: { message_id: 500, from: { id: 123, is_bot: true, username: "strudel_bot" }, text: "Прежний ответ" } };
const familyInput = (id: number, sender = "33"): MessageInput => ({ channel: "telegram", text: "@strudel_bot расписание", telegramSenderId: sender, externalChatId: "-100", externalId: `-100:${id}` });
const contextOnly = (store: Store, externalId: string) => store.db.prepare("SELECT context_only FROM messages WHERE external_id=?").get(externalId)?.context_only;

it("R1: a protected group runs no turn for unaddressed text, whatever its stored reply mode", async () => {
  const { store, adapter, scoped } = fixture();
  expect(store.getTelegramChat("-100")?.replies).toBe("mentions");
  // An older database or a direct edit may still say "instructions".
  store.db.prepare("UPDATE telegram_chats SET replies='instructions' WHERE chat_id='-100'").run();
  await adapter.processUpdate(message(1, "Давайте перенесём занятие на пятницу"));
  expect(scoped).not.toHaveBeenCalled();
  expect(contextOnly(store, "-100:1")).toBe(1);
  await adapter.processUpdate(message(2, "@strudel_bot какое расписание?"));
  expect(scoped).toHaveBeenCalledOnce();
  // Removing and re-adding the bot restores the binding but never the "instructions" mode.
  const membership = (id: number, status: string): TelegramUpdate => ({ update_id: id, my_chat_member: { chat: { id: -100, type: "group", title: "Family" }, from: { id: 11 }, date: 100 + id, old_chat_member: { status: status === "left" ? "member" : "left" }, new_chat_member: { status } } } as TelegramUpdate);
  await adapter.processUpdate(membership(10, "left"));
  await adapter.processUpdate(membership(11, "member"));
  expect(store.getTelegramChat("-100")).toMatchObject({ replies: "mentions", allowedSenders: [], access: "approved" });
});

it("R2: another client cannot claim a protected chat's message id, replay slot or approval card", async () => {
  const { store, messages, adapter, scoped, sentTo } = fixture();
  for (const externalId of ["-100:5", "22:5"]) {
    await expect(messages.submit({ channel: "telegram", text: "pre-claim", externalId, externalChatId: "home" })).rejects.toThrow("недоступно");
  }
  expect(store.findMessageByExternal("telegram", "-100:5")).toBeNull();
  // The real Telegram message with that number is still answered.
  await adapter.processUpdate(message(5, "@strudel_bot расписание"));
  expect(scoped).toHaveBeenCalledOnce();
  // A card tied to a message that names a protected chat is never posted there.
  const conversation = store.getOrCreateConversation({ channel: "api", externalId: "home", title: "App" });
  const origin = store.addMessage({ conversationId: conversation.id, channel: "telegram", direction: "inbound", text: "legacy row", externalId: "-100:77" });
  const answer = messages.interactions.ask({ conversationId: conversation.id, messageId: origin.id, title: "Разрешить действие?", questions: [{ id: "decision", question: "", options: ["Разрешить", "Отказать"] }] });
  void answer.catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(sentTo("-100").filter(text => text.includes("Разрешить"))).toEqual([]);
  messages.interactions.cancelMessage(origin.id);
});

it("R3: switching access off is accepted during turns; pausing a busy protected group works; the queue is bounded", async () => {
  const { store, messages, adapter, scoped, gate, release } = fixture();
  gate.blocked = true;
  const pending = [];
  for (let id = 1; id <= 5; id++) pending.push(await messages.submit(familyInput(id)));
  const settled = pending.map(item => item.completion.then(() => "ok", () => "rejected"));
  const conversationId = store.getTelegramChat("-100")!.conversationId!;
  expect(messages.restrictedSaturated(conversationId)).toBe(true);
  // Beyond the backlog a new mention is kept as context, without a turn or typing.
  await adapter.processUpdate(message(6, "@strudel_bot и ещё вопрос"));
  expect(contextOnly(store, "-100:6")).toBe(1);
  // A burst the adapter could not see is refused outright at twice the backlog.
  for (let id = 7; id <= 11; id++) pending.push(await messages.submit(familyInput(id)));
  await expect(messages.submit(familyInput(12))).rejects.toThrow("Слишком много запросов");
  // Disabling only is accepted although turns are running; widening is not.
  const current = telegramAuthorization(store);
  const disable = structuredClone(current); disable.chats["-100"]!.enabled = false;
  const widen = structuredClone(current); widen.chats["-100"]!.defaultCapabilities.push("report.read");
  expect(messages.hasActiveRuns).toBe(true);
  expect(onlyDisablesScopedAccess(current, disable)).toBe(true);
  expect(onlyDisablesScopedAccess(current, widen)).toBe(false);
  const reEnable = structuredClone(disable); reEnable.chats["-100"]!.enabled = true;
  expect(onlyDisablesScopedAccess(disable, reEnable)).toBe(false);
  // Pausing a protected group never waits for participants; an ordinary group keeps its guard.
  (adapter as any).activeChats.set("-100", 1); (adapter as any).activeChats.set("-300", 1);
  expect(() => adapter.setGroupEnabled("-100", false)).not.toThrow();
  expect(() => adapter.setGroupEnabled("-100", true)).toThrow("Дождитесь");
  expect(() => adapter.setGroupEnabled("-300", false)).toThrow("Дождитесь");
  (adapter as any).activeChats.clear();
  release();
  // The paused chat revokes every queued turn at its next check.
  expect(new Set(await Promise.all(settled))).toEqual(new Set(["rejected"]));
  expect(scoped.mock.calls.length).toBeLessThanOrEqual(1);
  await Promise.allSettled(pending.slice(5).map(item => item.completion));
});

it("R3: the owner API saves a disabling policy during a running turn and refuses a widening one", async () => {
  const { OpenStrudelRuntime } = await import("../src/runtime.js");
  const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", startTelegram: false, apiToken: "owner", engine: { run: vi.fn() } });
  let release!: () => void; const blocker = new Promise<void>(resolve => { release = resolve; });
  runtime.messages.restrictedExecutor = { run: vi.fn(async (_text: string, options: any) => { await blocker; options.assertCurrent(); return { response: "late" }; }), close: vi.fn() };
  const address = await runtime.api.listen("127.0.0.1", 0);
  const call = (method: string, body?: unknown) => fetch(`http://127.0.0.1:${address.port}/v1/settings/telegram-authorization`, {
    method, headers: { "content-type": "application/json", authorization: "Bearer owner" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    expect((await call("PUT", config())).status).toBe(200);
    const turn = await runtime.messages.submit(familyInput(1));
    const outcome = turn.completion.then(() => "delivered", () => "revoked");
    expect(runtime.messages.hasActiveRuns).toBe(true);
    const summary = await (await call("GET")).json();
    const widen = structuredClone(summary); widen.chats["-100"].defaultCapabilities.push("report.read");
    expect((await call("PUT", widen)).status).toBe(409);
    const disable = structuredClone(summary); disable.chats["-100"].enabled = false;
    expect((await call("PUT", disable)).status).toBe(200);
    release();
    expect(await outcome).toBe("revoked");
    const reopened = await (await call("GET")).json();
    reopened.chats["-100"].enabled = true;
    expect((await call("PUT", reopened)).status).toBe(200);
  } finally { release(); await runtime.stop(); }
});

it("R4: model turns and the notification hook never post to a protected audience; verified answers still do", async () => {
  const { store, adapter, sentTo } = fixture();
  const owner = store.getOrCreateConversation({ channel: "telegram", externalId: "11", title: "Owner" });
  const tools = telegramTools(store, { conversationId: owner.id, messageId: "m", channel: "telegram", telegramSenderId: "11", telegram: adapter } as any);
  const listed = await tools.call("list_telegram_chats", { query: null }) as { chats: Array<{ chatId: string }> };
  expect(listed.chats.map(chat => chat.chatId).sort()).toEqual(["-300", "11"]);
  for (const chatId of ["-100", "22"]) {
    await expect(tools.call("send_telegram_message", { chatId, text: "Финансы и черновик", paths: [] })).rejects.toThrow("недоступен");
    expect(() => adapter.deliveryTarget(chatId, `${chatId}:send:x`)).toThrow("ограниченным доступом");
  }
  await expect(receiveNotification(store, adapter, ["-100"], "hook-1", { text: "Внешнее уведомление" })).rejects.toThrow("ограниченным доступом");
  expect(sentTo("-100")).toEqual([]);
  await adapter.processUpdate(message(1, "@strudel_bot расписание"));
  expect(sentTo("-100")).toEqual(["scoped answer"]);
});

it("R6: a connector's new address never inherits the old credentials", () => {
  const current = config();
  const moved = { ...config(), connectors: { school: { url: "https://elsewhere.example/mcp" } } };
  expect(() => preserveConnectorHeaders(current, moved)).toThrow("headers");
  const same = { ...config(), connectors: { school: { url: "https://school.example/mcp", configured: true } } } as any;
  preserveConnectorHeaders(current, same);
  expect(same.connectors.school.headers).toEqual({ Authorization: "Bearer test-secret" });
  const explicit = { ...config(), connectors: { school: { url: "https://elsewhere.example/mcp", headers: { Authorization: "Bearer other" } } } };
  expect(() => preserveConnectorHeaders(current, explicit)).not.toThrow();
});

it("R10: every file rechecks delivery, and scheduled delivery refuses a protected audience", async () => {
  const { adapter, fetched } = fixture();
  const attachment = { id: "file-1", conversationId: "c", name: "report.pdf", mimeType: "application/pdf", size: 1 } as any;
  await expect(adapter.sendFiles("-300", [attachment], "k", { assertCurrent: () => { throw new Error("Права ответа изменились."); } })).rejects.toThrow("Права ответа изменились");
  expect(fetched).toEqual([]);
  const { OpenStrudelRuntime } = await import("../src/runtime.js");
  const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", startTelegram: false, apiToken: "owner", engine: { run: vi.fn() } });
  try {
    saveTelegramAuthorization(runtime.store, config());
    await expect(runtime.scheduler.deliver!("-100", "Еженедельная сводка", "schedule:1")).rejects.toThrow("ограниченным доступом");
    await expect(runtime.scheduler.deliver!("22", "Еженедельная сводка", "schedule:2")).rejects.toThrow("ограниченным доступом");
  } finally { await runtime.stop(); }
});

it("F2/R8: a protected audience fetches no media unless addressed, and never photos or files", async () => {
  const { store, adapter, scoped, downloads } = fixture();
  adapter.transcribe = vi.fn(async () => "Расшифрованный вопрос про домашнее задание");
  // Unaddressed voice without a caption: nothing is downloaded, transcribed or stored.
  await adapter.processUpdate(message(1, "", { text: undefined, voice: { file_id: "v1", file_size: 100 } }));
  // Unaddressed voice with a caption: only the caption is kept as context.
  await adapter.processUpdate(message(2, "", { text: undefined, caption: "Посмотрите вечером", voice: { file_id: "v2", file_size: 100 } }));
  // Addressed photo: the caption is the request; the photo itself is never fetched.
  await adapter.processUpdate(message(3, "", { text: undefined, caption: "@strudel_bot что задали?", photo: [{ file_id: "p3", file_size: 100 }] }));
  // Addressed document without words: nothing a restricted turn could use.
  await adapter.processUpdate(message(4, "", { text: undefined, document: { file_id: "d4", file_name: "homework.pdf", mime_type: "application/pdf" }, ...replyToBot }));
  expect(downloads()).toEqual([]);
  expect(adapter.transcribe).not.toHaveBeenCalled();
  expect(store.findMessageByExternal("telegram", "-100:1")).toBeNull();
  expect(store.findMessageByExternal("telegram", "-100:2")).toMatchObject({ text: "Посмотрите вечером" });
  expect(contextOnly(store, "-100:2")).toBe(1);
  expect(store.findMessageByExternal("telegram", "-100:4")).toBeNull();
  expect(scoped).toHaveBeenCalledOnce();
  expect(scoped.mock.calls[0]![0]).toContain("что задали?");
  // A voice reply to the bot addresses it: only then is speech downloaded and transcribed.
  await adapter.processUpdate(message(5, "", { text: undefined, voice: { file_id: "v5", file_size: 100 }, ...replyToBot }));
  expect(adapter.transcribe).toHaveBeenCalledOnce();
  expect(downloads().length).toBeGreaterThan(0);
  expect(scoped.mock.calls[1]![0]).toContain("Расшифрованный вопрос про домашнее задание");
});

it("N1: a failed restricted turn alerts the owner privately; a revoked grant stays quiet", async () => {
  const { adapter, scoped, sentTo } = fixture();
  const unavailable = () => new Error("Ограниченный доступ сейчас недоступен. Повторите запрос позже.");
  scoped.mockRejectedValueOnce(unavailable());
  await adapter.processUpdate(message(1, "@strudel_bot расписание"));
  await vi.waitFor(() => expect(sentTo("11")).toHaveLength(1));
  expect(sentTo("11")[0]).toContain("Требует внимания");
  expect(sentTo("-100")).toEqual([]);
  // A later answer closes the incident; a revoked grant afterwards notifies no one.
  await adapter.processUpdate(message(2, "@strudel_bot расписание"));
  expect(sentTo("-100")).toEqual(["scoped answer"]);
  scoped.mockRejectedValueOnce(new Error("Права доступа изменились. Отправьте запрос заново."));
  await adapter.processUpdate(message(3, "@strudel_bot расписание"));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(sentTo("11")).toHaveLength(1);
  // The next real failure is reported again.
  scoped.mockRejectedValueOnce(unavailable());
  await adapter.processUpdate(message(4, "@strudel_bot расписание"));
  await vi.waitFor(() => expect(sentTo("11")).toHaveLength(2));
});
