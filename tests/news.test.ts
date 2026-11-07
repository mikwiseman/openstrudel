import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { employeeTools } from "../src/personality.js";
import { Interactions } from "../src/interactions.js";
import { TelegramAdapter } from "../src/telegram.js";
import { toolBridge } from "../src/acp-mcp.js";
import { newsFeed, newsStamp } from "../src/news.js";
import type { CodexEngine } from "../src/types.js";

afterEach(() => { vi.unstubAllGlobals(); });

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

/** Moves a stored message to `hours` ago. */
const age = (store: Store, messageId: string, hours: number) =>
  store.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(new Date(Date.now() - hours * 3_600_000).toISOString(), messageId);

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
    expect(await tools().call("read_news", {})).toMatch(/^weak-story \| /m);
    store.close();
  });

  it("lets the editor curate recent stories despite scheduled chatter, preserving identity and scope", async () => {
    const { store, conversation, tools } = newsDesk();
    const first = await tools().call("publish_story", story({ edition: null, rank: null })) as { messageId: string };
    const updated = await tools().call("publish_story", story({ edition: null, rank: null, change: "Добавлена проверенная цена." })) as { messageId: string };
    const old = await tools().call("publish_story", story({ storyId: "old-event" })) as { messageId: string };
    age(store, old.messageId, 73);
    const hidden = await tools().call("publish_story", story({ storyId: "hidden-event" })) as { messageId: string };
    store.db.prepare("UPDATE messages SET hidden=1 WHERE id=?").run(hidden.messageId);
    for (let n = 0; n < 120; n++) store.addMessage({ conversationId: conversation.id, channel: "api", direction: "inbound", text: "Scheduled request" });
    const other = store.createProfile({ name: "Private desk" });
    const otherChat = store.profileConversation(other.id);
    store.addMessage({ conversationId: otherChat.id, channel: "api", direction: "outbound", text: "private", story: { ...store.getMessage(conversation.id, first.messageId)!.story!, id: "private-story" } });

    expect(await tools().call("read_news", {})).toMatch(/^granola-voice-typing \| [^\n]+$/);
    expect(await tools().call("read_news", { storyId: "granola-voice-typing" })).toMatchObject({ messageId: updated.messageId, story: { id: "granola-voice-typing", change: "Добавлена проверенная цена." } });
    await expect(tools().call("read_news", { storyId: "hidden-event" })).rejects.toThrow(/не найдена/);
    await expect(tools().call("read_news", { storyId: "private-story" })).rejects.toThrow(/не найдена/);
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

  it("reads 72 hours as one short line per story, newest first, one story in full, and lets the edition reuse any of them", async () => {
    const { store, conversation, tools } = newsDesk();
    const publish = async (changes: Record<string, unknown>, hours: number) => {
      const { messageId } = await tools().call("publish_story", story({ edition: null, rank: null, ...changes })) as { messageId: string };
      age(store, messageId, hours);
      return messageId;
    };
    await publish({ storyId: "old-event", title: "Старое событие" }, 80);
    await publish({}, 70);
    await publish({ storyId: "shield-ai-echodyne", title: "Shield AI покупает\nEchodyne за $5,3 млрд", section: "Деньги и рынки", eventAt: "2026-11-05",
      sources: [{ title: "Bloomberg", url: "https://www.bloomberg.com/news/articles/2026-11-05/shield-ai", role: "Первоисточник", publishedAt: null }] }, 50);
    await publish({ storyId: "model-rumor", title: "Слух о новой модели", section: "Слухи", status: "Слух", eventAt: null }, 2);
    // A development moves its story to the top with its latest version.
    const latest = await publish({ title: "Granola открыла голосовой ввод на Windows", status: "Обновление", change: "Вышла версия для Windows." }, 1);

    expect(await tools().call("read_news", {})).toBe([
      "granola-voice-typing | 2026-10-29T16:03Z | Granola открыла голосовой ввод на Windows | Инструменты · голос | not in Telegram | https://x.com/meetgranola/status/2115837013975081208",
      "model-rumor | undated | Слух о новой модели | Слухи | not in Telegram | https://x.com/meetgranola/status/2115837013975081208",
      "shield-ai-echodyne | 2026-11-05 | Shield AI покупает Echodyne за $5,3 млрд | Деньги и рынки | not in Telegram | https://www.bloomberg.com/news/articles/2026-11-05/shield-ai",
    ].join("\n"));
    const full = store.getMessage(conversation.id, latest)!;
    expect(await tools().call("read_news", { storyId: "granola-voice-typing" })).toEqual({ messageId: latest, updatedAt: full.createdAt, telegram: null, story: full.story });
    // One story in full at any age; a story this reader never had is an error.
    expect(await tools().call("read_news", { storyId: "old-event" })).toMatchObject({ story: { id: "old-event", title: "Старое событие" } });
    await expect(tools().call("read_news", { storyId: "missing-story" })).rejects.toThrow(/не найдена/);
    // The edition takes any story the list shows, here one of 50 hours ago, and nothing older than its 72 hours.
    await tools().call("publish_edition", { edition: "2026-11-07", storyIds: ["shield-ai-echodyne", "granola-voice-typing"] });
    expect(newsFeed(store, conversation.id).messages.filter(m => m.story?.edition === "2026-11-07").map(m => m.story!.id)).toEqual(["shield-ai-echodyne", "granola-voice-typing"]);
    await expect(tools().call("publish_edition", { edition: "2026-11-07", storyIds: ["old-event"] })).rejects.toThrow(/не найдена/);
    store.close();
  });

  it("shows when a story first went out in a delivered Telegram post of this employee", async () => {
    const root = mkdtempSync(join(tmpdir(), "news-telegram-"));
    const store = new Store(join(root, "test.sqlite"));
    const engine = { run: async () => ({ threadId: "t", response: "", events: [] }) } as CodexEngine;
    const messages = new MessageService(store, engine, root);
    const telegram = new TelegramAdapter("1:fixture", store, messages); messages.telegram = telegram;
    let refuse = false;
    vi.stubGlobal("fetch", vi.fn(async () => refuse
      ? Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 })
      : Response.json({ ok: true, result: { message_id: 7 } })));
    try {
      const profile = store.createProfile({ name: "News", instructions: "Редактор новостей." });
      const conversation = store.profileConversation(profile.id);
      store.linkTelegramChat({ chatId: "-100", title: "Wai News", allowedSenders: [] });
      const group = store.bindTelegramChat("-100", profile.id);
      const tools = () => employeeTools(store, engine, messages.interactions, { profile, conversationId: conversation.id, messageId: "turn", channel: "api",
        scheduled: true, scheduleTelegramChatId: "-100", telegram, files: messages.files, scope: messages.contextFor(conversation.id) });
      const source = (url: string) => ({ title: "Источник", url, role: "Первоисточник", publishedAt: null });
      const publish = (storyId: string, ...urls: string[]) => tools().call("publish_story", story({ storyId, edition: null, rank: null, sources: urls.map(source) }));
      const post = async (title: string, url: string) => {
        const receipt = await tools().call("send_telegram_message", { chatId: "-100", text: `**${title}**\nЧто произошло.\n[П](${url})`, paths: [] }) as { sent: boolean; messageId: string };
        return { ...receipt, at: store.getMessage(group.conversationId!, receipt.messageId)!.createdAt };
      };
      const telegramOf = async () => Object.fromEntries((await tools().call("read_news", {}) as string).split("\n").map(line => [line.split(" | ")[0], line.split(" | ")[4]]));
      const minute = (iso: string) => iso.slice(0, 16) + "Z";

      // A changelog page that went out two hours before its new entry was published belongs to an earlier story.
      const earlier = await post("Gemini: старая запись", "https://ai.google.dev/gemini-api/docs/changelog");
      age(store, earlier.messageId, 2);
      await publish("gemini-computer-use", "https://ai.google.dev/gemini-api/docs/changelog");
      // The card links the story's second source, written with a trailing slash.
      await publish("granola-voice-typing", "https://x.com/meetgranola/status/2115837013975081208", "https://www.granola.ai/blog/voice-typing");
      const card = await post("Granola делает голосовой ввод бесплатным", "https://www.granola.ai/blog/voice-typing/");
      expect(card.sent).toBe(true);
      // A post linking a deeper page of the story's source is another story.
      await publish("cursor-changelog", "https://cursor.com/changelog");
      await post("Cursor собирает живое приложение", "https://cursor.com/changelog/build-live-apps");
      // Telegram refused this one, so it never went out.
      await publish("refused-story", "https://example.com/refused");
      refuse = true;
      expect(await post("Не дошло", "https://example.com/refused")).toMatchObject({ sent: false, status: "not_sent" });
      refuse = false;
      // Another employee's chat is not this reader's Telegram.
      const other = store.createProfile({ name: "Startups" });
      store.linkTelegramChat({ chatId: "-200", title: "Startups", allowedSenders: [] });
      const otherGroup = store.bindTelegramChat("-200", other.id);
      store.addMessage({ conversationId: otherGroup.conversationId!, channel: "telegram", direction: "outbound", text: "[П](https://example.com/other-desk)", externalId: "-200:send:fixture" });
      await publish("other-desk", "https://example.com/other-desk");

      expect(await telegramOf()).toEqual({ "other-desk": "not in Telegram", "refused-story": "not in Telegram", "cursor-changelog": "not in Telegram",
        "granola-voice-typing": `Telegram ${minute(card.at)}`, "gemini-computer-use": "not in Telegram" });
      expect(await tools().call("read_news", { storyId: "granola-voice-typing" })).toMatchObject({ telegram: card.at });
      // Its own card counts, and the first post stays its time.
      const gemini = await post("Gemini: computer use для всех", "https://ai.google.dev/gemini-api/docs/changelog");
      await post("Gemini: повтор", "https://ai.google.dev/gemini-api/docs/changelog");
      expect((await telegramOf())["gemini-computer-use"]).toBe(`Telegram ${minute(gemini.at)}`);
    } finally { telegram.stop(); await messages.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("fits 100 Russian stories into the first 18,000 bytes Grok keeps of an MCP result", async () => {
    const { store, profile, tools } = newsDesk();
    store.linkTelegramChat({ chatId: "-100", title: "Wai News", allowedSenders: [] });
    const group = store.bindTelegramChat("-100", profile.id);
    for (let n = 1; n <= 100; n++) {
      const id = `story-${String(n).padStart(3, "0")}`, url = `https://example.com/news/2026/11/${id}`;
      const { messageId } = await tools().call("publish_story", story({ storyId: id, edition: null, rank: null, section: "Модели и инструменты", eventAt: "2026-11-05T12:00:00Z",
        title: `Модель номер ${n} научилась писать код быстрее предшественницы и стала вдвое дешевле`, sources: [{ title: "Источник", url, role: "Первоисточник", publishedAt: null }] })) as { messageId: string };
      age(store, messageId, 71 - n * 0.7);
      // Every third story went out as a card six minutes later.
      if (n % 3 === 0) age(store, store.addMessage({ conversationId: group.conversationId!, channel: "telegram", direction: "outbound", text: `**Модель ${n}**\n[П](${url})`, externalId: `-100:send:${id}` }).id, 70.9 - n * 0.7);
    }
    // What an MCP client such as Grok receives from the turn's tool bridge.
    const bridge = await toolBridge(tools());
    const client = new Client({ name: "grok", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { authorization: `Bearer ${bridge.token}` } } }));
    try {
      const result = await client.callTool({ name: "read_news", arguments: {} }) as { content: Array<{ type: string; text: string }> };
      const text = result.content[0]!.text;
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(18_000);
      expect(Buffer.byteLength(text)).toBeGreaterThan(17_500);
      const lines = (JSON.parse(text) as string).split("\n"), shown = lines.slice(0, -1);
      expect(lines.at(-1)).toBe(`+${100 - shown.length} older stories omitted`);
      expect(shown.map(line => line.split(" | ")[0])).toEqual(shown.map((_, index) => `story-${String(100 - index).padStart(3, "0")}`));
      expect(shown[0]).toBe("story-100 | 2026-11-05T12:00Z | Модель номер 100 научилась писать код быстрее предшественницы и стала вдвое дешевле | Модели и инструменты | not in Telegram | https://example.com/news/2026/11/story-100");
      expect(shown[1]).toMatch(/^story-099 \| 2026-11-05T12:00Z \| .+ \| Модели и инструменты \| Telegram \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z \| https:\/\/example\.com\/news\/2026\/11\/story-099$/);
    } finally { await client.close(); await bridge.close(); store.close(); }
  });
});
