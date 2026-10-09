import { afterEach, expect, it, vi } from "vitest";
import { MessageService } from "../src/messages.js";
import { Store } from "../src/store.js";
import type { CodexEngine, CodexRunResult } from "../src/types.js";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const releases: Array<() => void> = [];
  const engine: CodexEngine = {
    steer: vi.fn(async () => true),
    run: vi.fn(async (_text, options) => {
      options?.onEvent?.({ type: "thread.started", payload: { threadId: "thread" } });
      return new Promise<CodexRunResult>((resolve, reject) => {
        releases.push(() => resolve({ threadId: "thread", response: "Combined answer", events: [] }));
        options?.signal?.addEventListener("abort", () => reject(new Error("Ответ остановлен")), { once: true });
      });
    }),
  };
  return { store, engine, releases, service: new MessageService(store, engine) };
}

it("steers in place, records both inputs, returns one answer and makes a retry idempotent", async () => {
  const { store, engine, releases, service } = fixture();
  const first = await service.submit({ channel: "api", text: "Draft" });
  await vi.waitFor(() => expect(releases).toHaveLength(1));
  const input = { channel: "api" as const, text: "Shorter", mode: "steer" as const, externalId: "steer-once" };
  const second = await service.submit(input);
  expect(engine.run).toHaveBeenCalledOnce();
  expect(engine.steer).toHaveBeenCalledWith("Shorter", { threadId: "thread", images: [] });
  releases[0]!();
  expect((await second.completion).messageId).toBe((await first.completion).messageId);
  expect(store.listMessages(first.receipt.conversationId).filter(m => m.direction === "outbound")).toHaveLength(1);
  expect(store.listMessages(first.receipt.conversationId).every(m => m.status === "completed")).toBe(true);
  expect((await service.handle(input)).text).toBe("Combined answer");
  expect(engine.steer).toHaveBeenCalledOnce();
});

it("queues explicit later input and cancels a queued request before any engine call", async () => {
  const { store, engine, releases, service } = fixture();
  const first = await service.submit({ channel: "api", text: "First" });
  await vi.waitFor(() => expect(releases).toHaveLength(1));
  const later = await service.submit({ channel: "api", text: "Later", mode: "queue" });
  const rejected = expect(later.completion).rejects.toThrow("отменено");
  service.cancel(later.receipt.conversationId, later.receipt.messageId);
  releases[0]!();
  await first.completion; await rejected;
  expect(engine.run).toHaveBeenCalledOnce();
  expect(engine.steer).not.toHaveBeenCalled();
  expect(store.listMessages(first.receipt.conversationId).find(m => m.id === later.receipt.messageId)?.status).toBe("failed");
});

it("keeps an uncertain steer failure without silently running the instruction twice", async () => {
  const { engine, releases, service } = fixture();
  vi.mocked(engine.steer!).mockRejectedValueOnce(new Error("Transport lost after send"));
  const first = await service.submit({ channel: "api", text: "First" });
  await vi.waitFor(() => expect(releases).toHaveLength(1));
  const input = { channel: "api" as const, text: "Change", mode: "steer" as const, externalId: "uncertain" };
  await expect(service.submit(input)).rejects.toThrow("Transport lost");
  releases[0]!(); await first.completion;
  await expect(service.handle(input)).rejects.toThrow("Проверьте ответ");
  expect(engine.run).toHaveBeenCalledOnce();
  expect(engine.steer).toHaveBeenCalledOnce();
});

it("does not steer a Telegram sender's live turn from the application", async () => {
  const { engine, releases, service } = fixture();
  const first = await service.submit({ channel: "telegram", externalChatId: "17", text: "Telegram" });
  await vi.waitFor(() => expect(releases).toHaveLength(1));
  const second = await service.submit({ channel: "api", conversationId: first.receipt.conversationId, text: "App", mode: "steer" });
  expect(engine.steer).not.toHaveBeenCalled();
  releases[0]!(); await first.completion;
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  releases[1]!(); await second.completion;
});

it("stops only the selected active API message through the engine abort signal", async () => {
  const { store, engine, releases, service } = fixture();
  const first = await service.submit({ channel: "api", text: "Long request" });
  await vi.waitFor(() => expect(releases).toHaveLength(1));
  const stopped = expect(first.completion).rejects.toThrow("Ответ остановлен");
  // A busy conversation may have hundreds of background context entries.
  for (let i = 0; i < 205; i++) store.addMessage({ conversationId: first.receipt.conversationId, channel: "api", direction: "inbound", text: "Context " + i });
  expect(() => service.cancel("another-conversation", first.receipt.messageId)).toThrow("не найдено");
  service.cancel(first.receipt.conversationId, first.receipt.messageId);
  await stopped;
  expect(engine.run).toHaveBeenCalledOnce();
});

