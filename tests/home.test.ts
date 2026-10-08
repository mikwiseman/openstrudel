import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { MockCodexEngine } from "../src/codex.js";
import { Store } from "../src/store.js";
import { Home, decryptBackup, encryptBackup, type WireRequest } from "../src/home.js";
import { HomeLink } from "../src/home-link.js";
import { requestJSON, resultJSON, wireJSON } from "../src/home-transport.js";

const runtimes: OpenStrudelRuntime[] = [], roots: string[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function node(name: string) {
  const root = mkdtempSync(join(tmpdir(), "openstrudel-home-")); roots.push(root);
  const runtime = new OpenStrudelRuntime({ dbPath: join(root, "home.sqlite"), rootDirectory: root, startTelegram: false, engine: new MockCodexEngine(), apiToken: "test-owner", mobilePort: 0 }); runtimes.push(runtime);
  runtime.api.home.save({ ...runtime.api.home.state, name });
  const address = await runtime.api.listen("127.0.0.1", 0);
  const url = `http://127.0.0.1:${address.port}`;
  runtime.api.home.setEndpoint({ url });
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { authorization: "Bearer test-owner", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() as any };
  };
  return { runtime, api, url, home: runtime.api.home };
}
async function connect(primary: Awaited<ReturnType<typeof node>>, worker: Awaited<ReturnType<typeof node>>) {
  const invite = primary.home.invite({ url: primary.url });
  expect((await worker.api("/v1/home/join", "POST", { invitation: invite })).status).toBe(200);
  await eventually(() => expect(primary.home.nodes()).toHaveLength(2));
}
async function eventually(f: () => Promise<void> | void) {
  let error: unknown;
  for (let i = 0; i < 150; i++) { try { await f(); return; } catch (e) { error = e; await new Promise(resolve => setTimeout(resolve, 30)); } }
  throw error;
}

