import { afterEach, expect, it, vi } from "vitest";
import { readActivity } from "../src/activity.js";
import { HomeError } from "../src/home.js";
import { MessageService } from "../src/messages.js";
import { problemText } from "../src/operations.js";
import { Scheduler } from "../src/scheduler.js";
import { Store } from "../src/store.js";

const now = new Date("2026-11-02T12:00:00.000Z");
const recent = "2026-11-02T11:00:00.000Z";
const stores: Store[] = [];
let sequence = 0;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); stores.splice(0).forEach(store => store.close()); });

function setup(scheduler = true) {
  const store = new Store(":memory:"); stores.push(store);
  if (scheduler) new Scheduler(store, {} as MessageService);
  store.setSetting("owner.timezone", "UTC");
  const conversationId = store.primaryConversation().id;
  return { store, conversationId };
}
function date(store: Store, id: string, at: string) { store.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(at, id); }
function request(store: Store, conversationId: string, at = recent) {
  const input = store.addMessage({ conversationId, channel: "api", direction: "inbound", text: "Review this source" });
  const reply = store.addMessage({ conversationId, channel: "api", direction: "outbound", replyToId: input.id, text: "The source was reviewed; the decision is still pending." });
  date(store, input.id, new Date(Date.parse(at) - 1_000).toISOString()); date(store, reply.id, at);
  return { input, reply };
}
function run(store: Store, conversationId: string, options: { at?: string; status?: string; text?: string; name?: string } = {}) {
  const runId = "run-" + ++sequence, scheduleId = "schedule-" + sequence;
  const at = options.at ?? recent, created = new Date(Date.parse(at) - 2_000).toISOString();
  store.db.prepare(`INSERT INTO schedules(id,conversation_id,name,prompt,cron,timezone,next_run_at)
    VALUES(?,?,?,'Review sources','0 8 * * *','UTC',?)`).run(scheduleId, conversationId, options.name ?? "Daily source check", now.toISOString());
  store.db.prepare(`INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at)
    VALUES(?,?,?,?,?,?)`).run(runId, scheduleId, conversationId, created, options.status ?? "completed", created);
  const input = store.addMessage({ conversationId, channel: "api", direction: "inbound", externalId: "schedule:" + runId, text: "Scheduled request" });
  const text = options.text ?? "The sources were checked; recipient acceptance is still pending.";
  const reply = store.addMessage({ conversationId, channel: "api", direction: "outbound", replyToId: input.id, text });
  date(store, input.id, new Date(Date.parse(at) - 1_000).toISOString()); date(store, reply.id, at);
  store.db.prepare("UPDATE messages SET hidden=1 WHERE id=?").run(input.id);
  if (text.trim().endsWith("NO_REPLY") || text.trim().startsWith("FAILED:")) store.db.prepare("UPDATE messages SET hidden=1 WHERE id=?").run(reply.id);
  store.db.prepare("UPDATE schedule_runs SET message_id=? WHERE id=?").run(reply.id, runId);
  return { runId, scheduleId, input, reply };
}
function issue(store: Store, conversationId: string, messageId: string, changes: Record<string, unknown> = {}) {
  const key = "runtime.issue.test-" + ++sequence;
  store.setSetting(key, JSON.stringify({ conversationId, messageId, code: "execution", time: recent, ...changes }));
  return key;
}
const milestone = (activity: ReturnType<typeof readActivity>, id: string) => activity.progress.milestones.find(item => item.id === id)!.reached;

it("denies a non-owner before reading any Home state", () => {
  const { store } = setup(); const spy = vi.spyOn(store.db, "prepare");
  expect(() => readActivity(store, false, now)).toThrow(HomeError);
  expect(() => readActivity(store, "true" as unknown as boolean, now)).toThrow(HomeError);
  try { readActivity(store, false, now); } catch (error) { expect((error as HomeError).status).toBe(403); }
  expect(spy).not.toHaveBeenCalled();
});

