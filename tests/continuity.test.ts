import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import type { CodexEngine } from "../src/types.js";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const setup = () => { const s = new Store(":memory:"); stores.push(s); return s; };

describe("linked conversations", () => {
  it("honors a direct employee address in a pinned private chat without changing its default", async () => {
    const store = setup();
    const news = store.createProfile({ name: "News" });
    const baby = store.createProfile({ name: "Baby" });
    store.linkTelegramChat({ chatId: "42", title: "Personal", allowedSenders: ["42"] });
    const bound = store.bindTelegramChat("42", news.id);
    const babyChat = store.profileConversation(baby.id);
    store.setConversationThread(babyChat.id, "baby-history");
    const calls: Array<Parameters<CodexEngine["run"]>[1]> = [];
    const service = new MessageService(store, { async run(_text, options) {
      calls.push(options); return { threadId: options?.threadId ?? "news-thread", response: "done", events: [] };
    } });
    const addressed = await service.handle({ channel: "telegram", externalChatId: "42", text: "@Baby Найди прошлые пожелания" });
    const ordinary = await service.handle({ channel: "telegram", externalChatId: "42", text: "Свежие новости" });
    expect(addressed).toMatchObject({ profileId: baby.id, conversationId: babyChat.id });
    expect(calls[0]).toMatchObject({ threadId: "baby-history", profile: expect.stringContaining("Baby") });
    expect(ordinary.conversationId).toBe(bound.conversationId);
    expect(store.getTelegramChat("42")?.profileId).toBe(news.id);
    await service.close();
  });

  it("keeps a group mention away from the employee's personal history", async () => {
    const store = setup();
    const news = store.createProfile({ name: "News" });
    const baby = store.createProfile({ name: "Baby" });
    store.linkTelegramChat({ chatId: "-100", title: "Group", allowedSenders: ["42"] });
    store.bindTelegramChat("-100", news.id);
    const personal = store.profileConversation(baby.id);
    const service = new MessageService(store, { async run() { return { threadId: "group-only", response: "done", events: [] }; } });
    const addressed = await service.handle({ channel: "telegram", externalChatId: "-100", text: "@Baby Привет" });
    expect(addressed.profileId).toBe(baby.id);
    expect(addressed.conversationId).not.toBe(personal.id);
    expect(store.getConversation(addressed.conversationId)?.externalId).toBe(`-100::employee::${baby.id}`);
    await service.close();
  });

  it("continues the same employee thread from Telegram and the native app", async () => {
    const store = setup();
    const employee = store.createProfile({ name: "News" });
    store.linkTelegramChat({ chatId: "-100", title: "News group", allowedSenders: ["7"] });
    const binding = store.bindTelegramChat("-100", employee.id);
    const calls: Array<string | null | undefined> = [];
    const engine: CodexEngine = { async run(_text, options) { calls.push(options?.threadId); return { threadId: "same-thread", response: "done", events: [] }; } };
    const service = new MessageService(store, engine);
    const tg = await service.handle({ channel: "telegram", externalChatId: "-100", text: "First" });
    const app = await service.handle({ channel: "api", profile: employee.id, conversationId: binding.conversationId!, text: "Continue" });
    expect(tg.profileId).toBe(employee.id);
    expect(tg.conversationId).toBe(binding.conversationId);
    expect(app.conversationId).toBe(tg.conversationId);
    expect(calls).toEqual([null, "same-thread"]);
    await service.close();
  });
  it("keeps different Telegram groups separate even for the same employee", () => {
    const store = setup();
    const employee = store.createProfile({ name: "News" });
    for (const chatId of ["-100", "-200"]) store.linkTelegramChat({ chatId, title: chatId, allowedSenders: ["7"] });
    const first = store.bindTelegramChat("-100", employee.id);
    const second = store.bindTelegramChat("-200", employee.id);
    expect(first.conversationId).not.toBe(second.conversationId);
    expect(first.conversationId).not.toBe(store.profileConversation(employee.id).id);
    expect(store.getConversation(second.conversationId!)?.profileId).toBe(employee.id);
  });
  it("does not let a group expand its filesystem or command permissions", async () => {
    const store = setup();
    const employee = store.createProfile({ name: "News" });
    store.linkTelegramChat({ chatId: "-100", title: "Group", allowedSenders: ["7"] });
    store.bindTelegramChat("-100", employee.id);
    const decisions: unknown[] = [];
    const service = new MessageService(store, { async run(_text, options) {
      for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]) {
        decisions.push(await options!.onRequest!(method, { permissions: { filesystem: { read: ["/private"] } } }));
      }
      return { threadId: "group-only", response: "Access stays scoped", events: [] };
    } });
    // An approval shown in the group must not grant access to the owner's Mac.
    const stopApproval = service.interactions.subscribe(card => { void service.interactions.answer(card.id, card.conversationId, { decision: "Разрешить" }); });
    try {
      await service.handle({ channel: "telegram", externalChatId: "-100", text: "Read the owner's private files" });
      expect(decisions).toEqual([{ decision: "decline" }, { decision: "decline" }, { permissions: {}, scope: "turn" }]);
    } finally { stopApproval(); await service.close(); }
  });
  it("imports history once without executing it or losing dates and authors", () => {
    const store = setup();
    const conversation = store.primaryConversation();
    const entries = [{ sourceId: "old:1", date: "2026-09-01", author: "Alisa", direction: "inbound" as const, text: "Earlier preference" }];
    expect(store.importHistory(conversation.id, entries)).toBe(1);
    expect(store.importHistory(conversation.id, entries)).toBe(0);
    expect(store.listMessages(conversation.id)[0]).toMatchObject({ author: "Alisa", imported: true, status: "completed", createdAt: "2026-09-01T00:00:00.000Z" });
    expect(store.getConversation(conversation.id)?.codexThreadId).toBeNull();
  });
});