describe("user-owned primary Home", () => {
  it("routes extension reads and writes to the employee's device and reports legacy shared workspaces", async () => {
    const primary = await node("Laptop"), worker = await node("Mac mini");
    const profile = worker.runtime.store.createProfile({name:"Writer",instructions:""});
    const peer = worker.runtime.store.createProfile({name:"Editor",instructions:""});
    const chat = worker.runtime.store.profileConversation(profile.id);
    worker.runtime.store.profileConversation(peer.id);
    worker.runtime.store.setSetting("employee.context." + profile.id,"legacy-work");
    worker.runtime.store.setSetting("employee.context." + peer.id,"legacy-work");
    let installed: unknown;
    worker.runtime.engine.extensions = async () => ({
      list: async () => ({items:[],notice:null}),
      addMcp: async value => { installed=value;return {name:value.name}; },
    }) as any;
    await connect(primary,worker);
    await eventually(() => expect(primary.home.nodeFor("conversation",chat.id)).toBe(worker.home.state.nodeId));
    const scopes=await primary.api(`/v1/extensions/contexts?conversationId=${chat.id}`);
    expect(scopes.status).toBe(200);
    expect(scopes.value.contexts[0].sharedNotice).toContain("2 сотрудников");
    expect((await primary.api(`/v1/extensions?conversationId=${chat.id}`)).value.items).toEqual([]);
    const value={conversationId:chat.id,name:"docs",url:"https://example.com/mcp"};
    const result=await primary.api("/v1/extensions/mcp","POST",value);
    expect(result.status).toBe(200);
    expect(installed).toEqual(value);
    expect(result.value).toEqual({name:"docs"});
    expect(primary.runtime.store.getConversation(chat.id)).toBeNull();
  });
  it("preserves the joining Mac's main history as a named local agent", async () => {
    const primary = await node("Main"), worker = await node("Personal Mac");
    worker.runtime.store.setSetting("main.soul", "Помни мои планы");
    worker.runtime.store.setSetting("agent.accounts.main", '["default"]');
    const before = await worker.runtime.messages.handle({ channel: "api", text: "Мои старые планы", externalChatId: "home" });
    await connect(primary, worker);
    const saved = worker.runtime.store.listProfiles().find(p => p.name === "Помощник · Personal Mac")!;
    expect(saved.instructions).toBe("Помни мои планы");
    expect(worker.runtime.store.getSetting("employee.context." + saved.id)).toBe("personal");
    expect(worker.runtime.store.getSetting("agent.accounts." + saved.id)).toBe('["default"]');
    expect(worker.runtime.store.profileConversation(saved.id).id).toBe(before.conversationId);
    await eventually(async () => {
      const chat = await primary.api(`/v1/agents/${saved.id}/conversation`);
      expect(chat.value.messages.some((m: any) => m.id === before.messageId)).toBe(true);
    });
    expect(primary.runtime.store.getProfile(saved.id)).toBeNull();
  });
  it("cancels only before dispatch and keeps the canceled request id reserved", async () => {
    const primary = await node("Main"), worker = await node("Mac");
    const p = worker.runtime.store.createProfile({ name: "Offline", instructions: "" });
    await connect(primary, worker);
    await eventually(() => expect(primary.home.nodeFor("profile", p.id)).toBe(worker.home.state.nodeId));
    await worker.runtime.api.homeLink.stop();
    const body = { profile: p.id, text: "Не исполнять", externalId: randomUUID() };
    const request = await primary.api("/v1/messages", "POST", body);
    const path = "/v1/home/requests/" + request.value.operationId;
    expect((await primary.api(path, "DELETE")).value.canceled).toBe(true);
    expect((await primary.api(path)).value.status).toBe("canceled");
    expect((await primary.api("/v1/messages", "POST", body)).status).toBe(409);
    const next = await primary.api("/v1/messages", "POST", { ...body, externalId: randomUUID() });
    primary.home.dispatch(worker.home.state.nodeId);
    expect((await primary.api("/v1/home/requests/" + next.value.operationId, "DELETE")).status).toBe(409);
    worker.runtime.api.homeLink.start();
    await eventually(() => expect(worker.runtime.store.listMessages(request.value.conversationId).filter(m => m.direction === "inbound")).toHaveLength(1));
  });
  it("keeps one catalogue, routes agents to an outbound executor, and deduplicates delivery", async () => {
    const primary = await node("Main"), worker = await node("Mac");
    const profile = worker.runtime.store.createProfile({ name: "Исследователь", instructions: "Проверяй факты" });
    await connect(primary, worker);
    await eventually(async () => expect((await primary.api("/v1/profiles")).value.profiles.find((p: any) => p.id === profile.id)?.deviceId).toBe(worker.home.state.nodeId));
    expect(worker.home.nodes()).toHaveLength(0);
    const body = { text: "Привет", profile: profile.id, externalId: randomUUID() };
    const first = await primary.api("/v1/messages?async=true", "POST", body);
    expect(first.status).toBe(202);
    const second = await primary.api("/v1/messages?async=true", "POST", body);
    expect(second.value.operationId).toBe(first.value.operationId);
    await eventually(() => expect(worker.runtime.store.listMessages(first.value.conversationId).filter(m => m.direction === "outbound")).toHaveLength(1));
    const chat = await primary.api(`/v1/agents/${profile.id}/conversation`);
    expect(chat.status).toBe(200);
    expect(chat.value.messages.filter((m: any) => m.direction === "outbound")).toHaveLength(1);
    expect(primary.runtime.store.listProfiles()).toHaveLength(0);
    expect(primary.runtime.store.listConversations().flatMap(c => primary.runtime.store.listMessages(c.id))).toHaveLength(0);
  });
  it("durably waits for an offline executor and resumes without copying its agent", async () => {
    const primary = await node("Main"), worker = await node("Mac");
    const p = worker.runtime.store.createProfile({ name: "План", instructions: "Составляй планы" });
    await connect(primary, worker);
    await eventually(() => expect(primary.home.nodeFor("profile", p.id)).toBe(worker.home.state.nodeId));
    await worker.runtime.api.homeLink.stop();
    const before = await primary.api("/v1/messages", "POST", { profile: p.id, text: "Сохрани", externalId: randomUUID() });
    expect(before.status).toBe(202);
    expect(primary.home.pending(worker.home.state.nodeId)).toHaveLength(1);
    expect(worker.runtime.store.listMessages(before.value.conversationId)).toHaveLength(0);
    worker.runtime.api.homeLink.start();
    await eventually(() => expect(worker.runtime.store.listMessages(before.value.conversationId).filter(m => m.direction === "outbound")).toHaveLength(1));
  });
  it("hands over control while agent histories remain on their original machines", async () => {
    const source = await node("Old"), target = await node("New");
    const p = source.runtime.store.createProfile({ name: "Старый агент", instructions: "Помогай" });
    const result = await source.runtime.messages.handle({ channel: "api", profile: p.id, text: "Запомни" });
    await source.api("/v1/profiles");
    await connect(source, target);
    await eventually(() => expect(source.home.nodes().find(n => n.id === target.home.state.nodeId)?.online).toBe(true));
    const id = randomUUID();
    const transferred = await source.api("/v1/home/transfer", "POST", { deviceId: target.home.state.nodeId, operationId: id, backupPassword: "test password with enough words" });
    expect(transferred.status).toBe(200);
    expect(transferred.value.phase).toBe("transferred");
    expect(transferred.value.token).toBeUndefined();
    expect(transferred.value.backup).toContain("openstrudel.home.backup");
    await eventually(() => expect(target.home.state.role).toBe("primary"));
    await eventually(() => expect(source.home.operation(id).phase).toBe("completed"));
    expect(source.home.state.role).toBe("retired");
    expect(source.home.resources("profile")).toHaveLength(0);
    expect(target.runtime.store.getProfile(p.id)).toBeNull();
    await eventually(async () => {
      const chat = await target.api(`/v1/agents/${p.id}/conversation`);
      expect(chat.status).toBe(200); expect(chat.value.messages.some((m: any) => m.id === result.messageId)).toBe(true);
    });
    const old = await source.api("/v1/profiles");
    expect(old.status).toBe(409); expect(old.value.moved.url).toBe(target.url);
    const again = await source.api("/v1/home/operations/" + id);
    expect(again.value.phase).toBe("completed");
  }, 30000);
  it("does not consume client credentials as an executor invitation", async () => {
    const primary = await node("Main");
    const response = await primary.api("/v1/home/pair", "POST", { node: { id: randomUUID(), name: "Uninvited", platform: "linux", protocol: 1 } });
    expect(response.status).toBe(401);
    expect(primary.home.nodes()).toHaveLength(1);
    expect((await primary.api("/v1/devices/" + primary.home.state.nodeId, "DELETE")).status).toBe(409);
  });
  it("does not repeat an uncertain non-idempotent operation after executor restart", async () => {
    const store = new Store(":memory:"), home = new Home(store);
    let calls = 0;
    const link = new HomeLink(home, async () => { calls++; return wireJSON({ done: true }); });
    const request: WireRequest = { method: "POST", path: "/v1/profiles", owner: true, body: requestJSON({ name: "New" }) };
    const command = { id: randomUUID(), request };
    home.begin(command);
    const response = await link.execute(command);
    expect(response.status).toBe(409); expect(calls).toBe(0);
    expect(JSON.parse(Buffer.from(response.body, "base64").toString()).uncertain).toBe(true);
    expect(await link.execute(command)).toEqual(response); store.close();
  });
  it("authenticates encrypted control backups and refuses wrong passwords or tampering", () => {
    const password = "a long private recovery password";
    const data = { access: "private-access", state: { epoch: 3 } };
    const encrypted = encryptBackup(data, password);
    expect(encrypted).not.toContain("private-access");
    expect(decryptBackup(encrypted, password)).toEqual(data);
    expect(() => decryptBackup(encrypted, "different password")).toThrow("Проверьте файл и пароль");
    const tampered = JSON.parse(encrypted); tampered.data = "AAAA" + tampered.data.slice(4);
    expect(() => decryptBackup(JSON.stringify(tampered), password)).toThrow();
  });
});
