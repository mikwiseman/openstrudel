import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { Scheduler } from "../src/scheduler.js";
import { Interactions } from "../src/interactions.js";
import { employeeTools } from "../src/personality.js";
import { privateSourceSchedule } from "../src/private-sources.js";
import type { TelegramToolContext } from "../src/telegram-tools.js";

const stores: Store[] = [];
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) store.close(); });

/** A small team's morning: what each employee's schedule answers, by schedule name. */
const answers: Record<string, string> = {
  "Sales · morning": "OUTCOME: Acme owes an answer on the offer today.\n\n1. Acme: ask about the offer sent on Monday.",
  "Contracts": "NO_REPLY",
  "Press week": "FAILED: the calendar did not answer",
  "Desk": "OUTCOME: Two stories posted.\n\nStory one. Story two.",
};

function team() {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2030-01-15T03:40:00Z"));
  const store = new Store(":memory:"); stores.push(store);
  const engine = { run: vi.fn(async (input: string) => ({ threadId: "t", response: answers[/Scheduled request: (.*)/.exec(input)![1]!] ?? "Brief", events: [] })) };
  const messages = new MessageService(store, engine), scheduler = new Scheduler(store, messages);
  scheduler.deliver = async () => undefined;
  store.linkTelegramChat({ chatId: "-300", title: "Team room", allowedSenders: ["42"] });
  const save = (name: string, profile: string, more: Record<string, unknown> = {}) => {
    const own = store.profileConversation((store.getProfile(profile) ?? store.createProfile({ name: profile })).id);
    return scheduler.save({ conversationId: own.id, name, prompt: "Work", cron: "30 6 * * *", timezone: "Europe/Moscow", delivery: "app", ...more }, new Date("2030-01-15T00:00:00Z"));
  };
  save("Sales · morning", "Sales"); save("Contracts", "Lawyer"); save("Press week", "Press");
  save("Desk", "News", { delivery: "telegram", telegramChatId: "-300" });
  const context: TelegramToolContext = { conversationId: store.primaryConversation().id, messageId: "owner-request", channel: "api", byOwner: true, scope: "personal" };
  const tools = (patch: Partial<TelegramToolContext> = {}) => employeeTools(store, engine, new Interactions(store), { profile: null, ...context, ...patch });
  return { store, scheduler, tools, context };
}

it("reads what the team did since a time: one entry per schedule, its latest result and line, and what stayed quiet or failed", async () => {
  const { store, scheduler, tools } = team();
  await scheduler.tick(new Date("2030-01-15T03:30:05Z")); await scheduler.idle();
  const read = tools();
  expect(read.definitions.map(t => t.name)).toContain("read_team");
  const result = await read.call("read_team", { since: "2030-01-15T00:00:00Z" }) as any;
  expect(result.since).toBe("2030-01-15T00:00:00.000Z");
  const by = (name: string) => result.schedules.find((s: any) => s.schedule === name);
  expect(by("Sales · morning")).toMatchObject({ employee: "Sales", went: "app", runs: 1, quiet: 0, failed: 0, working: false,
    latest: { outcome: "Acme owes an answer on the offer today.", text: "Acme owes an answer on the offer today.\n\n1. Acme: ask about the offer sent on Monday." } });
  expect(by("Desk")).toMatchObject({ employee: "News", went: "Telegram: Team room", latest: { outcome: "Two stories posted." } });
  expect(by("Contracts")).toMatchObject({ employee: "Lawyer", runs: 1, quiet: 1, latest: null, failure: null });
  expect(by("Press week")).toMatchObject({ employee: "Press", runs: 1, failed: 1, latest: null, failure: "the calendar did not answer" });
  // Nothing before the time asked for.
  expect((await read.call("read_team", { since: "2030-01-15T04:00:00Z" }) as any).schedules).toEqual([]);
  // A run still going is named, so a brief can say who has not finished.
  store.db.prepare("UPDATE schedule_runs SET status='running' WHERE schedule_id=(SELECT id FROM schedules WHERE name='Contracts')").run();
  const again = await read.call("read_team", { since: null }) as any;
  expect(again.schedules.find((s: any) => s.schedule === "Contracts")).toMatchObject({ working: true });
}, 30_000);

it("is the owner's alone: never an employee's, a group's, a colleague's or an unapproved schedule's", () => {
  const { store, scheduler, tools, context } = team();
  const without = (patch: Partial<TelegramToolContext>) => expect(tools(patch).definitions.map(t => t.name)).not.toContain("read_team");
  without({ byOwner: false });
  without({ scope: "group-one" });
  without({ conversationId: store.profileConversation(store.getProfile("Sales")!.id).id });
  without({ channel: "telegram", byOwner: false, telegramSenderId: "77" });
  // The owner's brief reads the team once he approved its schedule for his private sources, and only while that holds.
  const brief = scheduler.save({ conversationId: context.conversationId, name: "Brief", prompt: "One morning brief", cron: "0 7 * * *", timezone: "Europe/Moscow", delivery: "app" }, new Date("2030-01-14T00:00:00Z"));
  let runs = 0;
  const running = () => {
    const inbound = store.addMessage({ conversationId: context.conversationId, channel: "api", direction: "inbound", text: "Scheduled request: Brief", externalId: "schedule:brief-run-" + Math.random() });
    store.db.prepare("UPDATE messages SET status='running' WHERE id=?").run(inbound.id);
    store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at,private_source_fingerprint) VALUES(?,?,?,?,?,?,?)")
      .run(inbound.externalId!.slice(9), brief.id, context.conversationId, new Date(Date.now() + ++runs).toISOString(), "running", new Date().toISOString(), store.getSetting("private_sources.schedule." + brief.id));
    return { messageId: inbound.id, scheduled: true, byOwner: false, scheduleTelegramChatId: null };
  };
  without(running());
  privateSourceSchedule(store, true, context.conversationId, brief.id, { enabled: true, fingerprint: privateSourceSchedule(store, true, context.conversationId, brief.id).fingerprint });
  expect(tools(running()).definitions.map(t => t.name)).toContain("read_team");
});
