import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { Scheduler } from "../src/scheduler.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter } from "../src/telegram.js";
import { HttpApi } from "../src/server.js";
import { readCheckIns, recordAnswer, recordPoll } from "../src/check-ins.js";
import { authenticateDailyMetrics, dailyMetricsReportConfig, dailyMetricsSummary, readDailyMetrics, saveDailyMetrics, type DailyMetricsConfig } from "../src/daily-metrics.js";

const now = new Date("2026-11-05T14:00:00.000Z"), token = "123:test-token";
const stores: Store[] = [];
afterEach(() => { vi.useRealTimers(); stores.splice(0).forEach(store => store.close()); });
function signed(user = 42, at = now, extra: Record<string, string> = {}) {
  const data = new URLSearchParams({ auth_date: String(Math.floor(at.getTime() / 1000)), user: JSON.stringify({ id: user, first_name: "Untrusted display name" }), ...extra });
  const text = [...data].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  data.set("hash", createHmac("sha256", secret).update(text).digest("hex"));
  return "tma " + data;
}
function setup() {
  const store = new Store(":memory:"); stores.push(store);
  const messages = new MessageService(store, { async run() { return { threadId: "t", response: "OK", events: [] }; } });
  const scheduler = new Scheduler(store, messages);
  store.linkTelegramChat({ chatId: "-100", title: "WAI HQ", allowedSenders: ["42", "77"] });
  const conversationId = store.connectTelegramGroup("-100").conversationId!;
  const ids = Object.fromEntries(["calm", "focus", "energy", "mood", "legacy"].map(name => [name, scheduler.save({ conversationId, name, prompt: "", cron: "30 18 * * *", timezone: "Europe/Moscow", delivery: "bound", poll: { question: name, options: Array.from({ length: 10 }, (_, i) => String(i + 1)) } }, now).id]));
  store.db.prepare("UPDATE schedules SET enabled=0 WHERE id=?").run(ids.legacy!);
  const config: DailyMetricsConfig = { conversationId, chatId: "-100", timezone: "Europe/Moscow", participants: [{ id: "42", name: "Мик" }, { id: "77", name: "Гриша" }], metrics: { calm: ids.calm!, focus: ids.focus!, energy: ids.energy!, mood: ids.mood! }, legacyCalmScheduleId: ids.legacy! };
  store.setSetting("dailyMetrics.config", JSON.stringify(config)); store.setSetting("telegram.bot_token", token);
  const vote = (id: string, metric: string, date: string, user: string, value: number, at: string, objectOptions = false) => {
    const options = Array.from({ length: 10 }, (_, i) => String(i + 1));
    recordPoll(store, { pollId: id, scheduleId: ids[metric]!, conversationId, chatId: "-100", messageId: 1, localDate: date, question: metric, options, createdAt: at });
    recordAnswer(store, { pollId: id, userId: user, userName: user, optionIds: [value - 1], at });
    if (objectOptions) store.db.prepare("UPDATE schedule_polls SET options_json=? WHERE poll_id=?").run(JSON.stringify({ question: metric, options }), id);
  };
  return { store, config, vote, scheduler, messages, conversationId };
}
describe("Telegram daily metrics authentication", () => {
  it("accepts signed configured people only, without trusting their supplied display name", () => {
    const { store } = setup();
    expect(authenticateDailyMetrics(store, signed(), now)).toEqual({ id: "42", name: "Мик" });
    expect(() => authenticateDailyMetrics(store, signed(99), now)).toThrow();
    expect(() => authenticateDailyMetrics(store, "Bearer owner", now)).toThrow();
    expect(() => authenticateDailyMetrics(store, signed().replace("Untrusted", "Forged"), now)).toThrow();
    expect(() => authenticateDailyMetrics(store, signed() + "&auth_date=1", now)).toThrow();
    expect(() => authenticateDailyMetrics(store, signed(42, new Date(now.getTime() - 86401_000)), now)).toThrow();
    expect(() => authenticateDailyMetrics(store, signed(42, new Date(now.getTime() + 61_000)), now)).toThrow();
    expect(() => authenticateDailyMetrics(store, signed(42, now, { chat: JSON.stringify({ id: -200, type: "group" }) }), now)).toThrow();
    store.deleteSetting("dailyMetrics.config");
    expect(() => authenticateDailyMetrics(store, signed(), now)).toThrow();
  });
});
describe("the metrics journal", () => {
  it("selects only the configured report and leaves unrelated schedules independent of malformed metrics settings", () => {
    const { store, config, scheduler, conversationId } = setup();
    const report = scheduler.save({ conversationId, name: "Report", prompt: "Daily scores", cron: "30 7 * * *", timezone: config.timezone, delivery: "bound" }, now);
    store.setSetting("dailyMetrics.config", JSON.stringify({ ...config, summaryScheduleId: report.id }));
    expect(dailyMetricsReportConfig(store, conversationId, report.id)?.summaryScheduleId).toBe(report.id);
    expect(dailyMetricsReportConfig(store, conversationId, "unrelated")).toBeNull();
    expect(() => dailyMetricsReportConfig(store, "other-chat", report.id)).toThrow();
    store.db.prepare("UPDATE schedules SET timezone='UTC' WHERE id=?").run(report.id);
    expect(() => dailyMetricsReportConfig(store, conversationId, report.id)).toThrow();
    store.setSetting("dailyMetrics.config", "invalid JSON");
    expect(dailyMetricsReportConfig(store, conversationId, "unrelated")).toBeNull();
  });
  it("projects archived bustle once, preserves zero, gaps and participants, and takes the latest daily answer", () => {
    const { store, vote, conversationId } = setup();
    vote("legacy-1", "legacy", "2026-11-01", "42", 10, "2026-11-01T17:00:00Z", true);
    vote("legacy-3", "legacy", "2026-11-03", "42", 8, "2026-11-03T17:00:00Z");
    vote("new", "calm", "2026-11-04", "42", 7, "2026-11-04T17:00:00Z");
    vote("new-later", "calm", "2026-11-04", "42", 9, "2026-11-04T18:00:00Z");
    vote("stranger", "focus", "2026-11-04", "99", 10, "2026-11-04T18:00:00Z");
    const data = readDailyMetrics(store, "42", now);
    expect(data.days).toHaveLength(30);
    expect(data.days.find(day => day.date === "2026-11-01")!.values).toEqual({ "42": { calm: 0 } });
    expect(data.days.find(day => day.date === "2026-11-02")!.values).toEqual({});
    expect(data.days.find(day => day.date === "2026-11-03")!.values).toEqual({ "42": { calm: 2 } });
    expect(data.days.find(day => day.date === "2026-11-04")!.values).toEqual({ "42": { calm: 9 } });
    expect(data.days.at(-1)).toEqual({ date: "2026-11-05", values: {} });
    expect(data.participants).toEqual([{ id: "42", name: "Мик" }, { id: "77", name: "Гриша" }]);
    const summary = dailyMetricsSummary(store, conversationId, now);
    expect(summary).toContain("2026-11-01: Mik: Calm 0/10");
    expect(summary).toContain("Mik: 2 consecutive reporting days");
  });
  it("writes only today's own four values atomically, without modifying poll votes or scheduling sends", () => {
    const { store, vote, conversationId } = setup();
    vote("telegram", "calm", "2026-11-05", "42", 3, "2026-11-05T10:00:00Z");
    const input = { date: "2026-11-05", scores: { calm: 8, focus: 6, energy: 7, mood: 9 } };
    const data = saveDailyMetrics(store, "42", input, now);
    expect(data.days.at(-1)!.values).toEqual({ "42": input.scores });
    expect(store.db.prepare("SELECT option_index FROM schedule_poll_answers WHERE poll_id='telegram'").get()!.option_index).toBe(2);
    expect(store.db.prepare("SELECT count(*) AS n FROM schedule_polls WHERE message_id IS NULL AND closed=1").get()!.n).toBe(4);
    expect(() => saveDailyMetrics(store, "42", { ...input, userId: "77" }, now)).toThrow();
    expect(() => saveDailyMetrics(store, "99", input, now)).toThrow();
    expect(() => saveDailyMetrics(store, "42", { ...input, date: "2026-11-04" }, now)).toThrow();
    expect(() => saveDailyMetrics(store, "42", { ...input, scores: { ...input.scores, calm: 0 } }, now)).toThrow();
    expect(() => saveDailyMetrics(store, "42", { ...input, scores: { calm: 8 } }, now)).toThrow();
    expect(() => saveDailyMetrics(store, "42", { ...input, scores: { ...input.scores, mood: 4.5 } }, now)).toThrow();
    const updated = saveDailyMetrics(store, "42", { ...input, scores: { ...input.scores, focus: 10 } }, new Date(now.getTime() + 1000));
    expect(updated.days.at(-1)!.values["42"]!.focus).toBe(10);
    expect(store.db.prepare("SELECT count(*) AS n FROM schedule_polls WHERE message_id IS NULL").get()!.n).toBe(4);
    expect(dailyMetricsSummary(store, conversationId, now)).toContain("Calm 8/10 · Focus 10/10 · Energy 7/10 · Mood 9/10");
    expect(dailyMetricsSummary(store, "other", now)).toBeNull();
    store.setSetting("home.transfer", "true");
    expect(() => saveDailyMetrics(store, "42", input, now)).toThrow();
  });
  it("refuses a changed or foreign schedule mapping and uses Moscow's calendar date", () => {
    const { store, config } = setup();
    expect(readDailyMetrics(store, "42", new Date("2026-11-04T21:00:00Z")).today).toBe("2026-11-05");
    store.db.prepare("UPDATE schedules SET conversation_id=? WHERE id=?").run(store.primaryConversation().id, config.metrics.focus);
    expect(() => readDailyMetrics(store, "42", now)).toThrow();
  });
  it("keeps native averages and calendar streaks correct when app and Telegram both record a day", () => {
    const { store, vote, config, conversationId } = setup();
    vote("day-1", "calm", "2026-11-01", "42", 4, "2026-11-01T10:00:00Z", true);
    vote("day-3", "calm", "2026-11-03", "42", 5, "2026-11-03T10:00:00Z");
    vote("day-4", "calm", "2026-11-04", "42", 7, "2026-11-04T10:00:00Z");
    vote("day-4-later", "calm", "2026-11-04", "42", 9, "2026-11-04T11:00:00Z");
    const checkIn = readCheckIns(store, { conversationId, now }).find(item => item.id === config.metrics.calm)!;
    expect(checkIn.participants[0]).toMatchObject({ streak: 2, average: 6, latest: { date: "2026-11-04", value: 9 } });
    expect(readCheckIns(store, { conversationId, now: new Date("2026-11-07T14:00:00Z") }).find(item => item.id === config.metrics.calm)!.participants[0]!.streak).toBe(0);
  });
});