it("edits waiting input with a compare-and-swap, keeps its receipt and runs the new text once", async () => {
  const { store, engine, releases, service } = fixture();
  const first = await service.submit({ channel: "api", text: "First" });
  const later = await service.submit({ channel: "api", text: "Original", mode: "queue", externalId: "editable" });
  const { conversationId, messageId } = later.receipt;
  service.editQueuedMessage(conversationId, messageId, "Revised", "Original");
  expect(() => service.editQueuedMessage(conversationId, messageId, "Stale overwrite", "Original")).toThrow("другом устройстве");
  expect(() => service.editQueuedMessage(conversationId, messageId, "  ", "Revised")).toThrow("Напишите");
  expect(service.queuedMessages(conversationId).map(m => m.text)).toEqual(["Revised"]);
  // An old transport retry must never run the original instruction again.
  await expect(service.submit({ channel: "api", text: "Original", externalId: "editable" })).rejects.toThrow("идентификатор");
  releases[0]!(); await first.completion;
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  expect(engine.run).toHaveBeenLastCalledWith("Revised", expect.anything());
  expect(() => service.editQueuedMessage(conversationId, messageId, "Too late", "Revised")).toThrow("уже отправлено");
  releases[1]!(); await later.completion;
  expect(store.findMessageByExternal("api", "editable")?.text).toBe("Revised");
  expect((await service.handle({ channel: "api", text: "Revised", externalId: "editable" })).text).toBe("Combined answer");
  expect(engine.run).toHaveBeenCalledTimes(2);
});

it("reorders waiting requests atomically and rejects stale or cross-conversation changes", async () => {
  const { store, engine, releases, service } = fixture();
  const first = await service.submit({ channel: "api", text: "First" });
  const second = await service.submit({ channel: "api", text: "Second", mode: "queue" });
  const third = await service.submit({ channel: "api", text: "Third", mode: "queue" });
  const chat = first.receipt.conversationId, a = second.receipt.messageId, b = third.receipt.messageId;
  expect(() => service.reorderQueuedMessages(chat, [a, a], [a, b])).toThrow("Проверьте");
  expect(() => service.reorderQueuedMessages("other", [b, a], [a, b])).toThrow("изменилась");
  expect(() => service.editQueuedMessage("other", a, "Wrong chat", "Second")).toThrow("убрано");
  service.reorderQueuedMessages(chat, [b, a], [a, b]);
  expect(service.queuedMessages(chat).map(m => m.id)).toEqual([b, a]);
  expect(() => service.reorderQueuedMessages(chat, [a, b], [a, b])).toThrow("изменилась");
  releases[0]!(); await first.completion;
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  expect(engine.run).toHaveBeenLastCalledWith("Third", expect.anything());
  expect(() => service.reorderQueuedMessages(chat, [a, b], [b, a])).toThrow("изменилась");
  releases[1]!(); await third.completion;
  await vi.waitFor(() => expect(releases).toHaveLength(3));
  expect(engine.run).toHaveBeenLastCalledWith("Second", expect.anything());
  releases[2]!(); await second.completion;
  expect(service.queuedMessages(chat)).toEqual([]);
  expect(store.getSetting("context.checkpoint." + chat)).toBe(b);
});

it("cancels a queued request immediately while the active turn is still waiting", async () => {
  const { releases, service } = fixture();
  const first = await service.submit({ channel: "api", text: "First" });
  const later = await service.submit({ channel: "api", text: "Later", mode: "queue" });
  const rejected = expect(later.completion).rejects.toThrow("отменено");
  service.cancel(later.receipt.conversationId, later.receipt.messageId);
  await rejected;
  expect(service.queuedMessages(first.receipt.conversationId)).toEqual([]);
  expect(service.hasActiveRuns).toBe(true);
  releases[0]!(); await first.completion;
  expect(service.hasActiveRuns).toBe(false);
});

it("keeps Telegram input immutable and in place while app messages are reordered", async () => {
  const { engine, releases, service } = fixture();
  const first = await service.submit({ channel: "telegram", externalChatId: "17", text: "Start" });
  const conversationId = first.receipt.conversationId;
  const second = await service.submit({ channel: "api", conversationId, text: "Second" });
  const telegram = await service.submit({ channel: "telegram", externalChatId: "17", text: "Telegram queued" });
  const fourth = await service.submit({ channel: "api", conversationId, text: "Fourth" });
  expect(() => service.editQueuedMessage(conversationId, telegram.receipt.messageId, "Spoof", "Telegram queued")).toThrow("убрано");
  expect(() => service.cancel(conversationId, telegram.receipt.messageId)).toThrow("не найдено");
  service.reorderQueuedMessages(conversationId, [fourth.receipt.messageId, second.receipt.messageId], [second.receipt.messageId, fourth.receipt.messageId]);
  for (const [index, submission] of [first, fourth, telegram, second].entries()) {
    await vi.waitFor(() => expect(releases).toHaveLength(index + 1));
    releases[index]!(); await submission.completion;
  }
  expect(vi.mocked(engine.run).mock.calls.map(call => call[0])).toEqual(["Start", "Fourth", "Telegram queued", "Second"]);
});

it("does not start queued work during shutdown and accepts new work after an emptied queue", async () => {
  const { engine, releases, service } = fixture();
  const first = await service.submit({ channel: "api", text: "First" });
  releases[0]!(); await first.completion;
  const next = await service.submit({ channel: "api", text: "Next" });
  const later = await service.submit({ channel: "api", text: "Never run" });
  const rejected = expect(later.completion).rejects.toThrow("завершает работу");
  const closed = service.close();
  releases[1]!(); await next.completion;
  await rejected; await closed;
  expect(engine.run).toHaveBeenCalledTimes(2);
  expect(service.hasActiveRuns).toBe(false);
  expect(service.queuedMessages(first.receipt.conversationId)).toEqual([]);
});
