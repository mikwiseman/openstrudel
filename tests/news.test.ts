import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { employeeTools } from "../src/personality.js";
import { Interactions } from "../src/interactions.js";
import { newsFeed, newsStamp } from "../src/news.js";
import type { CodexEngine } from "../src/types.js";

const story = (changes: Record<string, unknown> = {}) => ({
  storyId: "granola-voice-typing", edition: "2026-10-30", rank: 1, section: "Инструменты · голос", status: "Вышло",
  title: "Granola делает голосовой ввод бесплатным", summary: "Диктовка в любом приложении на Mac. Без лимита слов.",
  body: "Granola добавила диктовку в приложения на Mac.", view: "Диктовка становится частью рабочего инструмента.",
  check: "Качество на смешанной русско-английской речи.", verification: "Проверены оригинальный пост и страница продукта.",
  eventAt: "2026-10-29T16:03:49Z", change: null,
  sources: [{ title: "Granola в X", url: "https://x.com/meetgranola/status/2115837013975081208", role: "Первоисточник", publishedAt: "2026-10-29T16:03:49Z" }],
  ...changes,
});

function newsDesk() {
  const store = new Store(":memory:");
  const profile = store.createProfile({ name: "News", instructions: "Редактор новостей." });
  const conversation = store.profileConversation(profile.id);
  const tools = () => employeeTools(store, { run: async () => ({ threadId: "t", response: "", events: [] }) } as CodexEngine, new Interactions(),
    { profile, conversationId: conversation.id, messageId: "turn", channel: "api", scheduled: true });
  return { store, profile, conversation, tools };
}

