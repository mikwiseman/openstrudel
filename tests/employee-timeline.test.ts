import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter } from "../src/telegram.js";

const stores: Store[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const profile = store.createProfile({ name: "Editor" });
  const app = store.profileConversation(profile.id);
  const groups = ["-1001234567890", "-1001234567891"].map((chatId, i) => {
    store.linkTelegramChat({ chatId, title: "Team " + (i + 1), allowedSenders: ["7"] });
    return store.bindTelegramChat(chatId, profile.id);
  });
  return { store, profile, app, groups };
}

it("pages one employee's accepted requests across audiences without mixing context or other employees", () => {
  const { store, profile, app, groups } = fixture();
  const messages = Array.from({ length: 127 }, (_, i) => store.addMessage({
    conversationId: i % 2 ? groups[0]!.conversationId! : app.id,
    channel: i % 2 ? "telegram" : "api", direction: "inbound", text: String(i),
    ...(i % 2 ? { externalId: groups[0]!.chatId + ":" + (i + 1), author: "Dasha" } : {}),
  }));
  store.db.prepare("UPDATE messages SET created_at=?").run("2026-10-14T00:00:00.000Z");
  const chatter = store.addMessage({ conversationId: groups[1]!.conversationId!, channel: "telegram", direction: "inbound", text: "Ordinary chat" });
  store.db.prepare("UPDATE messages SET context_only=1 WHERE id=?").run(chatter.id);
  const foreign = store.addMessage({ conversationId: store.profileConversation(store.createProfile({ name: "Other" }).id).id, channel: "api", direction: "inbound", text: "Private" });
  const page = store.employeeMessagePage(profile.id, new URLSearchParams("limit=50"));
  const middle = store.employeeMessagePage(profile.id, new URLSearchParams({ before: page.pagination.olderCursor!, limit: "50" }));
  const first = store.employeeMessagePage(profile.id, new URLSearchParams({ before: middle.pagination.olderCursor!, limit: "50" }));
  expect([...first.messages, ...middle.messages, ...page.messages].map(m => m.id)).toEqual(messages.map(m => m.id));
  expect(page.messages.find(m => m.channel === "telegram")).toMatchObject({ author: "Dasha", origin: { channel: "telegram", title: "Team 1", chatId: groups[0]!.chatId } });
  expect(first.messages[1]?.origin?.url).toBe("https://t.me/c/1234567890/2");
  expect(() => store.employeeMessagePage(profile.id, new URLSearchParams({ after: foreign.id }))).toThrow();
  expect(store.listMessages(groups[1]!.conversationId!)).toHaveLength(1);
});

it.each(["NO_REPLY", "NO_REPLY\n", " NO_REPLY"])("removes a silently declined request (%j) from a loaded timeline while retaining its context and cursor", async response => {
  const { store, profile, groups } = fixture();
  let finish!: (v: any) => void;
  const messages = new MessageService(store, { run: () => new Promise(resolve => { finish = resolve; }) });
  const turn = await messages.submit({ channel: "telegram", conversationId: groups[0]!.conversationId!, externalChatId: groups[0]!.chatId, externalId: groups[0]!.chatId + ":1", text: "Not for the bot" });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const initial = store.employeeMessagePage(profile.id, new URLSearchParams());
  expect(initial.messages).toHaveLength(1);
  finish({ threadId: "test", response, events: [] });
  await turn.completion;
  const delta = store.employeeMessagePage(profile.id, new URLSearchParams({ after: initial.pagination.newerCursor!, watch: turn.receipt.messageId }));
  expect(delta.messages).toEqual([]);
  expect(delta.removedIds).toEqual([turn.receipt.messageId]);
  expect(store.listMessages(groups[0]!.conversationId!)).toHaveLength(1);
  await messages.close();
});

