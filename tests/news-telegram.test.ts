import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { Scheduler } from "../src/scheduler.js";
import { employeeTools } from "../src/personality.js";
import { TelegramAdapter } from "../src/telegram.js";
import { newsFeed, newsStamp } from "../src/news.js";
import { buttonStory, draftReply, editionPost, storyCard } from "../src/news-telegram.js";
import { saveOwnerTimezone } from "../src/timezone.js";
import { telegramText } from "../src/telegram-format.js";
import type { CodexEngine, NewsStory } from "../src/types.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const story = (changes: Record<string, unknown> = {}) => ({
  storyId: "voice-typing-free", edition: null, rank: null, section: "Инструменты", status: "Вышло",
  title: "Диктовка на Mac стала бесплатной и безлимитной", summary: "Приложение для заметок открыло диктовку в любом окне на Mac.\n\nЛимита слов нет, платный план для этого не нужен.",
  body: "Диктовка работает в любом приложении на Mac.", view: "Голосовой ввод становится частью рабочего инструмента, а не отдельной подпиской.",
  check: null, verification: "Прочитаны анонс и страница продукта.", eventAt: "2026-11-10T08:03:00Z", change: null,
  sources: [{ title: "анонс", url: "https://example.com/blog/voice-typing", role: "Первоисточник", publishedAt: null },
    { title: "The Example Times", url: "https://news.example.org/2026/voice", role: "Перепечатка", publishedAt: null }],
  telegram: "card", image: null, ...changes,
});

/** A News desk whose schedule delivers to the group -100, with every Telegram request recorded. */
function desk(at = "2026-11-10T09:00:00Z") {
  vi.useFakeTimers({ now: new Date(at), toFake: ["Date"] });
  const root = mkdtempSync(join(tmpdir(), "news-telegram-"));
  const store = new Store(join(root, "test.sqlite"));
  const engine = { run: async () => ({ threadId: "t", response: "", events: [] }) } as CodexEngine;
  const messages = new MessageService(store, engine, root);
  const telegram = new TelegramAdapter("1:fixture", store, messages); messages.telegram = telegram;
  const calls: Array<{ method: string; body: Record<string, any> }> = [];
  const refusing = new Set<string>();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    const method = String(url).split("/").at(-1)!;
    calls.push({ method, body: JSON.parse(init.body) });
    return refusing.has(method)
      ? Response.json({ ok: false, error_code: 400, description: "Bad Request: unsupported" }, { status: 400 })
      : Response.json({ ok: true, result: { message_id: 100 + calls.length } });
  }));
  saveOwnerTimezone(store, "Europe/Moscow");
  const profile = store.createProfile({ name: "News", instructions: "Редактор новостей." });
  const conversation = store.profileConversation(profile.id);
  store.linkTelegramChat({ chatId: "-100", title: "Reader group", allowedSenders: [] });
  store.bindTelegramChat("-100", profile.id);
  const tools = (scheduled = true) => employeeTools(store, engine, messages.interactions, { profile, conversationId: conversation.id, messageId: "turn", channel: "api",
    scheduled, byOwner: !scheduled, ...scheduled ? { scheduleTelegramChatId: "-100" } : {}, telegram, files: messages.files, scope: messages.contextFor(conversation.id) });
  const publish = (changes: Record<string, unknown> = {}) => tools().call("publish_story", story(changes)) as Promise<{ messageId: string; telegram: Record<string, unknown> | null }>;
  const close = async () => { telegram.stop(); await messages.close(); store.close(); rmSync(root, { recursive: true, force: true }); };
  return { store, messages, profile, conversation, tools, publish, calls, refusing, close };
}

