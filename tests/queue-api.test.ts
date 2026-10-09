import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenStrudelRuntime } from "../src/runtime.js";
import type { CodexEngine, CodexRunResult } from "../src/types.js";

it("shares edits, attachments and queue order between authenticated clients and rejects late writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "strudel-queue-"));
  const releases: Array<() => void> = [];
  const engine: CodexEngine = { run: vi.fn(async (_text, options) => {
    options?.onEvent?.({ type: "thread.started", payload: { threadId: "queue-test" } });
    return new Promise<CodexRunResult>(resolve => releases.push(() => resolve({ threadId: "queue-test", response: "Done", events: [] })));
  }) };
  const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", engine, rootDirectory: directory, startTelegram: false, apiToken: "queue-fixture-token" });
  const address = await runtime.api.listen("127.0.0.1", 0);
  const url = `http://127.0.0.1:${address.port}`;
  const api = (path: string, body?: unknown, authorized = true) => fetch(url + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(authorized ? { authorization: "Bearer queue-fixture-token" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const first = await (await api("/v1/messages?async=true", { text: "Working" })).json() as { conversationId: string; messageId: string };
    const path = "/v1/conversations/" + first.conversationId;
    const file = await (await api(path + "/files", { name: "note.txt", mimeType: "text/plain", contentBase64: Buffer.from("KEEP THIS FILE").toString("base64") })).json() as { attachment: { id: string } };
    const second = await (await api("/v1/messages?async=true", { text: "Original", conversationId: first.conversationId, attachments: [file.attachment.id] })).json() as { messageId: string };
    const third = await (await api("/v1/messages?async=true", { text: "Third", conversationId: first.conversationId })).json() as { messageId: string };
    const edit = path + "/messages/" + second.messageId + "/edit";
    expect((await api(edit, { text: "Unauthorized", expectedText: "Original" }, false)).status).toBe(401);
    expect((await api(edit, { text: "Revised", expectedText: "Original" })).status).toBe(200);
    expect((await api(edit, { text: "Conflict", expectedText: "Original" })).status).toBe(409);
    expect((await api(edit, { text: "Invalid" })).status).toBe(400);
    expect((await api(path + "/queue", { messageIds: [third.messageId, second.messageId], expectedMessageIds: [second.messageId, third.messageId] })).status).toBe(200);
    for (const route of [path, "/v1/conversation"]) {
      const snapshot = await (await api(route + "?page=true")).json() as { queuedMessages: Array<{ id: string; text: string; attachments?: Array<{ id: string }> }> };
      expect(snapshot.queuedMessages.map(m => m.id)).toEqual([third.messageId, second.messageId]);
      expect(snapshot.queuedMessages[1]).toMatchObject({ text: "Revised", attachments: [{ id: file.attachment.id }] });
    }
    expect((await api(path + "/queue", { messageIds: [], expectedMessageIds: [second.messageId, third.messageId] })).status).toBe(409);
    releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect((await api(path + "/messages/" + third.messageId + "/edit", { text: "Too late", expectedText: "Third" })).status).toBe(409);
    releases[1]!();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    const finalInput = vi.mocked(engine.run).mock.calls[2]![0];
    expect(finalInput).toContain("Revised"); expect(finalInput).toContain("note.txt"); expect(finalInput).not.toContain("Current user message:\nOriginal");
    releases[2]!();
    await vi.waitFor(() => expect(runtime.messages.hasActiveRuns).toBe(false));
  } finally {
    // Drain a failed test without leaving its fixture alive.
    for (let i = 0; i < 5 && runtime.messages.hasActiveRuns; i++) { releases.forEach(release => release()); await new Promise(resolve => setTimeout(resolve, 10)); }
    await runtime.stop(); rmSync(directory, { recursive: true, force: true });
  }
});
