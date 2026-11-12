import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MockCodexEngine } from "../src/codex.js";
import { HomeError } from "../src/home.js";
import { MessageService } from "../src/messages.js";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { Scheduler } from "../src/scheduler.js";
import { modelName, readScheduleOverview, readStatistics, type Statistics } from "../src/statistics.js";
import { Store } from "../src/store.js";
import { ensureUsageTable, recordTurnUsage, TICKS_PER_USD } from "../src/usage.js";

const stores: Store[] = [], runtimes: OpenStrudelRuntime[] = [], roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); stores.splice(0).forEach(store => store.close());
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(timeZone = "Europe/Moscow") {
  const store = new Store(":memory:"); stores.push(store);
  new Scheduler(store, {} as MessageService); ensureUsageTable(store);
  store.setSetting("owner.timezone", timeZone);
  return { store, main: store.primaryConversation().id };
}
const at = (store: Store, id: string, time: string) => store.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(time, id);
let sequence = 0;
/** One executed turn: the request, its answer and what it spent. */
function request(store: Store, conversationId: string, time: string, options: { text?: string; reply?: string; status?: string; channel?: "api" | "telegram"; externalId?: string;
  usage?: { provider: string; model: string; input: number; cached?: number; output: number; cost?: number } } = {}) {
  const input = store.addMessage({ conversationId, channel: options.channel ?? "api", direction: "inbound", text: options.text ?? "Request " + ++sequence, externalId: options.externalId });
  at(store, input.id, time);
  if (options.status) store.db.prepare("UPDATE messages SET status=? WHERE id=?").run(options.status, input.id);
  if (options.reply !== undefined) {
    const reply = store.addMessage({ conversationId, channel: options.channel ?? "api", direction: "outbound", replyToId: input.id, text: options.reply });
    at(store, reply.id, new Date(Date.parse(time) + 5_000).toISOString());
  }
  if (options.usage) recordTurnUsage(store, input.id, { provider: options.usage.provider, model: options.usage.model }, [{ provider: options.usage.provider, model: options.usage.model,
    usage: { inputTokens: options.usage.input, cachedReadTokens: options.usage.cached ?? 0, cacheCreationTokens: 0, outputTokens: options.usage.output, reasoningTokens: 0,
      ...(options.usage.cost === undefined ? {} : { costUsdTicks: options.usage.cost * TICKS_PER_USD }) } }]);
  return input;
}
const day = (statistics: Statistics, date: string) => statistics.days.find(period => period.start === date)!;

it("denies a non-owner before reading anything", () => {
  const { store } = setup(); const spy = vi.spyOn(store.db, "prepare");
  expect(() => readStatistics(store, false)).toThrow(HomeError);
  try { readStatistics(store, "true" as unknown as boolean); } catch (error) { expect((error as HomeError).status).toBe(403); }
  expect(spy).not.toHaveBeenCalled();
});