it("reads an empty Home without creating scheduler tables, conversations or settings", () => {
  const { store, conversationId } = setup(false);
  store.db.prepare("DELETE FROM conversations WHERE id=?").run(conversationId);
  store.deleteSetting("owner.timezone");
  const before = store.db.prepare("SELECT total_changes() AS n").get()!.n;
  expect(readActivity(store, true, now)).toEqual({
    checkedAt: now.toISOString(), period: { start: "2026-10-27T00:00:00.000Z", end: now.toISOString(), timeZone: "UTC" }, insights: [], checkIns: [],
    progress: { activeDays: 0, completedRequests: 0, completedRuns: 0, quietRuns: 0, failedRuns: 0, activeSchedules: 0,
      milestones: [{ id: "first-request", reached: false }, { id: "first-automation", reached: false }, { id: "three-active-days", reached: false }] },
  });
  expect(store.db.prepare("SELECT total_changes() AS n").get()!.n).toBe(before);
  expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name='schedules'").get()).toBeUndefined();
  expect(() => readActivity(store, true, new Date("invalid"))).toThrow("время");
});

it("counts completed requests once per receipt and local active date, without inventing business success", () => {
  const { store, conversationId } = setup();
  const first = request(store, conversationId, "2026-10-29T12:00:00.000Z");
  request(store, conversationId, "2026-10-29T13:00:00.000Z");
  request(store, conversationId, "2026-10-30T13:00:00.000Z");
  request(store, conversationId);
  const duplicate = store.addMessage({ conversationId, channel: "api", direction: "outbound", replyToId: first.input.id, text: "Another retained reply" });
  date(store, duplicate.id, "2026-10-31T13:00:00.000Z");
  const activity = readActivity(store, true, now);
  expect(activity.progress).toMatchObject({ completedRequests: 4, activeDays: 3, completedRuns: 0 });
  expect(milestone(activity, "first-request")).toBe(true); expect(milestone(activity, "three-active-days")).toBe(true);
  expect(activity.insights).toEqual([]);
  // Token/turn telemetry cannot create progress or change any milestone.
  store.setSetting("usage.totalTokens", "9999999999"); store.setSetting("codex.thread.fake", "many-turns");
  expect(readActivity(store, true, now)).toEqual(activity);
});

it.each([
  ["hidden inbound", "UPDATE messages SET hidden=1 WHERE id=?", "input"],
  ["hidden reply", "UPDATE messages SET hidden=1 WHERE id=?", "reply"],
  ["imported", "UPDATE messages SET imported=1 WHERE id=?", "input"],
  ["imported reply", "UPDATE messages SET imported=1 WHERE id=?", "reply"],
  ["context only", "UPDATE messages SET context_only=1 WHERE id=?", "input"],
  ["not completed", "UPDATE messages SET status='failed' WHERE id=?", "input"],
  ["pending reply", "UPDATE messages SET status='running' WHERE id=?", "reply"],
  ["notice", "UPDATE messages SET kind='notice' WHERE id=?", "reply"],
  ["operations", "UPDATE messages SET external_id='operations:daily' WHERE id=?", "input"],
  ["schedule", "UPDATE messages SET external_id='schedule:old' WHERE id=?", "input"],
  ["quiet", "UPDATE messages SET text='Explanation'||char(10)||char(9)||'NO_REPLY  ' WHERE id=?", "reply"],
  ["failed", "UPDATE messages SET text='  FAILED: source unavailable' WHERE id=?", "reply"],
  ["empty", "UPDATE messages SET text=char(9)||'  ' WHERE id=?", "reply"],
  ["deleted inbound", "DELETE FROM messages WHERE id=?", "input"],
  ["deleted reply", "DELETE FROM messages WHERE id=?", "reply"],
  ["invalid date", "UPDATE messages SET created_at='not-a-date' WHERE id=?", "reply"],
  ["impossible date", "UPDATE messages SET created_at='2026-10-32T11:00:00.000Z' WHERE id=?", "reply"],
  ["future reply", "UPDATE messages SET created_at='2026-11-03T11:00:00.000Z' WHERE id=?", "reply"],
  ["clock reversal", "UPDATE messages SET created_at='2026-11-02T11:01:00.000Z' WHERE id=?", "input"],
])("does not count %s as a completed user request", (_label, sql, target) => {
  const { store, conversationId } = setup(false); const pair = request(store, conversationId);
  store.db.prepare(sql).run(pair[target as "input" | "reply"].id);
  const activity = readActivity(store, true, now);
  expect(activity.progress.completedRequests).toBe(0); expect(activity.progress.activeDays).toBe(0);
  expect(milestone(activity, "first-request")).toBe(false);
});