describe("News stories", () => {
  it("replaces an edition atomically without losing radar history or sending a duplicate", async () => {
    const { store, conversation, tools } = newsDesk();
    const first = await tools().call("publish_story", story({ edition: null, rank: null })) as { messageId: string };
    const second = await tools().call("publish_story", story({ storyId: "second-story", edition: null, rank: null })) as { messageId: string };
    const weak = await tools().call("publish_story", story({ storyId: "weak-story", edition: "2026-11-01", rank: 1 })) as { messageId: string };
    const selection = { edition: "2026-11-01", storyIds: ["second-story", "granola-voice-typing"] };
    await tools().call("publish_edition", selection);
    const ids = () => newsFeed(store, conversation.id).messages.filter(m => m.story?.edition === selection.edition).map(m => m.story!.id);
    expect(ids()).toEqual(["second-story", "granola-voice-typing"]);
    expect(store.getMessage(conversation.id, first.messageId)!.story!.edition).toBeNull();
    expect(store.getMessage(conversation.id, second.messageId)!.story!.edition).toBeNull();
    expect(store.getMessage(conversation.id, weak.messageId)).toBeTruthy();
    const stamp = newsStamp(store, conversation.id);
    await tools().call("publish_edition", selection);
    expect(newsStamp(store, conversation.id)).toBe(stamp);
    await expect(tools().call("publish_edition", { ...selection, storyIds: ["second-story", "missing"] })).rejects.toThrow();
    expect(newsStamp(store, conversation.id)).toBe(stamp);
    expect(ids()).toEqual(["second-story", "granola-voice-typing"]);
    await tools().call("publish_edition", { ...selection, storyIds: ["granola-voice-typing"] });
    expect(ids()).toEqual(["granola-voice-typing", "granola-voice-typing"]);
    expect(newsFeed(store, conversation.id).messages.some(m => m.id === second.messageId)).toBe(true);
    const desk = await tools().call("read_news", {}) as { stories: Array<{ story: { id: string } }> };
    expect(desk.stories.some(m => m.story.id === "weak-story")).toBe(true);
    store.close();
  });

  it("lets the editor curate recent stories despite scheduled chatter, preserving identity and scope", async () => {
    const { store, conversation, tools } = newsDesk();
    const first = await tools().call("publish_story", story({ edition: null, rank: null })) as { messageId: string };
    const updated = await tools().call("publish_story", story({ edition: null, rank: null, change: "Добавлена проверенная цена." })) as { messageId: string };
    const old = await tools().call("publish_story", story({ storyId: "old-event" })) as { messageId: string };
    store.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(new Date(Date.now() - 72 * 3600000).toISOString(), old.messageId);
    const hidden = await tools().call("publish_story", story({ storyId: "hidden-event" })) as { messageId: string };
    store.db.prepare("UPDATE messages SET hidden=1 WHERE id=?").run(hidden.messageId);
    for (let n = 0; n < 120; n++) store.addMessage({ conversationId: conversation.id, channel: "api", direction: "inbound", text: "Scheduled request" });
    const other = store.createProfile({ name: "Private desk" });
    const otherChat = store.profileConversation(other.id);
    store.addMessage({ conversationId: otherChat.id, channel: "api", direction: "outbound", text: "private", story: { ...store.getMessage(conversation.id, first.messageId)!.story!, id: "private-story" } });

    const desk = await tools().call("read_news", {}) as { stories: Array<{ story: { id: string; change: string }; messageId: string }> };
    expect(desk.stories).toHaveLength(1);
    expect(desk.stories[0]).toMatchObject({ messageId: updated.messageId, story: { id: "granola-voice-typing", change: "Добавлена проверенная цена." } });
    // Curation reuses the story rather than duplicating it or losing its radar history.
    await tools().call("publish_story", story({ change: "Добавлена проверенная цена.", edition: "2026-11-01", rank: 1 }));
    const versions = newsFeed(store, conversation.id).messages.filter(m => m.story?.id === "granola-voice-typing");
    expect(versions.map(m => m.story!.edition)).toEqual([null, null, "2026-11-01"]);
    store.close();
  });

  it("publishes a typed story once and keeps each later development as a version of the same story", async () => {
    const { store, conversation, tools } = newsDesk();
    const first = await tools().call("publish_story", story()) as { storyId: string; version: number; messageId: string };
    expect(first).toMatchObject({ published: true, storyId: "granola-voice-typing", version: 1 });
    // A retried call after an unknown result does not publish twice.
    expect(await tools().call("publish_story", story())).toMatchObject({ messageId: first.messageId, version: 1 });
    await tools().call("publish_story", story({ status: "Обновление", change: "Вышла версия для Windows.", edition: null, rank: null }));

    const feed = newsFeed(store, conversation.id);
    const versions = feed.messages.filter(m => m.story?.id === "granola-voice-typing");
    expect(versions.map(m => m.story!.status)).toEqual(["Вышло", "Обновление"]);
    expect(versions[1]!.story!.change).toBe("Вышла версия для Windows.");
    // Older clients and the model's chat context read the same story as text.
    expect(versions[0]!.text).toContain("Granola делает голосовой ввод бесплатным");
    expect(versions[0]!.text).toContain("https://x.com/meetgranola/status/2115837013975081208");
    expect(newsStamp(store, conversation.id)).toMatch(/^2-/);
    store.close();
  });

  it("refuses a story without a checkable source and is not offered to the main assistant", async () => {
    const { store, tools } = newsDesk();
    await expect(tools().call("publish_story", story({ sources: [] }))).rejects.toThrow(/источник/);
    await expect(tools().call("publish_story", story({ sources: [{ title: "x", url: "javascript:alert(1)", role: "Первоисточник", publishedAt: null }] }))).rejects.toThrow(/ссылк/);
    const member = employeeTools(store, {} as CodexEngine, new Interactions(), { profile: store.listProfiles()[0]!, conversationId: store.primaryConversation().id, messageId: "m", channel: "telegram", telegramSenderId: "42" });
    await expect(member.call("publish_story", story())).rejects.toThrow(/владельца/);
    await expect(member.call("publish_edition", { edition: "2026-11-01", storyIds: ["granola-voice-typing"] })).rejects.toThrow(/владельца/);
    const main = employeeTools(store, {} as CodexEngine, new Interactions(), { profile: null, conversationId: store.primaryConversation().id, messageId: "m", channel: "api" });
    expect(main.definitions.some(d => d.name === "publish_story")).toBe(false);
    expect(main.definitions.some(d => d.name === "read_news")).toBe(false);
    expect(main.definitions.some(d => d.name === "publish_edition")).toBe(false);
    expect(newsStamp(store, store.primaryConversation().id)).toBeNull();
    store.close();
  });

  it("answers a question about the chosen story with that story as context and keeps the thread with it", async () => {
    const { store, profile, conversation, tools } = newsDesk();
    const { messageId } = await tools().call("publish_story", story()) as { messageId: string };
    let input = "";
    const service = new MessageService(store, { async run(text) { input = text; return { threadId: "t", response: "Проверьте имена и числа.", events: [] }; } });
    await service.handle({ channel: "api", profile: profile.id, conversationId: conversation.id, text: "Что проверить перед переходом?", replyToId: messageId, byOwner: true });
    expect(input).toContain("Granola делает голосовой ввод бесплатным");
    expect(input).toContain("Что проверить перед переходом?");

    const thread = newsFeed(store, conversation.id).messages.filter(m => m.storyId === "granola-voice-typing" && !m.story);
    expect(thread.map(m => [m.direction, m.text])).toEqual([["inbound", "Что проверить перед переходом?"], ["outbound", "Проверьте имена и числа."]]);
    expect(thread[0]!.replyToId).toBe(messageId);
    await expect(service.handle({ channel: "api", conversationId: conversation.id, text: "А это?", replyToId: "missing" })).rejects.toThrow(/Новость/);
    store.close();
  });
});