it("serves the separate signed API without creating a Home session or exposing Home data", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  const { store, messages } = setup();
  const telegram = new TelegramAdapter(null, store, messages);
  const api = new HttpApi(store, messages, telegram, "owner-secret");
  const address = await api.listen("127.0.0.1", 0), base = `http://127.0.0.1:${address.port}`;
  try {
    expect((await fetch(base + "/check-in/api")).status).toBe(401);
    expect((await fetch(base + "/check-in/api", { headers: { authorization: "Bearer owner-secret" } })).status).toBe(401);
    const headers = { authorization: signed(), "content-type": "application/json" };
    const read = await fetch(base + "/check-in/api", { headers });
    expect(read.status).toBe(200);
    expect(read.headers.get("set-cookie")).toBeNull();
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(await read.json()).toMatchObject({ viewerId: "42", today: "2026-11-05", version: "1.1.1" });
    expect((await fetch(base + "/v1/activity", { headers })).status).toBe(401);
    expect((await fetch(base + "/check-in/api", { headers: { ...headers, origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(base + "/check-in/api", { method: "POST", headers, body: JSON.stringify({ date: "2026-11-05", scores: { calm: 8, focus: 7, energy: 9, mood: 10 } }) })).status).toBe(200);
    expect((await fetch(base + "/check-in/api", { method: "POST", headers, body: JSON.stringify({ date: "2026-11-05", userId: "77", scores: { calm: 8, focus: 7, energy: 9, mood: 10 } }) })).status).toBe(400);
    expect(store.getSetting("web.sessions")).toBeNull();
  } finally { await api.close(); telegram.stop(); }
});

it("exposes only Mini App routes on its private proxy port and checks the configured HTTPS origin", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  const { store, messages, config } = setup();
  store.setSetting("dailyMetrics.config", JSON.stringify({ ...config, publicOrigin: "https://metrics.example" }));
  const telegram = new TelegramAdapter(null, store, messages);
  const api = new HttpApi(store, messages, telegram, "owner-secret");
  const address = await api.listenDailyMetrics("127.0.0.1", 0), base = `http://127.0.0.1:${address.port}`;
  try {
    const headers = { authorization: signed(), origin: "https://metrics.example", "content-type": "application/json" };
    expect((await fetch(base + "/check-in/api", { headers })).status).toBe(200);
    for (const path of ["/", "/health", "/v1/activity", "/auth/session", "/check-in/../v1/settings", "/check-in/private.js"])
      expect((await fetch(base + path, { headers: { authorization: "Bearer owner-secret" } })).status, path).toBe(404);
    expect((await fetch(base + "/check-in/api", { headers: { ...headers, origin: "https://foreign.example" } })).status).toBe(403);
    expect((await fetch(base + "/check-in/api", { method: "POST", headers: { authorization: signed(), "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await fetch(base + "/check-in/api", { method: "POST", headers, body: JSON.stringify({ date: "2026-11-05", scores: { calm: 8, focus: 7, energy: 9, mood: 10 } }) })).status).toBe(200);
    const html = await fetch(base + "/check-in/");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toContain("https://web.telegram.org");
    expect(html.headers.get("content-security-policy")).toContain("script-src 'self' https://telegram.org");
  } finally { await api.close(); telegram.stop(); }
});
