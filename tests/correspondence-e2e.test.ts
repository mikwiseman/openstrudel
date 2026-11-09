import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { configureCorrespondence, correspondenceSource } from "../src/correspondence.js";
import { mockResponses } from "./fixtures/mock-responses.js";

const rollouts = (root: string): string[] => readdirSync(join(root, ".data"), { withFileTypes: true, recursive: true })
  .filter(entry => entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name)).sort();
const text = (request: { body: any }) => JSON.stringify(request.body?.input ?? []);
async function until(check: () => boolean, ms = 60_000) {
  for (const started = Date.now(); !check(); await new Promise(done => setTimeout(done, 100))) if (Date.now() - started > ms) throw new Error("Timed out");
}

it("runs a correspondence event in an ephemeral Codex session that writes no rollout and leaves the owner's thread alone", async () => {
  const shown = "Подготовил вариант ответа Ире.";
  // The answer follows the request's latest user text, as a model would.
  const provider = await mockResponses(body => {
    const input = JSON.stringify(body?.input ?? []);
    return input.includes("Что с Ирой?") ? "Вариант ответа выше." : input.includes("Process this changed conversation") ? shown : "Запомнил.";
  });
  const root = mkdtempSync(join(tmpdir(), "openstrudel-correspondence-e2e-"));
  vi.stubEnv("OPENSTRUDEL_CODEX_MODE", "");
  vi.stubEnv("OPENSTRUDEL_PROVIDER_XAI_BASE_URL", provider.url);
  const runtime = new OpenStrudelRuntime({ rootDirectory: root, dbPath: join(root, ".data/openstrudel.sqlite"), startTelegram: false, apiToken: "e2e" });
  try {
    runtime.store.setSetting("providers.xai.key", "xai-e2e-key");
    const chat = runtime.store.primaryConversation();
    expect((await runtime.messages.handle({ channel: "api", text: "Запомни: синий", externalChatId: "home", byOwner: true })).text).toBe("Запомнил.");
    const thread = runtime.store.getConversation(chat.id)!.codexThreadId, saved = runtime.store.getSetting("codex.thread.provider-xai." + chat.id);
    const checkpoint = runtime.store.getSetting("context.checkpoint." + chat.id), files = rollouts(root);
    expect(thread).toBeTruthy(); expect(files).toHaveLength(1);
    const token = "a-private-source-token-with-32-characters";
    configureCorrespondence(runtime.store, true, { enabled: true, conversationId: chat.id, calendarId: "owner@example.com", defaultDurationMinutes: 60,
      sources: [{ id: "telegram", provider: "telegram", accountId: "42", space: "both", token }] });
    const worker = runtime.api.correspondence, before = provider.requests.length;
    worker.start();
    worker.receive(correspondenceSource(runtime.store, "telegram", "Bearer " + token), { id: "ira-1", threadId: "123", messageId: "1", type: "message.new", occurredAt: new Date().toISOString() });
    // Skip the 45-second quiet window.
    runtime.store.db.prepare("UPDATE correspondence_events SET due_at=0").run(); worker.wake();
    await until(() => runtime.store.db.prepare("SELECT status FROM correspondence_events").get()?.status === "completed");
    const event = provider.requests.slice(before).filter(request => request.url.startsWith("/v1/responses"));
    expect(event.length).toBeGreaterThan(0);
    for (const request of event) { expect(text(request)).toContain("Triage first"); expect(text(request)).not.toMatch(/Запомни: синий|Запомнил/); }
    // Codex stored nothing for it, and the owner's thread, saved session and checkpoint are untouched.
    expect(rollouts(root)).toEqual(files);
    expect(runtime.store.getConversation(chat.id)!.codexThreadId).toBe(thread);
    expect(runtime.store.getSetting("codex.thread.provider-xai." + chat.id)).toBe(saved);
    expect(runtime.store.getSetting("context.checkpoint." + chat.id)).toBe(checkpoint);
    // The chat shows only what it shows the owner: his answer and the event run's result.
    expect(runtime.store.listMessages(chat.id, 20).filter(m => m.direction === "outbound").map(m => m.text)).toEqual(["Запомнил.", shown]);
    // The owner's next turn resumes his own thread and gets what the event run showed him.
    const next = provider.requests.length;
    expect((await runtime.messages.handle({ channel: "api", text: "Что с Ирой?", externalChatId: "home", byOwner: true })).text).toBe("Вариант ответа выше.");
    const resumed = provider.requests.slice(next).filter(request => request.url.startsWith("/v1/responses")).at(-1)!;
    expect(text(resumed)).toContain("Запомни: синий");
    expect(text(resumed)).toContain(shown);
    expect(rollouts(root)).toEqual(files);
  } finally {
    await runtime.stop(); await provider.close(); vi.unstubAllEnvs();
    // A stopped Codex releases its thread-writer lock a moment later.
    for (let attempt = 0; attempt < 20 && existsSync(root); attempt++) { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); await new Promise(done => setTimeout(done, 300)); }
  }
}, 180_000);
