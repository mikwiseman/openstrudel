import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { MockCodexEngine } from "../src/codex.js";
import { HomeLink } from "../src/home-link.js";
import { LocalAgentMoves, agentTransfer } from "../src/agent-move.js";
import { homeRequest, requestJSON, resultJSON } from "../src/home-transport.js";

const runtimes: OpenStrudelRuntime[] = [], roots: string[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function node(name: string, previousRoot?: string, port = 0) {
  const root = previousRoot ?? mkdtempSync(join(tmpdir(), "openstrudel-move-")); if (!previousRoot) roots.push(root);
  const runtime = new OpenStrudelRuntime({ dbPath: join(root, "home.sqlite"), rootDirectory: root, startTelegram: false, engine: new MockCodexEngine(), apiToken: "test-owner", mobilePort: 0 }); runtimes.push(runtime);
  const home = runtime.api.home; home.save({ ...home.state, name });
  const address = await runtime.api.listen("127.0.0.1", port), url = `http://127.0.0.1:${address.port}`; home.setEndpoint({ url });
  const api = async (path: string, method = "GET", body?: unknown) => {
    // This fixture rebinds the same port after shutdown. Do not reuse undici's
    // idle socket from the previous server incarnation for the recovery write.
    const response = await fetch(url + path, { method, headers: { authorization: "Bearer test-owner", "content-type": "application/json", connection: "close" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() as any };
  };
  return { runtime, api, url, home, root };
}
async function eventually(f: () => Promise<void> | void) {
  let error: unknown;
  for (let i = 0; i < 350; i++) { try { await f(); return; } catch (e) { error = e; await new Promise(resolve => setTimeout(resolve, 25)); } }
  throw error;
}
async function connect(a: Awaited<ReturnType<typeof node>>, b: Awaited<ReturnType<typeof node>>) {
  await b.api("/v1/home/join", "POST", { invitation: a.home.invite({ url: a.url }) });
  await eventually(() => expect(a.home.nodes()).toHaveLength(2));
}

describe("agent moves with one execution owner", () => {
  it("recovers a failed release reply after reopening the primary database without reactivating its agent", async () => {
    let a = await node("Main"); const b = await node("Worker");
    const p = a.runtime.store.createProfile({ name: "Recovery" });
    await a.runtime.messages.handle({ channel: "api", profile: p.id, text: "Saved" });
    await connect(a, b); await a.api("/v1/profiles");
    const moves = (a.runtime.api as any).agentMoves as LocalAgentMoves;
    const original = moves.handle.bind(moves); let failed = false;
    vi.spyOn(moves, "handle").mockImplementation(async (action, input) => {
      const result = await original(action, input);
      if (action === "release" && !failed) { failed = true; throw new Error("Injected failure after durable release"); }
      return result;
    });
    const id = randomUUID(); await a.api(`/v1/agents/${p.id}/move`, "POST", { deviceId: b.home.state.nodeId, operationId: id });
    await eventually(() => expect(a.home.operation(id)?.phase).toBe("attention"));
    expect(agentTransfer(a.runtime.store, p.id).phase).toBe("moved");
    expect(agentTransfer(b.runtime.store, p.id).phase).toBe("staged");
    const root = a.root, port = Number(new URL(a.url).port);
    await a.runtime.stop(); runtimes.splice(runtimes.indexOf(a.runtime), 1);
    a = await node("Main", root, port);
    expect(a.home.operation(id).phase).toBe("attention");
    expect((await a.api(`/v1/home/operations/${id}/retry`, "POST", {})).status).toBe(202);
    await eventually(() => expect(a.home.operation(id)?.phase, a.home.operation(id)?.error).toBe("completed"));
    expect(agentTransfer(a.runtime.store, p.id).phase).toBe("moved");
    expect(agentTransfer(b.runtime.store, p.id)).toBeNull();
    expect(b.runtime.store.listMessages(b.runtime.store.profileConversation(p.id).id)).toHaveLength(2);
    expect((await a.api(`/v1/home/operations/${id}/retry`, "POST", {})).value.phase).toBe("completed");
  }, 20000);
  it("preserves files, message identity and schedule receipts, routes new messages, and can move back", async () => {
    const a = await node("Main"), b = await node("Worker"), store = a.runtime.store;
    const p = store.createProfile({ name: "Editor", instructions: "Keep my notes" });
    const first = await a.runtime.messages.handle({ channel: "api", profile: p.id, text: "Remember", externalId: "stable-message" });
    const workspace = a.runtime.messages.files.workspace(a.runtime.messages.contextFor(first.conversationId));
    mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, "notes.txt"), "Private notes");
    const file = a.runtime.messages.files.put(first.conversationId, a.runtime.messages.contextFor(first.conversationId), { name: "report.txt", contentBase64: Buffer.from("Report").toString("base64") });
    const schedule = a.runtime.scheduler.save({ conversationId: first.conversationId, name: "Edition", prompt: "Write", cron: "0 9 * * *", timezone: "UTC" });
    store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at,message_id) VALUES(?,?,?,?,?,?,?)").run("old-run", schedule.id, first.conversationId, "2026-10-05T09:00:00.000Z", "uncertain", "2026-10-05T09:00:00.000Z", first.messageId);
    await connect(a, b); await a.api("/v1/profiles");
    const id = randomUUID(), moved = await a.api(`/v1/agents/${p.id}/move`, "POST", { deviceId: b.home.state.nodeId, operationId: id });
    expect(moved.status).toBe(202); expect(moved.value.proof).toBeUndefined();
    expect((await a.api("/v1/messages", "POST", { profile: p.id, text: "During move" })).status).toBe(423);
    await eventually(() => expect(a.home.operation(id)?.phase, JSON.stringify(a.home.operation(id))).toBe("completed"));
    expect(a.home.nodeFor("profile", p.id)).toBe(b.home.state.nodeId);
    expect(agentTransfer(store, p.id)?.phase).toBe("moved");
    await expect(a.runtime.messages.handle({ channel: "api", profile: p.id, text: "Old instance" })).rejects.toThrow("перенесён");
    const target = b.runtime.store;
    expect(target.profileConversation(p.id).id).toBe(first.conversationId);
    expect(target.findReplyTo(target.findMessageByExternal("api", "stable-message")!.id)!.id).toBe(first.messageId);
    expect(readFileSync(join(b.runtime.messages.files.workspace(b.runtime.messages.contextFor(first.conversationId)), "notes.txt"), "utf8")).toBe("Private notes");
    expect(readFileSync(b.runtime.messages.files.get(file.id)!.path, "utf8")).toBe("Report");
    expect(b.runtime.scheduler.list(first.conversationId)[0]).toMatchObject({ id: schedule.id, enabled: true, nextRunAt: schedule.nextRunAt });
    expect(b.runtime.scheduler.runs(first.conversationId)[0]).toMatchObject({ id: "old-run", status: "uncertain", messageId: first.messageId });
    const repeat = await a.api("/v1/messages", "POST", { profile: p.id, text: "Remember", externalId: "stable-message" }); expect(repeat.status).toBe(202);
    await eventually(() => expect(a.home.command(repeat.value.operationId)?.response).toBeTruthy());
    expect(target.listMessages(first.conversationId).filter(m => m.direction === "inbound")).toHaveLength(1);
    const next = await a.api("/v1/messages", "POST", { profile: p.id, text: "Next", externalId: "next-message" });
    await eventually(() => expect(target.findReplyTo(target.findMessageByExternal("api", "next-message")!.id)).toBeTruthy());
    const back = randomUUID(); expect((await a.api(`/v1/agents/${p.id}/move`, "POST", { deviceId: a.home.state.nodeId, operationId: back })).status).toBe(202);
    await eventually(() => expect(a.home.operation(back)?.phase, JSON.stringify(a.home.operation(back))).toBe("completed"));
    expect(store.findMessageByExternal("api", "next-message")).toBeTruthy();
    expect(a.home.nodeFor("profile", p.id)).toBe(a.home.state.nodeId);
    expect(agentTransfer(target, p.id)?.phase).toBe("moved");
    expect((await a.api(`/v1/agents/${p.id}/conversation`)).value.messages).toHaveLength(4);
  }, 30000);

  it("moves the default assistant without replacing the target's local assistant", async () => {
    const a = await node("Main"), b = await node("Worker");
    const first = await a.runtime.messages.handle({ channel: "api", text: "My plans", externalId: "main-message" });
    const targetFirst = await b.runtime.messages.handle({ channel: "api", text: "Other plans" });
    await connect(a, b);
    const id = randomUUID(); await a.api("/v1/agents/main/move", "POST", { deviceId: b.home.state.nodeId, operationId: id });
    await eventually(() => expect(a.home.operation(id)?.phase, JSON.stringify(a.home.operation(id))).toBe("completed"));
    expect(a.home.state.mainAgentId).toBeTruthy();
    expect((await a.api("/v1/conversation")).value.conversation.id).toBe(first.conversationId);
    expect(b.runtime.store.getConversation(targetFirst.conversationId)).toBeTruthy();
    expect((await a.api("/v1/profiles")).value.profiles.some((p: any) => p.id === a.home.state.mainAgentId)).toBe(false);
    await a.api("/v1/messages", "POST", { text: "After move", externalId: "main-next" });
    await eventually(() => expect(b.runtime.store.findMessageByExternal("api", "main-next")?.conversationId).toBe(first.conversationId));
  }, 20000);

  it("refuses shared legacy spaces and releases the source after a failed prepare", async () => {
    const a = await node("Main"), b = await node("Worker");
    const p = a.runtime.store.createProfile({ name: "Shared" }); a.runtime.store.setSetting("employee.context." + p.id, "personal");
    await connect(a, b); await a.api("/v1/profiles");
    const id = randomUUID(); await a.api(`/v1/agents/${p.id}/move`, "POST", { deviceId: b.home.state.nodeId, operationId: id });
    await eventually(() => expect(a.home.operation(id)?.phase).toBe("canceled"));
    expect(a.home.operation(id).error).toContain("общая рабочая папка");
    expect(agentTransfer(a.runtime.store, p.id)).toBeNull();
    expect(b.runtime.store.getProfile(p.id)).toBeNull();
    expect((await a.api("/v1/agent-transfer/release", "POST", { id, proof: "0".repeat(64) })).status).toBe(403);
  }, 15000);

  it("replays durable steps after restart, never enables a staged target, and never undoes release", async () => {
    const a = await node("Main"), b = await node("Worker");
    const p = a.runtime.store.createProfile({ name: "Safe" }); await a.runtime.messages.handle({ channel: "api", profile: p.id, text: "History" });
    await connect(a, b); await a.runtime.api.homeLink.stop(); await b.runtime.api.homeLink.stop();
    const input = { id: randomUUID(), proof: "c".repeat(64), agent: p.id, agentId: p.id };
    const source = new LocalAgentMoves(a.home, a.runtime.messages), target = new LocalAgentMoves(b.home, b.runtime.messages);
    const prepared = await source.handle("prepare", input) as any;
    expect(await new LocalAgentMoves(a.home, a.runtime.messages).handle("prepare", input)).toEqual(prepared);
    expect(await target.handle("stage", { ...input, ...prepared })).toEqual({ ready: true, digest: prepared.digest });
    expect(b.home.inventory().profiles.some(v => v.id === p.id)).toBe(false);
    await expect(b.runtime.messages.handle({ channel: "api", profile: p.id, text: "Too early" })).rejects.toThrow("переносится");
    await source.handle("release", input);
    await expect(new LocalAgentMoves(a.home, a.runtime.messages).handle("cancel", input)).rejects.toThrow("уже состоялась");
    expect((await new LocalAgentMoves(a.home, a.runtime.messages).handle("release", input) as any).released).toBe(true);
    await target.handle("activate", { ...input, digest: prepared.digest });
    expect((await new LocalAgentMoves(b.home, b.runtime.messages).handle("activate", { ...input, digest: prepared.digest }) as any).active).toBe(true);
    await b.runtime.messages.handle({ channel: "api", profile: p.id, text: "Active" });
    expect(agentTransfer(a.runtime.store, p.id).phase).toBe("moved");
    expect(agentTransfer(b.runtime.store, p.id)).toBeNull();
  });
});
