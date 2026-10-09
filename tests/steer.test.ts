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