it("updates Telegram delivery without resending ambiguous chunks or assigning old history to a new employee", async () => {
  const { store, profile, groups } = fixture();
  const service = new MessageService(store, { run: async () => ({ threadId: "test", response: "Done", events: [] }) });
  const adapter = new TelegramAdapter("123:synthetic", store, service);
  const inbound = store.addMessage({ conversationId: groups[0]!.conversationId!, channel: "telegram", direction: "inbound", text: "Do it", externalId: groups[0]!.chatId + ":11" });
  const reply = store.addMessage({ conversationId: inbound.conversationId, channel: "telegram", direction: "outbound", replyToId: inbound.id, text: "Done" });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, result: { message_id: 12 } })));
  await adapter.sendMessage(groups[0]!.chatId, reply.text, "reply:" + reply.id);
  const delivered = store.employeeMessagePage(profile.id, new URLSearchParams({ after: reply.id, watch: reply.id })).updates[0]!;
  expect(delivered.delivery?.state).toBe("delivered");
  expect(delivered.origin?.url).toBe("https://t.me/c/1234567890/12");
  store.db.prepare("UPDATE telegram_outbox SET status='unknown',error='Lost acknowledgement'").run();
  expect(store.employeeMessagePage(profile.id, new URLSearchParams()).messages.at(-1)?.delivery?.state).toBe("unknown");
  const next = store.createProfile({ name: "New employee" });
  store.bindTelegramChat(groups[0]!.chatId, next.id);
  expect(store.employeeMessagePage(next.id, new URLSearchParams()).messages).toEqual([]);
  const old = store.employeeMessagePage(profile.id, new URLSearchParams()).messages;
  expect(old.map(m => m.id)).toEqual([inbound.id, reply.id]);
  expect(old[0]?.origin?.canReply).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  await service.close();
});

it("keeps imported history without an employee reachable from the main assistant", () => {
  const { store, profile } = fixture();
  const archive = store.getOrCreateConversation({ channel: "api", externalId: "import::legacy", title: "Old team" });
  store.importHistory(archive.id, [{ sourceId: "one", date: "2026-09-01", author: "Dasha", direction: "inbound", text: "Remember this" }]);
  expect(store.employeeMessagePage(null, new URLSearchParams()).messages[0]).toMatchObject({ text: "Remember this", origin: { channel: "archive", title: "Old team" } });
  expect(store.employeeMessagePage(profile.id, new URLSearchParams()).messages).toEqual([]);
});

it("sends an explicit owner reply once to its exact Telegram message and rejects a changed audience", async () => {
  const { store, profile, groups } = fixture();
  const run = vi.fn(async () => ({ threadId: "unused", response: "unused", events: [] }));
  const service = new MessageService(store, { run });
  const adapter = new TelegramAdapter("123:synthetic", store, service);
  const input = store.addMessage({ conversationId: groups[0]!.conversationId!, channel: "telegram", direction: "inbound", text: "Question", externalId: groups[0]!.chatId + ":11" });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, result: { message_id: 12 } })));
  const first = await adapter.replyFromApp({ conversationId: input.conversationId, replyToId: input.id, text: "Confirmed", externalId: "11111111-1111-4111-8111-111111111111" });
  const second = await adapter.replyFromApp({ conversationId: input.conversationId, replyToId: input.id, text: "Confirmed", externalId: "11111111-1111-4111-8111-111111111111" });
  expect(first.messageId).toBe(second.messageId);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body))).toMatchObject({ chat_id: groups[0]!.chatId, reply_parameters: { message_id: 11, allow_sending_without_reply: true } });
  expect(run).not.toHaveBeenCalled();
  const reply = store.employeeMessagePage(profile.id, new URLSearchParams()).messages.at(-1)!;
  expect(reply).toMatchObject({ text: "Confirmed", replyToId: input.id, author: "OpenStrudel", delivery: { state: "delivered" } });
  store.bindTelegramChat(groups[0]!.chatId, store.createProfile({ name: "Replacement" }).id);
  await expect(adapter.replyFromApp({ conversationId: input.conversationId, replyToId: input.id, text: "Do not send", externalId: "22222222-2222-4222-8222-222222222222" })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  await service.close();
});

