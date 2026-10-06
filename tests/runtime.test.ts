import { describe, expect, it } from "vitest";
import { MockCodexEngine } from "../src/codex.js";
import { OpenStrudelRuntime } from "../src/runtime.js";

describe("OpenStrudel runtime", () => {
  it("keeps the main chat and routes addressed messages to an employee", async () => {
    const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", engine: new MockCodexEngine(), startTelegram: false });
    const chat = await runtime.messages.handle({ channel: "api", externalChatId: "home", text: "Привет" });
    expect(chat.text).toContain("Принял задачу");
    const profile = runtime.store.createProfile({ name: "Исследователь", instructions: "Ищи факты и новости" });
    const routed = await runtime.messages.handle({ channel: "api", externalChatId: "home", text: "@Исследователь собери факты" });
    expect(routed.profileId).toBe(profile.id);
    expect(routed.conversationId).not.toBe(chat.conversationId);
    expect(runtime.store.getOrCreateConversation({ channel: "api", externalId: `home::employee::${profile.id}` }).id).toBe(routed.conversationId);
    const help = await runtime.messages.handle({ channel: "api", externalChatId: "home", text: "/help" });
    expect(help.text).toContain("обычными словами");
    await runtime.stop();
  });

  it("exposes only the small chat, employee and Telegram surface", async () => {
    const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", engine: new MockCodexEngine(), startTelegram: false });
    const address = await runtime.api.listen("127.0.0.1", 0);
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(health.status).toBe(200);
    expect((await health.json()) as { ok: boolean }).toMatchObject({ ok: true });
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello" }) });
    expect(response.status).toBe(200);
    expect((await response.json()) as { text: string }).toHaveProperty("text");
    const profiles = await fetch(`http://127.0.0.1:${address.port}/v1/profiles`);
    expect(profiles.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${address.port}/v1/devices`)).status).toBe(200);
    for (const path of ["/v1/tasks", "/v1/search"]) {
      expect((await fetch(`http://127.0.0.1:${address.port}${path}`)).status).toBe(404);
    }
    await runtime.stop();
  });
});