describe("News in Telegram", () => {
  it("writes a story's post itself and sends it once, silently, with the first source as its preview", async () => {
    const { publish, tools, calls, close } = desk();
    try {
      const first = await publish();
      expect(first.telegram).toEqual({ sent: true, kind: "card", telegramMessageId: "101" });
      expect(calls.map(call => call.method)).toEqual(["sendMessage"]);
      const { text, entities, link_preview_options, disable_notification, chat_id } = calls[0]!.body;
      expect(chat_id).toBe("-100");
      expect(text.split("\n\n")).toEqual(["Диктовка на Mac стала бесплатной и безлимитной", "Приложение для заметок открыло диктовку в любом окне на Mac.",
        "Лимита слов нет, платный план для этого не нужен.", "→ Голосовой ввод становится частью рабочего инструмента, а не отдельной подпиской.",
        expect.stringMatching(/^анонс · The Example Times · 10 ноября.+11:03$/)]);
      expect(entities).toContainEqual({ type: "bold", offset: 0, length: "Диктовка на Mac стала бесплатной и безлимитной".length });
      expect(entities.filter((e: { type: string }) => e.type === "text_link").map((e: { url: string }) => e.url)).toEqual(["https://example.com/blog/voice-typing", "https://news.example.org/2026/voice"]);
      expect(link_preview_options).toEqual({ url: "https://example.com/blog/voice-typing", prefer_large_media: true });
      expect(disable_notification).toBe(true);
      // The same call again, as after an unknown result, publishes and sends nothing more.
      expect((await publish()).telegram).toMatchObject({ sent: false, already: expect.any(String) });
      expect(calls).toHaveLength(1);
      expect(await tools().call("read_news", {})).toMatch(/^voice-typing-free \| .+ \| Telegram 2026-11-10T09:00Z \| /);
      // A story kept for the app and the edition never reaches the chat.
      expect((await publish({ storyId: "edition-only", telegram: null, sources: [story().sources[1]] })).telegram).toBeNull();
      expect(calls).toHaveLength(1);
      expect(await tools().call("read_news", {})).toMatch(/^edition-only \| .+ \| not in Telegram \| /m);
    } finally { await close(); }
  });

  it("puts a story's picture on top of its post, and sends the post as text when Telegram cannot take the picture", async () => {
    const { publish, calls, refusing, close } = desk();
    try {
      const chart = "https://example.com/charts/remote-work.png?v=2&size=large";
      const shown = await publish({ image: chart });
      expect(shown.telegram).toEqual({ sent: true, kind: "card", telegramMessageId: "101" });
      expect(calls.map(call => call.method)).toEqual(["sendRichMessage"]);
      expect(calls[0]!.body.disable_notification).toBe(true);
      const html = calls[0]!.body.rich_message.html as string;
      expect(html.startsWith('<img src="https://example.com/charts/remote-work.png?v=2&amp;size=large"/><p><b>Диктовка на Mac стала бесплатной и безлимитной</b></p><p>Приложение для заметок открыло диктовку в любом окне на Mac.</p>')).toBe(true);
      expect(html).toContain('<p>→ Голосовой ввод становится частью рабочего инструмента, а не отдельной подпиской.</p><p><a href="https://example.com/blog/voice-typing">анонс</a> · <a href="https://news.example.org/2026/voice">The Example Times</a> · 10 ноября');
      // A development still answers under that post.
      const update = await publish({ image: chart, status: "Обновление", change: "Вышла версия для Windows." });
      expect(update.telegram).toMatchObject({ sent: true, kind: "update" });
      expect(calls[1]!.method).toBe("sendMessage");
      expect(calls[1]!.body.reply_parameters).toMatchObject({ message_id: 101 });
      // A picture Telegram cannot fetch costs the picture, not the post.
      refusing.add("sendRichMessage");
      const plain = await publish({ storyId: "broken-picture", image: "https://example.com/missing.png", sources: [{ title: "анонс", url: "https://example.com/blog/other", role: "Первоисточник", publishedAt: null }] });
      expect(plain.telegram).toMatchObject({ sent: true, kind: "card" });
      expect(calls.slice(2).map(call => call.method)).toEqual(["sendRichMessage", "sendMessage"]);
      expect(calls[3]!.body.link_preview_options).toEqual({ url: "https://example.com/blog/other", prefer_large_media: true });
      // Only a real https link is a picture.
      await expect(publish({ storyId: "bad-picture", image: "http://example.com/a.png" })).rejects.toThrow(/https/);
      await expect(publish({ storyId: "bad-picture", image: "график" })).rejects.toThrow(/картинк/);
      // Telegram refuses a picture from its own file storage, so the editor is told to take it from the source's page.
      await expect(publish({ storyId: "bad-picture", image: "https://cdn1.telesco.pe/file/abc.jpg" })).rejects.toThrow(/источника/);
    } finally { await close(); }
  });

  it("sends a development as a reply under the story's first post and refuses the same event under a second name", async () => {
    const { publish, calls, close } = desk();
    try {
      await publish();
      const update = await publish({ status: "Обновление", change: "Вышла версия для Windows, тоже без лимита." });
      expect(update.telegram).toEqual({ sent: true, kind: "update", telegramMessageId: "102" });
      expect(calls[1]!.body).toMatchObject({ reply_parameters: { message_id: 101, allow_sending_without_reply: true }, disable_notification: true, link_preview_options: { is_disabled: true } });
      expect(calls[1]!.body.text).toMatch(/^↻ Обновление\n\nВышла версия для Windows, тоже без лимита\.\n\nанонс · /);
      // Another storyId for the page that already went out stays in the app and says which story to develop.
      const twin = await publish({ storyId: "free-dictation-again", title: "Диктовку сделали бесплатной" });
      expect(twin.telegram).toMatchObject({ sent: false, sameSourceAs: "voice-typing-free" });
      expect(calls).toHaveLength(2);
      const other = await publish({ storyId: "another-event", sources: [{ title: "анонс", url: "https://example.com/blog/another", role: "Первоисточник", publishedAt: null }] });
      expect(other.telegram).toMatchObject({ sent: true, kind: "card" });
    } finally { await close(); }
  });

  it("keeps sound for the day's first two must-know stories, in the owner's daytime", async () => {
    const day = desk("2026-11-10T09:00:00Z");
    const alert = (publish: typeof day.publish, n: number) => publish({ storyId: `alert-${n}`, telegram: "alert", sources: [{ title: "анонс", url: `https://example.com/alert-${n}`, role: "Первоисточник", publishedAt: null }] });
    try {
      expect((await alert(day.publish, 1)).telegram).toMatchObject({ sent: true, kind: "alert" });
      expect((await alert(day.publish, 2)).telegram).toMatchObject({ sent: true, kind: "alert" });
      expect((await alert(day.publish, 3)).telegram).toMatchObject({ sent: true, kind: "card" });
      expect(day.calls.map(call => call.body.disable_notification)).toEqual([undefined, undefined, true]);
    } finally { await day.close(); }
    // 23:30 in Moscow: the story goes out, without sound.
    const night = desk("2026-11-10T20:30:00Z");
    try {
      expect((await alert(night.publish, 1)).telegram).toMatchObject({ sent: true, kind: "card" });
      expect(night.calls[0]!.body.disable_notification).toBe(true);
    } finally { await night.close(); }
  });

  it("keeps the story published when Telegram refuses its post, and does not try again", async () => {
    const { publish, tools, store, conversation, calls, refusing, close } = desk();
    try {
      refusing.add("sendMessage");
      const refused = await publish();
      expect(refused.telegram).toMatchObject({ sent: false, reason: expect.stringMatching(/refused/) });
      expect(newsFeed(store, conversation.id).messages.map(m => m.story?.id)).toEqual(["voice-typing-free"]);
      expect(await tools().call("read_news", {})).toMatch(/ \| not in Telegram \| /);
      refusing.clear();
      expect((await publish({ status: "Обновление", change: "Новая цена." })).telegram).toMatchObject({ sent: false, reason: expect.stringMatching(/refused/) });
      expect(calls).toHaveLength(1);
    } finally { await close(); }
  });

  it("shows the editor what readers left on a story's post, and nothing about other messages", async () => {
    const { store, messages, publish, tools, close } = desk();
    try {
      await publish();
      await publish({ status: "Обновление", change: "Вышла версия для Windows." });
      const telegram = messages.telegram!;
      const react = (id: number, message: number, user: { id: number; first_name: string; is_bot?: boolean }, ...emoji: string[]) =>
        telegram.processUpdate({ update_id: id, message_reaction: { chat: { id: -100 }, message_id: message, user, new_reaction: emoji.map(e => ({ type: "emoji", emoji: e })) } });
      await react(1, 101, { id: 7, first_name: "Ann" }, "🔥");
      // A reaction to the reply that carried a development belongs to the same story.
      await react(2, 102, { id: 8, first_name: "Ben" }, "👎");
      await react(3, 999, { id: 7, first_name: "Ann" }, "👍");
      await react(4, 101, { id: 9, first_name: "Helper", is_bot: true }, "👍");
      expect(await tools().call("read_news", {})).toMatch(/^voice-typing-free \| .+ \| https:\/\/example\.com\/blog\/voice-typing \| 🔥 Ann · 👎 Ben$/);
      expect(await tools().call("read_news", { storyId: "voice-typing-free" })).toMatchObject({ reactions: "🔥 Ann · 👎 Ben" });
      // A changed mind replaces the reaction; a removed one leaves nothing.
      await react(5, 101, { id: 7, first_name: "Ann" }, "🤔");
      await react(6, 102, { id: 8, first_name: "Ben" });
      expect(await tools().call("read_news", {})).toMatch(/ \| 🤔 Ann$/);
    } finally { await close(); }
  });

  it("treats story text as plain text whatever characters it holds", () => {
    const title = "Модель *v2_beta* [почти](x) готова: 1. быстрее #всех & <дешевле> — на 30%!";
    const [post] = telegramText(storyCard({ ...story(), id: "x", title, summary: "- не список\n\n> не цитата `и не код`", view: null } as unknown as NewsStory, "Europe/Moscow"));
    expect(post!.text.split("\n\n").slice(0, 3)).toEqual([title, "- не список", "> не цитата `и не код`"]);
    expect(post!.entities.filter(e => e.type !== "text_link")).toEqual([{ type: "bold", offset: 0, length: title.length }]);
    // A line that begins like a heading, a list or a rule stays a line of text, and ordinary punctuation is left alone,
    // so the copy the Home keeps reads as the post does.
    const lines = "1. первый пункт\n\n# не заголовок\n\n+ не список\n\n=== не черта\n\n2026) год\n\nFable 5.2 стоит $8/$40 (на 20% дешевле) — это не всё!";
    const card = storyCard({ ...story(), id: "y", title: "Fable 5.2: цена ниже на 20%", summary: lines, view: null } as unknown as NewsStory, "Europe/Moscow");
    expect(card).toContain("**Fable 5.2: цена ниже на 20%**");
    expect(card).toContain("Fable 5.2 стоит $8/$40 (на 20% дешевле) — это не всё!");
    const [rendered] = telegramText(card);
    expect(rendered!.text.split("\n\n").slice(1, 7)).toEqual(lines.split("\n\n"));
    expect(rendered!.entities.filter(e => e.type !== "text_link")).toEqual([{ type: "bold", offset: 0, length: "Fable 5.2: цена ниже на 20%".length }]);
  });

  it("sends today's edition once as one rich message: the lead in full, the rest under their sections", async () => {
    const { publish, tools, calls, close } = desk("2026-11-10T03:50:00Z");
    try {
      const kept = (id: string, title: string, section: string) => publish({ storyId: id, title, section, telegram: null,
        sources: [{ title: "анонс", url: `https://example.com/${id}`, role: "Первоисточник", publishedAt: null }] });
      await kept("lead-one", "Первая главная история <дня> & её цена", "Модели");
      await kept("lead-two", "Вторая главная история", "Деньги");
      await kept("tool-a", "Инструмент А научился новому", "Инструменты");
      await kept("money-a", "Сделка на миллиард", "Деньги");
      await kept("tool-b", "Инструмент Б подешевел", "Инструменты");
      const selection = { edition: "2026-11-10", storyIds: ["lead-one", "lead-two", "tool-a", "money-a", "tool-b"], title: "AI-дайджест", intro: "Вчера в радаре было две карточки. Ниже только новое.", top: 2 };
      const sent = await tools().call("publish_edition", selection) as { telegram: Record<string, unknown> };
      expect(sent.telegram).toEqual({ sent: true, kind: "edition", telegramMessageId: "101" });
      expect(calls.map(call => call.method)).toEqual(["sendRichMessage"]);
      expect(calls[0]!.body.disable_notification).toBeUndefined();
      const html = calls[0]!.body.rich_message.html as string;
      expect(html.startsWith("<h1>AI-дайджест · вторник, 10 ноября</h1><p>Вчера в радаре было две карточки. Ниже только новое.</p><h2>Главное</h2><h3>1. Первая главная история &lt;дня&gt; &amp; её цена</h3>")).toBe(true);
      // A lead story is its headline, what happened and why it matters; a story under a section opens to its whole account.
      expect(html).toContain('<h3>2. Вторая главная история</h3><p>Приложение для заметок открыло диктовку в любом окне на Mac.</p><p>→ Голосовой ввод');
      expect(html).toContain('<details><summary>4. Сделка на миллиард</summary><p>Приложение для заметок открыло диктовку в любом окне на Mac.</p><p>Лимита слов нет, платный план для этого не нужен.</p><p>→ Голосовой ввод');
      expect(html).toContain('<p><a href="https://example.com/lead-two">анонс</a></p>');
      // Sections come in the order of their first story; the numbers are the edition's ranks.
      expect([...html.matchAll(/<h2>([^<]+)<\/h2>|<summary>([^<]+)<\/summary>/g)].map(m => m[1] ?? m[2]))
        .toEqual(["Главное", "Инструменты", "3. Инструмент А научился новому", "5. Инструмент Б подешевел", "Деньги", "4. Сделка на миллиард"]);
      expect(html.endsWith("<footer>Это всё на сегодня · 5 историй</footer>")).toBe(true);
      // A revised selection changes the app and sends nothing more.
      const again = await tools().call("publish_edition", { ...selection, storyIds: ["lead-two", "lead-one"] }) as { telegram: Record<string, unknown> };
      expect(again.telegram).toMatchObject({ sent: false, already: expect.any(String) });
      expect(calls).toHaveLength(1);
    } finally { await close(); }
  });

  it("sends the edition as ordinary text when Telegram refuses the rich message, and never an edition of another day", async () => {
    const { publish, tools, calls, refusing, close } = desk("2026-11-10T03:50:00Z");
    try {
      await publish({ telegram: null });
      refusing.add("sendRichMessage");
      const yesterday = await tools().call("publish_edition", { edition: "2026-11-09", storyIds: ["voice-typing-free"], title: null, intro: null, top: null }) as { telegram: Record<string, unknown> };
      expect(yesterday.telegram).toMatchObject({ sent: false });
      expect(calls).toHaveLength(0);
      const today = await tools().call("publish_edition", { edition: "2026-11-10", storyIds: ["voice-typing-free"], title: null, intro: null, top: null }) as { telegram: Record<string, unknown> };
      expect(today.telegram).toMatchObject({ sent: true, kind: "edition", telegramMessageId: "102" });
      expect(calls.map(call => call.method)).toEqual(["sendRichMessage", "sendMessage"]);
      expect(calls[1]!.body.text).toMatch(/^News · вторник, 10 ноября\n\nГлавное\n\n1\. Диктовка на Mac стала бесплатной и безлимитной\n\n/);
      expect(calls[1]!.body.text).toMatch(/Это всё на сегодня · 1 история$/);
    } finally { await close(); }
  });

  it("fits a long day into one rich message without dropping a story", () => {
    const long = "Очень длинное предложение о событии. ".repeat(8).trim();
    const stories = Array.from({ length: 60 }, (_, n) => ({ ...story(), id: `story-${n}`, title: `История номер ${n} о важном событии дня`, summary: `${long}\n\n${long}`, section: `Раздел ${n % 6}` })) as unknown as NewsStory[];
    const post = editionPost({ edition: "2026-11-10", storyIds: stories.map(s => s.id) }, stories, "News", "Europe/Moscow");
    expect(post.html.length).toBeLessThanOrEqual(30_000);
    for (const item of stories) expect(post.html).toContain(item.title);
    // The lead keeps what happened and why it matters even on the longest day.
    expect(post.html).toContain(`<h3>1. История номер 0 о важном событии дня</h3><p>${long}</p><p>→ `);
  });

  it("tells the reader's app whether the desk is working", async () => {
    const { store, messages, conversation, publish, close } = desk();
    try {
      await publish({ telegram: null });
      expect(newsFeed(store, conversation.id).status).toBeUndefined();
      const scheduler = new Scheduler(store, messages);
      const radar = scheduler.save({ conversationId: conversation.id, name: "Radar", prompt: "Check.", cron: "5 * * * *", timezone: "Europe/Moscow", enabled: true, telegramChatId: "-100", delivery: "telegram" });
      const run = (id: string, status: string, at: string, error: string | null = null) => store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at,error) VALUES(?,?,?,?,?,?,?)")
        .run(id, radar.id, conversation.id, at, status, at, error);
      expect(newsFeed(store, conversation.id).status).toEqual({ running: false, checkedAt: null, failedAt: null, failure: null, nextRunAt: radar.nextRunAt });
      run("a", "quiet", "2026-11-10T07:05:00.000Z");
      const quiet = newsStamp(store, conversation.id);
      expect(newsFeed(store, conversation.id).status).toMatchObject({ checkedAt: "2026-11-10T07:05:00.000Z", failedAt: null });
      // A failure counts until a run succeeds again, and the app hears of each change.
      run("b", "failed", "2026-11-10T08:05:00.000Z", "Закончился недельный лимит.\nПодробности");
      expect(newsFeed(store, conversation.id).status).toMatchObject({ checkedAt: "2026-11-10T07:05:00.000Z", failedAt: "2026-11-10T08:05:00.000Z", failure: "Закончился недельный лимит. Подробности" });
      expect(newsStamp(store, conversation.id)).not.toBe(quiet);
      // Since when is the first failure after the last success; why is what the latest one said.
      run("b2", "failed", "2026-11-10T08:35:00.000Z", "Источники недоступны.");
      expect(newsFeed(store, conversation.id).status).toMatchObject({ failedAt: "2026-11-10T08:05:00.000Z", failure: "Источники недоступны." });
      run("c", "running", "2026-11-10T09:05:00.000Z");
      expect(newsFeed(store, conversation.id).status).toMatchObject({ running: true, failedAt: "2026-11-10T08:05:00.000Z" });
      store.db.prepare("UPDATE schedule_runs SET status='completed' WHERE id='c'").run();
      expect(newsFeed(store, conversation.id).status).toMatchObject({ running: false, checkedAt: "2026-11-10T09:05:00.000Z", failedAt: null, failure: null });
      // A paused desk has no next run.
      scheduler.save({ ...radar, enabled: false });
      expect(newsFeed(store, conversation.id).status).toMatchObject({ nextRunAt: null });
    } finally { await close(); }
  });

  it("sends an owner's request from the app to the chat the desk's schedules deliver to", async () => {
    const { store, messages, conversation, tools, calls, close } = desk();
    try {
      expect((await tools(false).call("publish_story", story()) as { telegram: Record<string, unknown> }).telegram).toMatchObject({ sent: false, reason: expect.stringMatching(/no Telegram chat/) });
      new Scheduler(store, messages).save({ conversationId: conversation.id, name: "Radar", prompt: "Check.", cron: "5 * * * *", timezone: "Europe/Moscow", enabled: true, telegramChatId: "-100", delivery: "telegram" });
      expect((await tools(false).call("publish_story", story({ status: "Обновление", change: "Уточнение." })) as { telegram: Record<string, unknown> }).telegram).toMatchObject({ sent: true, kind: "card" });
      expect(calls).toHaveLength(1);
    } finally { await close(); }
  });
});

