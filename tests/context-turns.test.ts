import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { Interactions } from "../src/interactions.js";
import { employeeTools } from "../src/personality.js";
import type { MessageContext } from "../src/message-context.js";
import type { CodexEngine, CodexRunResult } from "../src/types.js";

const source = { connector: "company", endpoint: "https://example.invalid/mcp", fingerprint: "0123456789abcdef" };
const acme: MessageContext = { type: "client", source, clientId: "c-acme", slug: "acme", name: "Acme", company: "Acme Robotics", stage: "active", brand: "TRINITY", archived: false };

describe("a context-bearing request in the one chat", () => {
  it("waits for the running answer instead of steering it, and then reaches the model with its context in the same conversation", async () => {
    const store = new Store(":memory:");
    const inputs: string[] = [], steered: string[] = [];
    let release!: () => void;
    const engine: CodexEngine = {
      async run(input, options) {
        inputs.push(input);
        options?.onEvent?.({ type: "thread.started", payload: { threadId: "t1" } });
        if (inputs.length === 1) await new Promise<void>(resolve => { release = resolve; });
        return { threadId: "t1", response: "Ок", events: [] };
      },
      async steer(text) { steered.push(text); return true; },
    };
    const messages = new MessageService(store, engine);
    try {
      const first = await messages.submit({ channel: "api", text: "Долгий вопрос", mode: "steer" });
      await vi.waitFor(() => expect(inputs).toHaveLength(1));
      const plain = await messages.submit({ channel: "api", text: "Уточнение", mode: "steer" });
      await vi.waitFor(() => expect(steered).toEqual(["Уточнение"]));
      const withContext = await messages.submit({ channel: "api", text: "Что по договору?", mode: "steer", context: acme });
      expect(steered).toEqual(["Уточнение"]);
      expect(store.getMessage(first.receipt.conversationId, withContext.receipt.messageId)?.status).toBe("queued");
      release();
      await first.completion; await plain.completion; await withContext.completion;
      expect(inputs).toHaveLength(2);
      expect(inputs[1]).toContain("Business client context");
      expect(inputs[1]).toContain('"clientId":"c-acme"');
      expect(withContext.receipt.conversationId).toBe(first.receipt.conversationId);
    } finally { await messages.close(); store.close(); }
  });

  it("treats a retry with the same client as the same request, and a different client under the same id as a conflict", async () => {
    const store = new Store(":memory:");
    let runs = 0;
    const engine: CodexEngine = { async run() { runs++; return { threadId: "t", response: "Ответ " + runs, events: [] }; } };
    const messages = new MessageService(store, engine);
    try {
      const sent = await messages.handle({ channel: "api", externalId: "req-1", text: "Что по договору?", context: acme });
      // The app retries the same send; the service refreshed the client's display name meanwhile.
      const retried = await messages.handle({ channel: "api", externalId: "req-1", text: "Что по договору?", context: { ...acme, name: "Acme Robotics Ltd" } });
      expect(retried.messageId).toBe(sent.messageId);
      expect(runs).toBe(1);
      await expect(messages.handle({ channel: "api", externalId: "req-1", text: "Что по договору?", context: { ...acme, clientId: "c-other", slug: "other", name: "Other" } })).rejects.toThrow("уже использован");
      await expect(messages.handle({ channel: "api", externalId: "req-1", text: "Что по договору?" })).rejects.toThrow("уже использован");
      const quote: MessageContext = { type: "message", home: { id: "conn-wolf", homeId: "home-wolf", name: "Wolf" }, conversationId: "c1", messageId: "m1", title: "Группа", author: null, date: null, quote: "Текст" };
      const quoted = await messages.handle({ channel: "api", externalId: "req-2", text: "Что это?", context: quote });
      expect((await messages.handle({ channel: "api", externalId: "req-2", text: "Что это?", context: { ...quote, title: "Группа (переименована)" } })).messageId).toBe(quoted.messageId);
      await expect(messages.handle({ channel: "api", externalId: "req-2", text: "Что это?", context: { ...quote, messageId: "m2" } })).rejects.toThrow("уже использован");
      expect(runs).toBe(2);
    } finally { await messages.close(); store.close(); }
  });

  it("keeps the attached context in the history a restarted thread and the history tool read back", async () => {
    const store = new Store(":memory:");
    const inputs: string[] = [];
    // No thread id comes back, as after a model switch: the next turn replays recent history.
    const engine: CodexEngine = { async run(input): Promise<CodexRunResult> { inputs.push(input); return { threadId: null, response: "Ок", events: [] }; } };
    const messages = new MessageService(store, engine);
    try {
      const first = await messages.handle({ channel: "api", text: "Что по договору?", context: acme });
      await messages.handle({ channel: "api", text: "А сроки?" });
      const recent = inputs[1]!.split("Current user message:")[0]!;
      expect(recent).toContain("Recent conversation");
      expect(recent).toContain('"context":{"type":"client","connector":"company","clientId":"c-acme","slug":"acme","name":"Acme","company":"Acme Robotics"}');
      const tools = employeeTools(store, engine, new Interactions(), { profile: null, conversationId: first.conversationId, messageId: "m", channel: "api", byOwner: true });
      const history = await tools.call("read_chat_history", {}) as { messages: Array<{ text: string; context?: unknown }> };
      expect(history.messages.find(m => m.text === "Что по договору?")?.context).toEqual({ type: "client", connector: "company", clientId: "c-acme", slug: "acme", name: "Acme", company: "Acme Robotics" });
      expect(history.messages.find(m => m.text === "А сроки?")?.context).toBeUndefined();
      expect(JSON.stringify(history)).not.toContain("fingerprint");
    } finally { await messages.close(); store.close(); }
  });
});
