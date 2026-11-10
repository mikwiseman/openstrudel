import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { saveDailyMetrics, type DailyMetrics } from "../src/daily-metrics.js";
import { dailyMetricsCard } from "../src/daily-metrics-card.js";

const data: DailyMetrics = { version: "1.0.0", today: "2026-11-06", timezone: "Europe/Moscow", viewerId: "42",
  participants: [{ id: "42", name: "Мик & <Гриша>" }], days: [
    { date: "2026-11-03", values: { "42": { calm: 0 } } }, { date: "2026-11-04", values: {} },
    { date: "2026-11-05", values: { "42": { calm: 5, focus: 7, energy: 7 } } }, { date: "2026-11-06", values: { "42": { calm: 10 } } }] };
it("renders a dated score for every metric without inventing missing answers", () => {
  const card = dailyMetricsCard(data);
  expect(card.date).toBe("2026-11-05");
  expect(card.caption).toContain("Exhale · Thursday, 5 November");
  expect(card.caption.length).toBeLessThan(140);
  expect(card.svg).toContain("Мик &amp; &lt;Гриша&gt;");
  for (const metric of ["calm", "focus", "energy", "mood"]) {
    expect(card.svg.match(new RegExp(`data-metric="${metric}"`, "g"))).toHaveLength(7);
    expect(card.svg).toContain(`data-metric="${metric}" data-date="2026-11-04" data-missing="true"`);
  }
  expect(card.svg).toContain('data-metric="calm" data-date="2026-11-03" data-score="0"');
  expect(card.svg).toContain('data-metric="focus" data-date="2026-11-05" data-score="7"');
  expect(card.svg).toContain('data-metric="energy" data-date="2026-11-05" data-score="7"');
  expect(card.svg).toContain('data-metric="mood" data-date="2026-11-05" data-missing="true"');
  expect(card.svg).not.toContain('data-score="10"');
  expect(card.svg).not.toContain('data-date="2026-11-06"');
  expect(card.png.subarray(1, 4).toString()).toBe("PNG");
});

it("puts English weekdays above each date for both people and skips Saturday", () => {
  const days: DailyMetrics["days"] = [
    { date: "2026-11-05", values: { "42": { calm: 5 } } },
    { date: "2026-11-06", values: { "42": { calm: 4 }, "77": { calm: 8 } } },
    { date: "2026-11-07", values: { "42": { calm: 10 }, "77": { calm: 10 } } },
    { date: "2026-11-08", values: { "42": { calm: 0 }, "77": { focus: 7 } } },
  ];
  const { svg, caption } = dailyMetricsCard({ ...data, today: "2026-11-09", participants: [{ id: "42", name: "Мик" }, { id: "77", name: "Гриша" }], days });
  expect(caption).toBe("**Exhale · Sunday, 8 November**");
  expect(caption).not.toMatch(/AI|assistant|помощник/i);
  expect(svg).not.toMatch(/[А-Яа-яЁё]/);
  expect(svg).toContain(">Mik</text>");
  expect(svg).toContain(">Grisha</text>");
  for (const id of ["42", "77"]) {
    const header = svg.match(new RegExp(`<g data-header-person="${id}" data-header-date="2026-11-08">(.*?)</g>`))![1]!;
    const rows = [...header.matchAll(/y="(\d+)"[^>]*>(.*?)<\/text>/g)];
    expect(rows.map(row => row[2])).toEqual(["Sun", "08/11"]);
    expect(Number(rows[0]![1])).toBeLessThan(Number(rows[1]![1]));
  }
  expect(svg).not.toContain("2026-11-07");
  expect(svg).toContain("Calm streak · 3 check-in days"); // Thu, Fri, Sun; historical zero still counts.
  expect(svg).toContain("Calm streak · 0 check-in days"); // Focus alone does not count as calm.
  expect(svg).not.toContain("Week:"); // Weekly review has its own Sunday schedule.
  expect(svg).not.toContain('data-score="10"');
});

