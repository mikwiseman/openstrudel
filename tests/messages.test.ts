import { describe, expect, it } from "vitest";
import { MessageService } from "../src/messages.js";
import { Store } from "../src/store.js";
import type { CodexEngine, CodexRunResult } from "../src/types.js";

class SerialProbeEngine implements CodexEngine {
  active = 0;
  maxActive = 0;
  calls: Array<{ input: string; threadId: string | null | undefined }> = [];
  private sequence = 0;

  async run(input: string, options: Parameters<CodexEngine["run"]>[1] = {}): Promise<CodexRunResult> {
    this.calls.push({ input, threadId: options.threadId });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    this.active -= 1;
    return {
      threadId: options.threadId ?? `thread-${++this.sequence}`,
      response: `Ответ: ${input}`,
      events: [],
    };
  }
}

class RecoveryProbeEngine implements CodexEngine {
  calls = 0;

  async run(input: string, options: Parameters<CodexEngine["run"]>[1] = {}): Promise<CodexRunResult> {
    this.calls += 1;
    if (options.threadId) throw new Error("thread-store conflict: already has an active writer (code -32600)");
    return { threadId: "recovered-thread", response: `Ответ: ${input}`, events: [] };
  }
}

describe("MessageService", () => {
  it("serializes rapid messages per conversation and resumes the latest thread", async () => {
    const store = new Store(":memory:");
    const engine = new SerialProbeEngine();
    const messages = new MessageService(store, engine);

    const [first, second, third] = await Promise.all([
      messages.handle({ channel: "api", externalChatId: "home", text: "первое" }),
      messages.handle({ channel: "api", externalChatId: "home", text: "второе" }),
      messages.handle({ channel: "api", externalChatId: "home", text: "третье" }),
    ]);

    expect(engine.maxActive).toBe(1);
    expect(engine.calls.map((call) => call.threadId)).toEqual([null, "thread-1", "thread-1"]);
    expect([first.text, second.text, third.text]).toEqual(["Ответ: первое", "Ответ: второе", "Ответ: третье"]);
    expect(store.listMessages(first.conversationId).filter((message) => message.direction === "outbound")).toHaveLength(3);
    store.close();
  });

  it("updates an employee without changing its identity", () => {
    const store = new Store(":memory:");
    const profile = store.createProfile({ name: "Исследователь", instructions: "Собирай факты" });
    const updated = store.updateProfile(profile.id, { name: "Редактор", instructions: "Проверяй и сокращай" });
    expect(updated.id).toBe(profile.id);
    expect(store.getProfile(profile.id)).toMatchObject({ name: "Редактор", instructions: "Проверяй и сокращай" });
    store.close();
  });

  it("preserves a conflicting thread instead of silently retrying an action", async () => {
    const store = new Store(":memory:");
    const conversation = store.getOrCreateConversation({ channel: "api", externalId: "home" });
    store.setConversationThread(conversation.id, "stale-thread");
    const engine = new RecoveryProbeEngine();
    const messages = new MessageService(store, engine);

    await expect(messages.handle({ channel: "api", externalChatId: "home", text: "продолжай" })).rejects.toThrow("История сохранена");
    expect(engine.calls).toBe(1);
    expect(store.getConversation(conversation.id)?.codexThreadId).toBe("stale-thread");
    store.close();
  });
});