it("parts a long text between paragraphs when it can", () => {
  const paragraph = "Слово ".repeat(100).trim();
  const chunks = telegramText(Array.from({ length: 20 }, () => paragraph).join("\n\n"));
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) { expect(chunk.text.startsWith("Слово")).toBe(true); expect(chunk.text.endsWith("Слово")).toBe(true); }
  expect(chunks.map(chunk => chunk.text).join("\n\n")).toBe(Array.from({ length: 20 }, () => paragraph).join("\n\n"));
  // An entity that spans the break is kept on both sides of it.
  const code = telegramText("```\n" + Array.from({ length: 20 }, () => paragraph).join("\n\n") + "\n```");
  expect(code.length).toBeGreaterThan(1);
  for (const chunk of code) expect(chunk.entities).toEqual([{ type: "pre", offset: 0, length: chunk.text.length }]);
});

describe("a post draft asked from a card", () => {
  it("puts one «Пост» button under a story's first post, naming the story within Telegram's 64 bytes", async () => {
    const { store, conversation, tools, calls } = desk();
    const published = await tools().call("publish_story", story()) as { messageId: string };
    const sent = calls.find(call => call.method === "sendMessage")!.body;
    const button = sent.reply_markup.inline_keyboard[0][0];
    expect(button.text).toBe("✍️ Пост");
    expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    expect(buttonStory(store, button.callback_data, "-100")).toEqual({ conversationId: conversation.id, storyId: "voice-typing-free" });
    expect(published.messageId).toBe(button.callback_data.slice(3));
  });

  it("answers a press only for a story the application posted to that chat", async () => {
    const { store, tools, calls } = desk();
    await tools().call("publish_story", story());
    const data = calls.find(call => call.method === "sendMessage")!.body.reply_markup.inline_keyboard[0][0].callback_data;
    expect(buttonStory(store, data, "-200")).toBeNull();
    expect(buttonStory(store, "np:unknown", "-100")).toBeNull();
    expect(buttonStory(store, "card:0:1", "-100")).toBeNull();
  });

  it("answers a press at once and puts the draft under the card, only for someone who may write in that chat", async () => {
    const { store, messages, publish, calls, close } = desk();
    try {
      await publish();
      const card = calls.find(call => call.method === "sendMessage")!, cardId = 100 + calls.indexOf(card) + 1;
      const data = card.body.reply_markup.inline_keyboard[0][0].callback_data;
      const press = (id: number, from: number) => messages.telegram!.processUpdate({ update_id: id, callback_query: { id: "q" + id, from: { id: from }, data, message: { message_id: cardId, chat: { id: -100 } } } });
      await press(1, 9);
      expect(calls.at(-1)).toMatchObject({ method: "answerCallbackQuery", body: { callback_query_id: "q1", text: "Попросить пост может участник этого чата" } });
      expect(calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
      store.db.prepare("UPDATE telegram_chats SET allowed_senders_json=? WHERE chat_id='-100'").run(JSON.stringify(["7"]));
      await press(2, 7);
      expect(calls.find(call => call.method === "answerCallbackQuery" && call.body.callback_query_id === "q2")!.body.text).toBe("Пишу черновик…");
      // The draft, or the line that it failed, answers under the card; the card keeps its button for another one.
      await vi.waitFor(() => expect(calls.some(call => call.method === "sendMessage" && call.body.reply_parameters?.message_id === cardId)).toBe(true));
      expect(calls.some(call => call.method === "editMessageReplyMarkup" || call.method === "editMessageText")).toBe(false);
    } finally { await close(); }
  });

  it("gives a development's reply and a picture card no button", async () => {
    const { tools, calls } = desk();
    await tools().call("publish_story", story());
    await tools().call("publish_story", story({ change: "Диктовка появилась и на Windows.", status: "Обновление" }));
    await tools().call("publish_story", story({ storyId: "chart-story", image: "https://example.com/chart.png", sources: [{ title: "отчёт", url: "https://example.com/report", role: "Первоисточник", publishedAt: null }] }));
    const [, reply] = calls.filter(call => call.method === "sendMessage");
    expect(reply!.body.reply_markup).toBeUndefined();
    expect(calls.find(call => call.method === "sendRichMessage")!.body.reply_markup).toBeUndefined();
  });

  it("writes the draft's reply as the post, the note after it, or one line when it failed", () => {
    const post = { id: "p", storyIds: ["a"], titles: ["A"], channel: "telegram" as const, text: "Текст поста.", note: "Канал уже писал об этом 3 ноября.", status: "ready" as const,
      error: null, createdAt: "", updatedAt: "", usedAt: null };
    expect(draftReply(post)).toBe("**Черновик поста**\n\nТекст поста.\n\n_Канал уже писал об этом 3 ноября\\._".replace("\\.", "."));
    expect(draftReply({ ...post, status: "failed", error: "Закончился лимит модели." })).toBe("Черновик не получился: Закончился лимит модели.");
  });
});