it("labels weekdays correctly across a year boundary", () => {
  const { svg, caption } = dailyMetricsCard({ ...data, today: "2027-01-02", days: [] });
  expect(caption).toBe("**Exhale · Friday, 1 January**");
  expect(svg).toMatch(/data-header-date="2026-12-31">.*?>Thu<.*?>31\/12</);
});

it("draws all four trends and exact changes independently for both people", () => {
  const { svg } = dailyMetricsCard({ ...data, today: "2026-11-10",
    participants: [{ id: "42", name: "Person A" }, { id: "77", name: "Person B" }], days: [
      { date: "2026-11-08", values: { "42": { calm: 2, focus: 8, energy: 6, mood: 5 }, "77": { calm: 5, focus: 3, energy: 8, mood: 4 } } },
      { date: "2026-11-09", values: { "42": { calm: 4, focus: 7, energy: 6, mood: 3 }, "77": { calm: 3, focus: 6, energy: 7, mood: 4 } } },
    ] });
  const changes = { "42": { calm: 2, focus: -1, energy: 0, mood: -2 }, "77": { calm: -2, focus: 3, energy: -1, mood: 0 } };
  for (const [id, metrics] of Object.entries(changes)) {
    for (const [metric, delta] of Object.entries(metrics)) {
      const chart = svg.match(new RegExp(`<path data-trend-person="${id}" data-trend-metric="${metric}" d="([^"]+)"`))![1]!;
      expect(chart).toMatch(/^M890 [\d.]+ L1000 [\d.]+$/);
      expect(svg).toContain(`data-change-person="${id}" data-change-metric="${metric}" data-from="2026-11-08" data-to="2026-11-09" data-delta="${delta}"`);
    }
  }
  expect(svg).toContain(">+2 points</text>");
  expect(svg).toContain(">−1 point</text>");
  expect(svg).toContain(">0 points</text>");
  expect(svg.match(/>vs Sun 8 Nov<\/text>/g)).toHaveLength(8);
});

it("breaks trends at missing days, retaining zero and the same fixed scale", () => {
  const { svg } = dailyMetricsCard({ ...data, today: "2026-11-10", days: [
    { date: "2026-11-02", values: { "42": { calm: 0, focus: 10 } } },
    { date: "2026-11-03", values: { "42": { calm: 10, focus: 0 } } },
    { date: "2026-11-05", values: { "42": { calm: 5 } } },
    { date: "2026-11-06", values: { "42": { calm: 3 } } },
    { date: "2026-11-07", values: { "42": { calm: 10 } } }, // Saturday is excluded, not a gap.
    { date: "2026-11-08", values: { "42": { calm: 7 } } },
    { date: "2026-11-09", values: { "42": { calm: 4 } } },
  ] });
  const calm = svg.match(/data-trend-metric="calm" d="([^"]+)"/)![1]!;
  const focus = svg.match(/data-trend-metric="focus" d="([^"]+)"/)![1]!;
  // Zero sits on the baseline, ten at the top, and both metrics span 73 pixels.
  expect(calm).toMatch(/^M340 457 L450 384 M670 420.5 L780 [\d.]+ L890 [\d.]+ L1000 [\d.]+$/);
  expect(focus).toBe("M340 527 L450 600");
  expect(svg).not.toContain("2026-11-07");
  expect(svg).not.toContain('data-trend-metric="energy"');
  expect(svg).not.toContain('data-trend-metric="mood"');
});