it("requires replies to belong to the same retained conversation", () => {
  const { store, conversationId } = setup(); const pair = request(store, conversationId);
  const other = store.getOrCreateConversation({ channel: "api", externalId: "other" });
  store.db.prepare("UPDATE messages SET conversation_id=? WHERE id=?").run(other.id, pair.reply.id);
  expect(readActivity(store, true, now).progress.completedRequests).toBe(0);
  const result = run(store, conversationId);
  store.db.prepare("UPDATE messages SET conversation_id=? WHERE id=?").run(other.id, result.reply.id);
  expect(readActivity(store, true, now).insights).toEqual([]);
});

it("uses message receipt time for seven-day counts and keeps lifetime milestones only while evidence remains", () => {
  const { store, conversationId } = setup();
  const old = request(store, conversationId, "2026-09-01T12:00:00.000Z");
  const automation = run(store, conversationId, { at: "2026-09-01T12:00:00.000Z" });
  let activity = readActivity(store, true, now);
  expect(activity.progress).toMatchObject({ completedRequests: 0, completedRuns: 0, activeDays: 0 });
  expect(activity.insights).toEqual([]);
  expect(milestone(activity, "first-request")).toBe(true); expect(milestone(activity, "first-automation")).toBe(true);
  store.db.prepare("DELETE FROM messages WHERE id IN (?,?)").run(old.reply.id, automation.reply.id);
  activity = readActivity(store, true, now);
  expect(milestone(activity, "first-request")).toBe(false); expect(milestone(activity, "first-automation")).toBe(false);
  const spanning = request(store, conversationId, "2026-10-27T00:00:00.000Z");
  date(store, spanning.input.id, "2026-10-26T23:59:59.000Z");
  expect(readActivity(store, true, now).progress.completedRequests).toBe(1);
});

it.each([
  ["Europe/Moscow", "2026-11-02T21:30:00.000Z", "2026-10-27T21:00:00.000Z"],
  ["America/New_York", "2026-11-02T12:00:00.000Z", "2026-10-27T04:00:00.000Z"],
  ["America/New_York", "2026-03-09T12:00:00.000Z", "2026-03-03T05:00:00.000Z"],
  ["America/Santiago", "2026-09-12T12:00:00.000Z", "2026-09-06T04:00:00.000Z"],
])("uses seven local dates across UTC and DST boundaries in %s (%s)", (zone, at, start) => {
  const { store, conversationId } = setup(false); store.setSetting("owner.timezone", zone);
  request(store, conversationId, start); request(store, conversationId, new Date(Date.parse(start) - 1).toISOString());
  const activity = readActivity(store, true, new Date(at));
  expect(activity.period).toEqual({ start, end: at, timeZone: zone });
  expect(activity.progress).toMatchObject({ completedRequests: 1, activeDays: 1 });
});

it("groups active days by the owner timezone and excludes future receipts after clock rollback", () => {
  const { store, conversationId } = setup(false); store.setSetting("owner.timezone", "Europe/Moscow");
  for (const at of ["2026-10-30T20:59:59.000Z", "2026-10-30T21:00:00.000Z", "2026-10-31T21:00:00.000Z"]) request(store, conversationId, at);
  expect(readActivity(store, true, now).progress.activeDays).toBe(3);
  const earlier = readActivity(store, true, new Date("2026-10-30T21:30:00.000Z"));
  expect(earlier.progress).toMatchObject({ completedRequests: 2, activeDays: 2 });
  store.setSetting("owner.timezone", "invalid/timezone");
  expect(readActivity(store, true, now).period.timeZone).toBe("UTC");
});

