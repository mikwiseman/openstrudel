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
  expect(card.caption).toContain("Выдох · 5 ноября");
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

it("keeps Monday averages and changes separate by metric, excluding missing answers", () => {
  const days = Array.from({ length: 15 }, (_, i) => ({ date: new Date(Date.UTC(2026, 9, 26 + i)).toISOString().slice(0, 10), values: {} })) as DailyMetrics["days"];
  days[0]!.values["42"] = { calm: 0, focus: 8 };
  days[7]!.values["42"] = { calm: 4, focus: 6, mood: 3 };
  days[13]!.values["42"] = { calm: 8, focus: 8 };
  days[14]!.values["42"] = { calm: 1, mood: 10 }; // Monday belongs to the next edition.
  const { svg, caption } = dailyMetricsCard({ ...data, today: "2026-11-09", days: days.reverse() });
  expect(svg).toContain("Неделя: 6,0 · +6,0");
  expect(svg).toContain("Неделя: 7,0 · −1,0");
  expect(svg).toContain("Неделя: —");
  expect(svg).toContain("Неделя: 3,0");
  expect(svg).toContain("Спокойнее всего: 08.11 · 8/10");
  expect(caption.length).toBeLessThan(140);
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("delivers one captioned graphic and launch button through the existing receipt without calling the model", async () => {
  const root = mkdtempSync(join(tmpdir(), "metrics-card-"));
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  const model = vi.fn(async () => ({ threadId: "unused", response: "wall of text", events: [] }));
  const runtime = new OpenStrudelRuntime({ rootDirectory: root, dbPath: ":memory:", startTelegram: false, engine: { run: model } });
  const { store, scheduler } = runtime;
  try {
    store.linkTelegramChat({ chatId: "-100", title: "WAI HQ", allowedSenders: ["42"] });
    const conversationId = store.connectTelegramGroup("-100").conversationId!;
    const now = new Date("2026-11-05T20:00:00Z");
    const ids = Object.fromEntries(["calm", "focus", "energy", "mood"].map(name => [name, scheduler.save({ conversationId, name, prompt: "", cron: "30 18 * * *", timezone: "Europe/Moscow", delivery: "bound", enabled: false, poll: { question: name, options: Array.from({ length: 10 }, (_, i) => String(i + 1)) } }, now).id]));
    const report = scheduler.save({ conversationId, name: "Выдох", prompt: "Original request", cron: "30 7 * * *", timezone: "Europe/Moscow", delivery: "telegram", telegramChatId: "-100" }, now);
    store.setSetting("dailyMetrics.config", JSON.stringify({ conversationId, chatId: "-100", timezone: "Europe/Moscow", participants: [{ id: "42", name: "Мик" }], metrics: ids, summaryScheduleId: report.id }));
    store.setSetting("telegram.bot_username", "test_metrics_bot");
    saveDailyMetrics(store, "42", { date: "2026-11-05", scores: { calm: 5, focus: 7, energy: 7, mood: 6 } }, now);
    const sent: FormData[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => { sent.push(init.body as FormData); return Response.json({ ok: true, result: { message_id: 123 } }); }));
    await scheduler.tick(new Date("2026-11-06T04:30:00Z")); await scheduler.idle();
    expect(model).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get("photo")).toBeInstanceOf(Blob);
    expect(JSON.parse(String(sent[0]!.get("reply_markup")))).toEqual({ inline_keyboard: [[{ text: "Открыть Выдох", url: "https://t.me/test_metrics_bot?startapp=checkin" }]] });
    expect(String(sent[0]!.get("caption"))).toContain("Отправлено AI-помощником.");
    expect(JSON.parse(String(sent[0]!.get("caption_entities"))).some((e: any) => e.type === "italic")).toBe(true);
    expect(scheduler.runs(conversationId)[0]?.status).toBe("completed");
    scheduler.recover(); await scheduler.tick(new Date("2026-11-06T04:31:00Z")); await scheduler.idle();
    expect(sent).toHaveLength(1);
  } finally { await runtime.stop(); rmSync(root, { recursive: true, force: true }); }
});