it("retains an ambiguous app reply across retries and rejects changed text, paused groups and foreign files", async () => {
  const { store, groups } = fixture();
  const service = new MessageService(store, { run: async () => { throw new Error("Must not run"); } });
  const adapter = new TelegramAdapter("123:synthetic", store, service);
  const inbound = store.addMessage({ conversationId: groups[0]!.conversationId!, channel: "telegram", direction: "inbound", text: "Question", externalId: groups[0]!.chatId + ":11" });
  const input = { conversationId: inbound.conversationId, replyToId: inbound.id, text: "Reply", externalId: "11111111-1111-4111-8111-111111111111" };
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Connection lost after send"); }));
  const receipt = await adapter.replyFromApp(input);
  expect(store.employeeMessagePage(store.getConversation(inbound.conversationId)!.profileId, new URLSearchParams()).messages.at(-1)?.delivery?.state).toBe("unknown");
  expect(await adapter.replyFromApp(input)).toEqual(receipt);
  await expect(adapter.replyFromApp({ ...input, text: "Changed" })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  store.setSetting("telegram.paused." + groups[0]!.chatId, "true");
  await expect(adapter.replyFromApp({ ...input, externalId: "22222222-2222-4222-8222-222222222222" })).rejects.toThrow();
  await expect(adapter.replyFromApp({ ...input, attachments: ["missing"] })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  await service.close();
});

function adapterFixture(run: (input: string) => Promise<string> = async () => "Answer") {
  const { store, profile, app, groups } = fixture();
  store.setSetting("telegram.bot_username", "strudel_bot");
  const prompts: string[] = [];
  const service = new MessageService(store, { run: async (input: string) => { prompts.push(input); return { threadId: "test", response: await run(input), events: [] }; } });
  const adapter = new TelegramAdapter("123:synthetic", store, service);
  const sent: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/sendMessage")) sent.push(JSON.parse(String(init!.body)));
    return Response.json({ ok: true, result: { message_id: 500 + sent.length } });
  }));
  const update = (id: number, text: string, chatId = groups[0]!.chatId, extra: Record<string, unknown> = {}) =>
    ({ update_id: id, message: { message_id: id, text, from: { id: 7, first_name: "Dasha" }, chat: { id: Number(chatId), type: "supergroup", title: store.getTelegramChat(chatId)?.title }, ...extra } });
  const feed = () => store.employeeMessagePage(profile.id, new URLSearchParams()).messages;
  return { store, profile, app, groups, service, adapter, sent, update, feed, prompts };
}

it("shows no delivery state for replies that were never tracked for Telegram", () => {
  const { store, profile, groups, feed } = adapterFixture();
  const inbound = store.addMessage({ conversationId: groups[0]!.conversationId!, channel: "telegram", direction: "inbound", text: "September request", externalId: groups[0]!.chatId + ":3" });
  const reply = store.addMessage({ conversationId: inbound.conversationId, channel: "telegram", direction: "outbound", replyToId: inbound.id, text: "September answer" });
  expect(feed().find(m => m.id === reply.id)?.delivery).toBeUndefined();
  store.bindTelegramChat(groups[0]!.chatId, store.createProfile({ name: "Successor" }).id);
  expect(store.employeeMessagePage(profile.id, new URLSearchParams()).messages.find(m => m.id === reply.id)?.delivery).toBeUndefined();
});

it("marks Telegram's definite rejection as not sent and keeps an unanswered network failure uncertain", async () => {
  const { store, groups, adapter, feed } = adapterFixture();
  const inbound = store.addMessage({ conversationId: groups[0]!.conversationId!, channel: "telegram", direction: "inbound", text: "Question", externalId: groups[0]!.chatId + ":11" });
  const reply = store.addMessage({ conversationId: inbound.conversationId, channel: "telegram", direction: "outbound", replyToId: inbound.id, text: "Answer" });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was kicked from the supergroup chat" }, { status: 403 })));
  await expect(adapter.sendMessage(groups[0]!.chatId, reply.text, "reply:" + reply.id)).rejects.toThrow();
  expect(feed().find(m => m.id === reply.id)?.delivery).toEqual({ state: "not_sent", error: "Telegram отклонил сообщение, оно не отправлено. Проверьте, что бот остался в чате." });
  const second = store.addMessage({ conversationId: inbound.conversationId, channel: "telegram", direction: "outbound", replyToId: inbound.id, text: "Second" });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error_code: 502, description: "Bad Gateway" }, { status: 502 })));
  await expect(adapter.sendMessage(groups[0]!.chatId, second.text, "reply:" + second.id)).rejects.toThrow();
  expect(feed().find(m => m.id === second.id)?.delivery?.state).toBe("unknown");
});

