import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { Scheduler } from "../src/scheduler.js";
import { OpenStrudelRuntime } from "../src/runtime.js";
import type { CodexEngine } from "../src/types.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A Home whose model answers what the test tells it to, and waits when told to. */
function desk() {
  const store = new Store(":memory:"); cleanups.push(() => store.close());
  let answer = "Digest", release: (() => void) | undefined;
  const messages = new MessageService(store, { async run() {
    if (answer === "wait") await new Promise<void>(done => { release = done; });
    return { threadId: "team", response: answer === "wait" ? "Done" : answer, events: [] };
  } });
  const scheduler = new Scheduler(store, messages);
  const team = () => Object.fromEntries(store.listTeam().map(p => [p.name, p]));
  return { store, messages, scheduler, team, answers: (next: string) => { answer = next; }, release: () => release?.() };
}
const daily = (hour: number) => ({ name: "Daily " + hour, prompt: "Digest", cron: `0 ${hour} * * *`, timezone: "UTC" });
const morning = new Date("2030-01-01T00:00:00Z");

describe("the team list", () => {
  it("dates the preview by the answer it is taken from", () => {
    const { store } = desk();
    const quiet = store.createProfile({ name: "Archivist" }), writer = store.createProfile({ name: "Writer" });
    const chat = store.profileConversation(writer.id);
    store.addMessage({ conversationId: chat.id, channel: "api", direction: "outbound", text: "First answer" });
    const latest = store.addMessage({ conversationId: chat.id, channel: "api", direction: "outbound", text: "Latest answer" });
    store.addMessage({ conversationId: chat.id, channel: "api", direction: "inbound", text: "A later question" });
    store.addMessage({ conversationId: chat.id, channel: "api", direction: "outbound", text: "Saved", kind: "notice" });
    const [first, second] = store.listProfiles();
    expect(first).toMatchObject({ id: quiet.id, preview: null, previewAt: null });
    expect(second).toMatchObject({ id: writer.id, preview: "Latest answer", previewAt: latest.createdAt });
    // The rows a turn's engine reads as helpers keep to what the employee is; what it is doing now is the team list's.
    expect(second).not.toHaveProperty("working");
    expect(store.listTeam()[1]).toMatchObject({ preview: "Latest answer", previewAt: latest.createdAt, working: false, nextRunAt: null, failing: false });
  });

  it("carries the first picture of the answer the preview is taken from, and none when that answer has none", () => {
    const { store, team } = desk();
    const painter = store.createProfile({ name: "Painter" }), writer = store.createProfile({ name: "Writer" });
    const studio = store.profileConversation(painter.id), page = store.profileConversation(writer.id);
    const file = (name: string, mimeType: string) => ({ id: "00000000-0000-4000-8000-" + name.padEnd(12, "0").slice(0, 12).replace(/[^0-9a-f]/g, "a"), conversationId: studio.id, name, mimeType, size: 10 });
    const notes = file("notes.pdf", "application/pdf"), sketch = file("sketch.png", "image/png"), second = file("second.png", "image/png");
    store.addMessage({ conversationId: studio.id, channel: "api", direction: "outbound", text: "An earlier sketch", attachments: [second] });
    store.addMessage({ conversationId: studio.id, channel: "api", direction: "outbound", text: "The poster", attachments: [notes, sketch, second] });
    store.addMessage({ conversationId: page.id, channel: "api", direction: "outbound", text: "A picture came first", attachments: [second] });
    store.addMessage({ conversationId: page.id, channel: "api", direction: "outbound", text: "Then only words" });
    expect(team().Painter).toMatchObject({ preview: "The poster", previewImage: sketch });
    expect(team().Writer).toMatchObject({ preview: "Then only words", previewImage: null });
    // The engine's description of a turn's helpers stays free of what changes with every answer.
    expect(store.listProfiles().every(profile => !("previewImage" in profile))).toBe(true);
  });

  it("says who is working while a request of any of their chats waits or runs", async () => {
    const { store, messages, team, answers, release } = desk();
    const writer = store.createProfile({ name: "Writer" }), idle = store.createProfile({ name: "Idle" });
    store.profileConversation(idle.id);
    expect(team()).toMatchObject({ Writer: { working: false }, Idle: { working: false } });
    answers("wait");
    const turn = messages.handle({ channel: "api", text: "Draft the post", profile: writer.id });
    await expect.poll(() => team().Writer!.working).toBe(true);
    expect(team().Idle!.working).toBe(false);
    release(); await turn;
    expect(team().Writer!.working).toBe(false);
    // The main assistant's own request is nobody's on the team.
    const waiting = messages.handle({ channel: "api", text: "A question for the main chat" });
    await expect.poll(() => store.listMessages(store.primaryConversation().id).some(m => m.status === "running")).toBe(true);
    expect(Object.values(team()).some(p => p.working)).toBe(false);
    release(); await waiting;
    // The list is polled, so the question is answered from the few rows still in flight, never from a chat's whole history.
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT DISTINCT c.profile_id AS profile FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE m.status IN ('queued','running') AND c.profile_id IS NOT NULL`).all() as Array<{ detail: string }>;
    expect(plan.map(step => step.detail).join("\n")).toContain("messages_active_idx");
  });

  it("gives the earliest next run of the enabled recurring schedules, and none when there is none", () => {
    const { store, scheduler, team } = desk();
    const news = store.createProfile({ name: "Desk" }), chat = store.profileConversation(news.id);
    store.linkTelegramChat({ chatId: "-200", title: "Invented group", allowedSenders: [] });
    store.connectTelegramGroup("-200");
    const group = store.bindTelegramChat("-200", news.id).conversationId!;
    expect(team().Desk).toMatchObject({ nextRunAt: null });
    scheduler.save({ ...daily(9), conversationId: chat.id }, morning);
    scheduler.save({ ...daily(7), conversationId: group }, morning);
    scheduler.save({ ...daily(5), conversationId: chat.id, enabled: false }, morning);
    scheduler.save({ name: "Reminder", prompt: "Once", cron: "@once 2030-01-01T03:00:00Z", timezone: "UTC", conversationId: chat.id }, morning);
    scheduler.save({ ...daily(4), conversationId: store.primaryConversation().id }, morning);
    expect(team().Desk).toMatchObject({ nextRunAt: "2030-01-01T07:00:00.000Z" });
  });

  it("is failing while the latest finished run of an enabled schedule failed", async () => {
    const { store, scheduler, team, answers } = desk();
    const news = store.createProfile({ name: "Desk" }), other = store.createProfile({ name: "Other" });
    const chat = store.profileConversation(news.id);
    const radar = scheduler.save({ ...daily(6), conversationId: chat.id }, morning);
    scheduler.save({ ...daily(6), conversationId: store.profileConversation(other.id).id }, morning);
    expect(team().Desk!.failing).toBe(false);
    answers("FAILED: the source did not answer");
    await scheduler.tick(new Date("2030-01-01T06:00:01Z")); await scheduler.idle();
    expect(scheduler.runs(chat.id)[0]).toMatchObject({ status: "failed" });
    expect(team()).toMatchObject({ Desk: { failing: true, nextRunAt: "2030-01-02T06:00:00.000Z" }, Other: { failing: true } });
    // The next run that works clears it, for that employee alone.
    answers("Digest");
    store.db.prepare("UPDATE schedules SET enabled=0 WHERE conversation_id<>?").run(chat.id);
    await scheduler.tick(new Date("2030-01-02T06:00:01Z")); await scheduler.idle();
    expect(scheduler.runs(chat.id).map(run => run.status)).toEqual(["completed", "failed"]);
    expect(team()).toMatchObject({ Desk: { failing: false }, Other: { failing: false } });
    // A run in progress is not finished: the last answer still stands.
    store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at) VALUES('later-failed',?,?,?,'failed',?)").run(radar.id, chat.id, "2030-01-03T06:00:00.000Z", "2030-01-03T06:00:00.000Z");
    store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at) VALUES('in-flight',?,?,?,'running',?)").run(radar.id, chat.id, "2030-01-04T06:00:00.000Z", "2030-01-04T06:00:00.000Z");
    expect(team().Desk!.failing).toBe(true);
    // A paused schedule alarms nobody.
    scheduler.remove(radar.id, chat.id);
    expect(team().Desk).toMatchObject({ failing: false, nextRunAt: null });
  });

  it("lets a backup that worked answer for its main schedule", () => {
    const { store, scheduler, team } = desk();
    const news = store.createProfile({ name: "Desk" }), chat = store.profileConversation(news.id);
    const main = scheduler.save({ ...daily(7), conversationId: chat.id }, morning);
    const backup = scheduler.save({ ...daily(8), conversationId: chat.id, backupOf: main.id }, morning);
    const run = (id: string, schedule: string, at: string, status: string) =>
      store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at) VALUES(?,?,?,?,?,?)").run(id, schedule, chat.id, at, status, at);
    run("main-1", main.id, "2030-01-01T07:00:00.000Z", "failed");
    expect(team().Desk!.failing).toBe(true);
    run("backup-1", backup.id, "2030-01-01T08:00:00.000Z", "completed");
    expect(team().Desk!.failing).toBe(false);
    // The day after, the main one works and the backup steps aside: nothing failed.
    run("main-2", main.id, "2030-01-02T07:00:00.000Z", "quiet");
    run("backup-2", backup.id, "2030-01-02T08:00:00.000Z", "skipped");
    expect(team().Desk!.failing).toBe(false);
    run("main-3", main.id, "2030-01-03T07:00:00.000Z", "uncertain");
    expect(team().Desk!.failing).toBe(true);
  });

  it("serves them in the catalogue the app polls, and tells the app when they change", async () => {
    const root = mkdtempSync(join(tmpdir(), "strudel-team-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    let release: (() => void) | undefined;
    const engine: CodexEngine = { async run() { await new Promise<void>(done => { release = done; }); return { threadId: "t", response: "The brief is ready", events: [] }; } };
    const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", engine, rootDirectory: root, startTelegram: false, apiToken: "test-owner", mobilePort: 0 });
    const address = await runtime.api.listen("127.0.0.1", 0);
    cleanups.push(() => runtime.stop());
    const writer = runtime.store.createProfile({ name: "Writer" });
    const schedule = runtime.scheduler.save({ ...daily(7), conversationId: runtime.store.profileConversation(writer.id).id, enabled: true });
    const catalogue = async (etag?: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/profiles`, { headers: { authorization: "Bearer test-owner", ...etag ? { "if-none-match": etag } : {} } });
      return { status: response.status, etag: response.headers.get("etag") ?? undefined, profile: response.status === 200 ? (await response.json() as any).profiles[0] : undefined };
    };
    const resting = await catalogue();
    expect(resting.profile).toMatchObject({ name: "Writer", preview: null, previewAt: null, working: false, failing: false, nextRunAt: schedule.nextRunAt });
    expect((await catalogue(resting.etag)).status).toBe(304);
    const turn = runtime.messages.handle({ channel: "api", text: "Write the brief", profile: writer.id });
    await expect.poll(async () => (await catalogue(resting.etag)).profile?.working).toBe(true);
    release!(); await turn;
    const done = await catalogue(resting.etag);
    expect(done.profile).toMatchObject({ working: false, preview: "The brief is ready" });
    expect(Date.parse(done.profile.previewAt)).toBeGreaterThan(0);
  });
});
