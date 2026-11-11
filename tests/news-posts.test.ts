import { describe, expect, it, vi } from "vitest";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { newsFeed, publishStory } from "../src/news.js";
import { POST_BRIEF } from "../src/news-posts.js";
import type { CodexEngine } from "../src/types.js";

const story = (changes: Record<string, unknown> = {}) => ({
  storyId: "maple-3-weights", edition: null, rank: null, section: "Модели", status: "Вышло",
  title: "«Северный мост» открыл веса модели «Клён 3»", summary: "Модель вышла под свободной лицензией в трёх размерах.\n\nМладшая работает на ноутбуке со скоростью разговора.",
  body: "Старшая версия на тестах компании обходит прежний «Клён».", view: "Младшая версия важнее старшей: локальная работа с кодом становится обычной.",
  check: "Независимых замеров пока нет.", verification: "Прочитаны анонс и карточка модели.", eventAt: "2026-11-10T08:03:00Z", change: null,
  sources: [{ title: "анонс", url: "https://example.com/blog/maple-3", role: "Первоисточник", publishedAt: null }],
  telegram: null, image: null, numbers: [{ value: "3", label: "размера модели под свободной лицензией" }], topics: ["Северный мост", "Клён 3"], ...changes,
});

type Post = { id: string; storyIds: string[]; titles: string[]; channel: string; text: string; note: string | null; status: string; error: string | null; createdAt: string; updatedAt: string; usedAt: string | null };

/** A Home with a News desk whose engine answers a post request when the test lets it. */
async function home() {
  const turns: Array<{ input: string; options: Record<string, any>; finish: (answer: string | Error) => void }> = [];
  const engine: CodexEngine = { run: (input, options) => new Promise((resolve, reject) => {
    turns.push({ input, options: options ?? {}, finish: answer => answer instanceof Error ? reject(answer) : resolve({ threadId: "thread-" + turns.length, response: answer, events: [] }) });
  }) };
  const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", startTelegram: false, apiToken: "owner", engine });
  const address = await runtime.api.listen("127.0.0.1", 0);
  const owner = { authorization: "Bearer owner" };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = owner) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...body === undefined ? {} : { body: JSON.stringify(body) } });
  const desk = runtime.store.createProfile({ name: "News", instructions: "Редактор новостей. Голос владельца описан в voice/guide.md." });
  const chat = runtime.store.profileConversation(desk.id);
  const posts = `/v1/conversations/${chat.id}/posts`;
  const list = async () => (await (await call("GET", posts)).json() as { posts: Post[] }).posts;
  /** The next turn the engine was given, once it has it. */
  const turn = async (index: number) => { await vi.waitFor(() => expect(turns.length).toBeGreaterThan(index)); return turns[index]!; };
  const settled = async (id: string, status: string) => { await vi.waitFor(async () => expect((await list()).find(post => post.id === id)?.status).toBe(status)); return (await list()).find(post => post.id === id)!; };
  const stop = async () => {
    for (let n = 0; n < 5 && runtime.messages.hasActiveRuns; n++) { turns.forEach(each => each.finish("")); await new Promise(done => setTimeout(done, 10)); }
    await runtime.stop();
  };
  return { runtime, call, desk, chat, posts, list, turns, turn, settled, stop };
}