it("keeps the owner's explicit reply apart from the employee's answer and reports a rejected one as not sent", async () => {
  const { store, groups, adapter, feed } = adapterFixture();
  const input = store.addMessage({ conversationId: groups[0]!.conversationId!, channel: "telegram", direction: "inbound", text: "Question", externalId: groups[0]!.chatId + ":11" });
  const answer = store.addMessage({ conversationId: input.conversationId, channel: "telegram", direction: "outbound", replyToId: input.id, text: "Employee answer" });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 })));
  const receipt = await adapter.replyFromApp({ conversationId: input.conversationId, replyToId: input.id, text: "From the owner", externalId: "33333333-3333-4333-8333-333333333333" });
  const owner = feed().find(m => m.id === receipt.messageId)!;
  // Clients show an outbound Telegram message with an author as the owner's; the employee's answers have none.
  expect(owner).toMatchObject({ author: "OpenStrudel", delivery: { state: "not_sent" } });
  expect(feed().find(m => m.id === answer.id)?.author).toBeNull();
});

it("keeps a Telegram file that could not be received visible as a failed request", async () => {
  const { store, profile, adapter, sent, feed } = adapterFixture();
  store.linkTelegramChat({ chatId: "7", title: "Dasha", allowedSenders: ["7"] });
  store.bindTelegramChat("7", profile.id);
  await adapter.processUpdate({ update_id: 1, message: { message_id: 1, caption: "Please read", from: { id: 7, first_name: "Dasha" }, chat: { id: 7, type: "private" }, document: { file_id: "large", file_name: "large.pdf", file_size: 30_000_000 } } });
  expect(feed().at(-1)).toMatchObject({ text: "Please read", direction: "inbound", status: "failed", error: "Отправьте файл до 20 МБ.", author: "Dasha" });
  expect(sent.map(m => m.text)).toEqual(["Отправьте файл до 20 МБ."]);
});

it("shows a renamed Telegram group's current title on earlier requests", async () => {
  const { store, groups, adapter, update, feed } = adapterFixture();
  store.addMessage({ conversationId: groups[0]!.conversationId!, channel: "telegram", direction: "inbound", text: "Earlier", externalId: groups[0]!.chatId + ":1" });
  await adapter.processUpdate({ update_id: 2, message: { message_id: 2, new_chat_title: "Editorial", from: { id: 7 }, chat: { id: Number(groups[0]!.chatId), type: "supergroup", title: "Editorial" } } } as any);
  expect(feed().map(m => m.origin?.title)).toEqual(["Editorial"]);
  await adapter.processUpdate(update(3, "Next request", groups[0]!.chatId, { chat: { id: Number(groups[0]!.chatId), type: "supergroup", title: "Editorial desk" } }));
  expect(store.getTelegramChat(groups[0]!.chatId)?.title).toBe("Editorial desk");
  expect(store.getConversation(groups[0]!.conversationId!)?.title).toBe("Editorial desk");
});

it("keeps unaddressed group chatter out of the feed but uses it as context for the next request", async () => {
  const { store, groups, adapter, update, feed, prompts } = adapterFixture();
  store.db.prepare("UPDATE telegram_chats SET access='members',replies='mentions' WHERE chat_id=?").run(groups[0]!.chatId);
  await adapter.processUpdate(update(1, "The launch moved to Friday"));
  expect(feed()).toEqual([]);
  await adapter.processUpdate(update(2, "@strudel_bot when is the launch?"));
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("The launch moved to Friday");
  expect(feed().map(m => [m.direction, m.text])).toEqual([["inbound", "@strudel_bot when is the launch?"], ["outbound", "Answer"]]);
});