it("reads a new Home without creating tables or settings: thirty empty days and twelve empty weeks", () => {
  const store = new Store(":memory:"); stores.push(store);
  store.setSetting("owner.timezone", "Not/AZone");
  const before = store.db.prepare("SELECT total_changes() AS n").get()!.n;
  const statistics = readStatistics(store, true, new Date("2026-11-08T12:00:00.000Z"));
  expect(store.db.prepare("SELECT total_changes() AS n").get()!.n).toBe(before);
  expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('turn_usage','schedules')").all()).toEqual([]);
  expect(statistics).toMatchObject({ timeZone: "UTC", firstDay: null, usageSince: null, chats: {}, schedules: {} });
  expect(statistics.days.map(p => p.start)).toEqual(Array.from({ length: 30 }, (_, i) => new Date(Date.parse("2026-10-10T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10)));
  expect(statistics.weeks.map(p => p.start)).toEqual(["2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]);
  expect(statistics.days.every(p => p.requests === 0 && p.costUsd === null && p.chats.length === 0)).toBe(true);
  expect(day(statistics, "2026-11-08").previousToDate).toEqual({ requests: 0, tokens: 0, costUsd: null });
  expect(day(statistics, "2026-11-07").previousToDate).toBeUndefined();
  expect(() => readStatistics(store, true, new Date("invalid"))).toThrow("время");
});

it("counts executed requests by the owner's local day and week, with their source, outcome, chat, model and spend", () => {
  const { store, main } = setup();
  const now = new Date("2026-11-08T12:00:00.000Z"); // 15:00 in Moscow, a Sunday
  store.db.prepare("INSERT INTO employee_profiles(id,name,instructions,created_at) VALUES('news','News','', '2026-11-01T00:00:00.000Z')").run();
  const news = store.profileConversation("news").id;
  const group = store.getOrCreateConversation({ channel: "telegram", externalId: "-100123", title: "Рабочая группа" }).id;
  store.db.prepare("INSERT INTO schedules(id,conversation_id,name,prompt,cron,timezone,next_run_at) VALUES('radar',?,'Радар','Check','5 * * * *','Europe/Moscow','2026-11-08T13:05:00.000Z')").run(news);
  const run = (id: string, status: string, time: string, usage?: Parameters<typeof request>[3]["usage"]) => {
    store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at) VALUES(?,'radar',?,?,?,?)").run(id, news, time, status, time);
    const input = request(store, news, time, { externalId: "schedule:" + id, reply: status === "quiet" ? "NO_REPLY" : "FAILED: source unavailable", usage });
    store.db.prepare("UPDATE messages SET hidden=1 WHERE id=?").run(input.id);
  };
  // 01:30 on Sunday in Moscow, though still Saturday in UTC.
  request(store, main, "2026-11-07T22:30:00.000Z", { reply: "Done", usage: { provider: "chatgpt", model: "gpt-6-astra", input: 1_000, cached: 200, output: 50, cost: 0.7 } });
  request(store, group, "2026-11-08T08:00:00.000Z", { channel: "telegram", reply: "Seen.\nNO_REPLY", usage: { provider: "chatgpt", model: "gpt-6-astra", input: 500, output: 5, cost: 0.1 } });
  run("run-1", "failed", "2026-11-08T09:05:00.000Z", { provider: "grok", model: "grok-4.7", input: 100, output: 10 });
  run("run-2", "quiet", "2026-11-08T10:05:00.000Z");
  request(store, news, "2026-11-08T10:30:00.000Z", { externalId: "operations:urgent-1", reply: "Posted" });
  request(store, main, "2026-11-08T10:40:00.000Z", { externalId: "correspondence:gmail:42", reply: "NO_REPLY" });
  request(store, main, "2026-11-08T11:59:00.000Z", { status: "running" });
  // Yesterday: before 15:00 it counts towards the fair comparison, after it only towards the day.
  request(store, main, "2026-11-07T06:00:00.000Z", { reply: "Morning" });
  request(store, main, "2026-11-07T20:00:00.000Z", { reply: "Evening", usage: { provider: "anthropic", model: "claude-opus-5-5", input: 2_000, output: 100, cost: 0.5 } });
  // Not requests: a steer joins the running turn, imported history and context-only group messages never ran, a queued one has not started.
  const steered = request(store, main, "2026-11-08T11:00:00.000Z", { reply: "Answer" });
  const steer = store.addMessage({ conversationId: main, channel: "api", direction: "inbound", text: "and shorter", replyToId: steered.id });
  at(store, steer.id, "2026-11-08T11:00:30.000Z");
  const imported = request(store, main, "2026-11-08T07:00:00.000Z"); store.db.prepare("UPDATE messages SET imported=1 WHERE id=?").run(imported.id);
  const context = request(store, group, "2026-11-08T07:30:00.000Z", { channel: "telegram" }); store.db.prepare("UPDATE messages SET context_only=1 WHERE id=?").run(context.id);
  request(store, main, "2026-11-08T11:58:00.000Z", { status: "queued" });
  // A private chat named only by its id takes its person's name.
  const direct = store.getOrCreateConversation({ channel: "telegram", externalId: "4242", title: "Telegram 4242" }).id;
  const greeting = request(store, direct, "2026-11-08T09:30:00.000Z", { channel: "telegram", reply: "Привет" });
  store.db.prepare("UPDATE messages SET author='Анна Петрова' WHERE id=?").run(greeting.id);

  const statistics = readStatistics(store, true, now);
  const today = day(statistics, "2026-11-08");
  expect(today).toMatchObject({
    requests: 9, sources: { app: 3, telegram: 2, schedule: 2, events: 2 }, outcomes: { answered: 4, quiet: 3, failed: 1 },
    measured: 3, tokens: { input: 1_600, cached: 200, output: 65, reasoning: 0 }, costUsd: 0.8, unpriced: 1,
    previousToDate: { requests: 1, tokens: 0, costUsd: null },
  });
  expect(today.chats.map(c => [statistics.chats[c.id]!.kind, statistics.chats[c.id]!.title, c.requests, c.failed, c.costUsd])).toEqual([
    ["main", "Главный чат", 4, 0, 0.7], ["employee", "News", 3, 1, null], ["group", "Рабочая группа", 1, 0, 0.1], ["telegram", "Анна Петрова", 1, 0, null],
  ]);
  expect(statistics.chats[news]).toEqual({ title: "News", employee: "News", kind: "employee" });
  expect(today.models).toEqual([
    { provider: null, model: null, name: "Автоматически", requests: 6, tokens: 0, costUsd: null },
    { provider: "chatgpt", model: "gpt-6-astra", name: "GPT-6-Astra", requests: 2, tokens: 1_555, costUsd: 0.8 },
    { provider: "grok", model: "grok-4.7", name: "Grok 4.7", requests: 1, tokens: 110, costUsd: null },
  ]);
  expect(today.schedules).toEqual([{ id: "radar", runs: 2, quiet: 1, failed: 1, tokens: 110, costUsd: null }]);
  expect(statistics.schedules).toEqual({ radar: { name: "Радар", chatId: news, enabled: true } });
  // What ran: a schedule by its id, an event by its kind, people writing in a chat by the chat. The costliest first.
  const ran = today.work.map(w => [w.kind, w.kind === "chat" ? statistics.chats[w.id]!.title : w.id, w.requests, w.quiet, w.failed, w.tokens, w.costUsd]);
  expect(ran.slice(0, 3)).toEqual([["chat", "Главный чат", 3, 0, 0, 1_050, 0.7], ["chat", "Рабочая группа", 1, 1, 0, 505, 0.1], ["schedule", "radar", 2, 1, 1, 110, null]]);
  expect(ran.slice(3)).toEqual(expect.arrayContaining([["chat", "Анна Петрова", 1, 0, 0, 0, null], ["events", "correspondence", 1, 1, 0, 0, null], ["events", "operations", 1, 0, 0, 0, null]]));
  expect(ran).toHaveLength(6);
  expect(today.spent).toEqual({ answered: { tokens: 1_050, costUsd: 0.7 }, quiet: { tokens: 505, costUsd: 0.1 }, failed: { tokens: 110, costUsd: null } });
  expect(day(statistics, "2026-11-07")).toMatchObject({ requests: 2, outcomes: { answered: 2, quiet: 0, failed: 0 }, costUsd: 0.5 });
  // Both days sit in the week from Monday 2 November.
  expect(statistics.weeks.at(-1)).toMatchObject({ start: "2026-11-02", requests: 11, costUsd: 1.3, previousToDate: { requests: 0 } });
  expect(statistics).toMatchObject({ firstDay: "2026-11-07", usageSince: "2026-11-07", timeZone: "Europe/Moscow" });
});

it("lists every recurring schedule with its chat and this week's runs and cost, for the owner only", () => {
  const { store, main } = setup();
  const messages = new MessageService(store, { async run() { return { threadId: "t", response: "Готово", events: [] }; } });
  const scheduler = new Scheduler(store, messages);
  const now = new Date("2026-11-08T12:00:00.000Z");
  const radar = scheduler.save({ conversationId: main, name: "Радар", prompt: "Проверить", cron: "5 * * * *", timezone: "Europe/Moscow" }, now);
  const morning = scheduler.save({ conversationId: main, name: "Утро", prompt: "Собрать", cron: "0 7 * * *", timezone: "Europe/Moscow", enabled: false }, now);
  scheduler.save({ conversationId: main, name: "Напомнить", prompt: "Позвонить", cron: "@once 2026-11-09T09:00:00+03:00", timezone: "Europe/Moscow" }, now);
  for (const [id, status, time, cost] of [["r1", "quiet", "2026-11-03T08:05:00.000Z", 0.4], ["r2", "failed", "2026-11-07T09:05:00.000Z", undefined], ["r0", "completed", "2026-10-30T09:05:00.000Z", 9]] as const) {
    store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at) VALUES(?,?,?,?,?,?)").run(id, radar.id, main, time, status, time);
    request(store, main, time, { externalId: "schedule:" + id, reply: status === "quiet" ? "NO_REPLY" : "Готово", usage: cost === undefined ? undefined : { provider: "chatgpt", model: "gpt-6-astra", input: 1000, output: 10, cost } });
  }
  expect(() => readScheduleOverview(store, scheduler, false, now)).toThrow(HomeError);
  const overview = readScheduleOverview(store, scheduler, true, now);
  // One-time reminders are not automations; a switched-off schedule stays listed so it can be switched on again.
  expect(overview.schedules.map(s => [s.name, s.enabled, s.chat.kind, s.week])).toEqual([
    ["Радар", true, "main", { runs: 2, quiet: 1, failed: 1, tokens: 1010, costUsd: 0.4 }],
    ["Утро", false, "main", { runs: 0, quiet: 0, failed: 0, tokens: 0, costUsd: null }],
  ]);
  expect(overview.schedules[1]).toMatchObject({ id: morning.id, prompt: "Собрать", cron: "0 7 * * *", conversationId: main });
  // The latest run of «Радар» failed and the one before it did not: it is failing since that run. A switched-off schedule
  // is not failing. The reason is the first line of what the latest failed run said.
  expect(overview.schedules.map(s => [s.profileId, s.failure])).toEqual([[null, { since: "2026-11-07T09:05:00.000Z", reason: null }], [null, null]]);
  store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at,error) VALUES('r3',?,?,?,'failed',?,?)")
    .run(radar.id, main, "2026-11-08T09:05:00.000Z", "2026-11-08T09:05:00.000Z", "Закончился лимит модели.\nat run (scheduler.js:1)");
  expect(readScheduleOverview(store, scheduler, true, now).schedules[0]!.failure).toEqual({ since: "2026-11-07T09:05:00.000Z", reason: "Закончился лимит модели." });
  expect(readScheduleOverview(store, undefined, true, now).schedules).toEqual([]);
});

it("keeps local days whole across a daylight saving change", () => {
  const { store, main } = setup("Europe/Berlin");
  // Summer time ends at 03:00 on Sunday 25 October 2026, so that day lasts 25 hours.
  request(store, main, "2026-10-24T22:30:00.000Z", { reply: "00:30 summer time" });
  request(store, main, "2026-10-25T22:30:00.000Z", { reply: "23:30 winter time" });
  request(store, main, "2026-10-25T23:30:00.000Z", { reply: "00:30 on Monday" });
  const statistics = readStatistics(store, true, new Date("2026-10-26T12:00:00.000Z"));
  expect(day(statistics, "2026-10-24").requests).toBe(0);
  expect(day(statistics, "2026-10-25").requests).toBe(2);
  expect(day(statistics, "2026-10-26")).toMatchObject({ requests: 1, previousToDate: { requests: 1 } });
  // Monday 26 October begins a new week.
  expect(statistics.weeks.slice(-2).map(week => [week.start, week.requests])).toEqual([["2026-10-19", 2], ["2026-10-26", 1]]);
});

it("names models the way their providers do", () => {
  const { store } = setup();
  expect(modelName(store, "chatgpt", "gpt-6-astra")).toBe("GPT-6-Astra");
  expect(modelName(store, "openai", "gpt-5.6-terra")).toBe("GPT-5.6-Terra");
  expect(modelName(store, "anthropic", "claude-opus-5-5")).toBe("Claude Opus 5.5");
  store.setSetting("providers.grok.models", JSON.stringify([{ id: "grok-5", name: "Grok 5" }]));
  expect(modelName(store, "grok", "grok-5")).toBe("Grok 5");
  expect(modelName(store, "deepseek", "unlisted-model")).toBe("unlisted-model");
  expect(modelName(store, null, null)).toBe("Автоматически");
});

it("serves statistics to the owner and refuses a member over the Home API", async () => {
  const root = mkdtempSync(join(tmpdir(), "openstrudel-statistics-")); roots.push(root);
  const runtime = new OpenStrudelRuntime({ dbPath: join(root, "home.sqlite"), rootDirectory: root, startTelegram: false, engine: new MockCodexEngine(), apiToken: "test-owner", mobilePort: 0 }); runtimes.push(runtime);
  const address = await runtime.api.listen("127.0.0.1", 0);
  const base = `http://127.0.0.1:${address.port}`;
  runtime.store.setSetting("owner.timezone", "Europe/Moscow");
  const sent = await fetch(base + "/v1/messages", { method: "POST", headers: { authorization: "Bearer test-owner", "content-type": "application/json" }, body: JSON.stringify({ text: "Hello", wait: true }) });
  expect(sent.status).toBeLessThan(300);
  const owner = await fetch(base + "/v1/statistics", { headers: { authorization: "Bearer test-owner" } });
  expect(owner.status).toBe(200);
  const statistics = await owner.json() as Statistics;
  expect(statistics.timeZone).toBe("Europe/Moscow");
  expect(statistics.days).toHaveLength(30);
  expect(statistics.days.at(-1)!.requests + statistics.days.at(-2)!.requests).toBeGreaterThanOrEqual(1);
  const member = await runtime.api.homeLink.execute({ id: randomUUID(), request: { method: "GET", path: "/v1/statistics", owner: false } });
  expect(member.status).toBe(403);
  expect((await fetch(base + "/v1/statistics")).status).toBe(401);
}, 20_000);

it("switches a schedule from the owner's overview without losing its poll, delivery or backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "openstrudel-schedules-")); roots.push(root);
  const runtime = new OpenStrudelRuntime({ dbPath: join(root, "home.sqlite"), rootDirectory: root, startTelegram: false, engine: new MockCodexEngine(), apiToken: "test-owner", mobilePort: 0 }); runtimes.push(runtime);
  const address = await runtime.api.listen("127.0.0.1", 0);
  const base = `http://127.0.0.1:${address.port}`, owner = { authorization: "Bearer test-owner", "content-type": "application/json" };
  runtime.store.linkTelegramChat({ chatId: "-100", title: "WAI HQ", allowedSenders: ["7"] });
  const main = runtime.store.primaryConversation().id;
  const poll = { question: "Сколько суеты сегодня?", options: ["1 · спокойно", "10 · сплошная суета"] };
  const ritual = runtime.scheduler.save({ conversationId: main, name: "Суетолог · вечер", prompt: "", cron: "30 18 * * *", timezone: "Europe/Moscow", delivery: "telegram", telegramChatId: "-100", poll });
  runtime.scheduler.save({ conversationId: main, name: "Суетолог · резерв", prompt: "Спросить ещё раз", cron: "0 20 * * *", timezone: "Europe/Moscow", backupOf: ritual.id });
  const overview = async () => (await (await fetch(base + "/v1/schedules", { headers: owner })).json()).schedules as Array<Record<string, unknown>>;
  // The app sends back its ChatSchedule fields only: no poll, and enabled switched.
  const asApp = (schedule: Record<string, unknown>, enabled: boolean) => ({ ...Object.fromEntries(["id", "conversationId", "name", "prompt", "cron", "timezone", "nextRunAt", "telegramChatId", "delivery", "lastRunStatus", "backupOf"]
    .filter(key => schedule[key] != null).map(key => [key, schedule[key]])), enabled });
  for (const listed of await overview()) {
    const saved = await fetch(`${base}/v1/conversations/${main}/schedules`, { method: "POST", headers: owner, body: JSON.stringify(asApp(listed, false)) });
    expect(saved.status).toBe(201);
  }
  expect((await overview()).map(s => [s.name, s.enabled, s.poll, s.delivery, s.telegramChatId, s.backupOf])).toEqual([
    ["Суетолог · вечер", false, poll, "telegram", "-100", null],
    ["Суетолог · резерв", false, null, "app", null, ritual.id],
  ]);
  const [first] = await overview();
  await fetch(`${base}/v1/conversations/${main}/schedules`, { method: "POST", headers: owner, body: JSON.stringify(asApp(first!, true)) });
  expect((await overview())[0]).toMatchObject({ enabled: true, poll, nextRunAt: expect.any(String) });
  const member = await runtime.api.homeLink.execute({ id: randomUUID(), request: { method: "GET", path: "/v1/schedules", owner: false } });
  expect(member.status).toBe(403);
}, 20_000);
