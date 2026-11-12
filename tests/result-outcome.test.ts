import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { Scheduler } from "../src/scheduler.js";
import { readActivity } from "../src/activity.js";

const stores: Store[] = [];
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) store.close(); });
const now = new Date("2030-01-15T06:00:00Z");

/** One employee whose morning schedule answers `answer`, delivered to Telegram chat 42. */
async function run(answer: string) {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2030-01-15T09:00:05Z"));
  const store = new Store(":memory:"); stores.push(store);
  const inputs: string[] = [];
  const messages = new MessageService(store, { async run(input) { inputs.push(input); return { threadId: "t", response: answer, events: [] }; } });
  const scheduler = new Scheduler(store, messages);
  const lawyer = store.createProfile({ name: "Lawyer" }), own = store.profileConversation(lawyer.id);
  store.linkTelegramChat({ chatId: "42", title: "Owner", allowedSenders: ["42"] });
  const delivered: string[] = []; scheduler.deliver = async (_chat, text) => { delivered.push(text); };
  scheduler.save({ conversationId: own.id, name: "Contracts", prompt: "Check contracts and deadlines", cron: "0 9 * * *", timezone: "UTC",
    delivery: "telegram", telegramChatId: "42" }, now);
  await scheduler.tick(new Date("2030-01-15T09:00:05Z")); await scheduler.idle();
  const result = store.listMessages(own.id).find(m => m.direction === "outbound" && m.kind !== "notice");
  return { store, scheduler, inputs, delivered, result, lawyer, run: scheduler.runs(own.id)[0] };
}

it("keeps what each result made true in one line, for the team list, activity and Telegram's preview", async () => {
  const { store, inputs, delivered, result, lawyer } = await run("OUTCOME: Two contracts are due on Friday.\n\n**Contracts · Wednesday**\n1. Acme lease: signature due Friday.\n2. Beta act: send for signing.");
  // Every scheduled request asks for the line.
  expect(inputs[0]).toMatch(/OUTCOME: /);
  // The line opens the result as written, without its marker, and is kept apart.
  expect(result).toMatchObject({ outcome: "Two contracts are due on Friday.", text: "Two contracts are due on Friday.\n\n**Contracts · Wednesday**\n1. Acme lease: signature due Friday.\n2. Beta act: send for signing." });
  // Telegram's notification shows it first, after the employee's name.
  expect(delivered).toEqual(["**Lawyer**\n\nTwo contracts are due on Friday.\n\n**Contracts · Wednesday**\n1. Acme lease: signature due Friday.\n2. Beta act: send for signing."]);
  expect(store.listTeam().find(p => p.id === lawyer.id)?.outcome).toBe("Two contracts are due on Friday.");
  expect(readActivity(store, true).insights.find(i => i.kind === "result")?.outcome).toBe("Two contracts are due on Friday.");
});

it("keeps the line to sixty characters, cut between words", async () => {
  const { result } = await run("OUTCOME: Acme signed the lease, Beta still owes the act and Gamma asked for a new date\nDetails follow.");
  expect(result?.outcome).toBe("Acme signed the lease, Beta still owes the act and Gamma…");
  expect(result!.outcome!.length).toBeLessThanOrEqual(60);
  expect(result?.text).toBe("Acme signed the lease, Beta still owes the act and Gamma asked for a new date\nDetails follow.");
});

it("never turns a quiet or failed run into a result, and leaves a result without the line as it was", async () => {
  const quiet = await run("OUTCOME: Nothing new.\nNO_REPLY");
  expect(quiet.run).toMatchObject({ status: "quiet" });
  expect(quiet.delivered).toEqual([]);
  const failed = await run("OUTCOME: Could not check.\nFAILED: the contracts service did not answer");
  expect(failed.run).toMatchObject({ status: "failed", error: "the contracts service did not answer" });
  // Only the plain line that the edition did not come, never the run's own words.
  expect(failed.delivered).toHaveLength(1);
  expect(failed.delivered[0]).toMatch(/^Не получилось подготовить «Contracts»/);
  const plain = await run("**Contracts · Wednesday**\nAll in order.");
  expect(plain.result?.text).toBe("**Contracts · Wednesday**\nAll in order.");
  expect(plain.result?.outcome).toBeUndefined();
  expect(plain.store.listTeam().find(p => p.id === plain.lawyer.id)?.outcome).toBeNull();
});

it("leaves an answer in a conversation as written: only scheduled results carry the line", async () => {
  const store = new Store(":memory:"); stores.push(store);
  const messages = new MessageService(store, { async run() { return { threadId: "t", response: "OUTCOME: means the result in one line.", events: [] }; } });
  const reply = await messages.handle({ channel: "api", externalChatId: "home", text: "What does OUTCOME mean?" });
  expect(reply.text).toBe("OUTCOME: means the result in one line.");
  expect(store.listMessages(store.primaryConversation().id).at(-1)?.outcome ?? null).toBeNull();
});
