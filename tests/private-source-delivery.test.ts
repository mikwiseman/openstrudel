import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { privateSourceAudience, privateSourceSchedule, unipileSettings } from "../src/private-sources.js";
import { UnipileAdapter } from "../src/unipile.js";
import { Scheduler } from "../src/scheduler.js";
import type { CodexEngine } from "../src/types.js";

const reads = vi.hoisted(() => ({ after: undefined as ((path: string) => void) | undefined }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const bytes = await actual.readFile(...args); reads.after?.(String(args[0])); return bytes;
  } };
});
const now = new Date("2026-11-03T07:00:00.000Z");
const roots: string[] = [], runtimes: OpenStrudelRuntime[] = [];
afterEach(async () => {
  reads.after = undefined; vi.useRealTimers();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

function fixture(privateSources = true) {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:synthetic");
  const root = mkdtempSync(join(tmpdir(), "strudel-private-delivery-")); roots.push(root);
  const run = vi.fn<CodexEngine["run"]>();
  const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", rootDirectory: root, startTelegram: false, engine: { run } }); runtimes.push(runtime);
  const { store, scheduler, messages, telegram } = runtime, conversationId = store.primaryConversation().id;
  store.linkTelegramChat({ chatId: "42", title: "Synthetic owner", allowedSenders: ["42"] });
  unipileSettings(store, true, { accounts: [{ accountId: "acc_owner", provider: "linkedin", providerUserId: "synthetic-owner" }] });
  const saved = scheduler.save({ conversationId, name: "Private recurring brief", prompt: "Check sources, return the result", cron: "* * * * *", timezone: "UTC", delivery: "telegram", telegramChatId: "42" }, new Date(now.getTime() - 60_000));
  const approve = () => {
    const state = privateSourceSchedule(store, true, conversationId, saved.id);
    return privateSourceSchedule(store, true, conversationId, saved.id, { enabled: true, fingerprint: state.fingerprint });
  };
  if (privateSources) approve();
  const revoke = () => {
    const state = privateSourceSchedule(store, true, conversationId, saved.id);
    privateSourceSchedule(store, true, conversationId, saved.id, { enabled: false, fingerprint: state.fingerprint });
  };
  // Provider data and Bot API acknowledgements are synthetic; no network is used.
  const source = vi.spyOn(UnipileAdapter.prototype, "read").mockResolvedValue({ items: [{ text: "SYNTHETIC_PRIVATE_RESULT" }] } as any);
  const sent: Array<{ method: string; body: any }> = [];
  let onSend: (() => void) | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(new URL(url).origin).toBe("https://api.telegram.org");
    const method = new URL(url).pathname.split("/").at(-1)!;
    sent.push({ method, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    onSend?.();
    return Response.json({ ok: true, result: { message_id: sent.length, ...(method === "sendDocument" ? { document: {} } : {}) } });
  }));
  vi.spyOn(telegram, "notifyOwner").mockResolvedValue(undefined); // Inspect edition delivery, not safe operational notices.
  const read = async (options: Parameters<CodexEngine["run"]>[1]) => {
    expect(options!.tools!.definitions.map(tool => tool.name)).toContain("unipile_read");
    await options!.tools!.call("unipile_read", { accountId: "acc_owner", sourceFingerprint: "f".repeat(64), resource: "messages", chatId: "synthetic-chat" });
  };
  run.mockImplementation(async (_text, options) => { if (privateSources) await read(options); return { threadId: "synthetic", response: "SYNTHETIC_PRIVATE_RESULT", events: [] }; });
  const tick = async () => { await scheduler.tick(now); await scheduler.idle(); };
  return { runtime, store, scheduler, messages, telegram, conversationId, saved, run, source, sent, read, approve, revoke, tick, setOnSend: (callback: () => void) => { onSend = callback; } };
}

it("delivers an unchanged approved private run through the runtime's existing Telegram guard", async () => {
  const f = fixture(); await f.tick();
  expect(f.source).toHaveBeenCalledTimes(1); expect(f.sent).toHaveLength(1);
  expect(f.scheduler.runs(f.conversationId)[0]?.status).toBe("completed");
  expect(f.store.db.prepare("SELECT private_source_fingerprint FROM schedule_runs").get()?.private_source_fingerprint)
    .toBe(f.store.getSetting("private_sources.schedule." + f.saved.id));
});

it("does not fall back to ordinary execution when a saved private grant is corrupt", async () => {
  const f = fixture(); f.store.setSetting("private_sources.schedule." + f.saved.id, "corrupt");
  await f.tick(); expect(f.run).not.toHaveBeenCalled(); expect(f.sent).toEqual([]);
  expect(f.scheduler.runs(f.conversationId)[0]?.status).toBe("failed");
});

it.each(["grant", "pairing", "scope", "prompt"])("stops private delivery when %s changes after the last source read", async change => {
  const f = fixture();
  f.run.mockImplementation(async (_text, options) => {
    await f.read(options);
    if (change === "grant") f.revoke();
    if (change === "pairing") f.store.linkTelegramChat({ chatId: "42", title: "Revoked", allowedSenders: [] });
    if (change === "scope") f.store.setSetting("conversation.context." + f.conversationId, "group-shared");
    if (change === "prompt") f.store.db.prepare("UPDATE schedules SET prompt='Changed request' WHERE id=?").run(f.saved.id);
    return { threadId: "synthetic", response: "SYNTHETIC_PRIVATE_RESULT", events: [] };
  });
  await f.tick();
  expect(f.source).toHaveBeenCalledTimes(1); expect(f.sent).toEqual([]);
  expect(f.store.db.prepare("SELECT count(*) AS n FROM telegram_outbox").get()?.n).toBe(0);
  expect(f.scheduler.runs(f.conversationId)[0]?.status).toBe("failed");
});

it.each(["grant", "scope"])("rechecks %s before the next text chunk and does not replay a partial delivery", async change => {
  const f = fixture();
  f.run.mockImplementation(async (_text, options) => { await f.read(options); return { threadId: "synthetic", response: "private receipt ".repeat(800), events: [] }; });
  f.setOnSend(() => {
    if (change === "grant") f.revoke(); else f.store.setSetting("conversation.context." + f.conversationId, "work");
  });
  await f.tick();
  expect(f.sent).toHaveLength(1); expect(f.scheduler.runs(f.conversationId)[0]?.status).toBe("uncertain");
  expect(f.store.db.prepare("SELECT status FROM telegram_outbox").all()).toEqual([{ status: "delivered" }]);
  await f.tick(); expect(f.sent).toHaveLength(1);
});

it("does not acquire private access from approval added after a run was claimed", async () => {
  const f = fixture(false);
  f.run.mockImplementation(async (_text, options) => {
    f.approve();
    expect(options!.tools!.definitions.map(tool => tool.name)).not.toContain("unipile_read");
    expect(privateSourceAudience(f.store, { conversationId: f.conversationId, messageId: options!.messageId!, channel: "api", scope: "personal", scheduled: true, scheduleTelegramChatId: "42" })).toBe(false);
    return { threadId: "synthetic", response: "No private source was read", events: [] };
  });
  await f.tick(); expect(f.source).not.toHaveBeenCalled();
  expect(f.store.db.prepare("SELECT private_source_fingerprint FROM schedule_runs").get()?.private_source_fingerprint).toBeNull();
});

it("refuses separate scheduled sends for private runs while leaving automatic delivery available", async () => {
  const f = fixture();
  f.run.mockImplementation(async (_text, options) => {
    await f.read(options);
    await expect(options!.tools!.call("send_telegram_message", { chatId: "42", text: "Duplicate private result", paths: [] })).rejects.toThrow("automatic delivery only");
    return { threadId: "synthetic", response: "One automatic private result", events: [] };
  });
  await f.tick(); expect(f.sent).toHaveLength(1); expect(f.sent[0]?.body.text).toBe("One automatic private result");
});

it("still refuses a separate send after the private grant is deleted", async () => {
  const f = fixture();
  f.run.mockImplementation(async (_text, options) => {
    await f.read(options); f.revoke();
    await expect(options!.tools!.call("send_telegram_message", { chatId: "42", text: "Revoked private result", paths: [] })).rejects.toThrow("automatic delivery only");
    return { threadId: "synthetic", response: "Revoked private result", events: [] };
  });
  await f.tick(); expect(f.sent).toEqual([]); expect(f.scheduler.runs(f.conversationId)[0]?.status).toBe("failed");
});

it("preserves ordinary scheduled separate sends and their quiet automatic completion", async () => {
  const f = fixture(false);
  f.run.mockImplementation(async (_text, options) => {
    expect(await options!.tools!.call("send_telegram_message", { chatId: "42", text: "Ordinary scheduled card", paths: [] })).toMatchObject({ sent: true });
    return { threadId: "synthetic", response: "NO_REPLY", events: [] };
  });
  await f.tick(); expect(f.sent).toHaveLength(1); expect(f.scheduler.runs(f.conversationId)[0]?.status).toBe("quiet");
});

it.each(["ready", "running"])("retains private approval after %s recovery and stops delivery after explicit revocation", async status => {
  const f = fixture();
  f.store.db.prepare("UPDATE schedules SET next_run_at='2026-11-03T08:00:00.000Z' WHERE id=?").run(f.saved.id);
  const inbound = f.store.addMessage({ conversationId: f.conversationId, channel: "api", direction: "inbound", externalId: "schedule:interrupted", text: "Synthetic private run" });
  const outbound = f.store.addMessage({ conversationId: f.conversationId, channel: "api", direction: "outbound", replyToId: inbound.id, text: "SYNTHETIC_PRIVATE_RESULT" });
  f.store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at,message_id,private_source_fingerprint) VALUES('interrupted',?,?,?,?,?,?,?)")
    .run(f.saved.id, f.conversationId, now.toISOString(), status, now.toISOString(), status === "ready" ? outbound.id : null, f.store.getSetting("private_sources.schedule." + f.saved.id));
  f.revoke();
  const reopened = new Scheduler(f.store, f.messages); reopened.deliver = f.scheduler.deliver; reopened.recover();
  expect(f.scheduler.runs(f.conversationId)[0]?.status).toBe("ready");
  await reopened.tick(now); await reopened.idle(); expect(f.sent).toEqual([]); expect(f.run).not.toHaveBeenCalled();
  expect(f.scheduler.runs(f.conversationId)[0]?.status).toBe("failed");
});

