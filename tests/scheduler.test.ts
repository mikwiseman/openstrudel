import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { Scheduler } from "../src/scheduler.js";
import { scheduleTiming } from "../src/schedule-timing.js";
import { saveTelegramAuthorization } from "../src/authorization.js";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = new Store(":memory:"); stores.push(store);
  let calls = 0;
  const messages = new MessageService(store, { async run() { calls++; return { threadId: "scheduled", response: "Digest", events: [] }; } });
  const scheduler = new Scheduler(store, messages);
  return { store, messages, scheduler, calls: () => calls };
}
describe("restricted audience recovery", () => {
  it.each([
    ["-100", "ready", true],
    ["-100", "running", false],
    ["123", "ready", true],
    ["123", "running", false],
  ] as const)("does not deliver legacy %s / %s output after restrictions are enabled or revoked", async (chatId, status, enabled) => {
    const { store, scheduler, calls } = setup(), conversation = store.primaryConversation();
    store.linkTelegramChat({ chatId, title: "Synthetic destination", allowedSenders: ["123"] });
    const saved = scheduler.save({ conversationId: conversation.id, name: "Legacy digest", prompt: "Read legacy private data",
      cron: "0 9 * * *", timezone: "UTC", telegramChatId: chatId, delivery: "telegram", enabled: false }, new Date("2030-01-01T00:00:00Z"));
    const inbound = store.addMessage({ conversationId: conversation.id, channel: "api", direction: "inbound", externalId: "schedule:legacy-run", text: "Legacy request" });
    const outbound = store.addMessage({ conversationId: conversation.id, channel: "api", direction: "outbound", replyToId: inbound.id, text: "SYNTHETIC PRIVATE DRAFT" });
    store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at,message_id) VALUES(?,?,?,?,?,?,?)")
      .run("legacy-run", saved.id, conversation.id, saved.nextRunAt, status, saved.nextRunAt, status === "ready" ? outbound.id : null);
    saveTelegramAuthorization(store, { version: 1, revision: 0,
      connectors: { school: { url: "https://school.invalid/api/mcp/company", headers: {} } },
      policies: { school: { connectorId: "school", tools: [] } },
      subjects: chatId === "123" ? { "123": { enabled, capabilities: [], privatePolicyId: "school" } } : {},
      chats: chatId === "-100" ? { "-100": { enabled, policyId: "school", defaultCapabilities: [], members: {} } } : {} });
    const deliver = vi.fn(async () => {}); scheduler.deliver = deliver;
    scheduler.recover();
    expect(scheduler.runs(conversation.id)[0]?.status).toBe("ready");
    await scheduler.tick(new Date("2030-01-02T00:00:00Z")); await scheduler.idle();
    expect(deliver).not.toHaveBeenCalled(); expect(calls()).toBe(0);
    expect(scheduler.runs(conversation.id)[0]).toMatchObject({ status: "failed", error: expect.stringContaining("ограниченным доступом") });
    await scheduler.tick(new Date("2030-01-03T00:00:00Z")); await scheduler.idle();
    expect(deliver).not.toHaveBeenCalled();
  });
});
describe("durable one-time reminders", () => {
  const now = new Date("2030-01-15T06:00:00Z");
  const request = { name: "Reminder", prompt: "Send the requested reminder here", cron: "@once 2030-01-15T09:01:00+03:00", timezone: "Europe/Moscow" };

  it("wakes at a newly saved deadline without waiting for the periodic recovery check", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const { store, scheduler, calls } = setup(), c = store.primaryConversation();
    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      scheduler.save({...request,conversationId:c.id,cron:"@once 2030-01-15T06:00:03Z"});
      await vi.advanceTimersByTimeAsync(2999); expect(calls()).toBe(0);
      await vi.advanceTimersByTimeAsync(1); await scheduler.idle(); expect(calls()).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000); expect(calls()).toBe(1);
    } finally { scheduler.stop(); vi.useRealTimers(); }
  });

  it("keeps the exact instant, runs once after a restart and never repeats next year", async () => {
    const { store, messages, scheduler, calls } = setup(), c = store.primaryConversation();
    const saved = scheduler.save({ ...request, conversationId: c.id }, now);
    expect(saved.nextRunAt).toBe("2030-01-15T06:01:00.000Z");
    await scheduler.tick(new Date("2030-01-15T06:00:59Z")); await scheduler.idle();
    expect(calls()).toBe(0);
    const reopened = new Scheduler(store, messages); reopened.recover();
    await reopened.tick(new Date("2030-01-15T06:01:04Z")); await reopened.idle();
    expect(calls()).toBe(1);
    expect(reopened.list(c.id)[0]).toMatchObject({ enabled: false, lastRunStatus: "completed" });
    expect(reopened.runs(c.id)[0]).toMatchObject({ status: "completed", scheduledFor: saved.nextRunAt });
    await reopened.tick(new Date("2031-01-15T06:01:04Z")); await reopened.idle();
    expect(calls()).toBe(1);
  });

  it("catches up a missed one-time request without changing its original timestamp", async () => {
    const { store, scheduler, calls } = setup(), c = store.primaryConversation();
    scheduler.save({ ...request, conversationId: c.id }, now);
    await scheduler.tick(new Date("2030-01-16T08:00:00Z")); await scheduler.idle();
    await scheduler.tick(new Date("2030-01-16T08:00:15Z")); await scheduler.idle();
    expect(calls()).toBe(1);
    expect(scheduler.runs(c.id)[0]?.scheduledFor).toBe("2030-01-15T06:01:00.000Z");
  });

  it("does not retry an uncertain one-time delivery after recovery", async () => {
    const { store, scheduler, calls } = setup(), c = store.primaryConversation();
    store.linkTelegramChat({chatId:"123",title:"Test",allowedSenders:["123"]});
    let sends = 0;
    scheduler.deliver = async () => { sends++; throw new Error("Reply lost after send"); };
    scheduler.save({ ...request, conversationId: c.id, delivery: "telegram", telegramChatId: "123" }, now);
    await scheduler.tick(new Date("2030-01-15T06:01:04Z")); await scheduler.idle();
    scheduler.recover();
    await scheduler.tick(new Date("2030-01-15T06:02:00Z")); await scheduler.idle();
    expect(calls()).toBe(1); expect(sends).toBe(1);
    expect(scheduler.list(c.id)[0]).toMatchObject({enabled:false,lastRunStatus:"uncertain"});
  });

  it("disarms a claimed reminder on crash recovery without executing it again", async () => {
    const { store, scheduler, calls } = setup(), c = store.primaryConversation();
    const saved = scheduler.save({ ...request, conversationId: c.id }, now);
    store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at) VALUES(?,?,?,?,?,?)")
      .run("interrupted-once", saved.id, c.id, saved.nextRunAt, "running", saved.nextRunAt);
    scheduler.recover();
    await scheduler.tick(new Date("2030-01-15T06:02:00Z")); await scheduler.idle();
    expect(calls()).toBe(0);
    expect(scheduler.list(c.id)[0]).toMatchObject({enabled:false,lastRunStatus:"uncertain"});
  });

  it("allows pause before delivery and rejects re-enabling an elapsed reminder", async () => {
    const { store, scheduler, calls } = setup(), c = store.primaryConversation();
    const saved = scheduler.save({ ...request, conversationId: c.id }, now);
    scheduler.remove(saved.id, c.id);
    const later = new Date("2030-01-15T06:02:00Z");
    await scheduler.tick(later); await scheduler.idle();
    expect(calls()).toBe(0);
    expect(() => scheduler.save({...saved, enabled:true}, later)).toThrow("Время напоминания уже прошло");
    expect(() => scheduler.save({...saved, enabled:false}, later)).not.toThrow();
    expect(() => scheduler.save({...saved, enabled:true, cron:"@once 2030-01-15T09:03:00+03:00"}, later)).not.toThrow();
  });

  it.each([
    "@once 2030-01-15T09:00:00", "@once 2030-02-30T09:00:00Z",
    "@once 2030-13-01T09:00:00Z", "@once 2030-01-15T25:00:00Z", "@once tomorrow",
  ])("rejects an ambiguous or invalid date: %s", cron => {
    expect(() => scheduleTiming(cron, "Europe/Moscow", now)).toThrow();
  });

  it("preserves explicit DST offsets rather than inferring server local time", () => {
    expect(scheduleTiming("@once 2030-11-03T01:30:00-04:00", "America/New_York", now).nextRunAt).toBe("2030-11-03T05:30:00.000Z");
    expect(scheduleTiming("@once 2030-11-03T01:30:00-05:00", "America/New_York", now).nextRunAt).toBe("2030-11-03T06:30:00.000Z");
  });
});
describe("durable cron", () => {
  it("keeps the failed receipt after lost authorization and uses recovery only for later runs", async () => {
    const store = new Store(":memory:"); stores.push(store);
    let authorized = false, calls = 0;
    const messages = new MessageService(store, { async run() {
      calls++;
      if (!authorized) throw new Error("refresh_token_expired");
      return { threadId: "restored", response: "Digest", events: [] };
    } });
    const scheduler = new Scheduler(store, messages), c = store.primaryConversation();
    scheduler.save({ conversationId: c.id, name: "Daily", prompt: "Digest", cron: "0 6 * * *", timezone: "Europe/Moscow" }, new Date("2026-09-26T10:00:00Z"));
    await scheduler.tick(new Date("2026-09-27T03:00:01Z")); await scheduler.idle();
    expect(scheduler.runs(c.id)[0]).toMatchObject({ status: "failed", error: expect.stringContaining("Войдите в OpenAI на устройстве сотрудника") });
    authorized = true;
    scheduler.recover();
    await scheduler.tick(new Date("2026-09-27T04:00:01Z")); await scheduler.idle();
    expect(calls).toBe(1);
    await scheduler.tick(new Date("2026-09-28T03:00:01Z")); await scheduler.idle();
    expect(calls).toBe(2);
    expect(scheduler.runs(c.id).map(r => r.status)).toEqual(["completed", "failed"]);
    expect(scheduler.list(c.id)).toHaveLength(1);
  });

  it("does not publish a second edition when Telegram delivery is ambiguous", async () => {
    const { store, scheduler, calls } = setup();
    const c = store.primaryConversation();
    store.linkTelegramChat({chatId:"123",title:"Test",allowedSenders:["123"]});
    scheduler.deliver = async () => { throw new Error("Connection lost after sending"); };
    const before = new Date("2026-09-26T10:00:00Z");
    const primary = scheduler.save({conversationId:c.id,name:"Morning",prompt:"Digest",cron:"0 6 * * *",timezone:"Europe/Moscow",delivery:"telegram",telegramChatId:"123"},before);
    scheduler.save({conversationId:c.id,name:"Backstop",prompt:"Digest",cron:"0 9 * * *",timezone:"Europe/Moscow",backupOf:primary.id},before);
    await scheduler.tick(new Date("2026-09-27T03:00:01Z")); await scheduler.idle();
    expect(scheduler.runs(c.id)[0]?.status).toBe("uncertain");
    await scheduler.tick(new Date("2026-09-27T06:00:01Z")); await scheduler.idle();
    expect(calls()).toBe(1);
    expect(scheduler.runs(c.id)[0]?.status).toBe("skipped");
  });
  it("runs a backstop only when the primary edition did not complete that day", async () => {
    const { store, scheduler, calls } = setup();
    const c = store.primaryConversation();
    const before = new Date("2026-09-26T10:00:00Z");
    const primary = scheduler.save({conversationId:c.id,name:"Morning",prompt:"Digest",cron:"0 6 * * *",timezone:"Europe/Moscow"},before);
    scheduler.save({conversationId:c.id,name:"Backstop",prompt:"Digest",cron:"0 9 * * *",timezone:"Europe/Moscow",backupOf:primary.id},before);
    await scheduler.tick(new Date("2026-09-27T03:00:01Z")); await scheduler.idle();
    await scheduler.tick(new Date("2026-09-27T06:00:01Z")); await scheduler.idle();
    expect(calls()).toBe(1);
    expect(scheduler.runs(c.id)[0]?.status).toBe("skipped");
    store.db.prepare("UPDATE schedule_runs SET status='failed' WHERE schedule_id=?").run(primary.id);
    store.db.prepare("UPDATE schedules SET enabled=0 WHERE id=?").run(primary.id);
    await scheduler.tick(new Date("2026-09-28T06:00:01Z")); await scheduler.idle();
    expect(calls()).toBe(2);
  });

  it("keeps an empty recurring check silent in the chat and Telegram", async () => {
    const store = new Store(":memory:"); stores.push(store);
    const messages = new MessageService(store,{async run(){return {threadId:"quiet",response:"NO_REPLY",events:[]};}});
    const scheduler = new Scheduler(store,messages);
    const c = store.primaryConversation();
    store.linkTelegramChat({chatId:"123",title:"Test",allowedSenders:["123"]});
    const sent:string[]=[]; scheduler.deliver=async(_,text)=>{sent.push(text);};
    scheduler.save({conversationId:c.id,name:"Dates",prompt:"Only today",cron:"0 9 * * *",timezone:"Europe/Moscow",delivery:"telegram",telegramChatId:"123"},new Date("2026-09-26T10:00:00Z"));
    await scheduler.tick(new Date("2026-09-27T06:00:01Z")); await scheduler.idle();
    expect(sent).toEqual([]);
    expect(store.listMessages(c.id)).toEqual([]);
    expect(scheduler.runs(c.id)[0]?.status).toBe("quiet");
  });
  it("keeps a run quiet when its answer explains itself and ends with NO_REPLY", async () => {
    const store = new Store(":memory:"); stores.push(store);
    const messages = new MessageService(store,{async run(){return {threadId:"quiet",response:"I checked the latest queue — nothing worth a card tonight.\n\nNO_REPLY",events:[]};}});
    const scheduler = new Scheduler(store,messages);
    const c = store.primaryConversation();
    store.linkTelegramChat({chatId:"123",title:"Test",allowedSenders:["123"]});
    const sent:string[]=[]; scheduler.deliver=async(_,text)=>{sent.push(text);};
    scheduler.save({conversationId:c.id,name:"News",prompt:"Fresh items",cron:"0 9 * * *",timezone:"Europe/Moscow",delivery:"telegram",telegramChatId:"123"},new Date("2026-09-26T10:00:00Z"));
    await scheduler.tick(new Date("2026-09-27T06:00:01Z")); await scheduler.idle();
    expect(sent).toEqual([]);
    expect(store.listMessages(c.id)).toEqual([]);
    expect(scheduler.runs(c.id)[0]?.status).toBe("quiet");
  });
  it("tells the owner why a run could not do its work and keeps the failure out of the chat", async () => {
    const store = new Store(":memory:"); stores.push(store);
    let reason = "правила публикации не открылись";
    const messages = new MessageService(store,{async run(){return {threadId:"failed",response:`FAILED: ${reason}`,events:[]};}});
    const scheduler = new Scheduler(store,messages);
    const root = store.primaryConversation();
    const dates = store.getOrCreateConversation({channel:"telegram",externalId:"-100",title:"С днем рождения"});
    const recipes = store.getOrCreateConversation({channel:"telegram",externalId:"-200",title:"Рецепты"});
    store.linkTelegramChat({chatId:"-100",title:"С днем рождения",allowedSenders:["1"]});
    const sent:string[]=[]; scheduler.deliver=async(_,text)=>{sent.push(text);};
    scheduler.save({conversationId:dates.id,name:"Важные даты",prompt:"Поздравь",cron:"0 9 * * *",timezone:"Europe/Moscow",delivery:"telegram",telegramChatId:"-100"},new Date("2026-09-26T10:00:00Z"));
    await scheduler.tick(new Date("2026-09-27T06:00:01Z")); await scheduler.idle();
    expect(sent).toEqual([]);
    expect(store.listMessages(dates.id)).toEqual([]);
    expect(scheduler.runs(dates.id)[0]).toMatchObject({status:"failed",error:reason});
    expect(store.listMessages(root.id).map(m=>m.text)).toEqual([`Требует внимания · С днем рождения\nЗадача не выполнена: ${reason}`]);
    // Another chat failing for its own reason is a different cause.
    reason = "нет инструмента для картинок";
    scheduler.save({conversationId:recipes.id,name:"Рецепт дня",prompt:"Рецепт",cron:"0 9 * * *",timezone:"Europe/Moscow"},new Date("2026-09-26T10:00:00Z"));
    await scheduler.tick(new Date("2026-09-27T06:00:02Z")); await scheduler.idle();
    expect(store.listMessages(root.id).map(m=>m.text).at(-1)).toBe(`Требует внимания · Рецепты\nЗадача не выполнена: ${reason}`);
  });
  it("reports a repeated scheduled failure once until a successful check closes it", async () => {
    const store = new Store(":memory:"); stores.push(store);
    let response = "FAILED: источник недоступен";
    const messages = new MessageService(store,{async run(){return {threadId:"repeated-failure",response,events:[]};}});
    const scheduler = new Scheduler(store,messages);
    const root = store.primaryConversation();
    const chat = store.getOrCreateConversation({channel:"telegram",externalId:"-100",title:"Проверка"});
    scheduler.save({conversationId:chat.id,name:"Проверка",prompt:"Проверь",cron:"* * * * *",timezone:"UTC"},new Date("2026-09-26T10:00:00Z"));
    for (const minute of [1,2]) {
      await scheduler.tick(new Date(`2026-09-26T10:0${minute}:01Z`)); await scheduler.idle();
    }
    expect(scheduler.runs(chat.id).map(run=>run.status)).toEqual(["failed","failed"]);
    expect(store.listMessages(root.id)).toHaveLength(1);
    response = "NO_REPLY";
    await scheduler.tick(new Date("2026-09-26T10:03:01Z")); await scheduler.idle();
    expect(store.getSetting("runtime.issue."+chat.id)).toBeNull();
    response = "FAILED: источник недоступен";
    await scheduler.tick(new Date("2026-09-26T10:04:01Z")); await scheduler.idle();
    expect(store.listMessages(root.id)).toHaveLength(2);
  });
  it("keeps an app-only edition in the app even when the chat has a Telegram binding", async () => {
    const { store, scheduler } = setup();
    const c = store.primaryConversation();
    store.linkTelegramChat({ chatId: "123", title: "Test", allowedSenders: ["456"] });
    store.db.prepare("UPDATE telegram_chats SET conversation_id=? WHERE chat_id=?").run(c.id, "123");
    const delivered: string[] = [];
    scheduler.deliver = async chatId => { delivered.push(chatId); };
    scheduler.save({ conversationId: c.id, name: "App edition", prompt: "Digest", cron: "0 6 * * *", timezone: "Europe/Moscow", delivery: "app" }, new Date("2026-09-26T10:00:00Z"));
    await scheduler.tick(new Date("2026-09-27T04:00:00Z"));
    await scheduler.idle();
    expect(delivered).toEqual([]);
    expect(scheduler.runs(c.id)[0]?.status).toBe("completed");
  });
  it("keeps an edition in the app when its Telegram chat is paused", async () => {
    const { store, scheduler } = setup();
    const c = store.primaryConversation();
    store.linkTelegramChat({ chatId: "-100", title: "Group", allowedSenders: ["456"] });
    store.db.prepare("UPDATE telegram_chats SET conversation_id=? WHERE chat_id=?").run(c.id, "-100");
    const delivered: string[] = [];
    scheduler.deliver = async chatId => { delivered.push(chatId); };
    scheduler.save({ conversationId: c.id, name: "Bound", prompt: "Digest", cron: "0 6 * * *", timezone: "Europe/Moscow", delivery: "bound" }, new Date("2026-09-26T10:00:00Z"));
    scheduler.save({ conversationId: c.id, name: "Direct", prompt: "Digest", cron: "0 6 * * *", timezone: "Europe/Moscow", delivery: "telegram", telegramChatId: "-100" }, new Date("2026-09-26T10:00:00Z"));
    store.setSetting("telegram.paused.-100", "true");
    await scheduler.tick(new Date("2026-09-27T04:00:00Z")); await scheduler.idle();
    expect(delivered).toEqual([]);
    expect(scheduler.runs(c.id).map(run => run.status)).toEqual(["completed", "completed"]);
    expect(store.listMessages(c.id).filter(m => m.direction === "outbound").map(m => m.text)).toEqual(["Digest", "Digest"]);
    store.deleteSetting("telegram.paused.-100");
    await scheduler.tick(new Date("2026-09-28T04:00:00Z")); await scheduler.idle();
    expect(delivered).toEqual(["-100", "-100"]);
  });
  it("runs an edition whose local time falls in the spring-forward hour", async () => {
    const { store, scheduler, calls } = setup();
    const c = store.primaryConversation();
    scheduler.save({ conversationId: c.id, name: "Night", prompt: "Digest", cron: "30 2 * * *", timezone: "Europe/Berlin" }, new Date("2026-03-27T12:00:00Z"));
    await scheduler.tick(new Date("2026-03-28T02:00:00Z")); await scheduler.idle();
    expect(calls()).toBe(1);
    // 29 March 2026: Berlin skips 02:00-03:00; the edition is due at 01:30 UTC.
    await scheduler.tick(new Date("2026-03-29T02:00:00Z")); await scheduler.idle();
    expect(calls()).toBe(2);
    expect(scheduler.runs(c.id).map(run => run.scheduledFor)).toContain("2026-03-29T01:30:00.000Z");
  });
  it("does not confirm a pause for a missing schedule or a different chat", () => {
    const { store, scheduler } = setup();
    const c = store.primaryConversation();
    const s = scheduler.save({ conversationId: c.id, name: "Morning", prompt: "Digest", cron: "0 6 * * *", timezone: "Europe/Moscow" });
    expect(() => scheduler.remove("missing", c.id)).toThrow("Расписание этого чата не найдено");
    expect(() => scheduler.remove(s.id, "another-chat")).toThrow("Расписание этого чата не найдено");
    expect(scheduler.list(c.id)[0]?.enabled).toBe(true);
    scheduler.remove(s.id, c.id);
    expect(scheduler.list(c.id)[0]?.enabled).toBe(false);
  });

  it("uses the requested timezone and catches up once after sleep", async () => {
    const { store, scheduler, calls } = setup();
    const c = store.primaryConversation();
    const schedule = scheduler.save({ conversationId: c.id, name: "Morning", prompt: "Digest", cron: "0 6 * * *", timezone: "Europe/Moscow" }, new Date("2026-09-26T10:00:00Z"));
    expect(schedule.nextRunAt).toBe("2026-09-27T03:00:00.000Z");
    await scheduler.tick(new Date("2026-09-29T10:00:00Z"));
    await scheduler.idle();
    await scheduler.tick(new Date("2026-09-29T10:00:05Z"));
    await scheduler.idle();
    expect(calls()).toBe(1);
    expect(scheduler.list(c.id)[0]?.nextRunAt).toBe("2026-09-30T03:00:00.000Z");
    expect(scheduler.runs(c.id)).toEqual([expect.objectContaining({ status: "completed", scheduledFor: "2026-09-29T03:00:00.000Z" })]);
  });
  it("does not rerun an interrupted action on recovery", async () => {
    const { store, scheduler, calls } = setup();
    const c = store.primaryConversation();
    const s = scheduler.save({ conversationId: c.id, name: "Morning", prompt: "Action", cron: "0 6 * * *", timezone: "Europe/Moscow" }, new Date("2026-09-26T10:00:00Z"));
    store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at) VALUES(?,?,?,?,?,?)").run("interrupted", s.id, c.id, "2026-09-27T03:00:00.000Z", "running", "2026-09-27T03:00:00.000Z");
    scheduler.recover();
    await scheduler.tick(new Date("2026-09-27T04:00:00Z")); await scheduler.idle();
    expect(calls()).toBe(0);
    expect(scheduler.runs(c.id)[0]?.status).toBe("uncertain");
  });
});
