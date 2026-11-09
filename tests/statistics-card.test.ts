import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenStrudelRuntime } from "../src/runtime.js";
import type { Statistics, StatisticsPeriod } from "../src/statistics.js";
import { statisticsCard } from "../src/statistics-card.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
/** Russian figures keep their unit with a no-break space; compare words, not space characters. */
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, " ");
const shift = (date: string, days: number) => new Date(Date.parse(date + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
const empty = (start: string): StatisticsPeriod => ({ start, requests: 0, sources: { app: 0, telegram: 0, schedule: 0, events: 0 },
  outcomes: { answered: 0, quiet: 0, failed: 0 }, measured: 0, tokens: { input: 0, cached: 0, output: 0, reasoning: 0 }, costUsd: null, unpriced: 0, chats: [], models: [], schedules: [] });
/** Thirty days ending today, with the given days filled in. */
function statistics(today: string, filled: Record<string, Partial<StatisticsPeriod>>, usageSince = "2026-09-01"): Statistics {
  return { checkedAt: today + "T06:00:00.000Z", timeZone: "Europe/Moscow", firstDay: "2026-09-01", usageSince, weeks: [],
    days: Array.from({ length: 30 }, (_, i) => { const start = shift(today, i - 29); return { ...empty(start), ...filled[start] }; }),
    chats: { main: { title: "Главный чат", employee: null, kind: "main" }, rd: { title: "R&D <лаборатория>", employee: null, kind: "group" } },
    schedules: { radar: { name: "Радар", chatId: "main", enabled: true } } };
}
const busy = (requests: number, extra: Partial<StatisticsPeriod> = {}): Partial<StatisticsPeriod> => ({ requests, sources: { app: 1, telegram: requests - 1, schedule: 0, events: 0 },
  outcomes: { answered: requests - 2, quiet: 1, failed: 1 }, chats: [{ id: "main", requests: requests - 3, tokens: 0, costUsd: null, failed: 1 }, { id: "rd", requests: 3, tokens: 0, costUsd: null, failed: 0 }], ...extra });

it("draws yesterday against the day before, from the numbers alone, without the week on a weekday", () => {
  const card = statisticsCard(statistics("2026-11-10", {
    "2026-11-08": busy(20), "2026-11-09": busy(41, { measured: 41, tokens: { input: 12_000, cached: 9_000, output: 400, reasoning: 0 }, costUsd: 1.25,
      models: [{ provider: "chatgpt", model: "gpt-6-astra", name: "GPT-6-Astra", requests: 41, tokens: 12_400, costUsd: 1.25 }] }),
  }), "Личный");
  expect(card).toMatchObject({ date: "2026-11-09", weekly: false });
  expect(plain(card.caption)).toBe("**Личный · вчера, 9 ноября**\n41 запрос, на 21 больше, чем днём раньше · 12,4 тыс. токенов · ≈ 1,25 $ · сбои: 1\nСамый занятой день недели.");
  // Seven days, the last one yesterday; the number sits on the card once, as the large figure.
  expect([...card.svg.matchAll(/data-day="([\d-]+)" data-requests="(\d+)"/g)].map(m => [m[1], Number(m[2])])).toEqual(
    [["2026-11-03", 0], ["2026-11-04", 0], ["2026-11-05", 0], ["2026-11-06", 0], ["2026-11-07", 0], ["2026-11-08", 20], ["2026-11-09", 41]]);
  expect(card.svg).toContain(">41<");
  expect(card.svg).toContain("Модель — GPT-6-Astra");
  expect(card.svg).not.toContain("НЕДЕЛЯ");
  expect(card.png.subarray(1, 4).toString()).toBe("PNG");
});

it("adds the seven days that ended yesterday on Sunday, says since when tokens are counted and escapes chat names", () => {
  const filled: Record<string, Partial<StatisticsPeriod>> = {};
  for (let i = 0; i < 7; i++) filled[shift("2026-10-25", i)] = busy(10);
  for (let i = 0; i < 7; i++) filled[shift("2026-11-01", i)] = busy(i === 6 ? 4 : 30, { schedules: [{ id: "radar", runs: 3, quiet: 1, failed: 0, tokens: 900, costUsd: 0.5 }] });
  const card = statisticsCard(statistics("2026-11-08", filled, "2026-11-03"), "Работа");
  expect(card).toMatchObject({ date: "2026-11-07", weekly: true });
  expect(card.svg).toContain("НЕДЕЛЯ · 1–7 НОЯБРЯ");
  expect(card.svg).toContain("R&amp;D &lt;лаборатория&gt;");
  expect(plain(card.svg)).toContain("Дороже всего — «Радар»: ≈ 3,50 $");
  expect(card.svg).toContain("Токены и стоимость — с 3 ноября.");
  expect(card.caption).toContain("4 запроса, на 26 меньше, чем днём раньше");
  expect(card.caption).toContain("Самый спокойный день недели.");
  expect(card.caption).toContain("**Неделя · 1–7 ноября:** 184 запроса, на 114 больше, чем неделей раньше");
  // A week across two months names both; a day without requests says so instead of listing zeros.
  const turn = statisticsCard(statistics("2026-10-04", {}), "Работа");
  expect(turn.svg).toContain("НЕДЕЛЯ · 27 СЕНТЯБРЯ – 3 ОКТЯБРЯ");
  expect(turn.caption).toContain("Тихий день: ни одного запроса.");
  expect(turn.svg).not.toContain("Ответил 0");
});

it("never counts its own runs: a day when only the card ran is a quiet day", () => {
  const own = { requests: 1, sources: { app: 0, telegram: 0, schedule: 1, events: 0 }, outcomes: { answered: 1, quiet: 0, failed: 0 },
    chats: [{ id: "dm", requests: 1, tokens: 0, costUsd: null, failed: 0 }], schedules: [{ id: "card", runs: 1, quiet: 0, failed: 0, tokens: 0, costUsd: null }] };
  const card = statisticsCard(statistics("2026-11-10", { "2026-11-08": own, "2026-11-09": own }), "Грант", "card");
  expect(plain(card.caption)).toBe("**Грант · вчера, 9 ноября**\n0 запросов, столько же, сколько днём раньше\nТихий день: ни одного запроса.");
  expect(card.svg).toContain('data-day="2026-11-09" data-requests="0"');
  expect(card.svg).not.toContain("Расписания 1");
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
    expect(String(photos[0]!.get("caption"))).toContain("Личный · вчера, 7 ноября");
    expect(String(photos[0]!.get("caption"))).toContain("2 запроса");
    expect(String(photos[0]!.get("caption"))).toContain("Неделя · 1–7 ноября:");
    expect(scheduler.runs(own)[0]?.status).toBe("completed");

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
    expect(store.db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id=? AND (text LIKE 'Статистика%' OR text LIKE '%вчера,%')").get(group)).toEqual({ n: 0 });
    expect((store.db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id=?").get(group) as { n: number }).n).toBeGreaterThanOrEqual(before.n);
    expect(model).not.toHaveBeenCalled();
  } finally { await runtime.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);