it("shows actual schedule outputs with source IDs and distinguishes quiet, failed and uncertain receipts", () => {
  const { store } = setup(); const employee = store.createProfile({ name: "Research" }), conversationId = store.profileConversation(employee.id).id;
  const result = run(store, conversationId);
  run(store, conversationId, { status: "quiet", text: "Nothing changed\n NO_REPLY" });
  run(store, conversationId, { status: "failed", text: "FAILED: unavailable" });
  for (const status of ["uncertain", "skipped", "ready", "running"]) run(store, conversationId, { status });
  store.db.prepare("UPDATE schedules SET enabled=0 WHERE id=?").run(result.scheduleId);
  const activity = readActivity(store, true, now);
  expect(activity.progress).toMatchObject({ activeDays: 0, completedRequests: 0, completedRuns: 1, quietRuns: 1, failedRuns: 1, activeSchedules: 6 });
  expect(activity.insights).toEqual([{ id: "run:" + result.runId, kind: "result", title: "Daily source check", text: result.reply.text,
    occurredAt: recent, conversationId, profileId: employee.id, employeeName: "Research", messageId: result.reply.id, status: "completed" }]);
  expect(milestone(activity, "first-automation")).toBe(true); expect(milestone(activity, "three-active-days")).toBe(false);
});

it.each([
  ["hidden", "UPDATE messages SET hidden=1 WHERE id=?", "reply"],
  ["deleted", "DELETE FROM messages WHERE id=?", "reply"],
  ["missing prompt", "DELETE FROM messages WHERE id=?", "input"],
  ["wrong prompt", "UPDATE messages SET external_id='schedule:other' WHERE id=?", "input"],
  ["quiet", "UPDATE messages SET text=char(160)||'NO_REPLY'||char(160) WHERE id=?", "reply"],
  ["quiet last line", "UPDATE messages SET text='Explanation'||char(10)||char(9)||'NO_REPLY' WHERE id=?", "reply"],
  ["failed", "UPDATE messages SET text=char(10)||'FAILED: unavailable' WHERE id=?", "reply"],
  ["no output", "UPDATE messages SET text='' WHERE id=?", "reply"],
  ["invalid time", "UPDATE messages SET created_at='invalid' WHERE id=?", "reply"],
  ["future input", "UPDATE messages SET created_at='2026-11-03T00:00:00.000Z' WHERE id=?", "input"],
])("excludes a %s completed schedule response and its milestone", (_label, sql, target) => {
  const { store, conversationId } = setup(); const result = run(store, conversationId);
  store.db.prepare(sql).run(result[target as "input" | "reply"].id);
  const activity = readActivity(store, true, now);
  expect(activity.insights).toEqual([]); expect(activity.progress.completedRuns).toBe(0); expect(milestone(activity, "first-automation")).toBe(false);
});

it("does not mistake a discussion of NO_REPLY for a quiet answer or lose receipts after a schedule moves", () => {
  const { store, conversationId } = setup();
  const result = run(store, conversationId, { text: "The keyword is NO_REPLY" });
  store.db.prepare("UPDATE messages SET hidden=0 WHERE id=?").run(result.reply.id);
  const target = store.getOrCreateConversation({ channel: "api", externalId: "new-destination" });
  store.db.prepare("UPDATE schedules SET conversation_id=? WHERE id=?").run(target.id, result.scheduleId);
  expect(readActivity(store, true, now).insights[0]).toMatchObject({ conversationId, messageId: result.reply.id });
});

it("keeps thirty-date highlights distinct from seven-date counters and rejects corrupt/future run dates", () => {
  const { store, conversationId } = setup();
  const boundary = run(store, conversationId, { at: "2026-10-04T00:00:00.000Z" });
  run(store, conversationId, { at: "2026-10-03T23:59:59.999Z" });
  for (const [column, dateValue] of [
    ["created_at", "invalid"], ["scheduled_for", "invalid"],
    ["created_at", "2026-11-03T00:00:00.000Z"], ["scheduled_for", "2026-11-03T00:00:00.000Z"],
  ]) {
    const result = run(store, conversationId);
    store.db.prepare(`UPDATE schedule_runs SET ${column}=? WHERE id=?`).run(dateValue!, result.runId);
  }
  const activity = readActivity(store, true, now);
  expect(activity.insights.map(item => item.messageId)).toEqual([boundary.reply.id]);
  expect(activity.progress.completedRuns).toBe(0); expect(milestone(activity, "first-automation")).toBe(true);
});

