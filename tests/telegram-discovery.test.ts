import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { TelegramAdapter, type TelegramUpdate } from "../src/telegram.js";
import { MessageService } from "../src/messages.js";

const stores: Store[] = [];
afterEach(() => { vi.unstubAllGlobals(); stores.splice(0).forEach(s => s.close()); });
function setup() {
  const store = new Store(":memory:"); stores.push(store);
  store.linkTelegramChat({ chatId: "42", title: "Owner", allowedSenders: ["42"] });
  const handle = vi.fn(async () => ({ conversationId: "home", messageId: "reply", text: "done" }));
  const adapter = new TelegramAdapter("123:test", store, { handle } as unknown as MessageService);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, result: { message_id: 99 } })));
  return { store, handle, adapter };
}
function membership(update: number, sender = 42, status = "member") {
  return { update_id: update, my_chat_member: {
    chat: { id: -100, title: "Офис", type: "supergroup" }, from: { id: sender }, date: 1000 + update,
    old_chat_member: { status: "left" }, new_chat_member: { status }
  } } as unknown as TelegramUpdate;
}
it("adding the bot by its owner enables the assistant with isolated group history", async () => {
  const { store, adapter, handle } = setup();
  await adapter.processUpdate(membership(1));
  expect(store.getTelegramChat("-100")).toMatchObject({ title: "Офис", allowedSenders: ["42"], profileId: null, conversationId: expect.any(String), access: "members", replies: "mentions" });
  const conversation = store.getTelegramChat("-100")!.conversationId!;
  expect(store.getConversation(conversation)).toMatchObject({ channel: "telegram", externalId: "-100", profileId: null });
  expect(handle).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  await adapter.processUpdate(membership(1));
  expect(store.getTelegramChat("-100")!.conversationId).toBe(conversation);
  expect(fetch).not.toHaveBeenCalled();
});
it("does not discover groups added by strangers", async () => {
  const { store, adapter } = setup();
  await adapter.processUpdate(membership(1, 7));
  expect(store.getTelegramChat("-100")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it("keeps an unassigned group silent until an employee is chosen", async () => {
  const { store, adapter, handle } = setup();
  store.linkTelegramChat({ chatId: "-100", title: "Офис", allowedSenders: ["42"] });
  await adapter.processUpdate({ update_id: 2, message: { message_id: 2, chat: { id: -100, type: "group" }, from: { id: 42 }, text: "Hello" } });
  expect(handle).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it("revokes a removed group but keeps its conversation history", async () => {
  const { store, adapter } = setup();
  store.linkTelegramChat({ chatId: "-100", title: "Офис", allowedSenders: ["42"] });
  const p = store.createProfile({ name: "Office" });
  const chat = store.bindTelegramChat("-100", p.id);
  await adapter.processUpdate(membership(3, 7, "left"));
  expect(store.getTelegramChat("-100")).toBeNull();
  expect(store.getConversation(chat.conversationId!)).not.toBeNull();
  await adapter.processUpdate(membership(1));
  expect(store.getTelegramChat("-100")).toBeNull();
  await adapter.processUpdate(membership(4));
  expect(store.getTelegramChat("-100")).toMatchObject({ conversationId: chat.conversationId, profileId: p.id, access: chat.access, replies: chat.replies });
});

it("answers an addressed colleague without choosing an employee or exposing a private chat", async () => {
  const { store, adapter, handle } = setup();
  store.setSetting("telegram.bot_username", "strudel_bot");
  await adapter.processUpdate(membership(1));
  await adapter.processUpdate({ update_id: 2, message: { message_id: 2, chat: { id: -100, type: "group" }, from: { id: 77 }, text: "Morning" } });
  expect(handle).not.toHaveBeenCalled();
  await adapter.processUpdate({ update_id: 3, message: { message_id: 3, chat: { id: -100, type: "group" }, from: { id: 77 }, text: "@strudel_bot help" } });
  expect(handle).toHaveBeenCalledTimes(1);
  expect(handle.mock.calls[0]![0]).toMatchObject({ conversationId: store.getTelegramChat("-100")!.conversationId, externalChatId: "-100", telegramSenderId: "77" });
});

it("ordinary membership updates do not reopen a group explicitly paused by its owner", async () => {
  const { store, adapter } = setup();
  await adapter.processUpdate(membership(1));
  adapter.bindChat("-100", null);
  await adapter.processUpdate(membership(2, 42, "administrator"));
  expect(store.getTelegramChat("-100")?.conversationId).toBeNull();
});
it("recognizes the native Add to Group deep link for an existing group", async () => {
  const { store, adapter, handle } = setup();
  store.setSetting("telegram.bot_username", "strudel_bot");
  await adapter.processUpdate({ update_id: 4, message: { message_id: 4, from: { id: 42 }, chat: { id: -100, type: "group", title: "Офис" }, text: "/start@strudel_bot choose" } });
  expect(store.getTelegramChat("-100")?.title).toBe("Офис");
  expect(handle).not.toHaveBeenCalled();
});

it("preserves the employee and history when Telegram upgrades a group", async () => {
  const { store, adapter, handle } = setup();
  store.linkTelegramChat({ chatId: "-100", title: "Офис", allowedSenders: ["42"] });
  const profile = store.createProfile({ name: "Office" });
  const original = store.bindTelegramChat("-100", profile.id);
  const messages = new MessageService(store, { run: vi.fn() });
  const context = messages.contextFor(original.conversationId!);
  store.addMessage({ conversationId: original.conversationId!, channel: "telegram", direction: "inbound", text: "Remember this" });
  // The new membership event may arrive before the migration service message.
  store.linkTelegramChat({ chatId: "-100200", title: "Офис", allowedSenders: ["42"] });
  await adapter.processUpdate({ update_id: 8, message: { message_id: 8, chat: { id: -100 }, migrate_to_chat_id: -100200 } } as TelegramUpdate);
  expect(store.getTelegramChat("-100")).toBeNull();
  expect(store.getTelegramChat("-100200")).toMatchObject({ profileId: profile.id, conversationId: original.conversationId, allowedSenders: ["42"] });
  expect(store.getConversation(original.conversationId!)?.externalId).toBe(`-100200::employee::${profile.id}`);
  expect(store.listMessages(original.conversationId!)[0]?.text).toBe("Remember this");
  await adapter.processUpdate({ update_id: 9, message: { message_id: 9, chat: { id: -100200 }, migrate_from_chat_id: -100 } } as TelegramUpdate);
  expect(store.getTelegramChat("-100200")?.conversationId).toBe(original.conversationId);
  expect(messages.contextFor(original.conversationId!)).toBe(context);
  expect(handle).not.toHaveBeenCalled();
});

it('pauses and resumes a group without losing its existing character, history or permissions', async () => {
  const {store, adapter, handle} = setup();
  await adapter.processUpdate(membership(1));
  const profile = store.createProfile({ name: 'Wolf', instructions: 'Keep my character.' });
  const original = store.bindTelegramChat('-100', profile.id);
  adapter.setGroupEnabled('-100', false);
  expect(store.getTelegramChat('-100')).toMatchObject({enabled:false, profileId:profile.id, conversationId:original.conversationId});
  await adapter.processUpdate(membership(2));
  await adapter.processUpdate({ update_id:3, message:{message_id:3,chat:{id:-100,type:'group'},from:{id:42},text:'Hello'} });
  expect(handle).not.toHaveBeenCalled();
  store.migrateTelegramGroup('-100', '-100200');
  expect(store.getTelegramChat('-100200')?.enabled).toBe(false);
  adapter.setGroupEnabled('-100200', true);
  expect(store.getTelegramChat('-100200')).toMatchObject({enabled:true, profileId:profile.id, conversationId:original.conversationId,access:original.access,replies:original.replies});
});
