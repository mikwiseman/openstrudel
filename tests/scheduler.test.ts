import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { Scheduler } from "../src/scheduler.js";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = new Store(":memory:"); stores.push(store);
  let calls = 0;
  const messages = new MessageService(store, { async run() { calls++; return { threadId: "scheduled", response: "Digest", events: [] }; } });
  const scheduler = new Scheduler(store, messages);
  return { store, messages, scheduler, calls: () => calls };
}
describe("durable cron", () => {
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