it("omits orphan employee data after corrupt or partially restored history", () => {
  const { store } = setup(); const employee = store.createProfile({ name: "Removed" }), conversationId = store.profileConversation(employee.id).id;
  const pair = request(store, conversationId); run(store, conversationId); issue(store, conversationId, pair.input.id);
  store.db.exec("PRAGMA foreign_keys=OFF"); store.db.prepare("DELETE FROM employee_profiles WHERE id=?").run(employee.id);
  const activity = readActivity(store, true, now);
  expect(activity.insights).toEqual([]);
  expect(activity.progress).toMatchObject({ activeDays: 0, completedRequests: 0, completedRuns: 0, activeSchedules: 0 });
});

it("keeps only safe unresolved attention with a retained source, and ignores corrupt or stale incident records", () => {
  const { store, conversationId } = setup(); const pair = request(store, conversationId);
  const key = issue(store, conversationId, pair.input.id, { code: "connector", title: "PRIVATE_KEY", detail: "PRIVATE_STACK_AND_KEY", tools: ["PRIVATE_TOKEN"] });
  for (const changes of [
    { time: "invalid" }, { time: "2026-11-03T00:00:00.000Z" }, { time: "2026-09-01T00:00:00.000Z" },
    { code: "toString" }, { code: "unknown" }, { conversationId: "deleted" }, { messageId: "deleted" },
    { resolved: true }, { resolvedAt: recent }, { status: "resolved" },
  ]) issue(store, conversationId, pair.input.id, changes);
  store.setSetting("runtime.issue.corrupt", "{broken"); store.setSetting("runtime.issue.array", "[]");
  const activity = readActivity(store, true, now);
  expect(activity.insights).toHaveLength(1);
  expect(activity.insights[0]).toMatchObject({ kind: "attention", title: "Требует внимания", text: problemText.connector,
    messageId: pair.input.id, conversationId, profileId: null, employeeName: "OpenStrudel", status: "unresolved" });
  expect(JSON.stringify(activity)).not.toMatch(/PRIVATE|STACK|TOKEN/);
  store.deleteSetting(key); expect(readActivity(store, true, now).insights).toEqual([]);
});

it("omits manually hidden private sources but retains generic failed-schedule attention without exposing its hidden text", () => {
  const { store, conversationId } = setup(); const pair = request(store, conversationId);
  store.db.prepare("UPDATE messages SET hidden=1 WHERE id=?").run(pair.input.id); issue(store, conversationId, pair.input.id);
  const result = run(store, conversationId, { status: "failed", text: "FAILED: PRIVATE_KEY" });
  issue(store, conversationId, result.reply.id);
  const attention = readActivity(store, true, now).insights;
  expect(attention).toHaveLength(1); expect(attention[0]).toMatchObject({ text: problemText.execution, messageId: null });
  expect(JSON.stringify(attention)).not.toContain("PRIVATE_KEY");
  store.db.prepare("DELETE FROM messages WHERE id=?").run(result.reply.id);
  expect(readActivity(store, true, now).insights).toEqual([]);
});

it("accepts a failed pre-execution run as an incident source, without fabricating a message or completion", () => {
  const { store, conversationId } = setup(); const result = run(store, conversationId, { status: "failed" });
  store.db.prepare("DELETE FROM messages WHERE id IN (?,?)").run(result.input.id, result.reply.id);
  store.db.prepare("UPDATE schedule_runs SET message_id=NULL WHERE id=?").run(result.runId);
  issue(store, conversationId, result.runId, { code: "resources" });
  const activity = readActivity(store, true, now);
  expect(activity.insights[0]).toMatchObject({ messageId: null, text: problemText.resources, status: "unresolved" });
  expect(activity.progress).toMatchObject({ completedRuns: 0, failedRuns: 1 });
});