describe("News post drafts", () => {
  it("writes a post from the chosen stories on the desk's own turn, carrying the stories and nothing of the chat", async () => {
    const { runtime, call, chat, posts, list, turn, settled, stop } = await home();
    try {
      publishStory(runtime.store, chat.id, story());
      publishStory(runtime.store, chat.id, story({ status: "Обновление", title: "«Клён 3» получил независимый замер", change: "Вышел независимый замер: младшая версия держит 40 токенов в секунду." }));
      publishStory(runtime.store, chat.id, story({ storyId: "granite-price", title: "«Гранит» назвал цену ускорителя", section: "Чипы и вычисления", numbers: null, topics: ["Гранит"] }));
      runtime.store.addMessage({ conversationId: chat.id, channel: "api", direction: "inbound", text: "Старая просьба из чата редакции" });
      expect(await list()).toEqual([]);

      const asked = await call("POST", posts, { storyIds: ["maple-3-weights", "granite-price"], channel: "telegram" });
      expect(asked.status).toBe(202);
      const { post } = await asked.json() as { post: Post };
      expect(post).toMatchObject({ storyIds: ["maple-3-weights", "granite-price"], titles: ["«Клён 3» получил независимый замер", "«Гранит» назвал цену ускорителя"],
        channel: "telegram", text: "", note: null, status: "writing", error: null, usedAt: null });
      expect((await list()).map(each => [each.id, each.status])).toEqual([[post.id, "writing"]]);

      const { input, options, finish } = await turn(0);
      expect(input.split("\n")).toContain(POST_BRIEF);
      // Every chosen story as it stands now, with its figures, and what happened to it before.
      expect(input).toContain("«Клён 3» получил независимый замер");
      expect(input).toContain("размера модели под свободной лицензией");
      expect(input).toContain("«Северный мост» открыл веса модели «Клён 3»");
      expect(input).toContain("Вышел независимый замер: младшая версия держит 40 токенов в секунду.");
      expect(input).toContain("«Гранит» назвал цену ускорителя");
      expect(input).toContain("Telegram");
      // The voice is the owner's: the desk's own instructions name the guide, and the turn is told to open it and to send nothing.
      expect(input).toContain("your instructions name the voice guide, a skill of yours; open it before you write and follow it");
      expect(input).toContain("Never publish or send the post anywhere");
      expect(input).toContain("Current user message:\nПост для канала: «Клён 3» получил независимый замер и ещё 1");
      // The turn is the desk's own, so its instructions name the owner's voice; it starts clean and leaves no session behind.
      expect(options.profile).toContain("voice/guide.md");
      expect(input).not.toContain("Старая просьба из чата редакции");
      expect(input).not.toContain("Recent conversation");
      expect(options.threadId).toBeUndefined();
      expect(options.ephemeral).toBe(true);

      finish("**«Клён 3» теперь у каждого на ноутбуке**\n\nТри размера, свободная лицензия.\n\n---\nКанал уже писал про «Клён 2» 3 ноября: я на него сослался.");
      const ready = await settled(post.id, "ready");
      expect(ready.text).toBe("**«Клён 3» теперь у каждого на ноутбуке**\n\nТри размера, свободная лицензия.");
      expect(ready.note).toBe("Канал уже писал про «Клён 2» 3 ноября: я на него сослался.");
      expect(runtime.store.getConversation(chat.id)!.codexThreadId).toBeNull();
      // The request and the draft stay with the first story's thread, and no new story appears.
      const thread = newsFeed(runtime.store, chat.id).messages.filter(message => message.storyId === "maple-3-weights" && !message.story);
      expect(thread.map(message => message.direction)).toEqual(["inbound", "outbound"]);
      expect(newsFeed(runtime.store, chat.id).messages.filter(message => message.story)).toHaveLength(3);
    } finally { await stop(); }
  });

  it("revises a post from the owner's own text and words, makes a LinkedIn version of it, and keeps what the owner typed", async () => {
    const { runtime, call, chat, posts, list, turn, settled, stop } = await home();
    try {
      publishStory(runtime.store, chat.id, story());
      const { post } = await (await call("POST", posts, { storyIds: ["maple-3-weights"], channel: "telegram", instruction: "Сделай акцент на ноутбуке" })).json() as { post: Post };
      const first = await turn(0);
      expect(first.input).toContain("Сделай акцент на ноутбуке");
      first.finish("Первый вариант поста.");
      await settled(post.id, "ready");

      // The owner's edit is the post from then on, whatever the desk wrote.
      const edited = await call("PATCH", `${posts}/${post.id}`, { text: "Мой вариант поста." });
      expect(edited.status).toBe(200);
      expect((await edited.json() as { post: Post }).post).toMatchObject({ id: post.id, text: "Мой вариант поста.", status: "ready" });
      expect((await list())[0]!.text).toBe("Мой вариант поста.");

      // A change asked in words starts from the text the owner has now.
      const revision = await call("POST", posts, { id: post.id, storyIds: ["maple-3-weights"], channel: "telegram", text: "Мой вариант поста, уже с правкой.", instruction: "Короче и без второго абзаца" });
      expect(revision.status).toBe(202);
      expect((await revision.json() as { post: Post }).post).toMatchObject({ id: post.id, status: "writing", text: "Мой вариант поста, уже с правкой." });
      // One writer at a time for a post.
      expect((await call("POST", posts, { id: post.id, storyIds: ["maple-3-weights"], channel: "telegram", instruction: "Ещё короче" })).status).toBe(409);
      const second = await turn(1);
      expect(second.input).toContain("Мой вариант поста, уже с правкой.");
      expect(second.input).toContain("Короче и без второго абзаца");
      expect(second.input).toContain("Current user message:\nПравка поста: Короче и без второго абзаца");
      second.finish("Короткий вариант.");
      expect(await settled(post.id, "ready")).toMatchObject({ text: "Короткий вариант.", note: null });
      expect(await list()).toHaveLength(1);

      // The LinkedIn version is a post of its own, written from this one.
      const linked = await (await call("POST", posts, { from: post.id, storyIds: ["maple-3-weights"], channel: "linkedin" })).json() as { post: Post };
      expect(linked.post.id).not.toBe(post.id);
      expect(linked.post).toMatchObject({ channel: "linkedin", status: "writing", text: "" });
      const third = await turn(2);
      expect(third.input).toContain("Короткий вариант.");
      expect(third.input).toContain("LinkedIn");
      expect(third.input).toContain("Current user message:\nВерсия для LinkedIn: «Северный мост» открыл веса модели «Клён 3»");
      third.finish("A short LinkedIn post.");
      await settled(linked.post.id, "ready");
      expect((await list()).map(each => each.channel)).toEqual(["linkedin", "telegram"]);

      // Copying or sharing is remembered; nothing is ever sent for the owner.
      const used = await (await call("PATCH", `${posts}/${post.id}`, { used: "copied" })).json() as { post: Post };
      expect(used.post.usedAt).toEqual(expect.any(String));
      expect((await call("DELETE", `${posts}/${linked.post.id}`)).status).toBe(200);
      expect((await list()).map(each => each.id)).toEqual([post.id]);
      expect((await call("PATCH", `${posts}/${linked.post.id}`, { text: "x" })).status).toBe(404);
    } finally { await stop(); }
  });

  it("is the owner's alone, refuses what it cannot write from, and says when a draft failed", async () => {
    const { runtime, call, chat, posts, list, turn, settled, stop } = await home();
    try {
      publishStory(runtime.store, chat.id, story());
      const body = { storyIds: ["maple-3-weights"], channel: "telegram" };
      const login = await call("POST", "/auth/session", { key: runtime.api.web.invite(false).key }, {});
      const member = { cookie: login.headers.get("set-cookie")!.split(";")[0]!, "x-openstrudel-csrf": (await login.json() as { csrf: string }).csrf };
      expect((await call("GET", posts, undefined, member)).status).toBe(403);
      expect((await call("POST", posts, body, member)).status).toBe(403);
      expect((await call("GET", "/v1/conversations/missing/posts")).status).toBe(404);
      expect((await call("POST", posts, { ...body, storyIds: ["no-such-story"] })).status).toBe(400);
      expect((await call("POST", posts, { ...body, storyIds: [] })).status).toBe(400);
      expect((await call("POST", posts, { ...body, storyIds: ["a", "b", "c", "d", "e", "f"] })).status).toBe(400);
      expect((await call("POST", posts, { ...body, channel: "fax" })).status).toBe(400);
      expect((await call("POST", posts, { ...body, instruction: "x".repeat(601) })).status).toBe(400);
      expect((await call("POST", posts, { ...body, id: "missing" })).status).toBe(404);
      expect((await call("POST", posts, { ...body, from: "missing" })).status).toBe(404);
      expect(await list()).toEqual([]);

      const { post } = await (await call("POST", posts, body)).json() as { post: Post };
      expect((await call("PATCH", `${posts}/${post.id}`, { text: "x".repeat(6001) })).status).toBe(400);
      expect((await call("PATCH", `${posts}/${post.id}`, { used: "printed" })).status).toBe(400);
      (await turn(0)).finish(new Error("model unavailable"));
      const failed = await settled(post.id, "failed");
      expect(failed.error).toEqual(expect.any(String));
      expect(failed.text).toBe("");
      // The same post can be asked for again.
      expect((await call("POST", posts, { ...body, id: post.id })).status).toBe(202);
      (await turn(1)).finish("   ");
      // An empty answer is not a post.
      expect((await settled(post.id, "failed")).error).toEqual(expect.any(String));
      expect((await call("POST", posts, { ...body, id: post.id })).status).toBe(202);
      await turn(2);
      // A Home that restarted while a draft was being written says so; the state lives in the store alone.
      runtime.store.interruptUnfinishedMessages();
      expect((await list())[0]).toMatchObject({ id: post.id, status: "failed", error: expect.stringContaining("перезапустился") });
    } finally { await stop(); }
  });
});