it.each(["document", "photo"])("rechecks revocation after real asynchronous %s preparation and before sending the file", async kind => {
  const f = fixture();
  const bytes = kind === "photo" ? Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1cAAAAASUVORK5CYII=", "base64") : Buffer.from("Synthetic private document");
  const file = f.messages.files.put(f.conversationId, "personal", { name: kind === "photo" ? "private.png" : "private.txt", mimeType: kind === "photo" ? "image/png" : "text/plain", contentBase64: bytes.toString("base64") });
  const path = f.messages.files.get(file.id)!.path; let prepared = 0, deliveryPath: string | undefined;
  reads.after = readPath => {
    if (readPath === deliveryPath && ++prepared === (kind === "photo" ? 2 : 1)) f.revoke();
  };
  f.run.mockImplementation(async (_text, options) => {
    await f.read(options);
    const attached = await options!.tools!.call("attach_file", { path }) as { file: { id: string } };
    deliveryPath = f.messages.files.get(attached.file.id)!.path;
    return { threadId: "synthetic", response: "Attached private result", events: [] };
  });
  await f.tick();
  expect(prepared).toBe(kind === "photo" ? 2 : 1);
  expect(f.sent.map(item => item.method)).toEqual(kind === "photo" ? [] : ["sendMessage"]);
  expect(f.scheduler.runs(f.conversationId)[0]?.status).toBe("uncertain");
});

it("rechecks a revoked grant before retrying Telegram's explicit rate-limit rejection", async () => {
  const f = fixture(); let attempts = 0, rejected!: () => void;
  const first = new Promise<void>(resolve => { rejected = resolve; });
  vi.stubGlobal("fetch", vi.fn(async () => { attempts++; f.revoke(); rejected(); return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }); }));
  const pending = f.tick(); await first; await vi.advanceTimersByTimeAsync(1_001); await pending;
  expect(attempts).toBe(1); expect(f.scheduler.runs(f.conversationId)[0]?.status).toBe("uncertain");
});
