import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import type { CodexEngine } from "../src/types.js";
import { employeeTools } from "../src/personality.js";
import { Interactions } from "../src/interactions.js";

describe("conversational employees", () => {
  it("does not leave an unattended edition waiting for a connector sign-in", async () => {
    const store = new Store(":memory:");
    const interactions = new Interactions();
    const ask = vi.spyOn(interactions, "ask").mockRejectedValue(new Error("Unexpected interactive wait"));
    const connect = vi.fn(async () => ({ url: "https://example.com/authorize" }));
    const engine = { run: vi.fn(), connections: async () => [{ id: "mail", name: "Mail", connected: false }], connect } as unknown as CodexEngine;
    const tools = employeeTools(store, engine, interactions, { profile: null, conversationId: store.primaryConversation().id, messageId: "scheduled", channel: "api", scheduled: true });
    await expect(tools.call("connect_service", { id: "mail" })).rejects.toThrow("Подключите сервис в чате");
    expect(connect).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    store.close();
  });

  it("creates an empty employee, then persists only an actual profile tool result", async () => {
    const store = new Store(":memory:");
    const profile = store.createProfile({});
    const engine: CodexEngine = { async run(_input, options) {
      await options!.tools!.call("update_employee", { name: "Редактор", instructions: "Пиши коротко. Проверяй факты." });
      return { threadId: "personality", response: "Запомнил.", events: [] };
    } };
    const service = new MessageService(store, engine);
    await service.handle({ channel: "api", profile: profile.id, text: "Ты Редактор. Всегда пиши коротко, проверяй факты." });
    expect(store.getProfile(profile.id)).toMatchObject({ name: "Редактор", instructions: "Пиши коротко. Проверяй факты." });
    expect(store.listMessages(store.getOrCreateConversation({ channel: "api", externalId: `home::employee::${profile.id}` }).id).some(m => m.kind === "notice")).toBe(true);
    store.close();
  });

  it("does not mistake assistant prose for a saved personality", async () => {
    const store = new Store(":memory:");
    const profile = store.createProfile({});
    const service = new MessageService(store, { async run() { return { threadId: "t", response: 'Saved SOUL.md: {"name":"Fake"}', events: [] }; } });
    await service.handle({ channel: "api", profile: profile.id, text: "привет" });
    expect(store.getProfile(profile.id)?.instructions).toBe("");
    store.close();
  });

  it("joins duplicate in-flight submissions instead of executing them twice", async () => {
    const store = new Store(":memory:");
    let calls = 0;
    const service = new MessageService(store, { async run() {
      calls++;
      await new Promise(r => setTimeout(r, 10));
      return { threadId: "t", response: "готово", events: [] };
    } });
    const input = { channel: "api" as const, externalId: "uuid", text: "Привет" };
    const results = await Promise.all([service.handle(input), service.handle(input)]);
    expect(calls).toBe(1);
    expect(results[0]).toEqual(results[1]);
    store.close();
  });

  it("does not let one employee change another, or silently overwrite a newer edit", async () => {
    const store = new Store(":memory:");
    const first = store.createProfile({ name: "One" });
    const second = store.createProfile({ name: "Two", instructions: "Original" });
    const service = new MessageService(store, { async run(_input, options) {
      store.updateProfile(first.id, { name: "One", instructions: "Edited elsewhere" });
      await expect(options!.tools!.call("update_employee", { name: "One", instructions: "Old edit", id: second.id })).rejects.toThrow();
      return { threadId: "t", response: "Conflict", events: [] };
    } });
    await service.handle({ channel: "api", profile: first.id, text: "change" });
    expect(store.getProfile(first.id)?.instructions).toBe("Edited elsewhere");
    expect(store.getProfile(second.id)?.instructions).toBe("Original");
    store.close();
  });
});