it("answers two groups at once without crossing replies or context", async () => {
  const waiting: Array<() => void> = [];
  const { groups, adapter, update, feed, sent, prompts } = adapterFixture(async input => {
    await new Promise<void>(resolve => waiting.push(resolve));
    return input.includes("alpha") ? "Answer for alpha" : "Answer for beta";
  });
  const turns = [adapter.processUpdate(update(1, "Question alpha", groups[0]!.chatId)), adapter.processUpdate(update(2, "Question beta", groups[1]!.chatId))];
  await vi.waitFor(() => expect(waiting).toHaveLength(2));
  waiting.splice(0).reverse().forEach(resume => resume());
  await Promise.all(turns);
  expect(prompts.find(p => p.includes("alpha"))).not.toContain("beta");
  expect(prompts.find(p => p.includes("beta"))).not.toContain("alpha");
  const rows = feed();
  for (const [question, answer, chatId] of [["Question alpha", "Answer for alpha", groups[0]!.chatId], ["Question beta", "Answer for beta", groups[1]!.chatId]]) {
    const request = rows.find(m => m.text === question)!, reply = rows.find(m => m.text === answer)!;
    expect(reply).toMatchObject({ replyToId: request.id, conversationId: request.conversationId, origin: { chatId }, delivery: { state: "delivered" } });
    expect(sent.filter(m => m.text === answer).map(m => String(m.chat_id))).toEqual([chatId]);
  }
});

it("shows one request and one reply when Telegram repeats an update", async () => {
  const { store, adapter, update, feed, sent, prompts } = adapterFixture();
  await adapter.processUpdate(update(1, "Do it once"));
  await adapter.processUpdate(update(1, "Do it once"));
  store.db.prepare("DELETE FROM telegram_updates").run();
  await adapter.processUpdate(update(1, "Do it once"));
  expect(feed().map(m => m.text)).toEqual(["Do it once", "Answer"]);
  expect(feed()[1]?.delivery?.state).toBe("delivered");
  expect(prompts).toHaveLength(1);
  expect(sent).toHaveLength(1);
});

it("does not send a reply after the bot leaves the group mid-turn and shows it as not sent", async () => {
  let finish!: () => void;
  const { groups, adapter, update, feed, sent } = adapterFixture(() => new Promise(resolve => { finish = () => resolve("Late answer"); }));
  const turn = adapter.processUpdate(update(1, "Long task"));
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await adapter.processUpdate({ update_id: 2, my_chat_member: { chat: { id: Number(groups[0]!.chatId), title: "Team 1", type: "supergroup" }, from: { id: 7 }, date: 100, old_chat_member: { status: "member" }, new_chat_member: { status: "left" } } });
  finish(); await turn;
  expect(sent).toEqual([]);
  expect(feed().at(-1)).toMatchObject({ text: "Late answer", delivery: { state: "not_sent", error: "Подключение этого чата изменилось. Ответ не отправлен в Telegram." } });
});

it("keeps a durable not-sent receipt when the sender is revoked before delivery", async () => {
  let finish!: () => void;
  const { store, groups, adapter, update, feed, sent, prompts } = adapterFixture(() => new Promise(resolve => { finish = () => resolve("Private result"); }));
  const turn = adapter.processUpdate(update(1, "Long task"));
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  store.db.prepare("UPDATE telegram_chats SET allowed_senders_json='[]' WHERE chat_id=?").run(groups[0]!.chatId);
  finish(); await turn;
  expect(sent).toEqual([]);
  expect(feed().at(-1)).toMatchObject({ text: "Private result", delivery: { state: "not_sent", error: "Право отвечать этому участнику отозвано." } });
  await adapter.processUpdate(update(1, "Long task"));
  expect(prompts).toHaveLength(1);
  expect(store.db.prepare("SELECT status FROM telegram_outbox").all()).toEqual([{ status: "not_sent" }]);
});
