import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenStrudelRuntime } from "../src/runtime.js";
import type { Statistics, StatisticsPeriod } from "../src/statistics.js";
import { statisticsCard } from "../src/statistics-card.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
type Work = StatisticsPeriod["work"][number];
const shift = (date: string, days: number) => new Date(Date.parse(date + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
const empty = (start: string): StatisticsPeriod => ({ start, requests: 0, sources: { app: 0, telegram: 0, schedule: 0, events: 0 },
  outcomes: { answered: 0, quiet: 0, failed: 0 }, measured: 0, tokens: { input: 0, cached: 0, output: 0, reasoning: 0 }, costUsd: null, unpriced: 0, chats: [], models: [], schedules: [],
  work: [], spent: { answered: { tokens: 0, costUsd: null }, quiet: { tokens: 0, costUsd: null }, failed: { tokens: 0, costUsd: null } } });
const ran = (kind: Work["kind"], id: string, requests: number, costUsd: number | null = null, more: Partial<Work> = {}): Work => ({ kind, id, requests, quiet: 0, failed: 0, tokens: 0, costUsd, ...more });
/** A day made of what ran on it; unless given, everything it spent went to answers. */
function day(work: Work[], more: Partial<StatisticsPeriod> = {}): Partial<StatisticsPeriod> {
  const sum = (pick: (w: Work) => number) => work.reduce((n, w) => n + pick(w), 0);
  const requests = sum(w => w.requests), quiet = sum(w => w.quiet), failed = sum(w => w.failed), tokens = sum(w => w.tokens);
  const costUsd = work.some(w => w.costUsd !== null) ? sum(w => w.costUsd ?? 0) : null;
  return { requests, outcomes: { answered: requests - quiet - failed, quiet, failed }, measured: tokens ? requests : 0, tokens: { input: tokens, cached: 0, output: 0, reasoning: 0 }, costUsd, work,
    spent: { ...empty("").spent, answered: { tokens, costUsd } }, ...more };
}
/** Thirty days ending today, with the given days filled in. */
function statistics(today: string, filled: Record<string, Partial<StatisticsPeriod>>, usageSince: string | null = "2026-09-01"): Statistics {
  return { checkedAt: today + "T06:00:00.000Z", timeZone: "Europe/Moscow", firstDay: "2026-09-01", usageSince, weeks: [],
    days: Array.from({ length: 30 }, (_, i) => { const start = shift(today, i - 29); return { ...empty(start), ...filled[start] }; }),
    chats: { main: { title: "Главный чат", employee: null, kind: "main" }, rd: { title: "R&D <лаборатория>", employee: null, kind: "group" }, dm: { title: "Mik Wiseman", employee: null, kind: "telegram" } },
    schedules: { radar: { name: "Радар", chatId: "main", enabled: true }, bank: { name: "Bank · payments", chatId: "dm", enabled: true } } };
}
/** Every text on the card, in drawing order. */
const words = (svg: string) => svg.replace(/<\/?tspan[^>]*>/g, "").split(/<[^>]+>/).filter(Boolean);
/** What ran on the card: each line with its share of the whole in percent. */
const shares = (svg: string) => [...svg.matchAll(/data-line="([^"]*)" data-share="(\d+)"/g)].map(m => [m[1], Number(m[2])]);

it("draws what yesterday cost and what it went to, against the day before, without the week on a weekday", () => {
  const card = statisticsCard(statistics("2026-11-10", {
    "2026-11-08": day([ran("events", "correspondence", 300, 109.86)]),
    "2026-11-09": day([ran("chat", "main", 2, 4.04), ran("schedule", "radar", 25, 8.02, { quiet: 12 }), ran("chat", "dm", 15, 6.3, { failed: 3 }),
      ran("events", "correspondence", 118, 41.2, { quiet: 96, failed: 2, tokens: 43_900_000 }), ran("schedule", "bank", 48, 12.1, { quiet: 44 })], {
      spent: { answered: { tokens: 0, costUsd: 18.4 }, quiet: { tokens: 0, costUsd: 48.1 }, failed: { tokens: 0, costUsd: 5.16 } },
      models: [{ provider: "chatgpt", model: "gpt-6-astra", name: "GPT-6-Astra", requests: 208, tokens: 43_900_000, costUsd: 71.66 }, { provider: null, model: null, name: "Автоматически", requests: 3, tokens: 0, costUsd: null }] }),
  }), "Личный");
  expect(card).toMatchObject({ date: "2026-11-09", weekly: false });
  expect(card.caption).toBe("**Личный · Monday, November 9**\n≈ $71.66, $38.20 less than the day before · 5 failed\nCorrespondence $41.20 · Bank · payments $12.10 · Радар $8.02");
  const drawn = words(card.svg);
  // One large number, named above it and compared below; tokens stand beside the comparison, once.
  expect(drawn.slice(0, 6)).toEqual(["Личный", "Monday, November 9", "SPENT YESTERDAY", "≈", "$71.66", "$38.20 less than the day before · 43.9M tokens"]);
  // Seven days of spend, the last one yesterday.
  expect([...card.svg.matchAll(/data-day="([\d-]+)" data-value="([\d.]+)"/g)].map(m => [m[1], Number(m[2])])).toEqual(
    [["2026-11-03", 0], ["2026-11-04", 0], ["2026-11-05", 0], ["2026-11-06", 0], ["2026-11-07", 0], ["2026-11-08", 109.86], ["2026-11-09", 71.66]]);
  // How the requests ended and what each ending spent.
  expect(drawn.slice(13, 19)).toEqual(["51 ANSWERED", "$18.40", "152 QUIET", "$48.10", "5 FAILED", "$5.16"]);
  // What ran, the costliest first: an event by its kind, a schedule by its name, a chat by its title, each in its own word.
  expect(shares(card.svg)).toEqual([["Correspondence", 57], ["Bank · payments", 17], ["Радар", 11], ["Mik Wiseman", 9], ["Main chat", 6]]);
  expect(drawn.slice(19)).toEqual(["WHERE IT WENT",
    "Correspondence", "$41.20", "118 events · 96 quiet · 2 failed", "Bank · payments", "$12.10", "48 runs · 44 quiet", "Радар", "$8.02", "25 runs · 12 quiet",
    "Mik Wiseman", "$6.30", "15 messages · 3 failed", "Main chat", "$4.04", "2 messages", "GPT-6-Astra"]);
  expect(card.png.subarray(1, 4).toString()).toBe("PNG");
});

it("adds the seven days that ended yesterday on Sunday, compares only with what was measured throughout and escapes names", () => {
  const filled: Record<string, Partial<StatisticsPeriod>> = {};
  for (let i = 0; i < 7; i++) filled[shift("2026-10-25", i)] = day([ran("chat", "main", 10, 1)]);
  for (let i = 0; i < 7; i++) filled[shift("2026-11-01", i)] = day([ran("chat", "main", 20, i === 6 ? 0.5 : 3), ran("schedule", "radar", 3, 0.5), ran("chat", "rd", 4, 1), ran("chat", "dm", 1, 0.25)]);
  const card = statisticsCard(statistics("2026-11-08", filled), "Работа");
  expect(card).toMatchObject({ date: "2026-11-07", weekly: true });
  expect(card.caption).toBe("**Работа · Saturday, November 7**\n≈ $2.25, $2.50 less than the day before\nR&D <лаборатория> $1.00 · Main chat $0.50 · Радар $0.50"
    + "\n**Week · November 1–7:** ≈ $30.75, $23.75 more than the week before");
  const drawn = words(card.svg);
  expect(drawn.slice(drawn.indexOf("WEEK · NOVEMBER 1–7"))).toEqual(["WEEK · NOVEMBER 1–7", "≈", "$30.75", "$23.75 more than the week before",
    "Main chat", "$18.50", "R&amp;D &lt;лаборатория&gt;", "$7.00", "Радар", "$3.50"]);
  // Counted only from Friday: the card says so and compares with neither the day nor the week before, which were not measured throughout.
  const recent = statisticsCard(statistics("2026-11-08", filled, "2026-11-06"), "Работа");
  expect(recent.caption).toBe("**Работа · Saturday, November 7**\n≈ $2.25\nR&D <лаборатория> $1.00 · Main chat $0.50 · Радар $0.50\n**Week · November 1–7:** ≈ $30.75");
  expect(words(recent.svg).slice(-8)).toEqual(["$30.75", "Main chat", "$18.50", "R&amp;D &lt;лаборатория&gt;", "$7.00", "Радар", "$3.50", "Tokens and cost are counted from November 6."]);
  // A week across two months names both; a day without requests says so instead of listing zeros.
  const turn = statisticsCard(statistics("2026-10-04", {}), "Работа");
  expect(turn.svg).toContain("WEEK · SEPTEMBER 27 – OCTOBER 3");
  expect(turn.caption).toBe("**Работа · Saturday, October 3**\nA quiet day: nothing ran.\n**Week · September 27 – October 3:** 0 requests, the same as the week before");
  expect(words(turn.svg).slice(2, 5)).toEqual(["REQUESTS YESTERDAY", "0", "The same as the day before"]);
  expect(turn.svg).not.toContain("ANSWERED");
});

it("counts in tokens where nothing had a price and in requests where nothing was measured", () => {
  const measured = statisticsCard(statistics("2026-11-10", {
    "2026-11-08": day([ran("chat", "main", 5, null, { tokens: 2_400 })]),
    "2026-11-09": day([ran("chat", "main", 5, null, { tokens: 2_400 }), ran("schedule", "radar", 30, null, { tokens: 10_000, quiet: 28 })]),
  }), "Личный");
  expect(measured.caption).toBe("**Личный · Monday, November 9**\n12.4K tokens, 10K more than the day before\nРадар 10K · Main chat 2.4K");
  expect(words(measured.svg)).toEqual(expect.arrayContaining(["TOKENS YESTERDAY", "12.4K", "10K more than the day before", "WHERE THEY WENT", "30 runs · 28 quiet"]));
  expect(shares(measured.svg)).toEqual([["Радар", 81], ["Main chat", 19]]);

  const counted = statisticsCard(statistics("2026-11-10", {
    "2026-11-08": day([ran("chat", "main", 20)]),
    "2026-11-09": day([ran("chat", "main", 38, null, { failed: 1 }), ran("chat", "rd", 3, null, { quiet: 2 })]),
  }, null), "Личный");
  expect(counted.caption).toBe("**Личный · Monday, November 9**\n41 requests, 21 more than the day before · 1 failed\nMain chat 38 messages · R&D <лаборатория> 3 messages");
  const drawn = words(counted.svg);
  expect(drawn.slice(2, 5)).toEqual(["REQUESTS YESTERDAY", "41", "21 more than the day before"]);
  // A request is named once: the count stands as the line's figure, not again beneath it.
  expect(drawn.slice(12)).toEqual(["ANSWERED", "38", "QUIET", "2", "FAILED", "1", "WHAT RAN", "Main chat", "38 messages", "1 failed", "R&amp;D &lt;лаборатория&gt;", "3 messages", "2 quiet"]);

  // Part of a day without a published price stays out of the cost, and the card says how much. What cost nothing is not
  // listed unless it failed.
  const partly = statisticsCard(statistics("2026-11-10", {
    "2026-11-09": day([ran("chat", "main", 5, 2.5), ran("schedule", "radar", 3, null, { tokens: 900 }), ran("schedule", "bank", 1, null, { failed: 1 })], { unpriced: 3,
      models: [{ provider: "chatgpt", model: "gpt-6-astra", name: "GPT-6-Astra", requests: 5, tokens: 0, costUsd: 2.5 }, { provider: "grok", model: "grok-4.7", name: "Grok 4.7", requests: 3, tokens: 900, costUsd: null }] }),
  }), "Личный");
  expect(partly.caption).toBe("**Личный · Monday, November 9**\n≈ $2.50 · 1 failed\nMain chat $2.50 · Bank · payments —");
  expect(shares(partly.svg)).toEqual([["Main chat", 100], ["Bank · payments", 0]]);
  expect(words(partly.svg)).toEqual(expect.arrayContaining(["Bank · payments", "—", "1 run · 1 failed"]));
  expect(words(partly.svg).slice(-2)).toEqual(["GPT-6-Astra $2.50 · Grok 4.7 —", "3 requests without a published price are not in the cost."]);
});

it("cuts a long name to the room its line has and folds what ran beyond five lines into one", () => {
  const names = ["Банк — подтверждения записанных платежей в общем чате", "b", "c", "d", "e", "f", "g"];
  const stats = statistics("2026-11-10", { "2026-11-09": day(names.map((_, i) => ran("schedule", "s" + i, 10 - i, 7 - i, { quiet: 1, failed: i === 6 ? 2 : 0 }))) });
  names.forEach((name, i) => { stats.schedules["s" + i] = { name, chatId: "main", enabled: true }; });
  const drawn = words(statisticsCard(stats, "Личный").svg);
  const long = drawn.find(word => word.startsWith("Банк — подтверждения записанных"))!;
  expect(long.endsWith("…") && names[0]!.startsWith(long.slice(0, -1)) && long.length < names[0]!.length).toBe(true);
  expect(drawn.slice(drawn.indexOf("e"))).toEqual(["e", "$3.00", "6 runs · 1 quiet", "2 more", "$3.00", "9 requests · 2 quiet · 2 failed"]);
});

it("never counts its own runs: a day when only the card ran is a quiet day", () => {
  const own = day([ran("schedule", "card", 1)]);
  const card = statisticsCard(statistics("2026-11-10", { "2026-11-08": own, "2026-11-09": own }), "Грант", "card");
  expect(card.caption).toBe("**Грант · Monday, November 9**\nA quiet day: nothing ran.");
  expect(card.svg).toContain('data-day="2026-11-09" data-value="0"');
  // Beside real requests it leaves their count and their endings alone.
  const busy = statisticsCard(statistics("2026-11-10", { "2026-11-09": day([ran("schedule", "card", 1), ran("chat", "main", 4, null, { quiet: 1 })]) }, null), "Грант", "card");
  expect(busy.caption).toBe("**Грант · Monday, November 9**\n4 requests, 4 more than the day before\nMain chat 4 messages");
  expect(words(busy.svg)).toEqual(expect.arrayContaining(["ANSWERED", "3", "QUIET", "1"]));
});

it("sends the owner's own chat the card at nine through Telegram without a model turn, and never a group", async () => {
  const root = mkdtempSync(join(tmpdir(), "statistics-card-"));
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  const model = vi.fn(async () => ({ threadId: "unused", response: "wall of text", events: [] }));
  const runtime = new OpenStrudelRuntime({ rootDirectory: root, dbPath: ":memory:", startTelegram: false, engine: { run: model } });
  const { store, scheduler } = runtime;
  try {
    store.setSetting("owner.timezone", "Europe/Moscow");
    runtime.api.home.rename("Личный");
    store.linkTelegramChat({ chatId: "42", title: "Мик", allowedSenders: ["42"] });
    store.linkTelegramChat({ chatId: "-100", title: "Команда", allowedSenders: ["42"] });
    const own = store.getOrCreateConversation({ channel: "telegram", externalId: "42", title: "Мик" }).id;
    const group = store.connectTelegramGroup("-100").conversationId!;
    for (const [at, text] of [["2026-11-07T09:00:00Z", "Что нового?"], ["2026-11-07T12:00:00Z", "Спасибо"]]) {
      const request = store.addMessage({ conversationId: own, channel: "telegram", direction: "inbound", text: text! });
      const reply = store.addMessage({ conversationId: own, channel: "telegram", direction: "outbound", replyToId: request.id, text: "Готово" });
      store.db.prepare("UPDATE messages SET created_at=?,status='completed' WHERE id IN (?,?)").run(at, request.id, reply.id);
    }
    const saved = new Date("2026-11-07T20:00:00Z");
    const card = scheduler.save({ conversationId: own, name: "Статистика", prompt: "Карточка статистики", cron: "0 9 * * *", timezone: "Europe/Moscow", delivery: "telegram", telegramChatId: "42" }, saved);
    store.setSetting("statistics.cardScheduleId", card.id);
    const sent: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { sent.push({ url, body: init.body }); return Response.json({ ok: true, result: { message_id: 123 } }); }));
    await scheduler.tick(new Date("2026-11-08T06:00:00Z")); await scheduler.idle();
    expect(model).not.toHaveBeenCalled();
    const photos = sent.filter(call => call.url.endsWith("/sendPhoto")).map(call => call.body as FormData);
    expect(photos).toHaveLength(1);
    expect(photos[0]!.get("chat_id")).toBe("42");
    expect(photos[0]!.get("photo")).toBeInstanceOf(Blob);
    expect(String(photos[0]!.get("caption"))).toContain("Личный · Saturday, November 7");
    expect(String(photos[0]!.get("caption"))).toContain("2 requests");
    expect(String(photos[0]!.get("caption"))).toContain("Мик 2 messages");
    expect(String(photos[0]!.get("caption"))).toContain("Week · November 1–7:");
    expect(scheduler.runs(own)[0]?.status).toBe("completed");
    // The run is kept in the owner's chat under an English title, like the card it carries.
    expect(store.db.prepare("SELECT text FROM messages WHERE conversation_id=? AND external_id LIKE 'schedule:%'").get(own)).toEqual({ text: "Statistics · 2026-11-07" });

    // The same card pointed at a group fails before anything is drawn or sent there.
    scheduler.save({ ...card, enabled: false }, saved);
    const elsewhere = scheduler.save({ conversationId: group, name: "Статистика", prompt: "Карточка статистики", cron: "0 9 * * *", timezone: "Europe/Moscow", delivery: "telegram", telegramChatId: "-100" }, saved);
    store.setSetting("statistics.cardScheduleId", elsewhere.id);
    await scheduler.tick(new Date("2026-11-09T06:00:00Z")); await scheduler.idle();
    expect(sent.filter(call => call.url.endsWith("/sendPhoto"))).toHaveLength(1);
    expect(scheduler.runs(group)[0]).toMatchObject({ status: "failed", error: expect.stringContaining("только в личный чат владельца") });
    // Kept in the group's own chat instead, it would reach the group through its history: that fails too, and nothing is written there.
    scheduler.save({ ...elsewhere, enabled: false }, saved);
    const kept = scheduler.save({ conversationId: group, name: "Статистика в приложении", prompt: "Карточка статистики", cron: "0 9 * * *", timezone: "Europe/Moscow", delivery: "app" }, saved);
    store.setSetting("statistics.cardScheduleId", kept.id);
    const before = store.db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id=?").get(group) as { n: number };
    await scheduler.tick(new Date("2026-11-10T06:00:00Z")); await scheduler.idle();
    expect(scheduler.runs(group)[0]).toMatchObject({ status: "failed", error: expect.stringContaining("только в личный чат владельца") });
    expect(store.db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id=? AND (text LIKE 'Statistics%' OR text LIKE '%November%')").get(group)).toEqual({ n: 0 });
    expect((store.db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id=?").get(group) as { n: number }).n).toBeGreaterThanOrEqual(before.n);
    expect(model).not.toHaveBeenCalled();
  } finally { await runtime.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

it("keeps the card on the owner's own page when its schedule stays in the app, so a morning brief can carry it as one line", async () => {
  const root = mkdtempSync(join(tmpdir(), "statistics-card-"));
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  const model = vi.fn(async () => ({ threadId: "unused", response: "wall of text", events: [] }));
  const runtime = new OpenStrudelRuntime({ rootDirectory: root, dbPath: ":memory:", startTelegram: false, engine: { run: model } });
  const { store, scheduler } = runtime;
  try {
    store.setSetting("owner.timezone", "Europe/Moscow");
    store.linkTelegramChat({ chatId: "42", title: "Мик", allowedSenders: ["42"] });
    const own = store.getOrCreateConversation({ channel: "telegram", externalId: "42", title: "Мик" }).id;
    const card = scheduler.save({ conversationId: own, name: "Статистика", prompt: "Карточка статистики", cron: "50 6 * * *", timezone: "Europe/Moscow", delivery: "app" }, new Date("2026-11-07T20:00:00Z"));
    store.setSetting("statistics.cardScheduleId", card.id);
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { sent.push(url); return Response.json({ ok: true, result: { message_id: 1 } }); }));
    await scheduler.tick(new Date("2026-11-08T03:50:00Z")); await scheduler.idle();
    expect(sent).toEqual([]);
    expect(scheduler.runs(own)[0]?.status).toBe("completed");
    const kept = store.listMessages(own).find(m => m.direction === "outbound" && m.attachments?.length);
    expect(kept?.attachments?.[0]?.mimeType).toBe("image/png");
    expect(kept?.text).toMatch(/^\*\*.* · Saturday, November 7\*\*/);
    expect(model).not.toHaveBeenCalled();
  } finally { await runtime.stop(); rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
}, 30_000);