it("bounds and orders all insights after excluding invalid newer records, without transcript reads", () => {
  const { store, conversationId } = setup();
  for (let i = 0; i < 40; i++) {
    const at = new Date(Date.parse(recent) - i * 60_000).toISOString();
    run(store, conversationId, { at, text: "x".repeat(20_000), name: "n".repeat(1_000) });
    const pair = request(store, conversationId, at); issue(store, conversationId, pair.input.id, { time: at });
  }
  for (let i = 0; i < 40; i++) {
    run(store, conversationId, { text: "NO_REPLY" }); issue(store, "deleted", "missing");
  }
  const list = vi.spyOn(store, "listMessages"), issues = vi.spyOn(store, "getConversation");
  const activity = readActivity(store, true, now);
  expect(activity.insights).toHaveLength(30);
  expect(activity.insights.some(item => item.kind === "result")).toBe(true); expect(activity.insights.some(item => item.kind === "attention")).toBe(true);
  expect(activity.insights.every(item => item.text.length <= 6_000 && item.title.length <= 200)).toBe(true);
  expect(activity.progress).toMatchObject({ completedRequests: 40, completedRuns: 40, activeDays: 1 });
  expect(activity.insights.map(item => item.occurredAt)).toEqual(activity.insights.map(item => item.occurredAt).sort().reverse());
  expect(list).not.toHaveBeenCalled(); expect(issues).not.toHaveBeenCalled();
});

it("does not split a Unicode surrogate pair at a preview boundary", () => {
  const { store, conversationId } = setup();
  run(store, conversationId, { text: "a".repeat(5_999) + "🙂rest", name: "n".repeat(199) + "🙂rest" });
  const insight = readActivity(store, true, now).insights[0]!;
  expect(insight.text).toBe("a".repeat(5_999)); expect(insight.title).toBe("n".repeat(199));
});

it("handles absent scheduler tables independently and excludes orphan/deleted conversations", () => {
  const { store, conversationId } = setup(); const result = run(store, conversationId);
  store.db.exec("PRAGMA foreign_keys=OFF");
  store.db.prepare("DELETE FROM conversations WHERE id=?").run(conversationId);
  issue(store, conversationId, result.reply.id);
  expect(readActivity(store, true, now).progress).toMatchObject({ completedRuns: 0, activeSchedules: 0 });
  expect(readActivity(store, true, now).insights).toEqual([]);
  store.db.exec("DROP TABLE schedule_runs"); expect(readActivity(store, true, now).insights).toEqual([]);
  store.db.exec("DROP TABLE schedules"); expect(readActivity(store, true, now).progress.activeSchedules).toBe(0);
});

it("projects the real MessageService/Scheduler completion, quiet and failure paths", async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const { store, conversationId } = setup(false);
  const responses = ["Source check complete; approval remains pending.", "NO_REPLY", "FAILED: PRIVATE_SOURCE_ERROR"];
  const messages = new MessageService(store, { async run() { return { threadId: "fixture", response: responses.shift()!, events: [] }; } });
  const scheduler = new Scheduler(store, messages); messages.scheduler = scheduler;
  try {
    for (let index = 0; index < 3; index++) {
      const schedule = scheduler.save({ conversationId, name: "Check " + index, prompt: "Read only", cron: "* * * * *", timezone: "UTC", delivery: "app" }, new Date(now.getTime() - 60_000));
      await scheduler.tick(now); await scheduler.idle(); scheduler.remove(schedule.id, conversationId);
    }
    const activity = readActivity(store, true, now);
    expect(activity.progress).toMatchObject({ completedRuns: 1, quietRuns: 1, failedRuns: 1, completedRequests: 0, activeDays: 0, activeSchedules: 0 });
    expect(activity.insights.map(item => item.kind).sort()).toEqual(["attention", "result"]);
    expect(JSON.stringify(activity)).not.toContain("PRIVATE_SOURCE_ERROR");
  } finally { scheduler.stop(); await messages.close(); }
});