it("uses each metric's previous recorded date, even outside the chart and across a year", () => {
  const { svg } = dailyMetricsCard({ ...data, today: "2027-01-11", days: [
    { date: "2026-12-31", values: { "42": { calm: 0 } } },
    { date: "2027-01-07", values: { "42": { focus: 4 } } },
    { date: "2027-01-08", values: { "42": { energy: 6 } } },
    { date: "2027-01-09", values: { "42": { calm: 10, focus: 10, energy: 10, mood: 10 } } },
    { date: "2027-01-10", values: { "42": { calm: 3, focus: 5, mood: 7 } } },
    { date: "2027-01-11", values: { "42": { calm: 10 } } },
  ] });
  expect(svg).toContain('data-change-metric="calm" data-from="2026-12-31" data-to="2027-01-10" data-delta="3"');
  expect(svg).toContain(">vs Thu 31 Dec 2026</text>");
  expect(svg).toContain('data-change-metric="focus" data-from="2027-01-07" data-to="2027-01-10" data-delta="1"');
  expect(svg).not.toContain('data-change-metric="energy"'); // No new rating, no stale change.
  expect(svg).not.toContain('data-change-metric="mood"'); // First rating, no invented baseline.
  expect(svg).toContain(">No rating</text>");
  expect(svg).toContain(">First rating</text>");
  expect(svg).not.toContain('data-score="10"'); // Today and Saturday never affect this report.
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each([
  { start: "2026-11-05T20:00:00Z", run: "2026-11-06T04:30:00Z", quiet: false },
  { start: "2026-11-07T20:00:00Z", run: "2026-11-08T04:30:00Z", quiet: true },
])("delivers one English card, except for a Saturday edition ($run)", async ({ start, run, quiet }) => {
  const root = mkdtempSync(join(tmpdir(), "metrics-card-"));
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  const model = vi.fn(async () => ({ threadId: "unused", response: "wall of text", events: [] }));
  const runtime = new OpenStrudelRuntime({ rootDirectory: root, dbPath: ":memory:", startTelegram: false, engine: { run: model } });
  const { store, scheduler } = runtime;
  try {
    store.linkTelegramChat({ chatId: "-100", title: "WAI HQ", allowedSenders: ["42"] });
    const conversationId = store.connectTelegramGroup("-100").conversationId!;
    const now = new Date(start);
    const ids = Object.fromEntries(["calm", "focus", "energy", "mood"].map(name => [name, scheduler.save({ conversationId, name, prompt: "", cron: "30 18 * * *", timezone: "Europe/Moscow", delivery: "bound", enabled: false, poll: { question: name, options: Array.from({ length: 10 }, (_, i) => String(i + 1)) } }, now).id]));
    const report = scheduler.save({ conversationId, name: "Выдох", prompt: "Original request", cron: "30 7 * * *", timezone: "Europe/Moscow", delivery: "telegram", telegramChatId: "-100" }, now);
    store.setSetting("dailyMetrics.config", JSON.stringify({ conversationId, chatId: "-100", timezone: "Europe/Moscow", participants: [{ id: "42", name: "Мик" }], metrics: ids, summaryScheduleId: report.id }));
    store.setSetting("telegram.bot_username", "test_metrics_bot");
    if (!quiet) saveDailyMetrics(store, "42", { date: "2026-11-05", scores: { calm: 5, focus: 7, energy: 7, mood: 6 } }, now);
    const sent: FormData[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => { sent.push(init.body as FormData); return Response.json({ ok: true, result: { message_id: 123 } }); }));
    await scheduler.tick(new Date(run)); await scheduler.idle();
    expect(model).not.toHaveBeenCalled();
    if (quiet) {
      expect(sent).toHaveLength(0);
      expect(scheduler.runs(conversationId)[0]?.status).toBe("quiet");
      return;
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get("photo")).toBeInstanceOf(Blob);
    expect(JSON.parse(String(sent[0]!.get("reply_markup")))).toEqual({ inline_keyboard: [[{ text: "Open Exhale", url: "https://t.me/test_metrics_bot?startapp=checkin" }]] });
    expect(String(sent[0]!.get("caption"))).toBe("Exhale · Thursday, 5 November");
    expect(JSON.parse(String(sent[0]!.get("caption_entities"))).some((e: any) => e.type === "italic")).toBe(false);
    expect(scheduler.runs(conversationId)[0]?.status).toBe("completed");
    scheduler.recover(); await scheduler.tick(new Date("2026-11-06T04:31:00Z")); await scheduler.idle();
    expect(sent).toHaveLength(1);
  } finally { await runtime.stop(); rmSync(root, { recursive: true, force: true }); }
});
