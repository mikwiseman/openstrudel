import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { Correspondence, configureCorrespondence, correspondenceSource } from "../src/correspondence.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); vi.useRealTimers(); });

it("runs each batch in an ephemeral session without the owner's chat, keeps his thread, and gives his next turn what it showed", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
  const root = mkdtempSync(join(tmpdir(), "openstrudel-correspondence-session-"));
  const store = new Store(":memory:"), chat = store.primaryConversation();
  const calls: Array<{ input: string; options: any }> = [];
  const shown = "Подготовил вариант ответа Ире: «Да, в пятницу удобно».";
  // As an engine reports: a turn without a thread starts one; an event turn answers by its own text.
  const engine = { async run(input: string, options: any = {}) {
    calls.push({ input, options });
    const event = input.includes("Process this changed conversation"), threadId = options.threadId ?? (event ? "event-session-" + calls.length : "owner-thread");
    if (!options.threadId) options.onEvent?.({ type: "thread.started", payload: { threadId } });
    const events = calls.filter(call => call.input.includes("Process this changed conversation")).length;
    return { threadId, response: !event ? "Запомнил." : events === 1 ? shown : "NO_REPLY", events: [] };
  } };
  store.createProfile({ name: "Помощник" });
  const messages = new MessageService(store, engine, root);
  const worker = new Correspondence(store, messages);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }), () => store.close(), () => messages.close(), () => worker.stop());
  await messages.handle({ channel: "api", conversationId: chat.id, text: "Запомни: синий", byOwner: true });
  const checkpoint = store.getSetting("context.checkpoint." + chat.id);
  expect(store.getConversation(chat.id)?.codexThreadId).toBe("owner-thread");
  const token = "a-private-source-token-with-32-characters";
  const input = { enabled: true, conversationId: chat.id, calendarId: "owner@example.com", defaultDurationMinutes: 60,
    sources: [{ id: "telegram", provider: "telegram", accountId: "42", space: "both", token }] };
  configureCorrespondence(store, true, input);
  worker.start();
  const deliver = async (id: string) => {
    worker.receive(correspondenceSource(store, "telegram", "Bearer " + token), { id, threadId: "123", messageId: id, type: "message.new", occurredAt: "2026-11-09T09:59:59Z" });
    await vi.advanceTimersByTimeAsync(45_000); await worker.idle();
  };
  await deliver("ira-1");
  configureCorrespondence(store, true, { ...input, model: { provider: "chatgpt", model: "gpt-6-sol" } }, [{ id: "gpt-6-sol", name: "GPT-6 Sol", description: "", isDefault: false,
    defaultReasoningEffort: "medium", reasoningEfforts: [], speeds: [{ id: "default", name: "Обычная", description: "" }], provider: "chatgpt" }]);
  await deliver("ira-2");
  expect(store.db.prepare("SELECT status, COUNT(*) AS n FROM correspondence_events GROUP BY status").all()).toEqual([{ status: "completed", n: 2 }]);
  const [first, second] = calls.slice(1);
  for (const run of [first!, second!]) {
    // A new session that saves nothing, with no chat history before the request and no helpers to hand work to.
    expect(run.options).toMatchObject({ threadId: undefined, ephemeral: true, scheduled: true, byOwner: false, employees: [] });
    expect(run.input).not.toMatch(/Recent conversation|Запомни: синий|Запомнил/);
  }
  expect(first!.options.model).not.toBe("gpt-6-sol"); expect(first!.options.reserves).toBeUndefined();
  // The owner's own choice for event runs, at that model's level and without the device's reserves.
  expect(second!.options).toMatchObject({ provider: "chatgpt", model: "gpt-6-sol", reasoningEffort: null, reserves: false });
  // The owner's thread and checkpoint are his own; the shown result stays in his chat, NO_REPLY stays hidden.
  expect(store.getConversation(chat.id)?.codexThreadId).toBe("owner-thread");
  expect(store.getSetting("context.checkpoint." + chat.id)).toBe(checkpoint);
  expect(store.listMessages(chat.id, 20).filter(m => m.direction === "outbound").map(m => m.text)).toEqual(["Запомнил.", shown]);
  // His next turn resumes his thread and hears, once, what the event run showed him.
  await messages.handle({ channel: "api", conversationId: chat.id, text: "Что с Ирой?", byOwner: true });
  const next = calls.at(-1)!;
  expect(next.options.threadId).toBe("owner-thread"); expect(next.options.employees).toHaveLength(1);
  expect(next.input).toContain(shown);
  expect(next.input).not.toMatch(/NO_REPLY|Process this changed conversation/);
  await messages.handle({ channel: "api", conversationId: chat.id, text: "Спасибо", byOwner: true });
  expect(calls.at(-1)!.input).not.toContain(shown);
});
