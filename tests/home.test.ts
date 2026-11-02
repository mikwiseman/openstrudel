import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { MockCodexEngine } from "../src/codex.js";
import { Store } from "../src/store.js";
import { execFileSync } from "node:child_process";
import { Home, decryptBackup, defaultDeviceName, encryptBackup, type WireRequest } from "../src/home.js";
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
  it("lets the owner choose Telegram group senders on a connected Home and denies member changes", async () => {
    const primary = await node("Primary"), worker = await node("Bot Home");
    await connect(primary,worker);
    worker.runtime.store.linkTelegramChat({chatId:"-100",title:"Client group",allowedSenders:["42"]});
    worker.runtime.store.connectTelegramGroup("-100");
    const original = worker.runtime.store.getTelegramChat("-100")!;
    const path = "/v1/integrations/telegram/chats/-100";
    const request = {replyAccess:"approved",allowedSenders:["42","77"]};
    const member = await worker.runtime.api.homeLink.execute({id:randomUUID(),request:{method:"PATCH",path,owner:false,body:requestJSON(request)}});
    expect(member.status).toBe(403);
    expect(worker.runtime.store.getTelegramChat("-100")).toEqual(original);
    const result = await primary.api(path + "?deviceId=" + worker.home.state.nodeId,"PATCH",request);
    expect(result.status).toBe(200);
    expect(worker.runtime.store.getTelegramChat("-100")).toMatchObject({allowedSenders:["42","77"],access:"approved",conversationId:original.conversationId});
    expect(primary.runtime.store.getTelegramChat("-100")).toBeNull();
    expect((await primary.api(path + "?deviceId=" + worker.home.state.nodeId,"PATCH",{replyAccess:"members"})).status).toBe(200);
    expect(worker.runtime.store.getTelegramChat("-100")?.access).toBe("members");
  });

  it("keeps diagnostics owner-only, persists the level on the selected device and serves no secrets", async () => {
    const primary = await node("Primary"), worker = await node("Worker");
    await connect(primary, worker);
    worker.runtime.store.setSetting("speech.elevenlabs.key", "private-key-value");
    const route = "/v1/diagnostics?deviceId=" + worker.home.state.nodeId;
    expect((await primary.api(route, "POST", { level: "detailed" })).status).toBe(200);
    expect((await primary.api(route)).value).toMatchObject({ level: "detailed", speech: { provider: "local", connected: true, transcription: "local" } });
    vi.stubEnv("OPENSTRUDEL_STT_URL", "https://stt.example.test");
    try { expect((await primary.api(route)).value.speech).toEqual({ provider: "local", connected: true, transcription: "server" }); } finally { vi.unstubAllEnvs(); }
    expect(primary.runtime.store.getSetting("diagnostics.level")).toBeNull();
    const member = await worker.runtime.api.homeLink.execute({ id: randomUUID(), request: { method: "GET", path: "/v1/diagnostics", owner: false } });
    expect(member.status).toBe(403);
    expect(JSON.stringify((await primary.api(route)).value)).not.toContain("private-key-value");
  });
  it("relays speech settings without logging the key, transcribes on the selected Home and refuses member changes", async () => {
    const actualFetch = fetch, secret = "test-elevenlabs-key-remote-only";
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input);
      if (!url.startsWith("https://api.elevenlabs.io/")) return actualFetch(input, init);
      expect(init.headers["xi-api-key"]).toBe(secret); calls.push(url);
      return Response.json(url.endsWith("/voices") ? { voices: [{ voice_id: "test-voice", name: "Test voice" }] } : url.endsWith("/speech-to-text") ? { text: "From remote audio" } : []);
    }));
    try {
      const primary = await node("Primary"), worker = await node("Speech Home");
      const employee = worker.runtime.store.createProfile({name:"Remote dictation"});
      const conversation = worker.runtime.store.profileConversation(employee.id);
      await connect(primary, worker);
      await eventually(() => expect(primary.home.nodeFor("conversation", conversation.id)).toBe(worker.home.state.nodeId));
      const logged: string[] = [], enqueue = primary.home.enqueue.bind(primary.home);
      primary.home.enqueue = (nodeId, request, id) => { logged.push(Buffer.from(request.body ?? "", "base64").toString()); return enqueue(nodeId, request, id); };
      const remote = "/v1/settings/speech?deviceId=" + worker.home.state.nodeId;
      expect((await primary.api(remote, "POST", { provider: "elevenlabs", key: secret })).value).toMatchObject({ provider: "elevenlabs", connected: true, voiceId: "test-voice" });
      expect(worker.runtime.store.getSetting("speech.elevenlabs.key")).toBe(secret);
      expect(primary.runtime.store.getSetting("speech.elevenlabs.key")).toBeNull();
      expect((await primary.api(remote)).value).not.toHaveProperty("key");
      const settings = await primary.api("/v1/settings/speech?conversationId=" + conversation.id);
      expect(settings.value).toMatchObject({provider:"elevenlabs",connected:true});
      const transcript = await primary.api("/v1/speech/transcribe?conversationId=" + conversation.id, "POST", { name: "test.mp4", contentBase64: "AQID" });
      expect(transcript).toEqual({ status: 200, value: { text: "From remote audio" } });
      expect(calls.filter(p => p.endsWith("/speech-to-text"))).toHaveLength(1);
      expect([...logged, JSON.stringify(primary.home.snapshot())].join("\n")).not.toContain(secret);
      const member = await worker.runtime.api.homeLink.execute({ id: randomUUID(), request: { method: "POST", path: "/v1/settings/speech", owner: false, body: requestJSON({ removeKey: true }) } });
      expect(member.status).toBe(403); expect(worker.runtime.store.getSetting("speech.elevenlabs.key")).toBe(secret);
      await worker.runtime.api.homeLink.stop();
      const late = { method: "POST", path: "/v1/settings/speech", owner: true, body: requestJSON({ key: secret }) };
      await expect(primary.runtime.api.homeLink.call(worker.home.state.nodeId, late, undefined, 100)).rejects.toMatchObject({ status: 503 });
      expect(primary.home.pending(worker.home.state.nodeId)).toEqual([]);
      expect(logged.join("\n")).not.toContain(secret);
    } finally { vi.unstubAllGlobals(); }
  });
  it("serves a bounded employee timeline through the primary Home while keeping ordinary message routes separate", async () => {
    const primary = await node("Primary"), worker = await node("Worker");
    const store = worker.runtime.store;
    const employee = store.createProfile({ name: "Timeline editor" });
    const app = store.profileConversation(employee.id);
    store.linkTelegramChat({ chatId: "-1001234567890", title: "Core team", allowedSenders: ["42"] });
    const group = store.bindTelegramChat("-1001234567890", employee.id);
    store.addMessage({ conversationId: app.id, channel: "api", direction: "inbound", text: "Private request" });
    store.addMessage({ conversationId: group.conversationId!, channel: "telegram", direction: "inbound", text: "Team request", externalId: "-1001234567890:1", author: "Dasha" });
    await connect(primary, worker);
    await eventually(async () => expect((await primary.api("/v1/profiles")).value.profiles.find((p: any) => p.id === employee.id)?.deviceId).toBe(worker.home.state.nodeId));
    const response = await primary.api("/v1/agents/" + employee.id + "/conversation?timeline=true&page=true");
    expect(response.status).toBe(200);
    expect(response.value.timeline).toBe(true);
    expect(response.value.conversation.id).toBe(app.id);
    expect(response.value.messages.map((m: any) => m.text)).toEqual(["Private request", "Team request"]);
    expect((await primary.api("/v1/agents/" + employee.id + "/conversation?page=true")).value.messages).toHaveLength(1);
    expect((await fetch(primary.url + "/v1/agents/" + employee.id + "/conversation?timeline=true")).status).toBe(401);
  });

  it("renames an employee without replacing instructions saved by another client", async () => {
    const host = await node("Team");
    const employee = host.runtime.store.createProfile({ name: "Editor", instructions: "Original instructions" });
    host.runtime.store.updateProfile(employee.id, { name: employee.name, instructions: "New instructions from iPhone" });
    const renamed = await host.api("/v1/profiles/" + employee.id, "PATCH", { name: "Редактор" });
    expect(renamed.status).toBe(200);
    expect(renamed.value.profile).toMatchObject({ name: "Редактор", instructions: "New instructions from iPhone" });
    expect((await host.api("/health")).value.employeeRenameKeepsInstructions).toBe(1);
  });

  it("protects an older worker's instructions when the primary forwards a name-only rename", async () => {
    const primary = await node("Primary"), worker = await node("Worker");
    const employee = worker.runtime.store.createProfile({ name: "Editor", instructions: "Catalogue instructions" });
    await connect(primary, worker);
    await eventually(() => expect(primary.home.nodeFor("profile", employee.id)).toBe(worker.home.state.nodeId));
    await worker.runtime.api.homeLink.stop();
    worker.runtime.store.updateProfile(employee.id, { name: "Editor", instructions: "Saved on the worker" });
    const rename = primary.api("/v1/profiles/" + employee.id, "PATCH", { name: "Редактор" });
    const pending = await new Promise<WireRequest>(resolve => { const check = () => { const command = primary.home.pending(worker.home.state.nodeId)[0]; if (command) resolve(command.request); else setTimeout(check, 20); }; check(); });
    // An older worker requires the field and would otherwise save empty instructions.
    expect(JSON.parse(Buffer.from(pending.body!, "base64").toString())).toEqual({ name: "Редактор", instructions: "Catalogue instructions", keepInstructions: true });
    worker.runtime.api.homeLink.start();
    expect((await rename).status).toBe(200);
    expect(worker.runtime.store.getProfile(employee.id)).toMatchObject({ name: "Редактор", instructions: "Saved on the worker" });
  });

  it("renames the device for every client immediately without changing its identity or address", async () => {
    const host = await node("Old server");
    const before = host.home.state;
    const renamed = await host.api("/v1/home", "PATCH", { name: "  Рабочий сервер  " });
    expect(renamed.status).toBe(200);
    expect(renamed.value.home.name).toBe("Рабочий сервер");
    for (let client = 0; client < 2; client++) {
      expect((await host.api("/v1/devices")).value.devices).toContainEqual(expect.objectContaining({ id: before.nodeId, name: "Рабочий сервер" }));
    }
    expect(host.home.state).toMatchObject({ ...before, name: "Рабочий сервер" });
    expect(host.home.self().endpoint?.url).toBe(host.url);
    expect(new Home(host.runtime.store).state.name).toBe("Рабочий сервер");
    for (const name of [" ", "a".repeat(121), 42]) expect((await host.api("/v1/home", "PATCH", { name })).status).toBe(400);
    expect(host.home.state.name).toBe("Рабочий сервер");
    expect((await host.api("/health")).value.deviceRenameVersion).toBe(1);
  });

  it("replaces a container hostname once but preserves a name explicitly chosen by the owner", async () => {
    const host = await node("020bc40355c2");
    expect(new Home(host.runtime.store).state.name).toBe("Server");
    await host.api("/v1/home", "PATCH", { name: "020bc40355c2" });
    expect(new Home(host.runtime.store).state.name).toBe("020bc40355c2");
  });

  it("replaces a raw macOS network name once but preserves the same name chosen by the owner", async () => {
    const host = await node("waiMini.local");
    expect(new Home(host.runtime.store).state.name).toBe(defaultDeviceName());
    expect(defaultDeviceName()).not.toMatch(/\.local$/i);
    await host.api("/v1/home", "PATCH", { name: "waiMini.local" });
    expect(new Home(host.runtime.store).state.name).toBe("waiMini.local");
  });

  it.skipIf(process.platform !== "darwin")("names a new Mac Home after the computer name shown in macOS", () => {
    expect(defaultDeviceName()).toBe(execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim());
  });

  it("discovers Telegram conversations in the conditional catalogue without combining their histories", async () => {
    const host = await node("Telegram host");
    const read = (etag?: string) => fetch(host.url + "/v1/profiles", { headers: { authorization: "Bearer test-owner", ...(etag ? { "if-none-match": etag } : {}) } });
    const initial = await read();
    const store = host.runtime.store;
    store.linkTelegramChat({ chatId: "-123", title: "Team", allowedSenders: ["42"] });
    const group = store.connectTelegramGroup("-123");
    const changed = await read(initial.headers.get("etag")!);
    expect(changed.status).toBe(200);
    expect((await changed.json()).telegram.chats).toContainEqual(expect.objectContaining({ chatId: "-123", conversationId: group.conversationId, profileId: null }));
    const etag = changed.headers.get("etag")!;
    const inbound = store.addMessage({ conversationId: group.conversationId!, channel: "telegram", direction: "inbound", text: "Group question" });
    store.addMessage({ conversationId: group.conversationId!, channel: "telegram", direction: "outbound", text: "Specialist result", replyToId: inbound.id });
    expect((await read(etag)).status).toBe(304); // Message polling uses the existing bounded conversation endpoint.
    const timeline = await host.api("/v1/conversations/" + group.conversationId + "?page=true");
    expect(timeline.value.messages.map((m: any) => m.text)).toEqual(["Group question", "Specialist result"]);
    expect((await host.api("/v1/conversation?page=true")).value.messages).toEqual([]);
    store.linkTelegramChat({ chatId: "-123", title: "Renamed team", allowedSenders: ["42"] });
    expect((await read(etag)).status).toBe(200);
  });
  it("conditionally refreshes independent client catalogs after employee deletion without exposing data before auth", async () => {
    const host = await node("Mac mini");
    const employee = host.runtime.store.createProfile({ name: "Temporary editor", instructions: "Keep the facts." });
    const read = (etag?: string, token = "test-owner") => fetch(host.url + "/v1/profiles", { headers: { authorization: "Bearer " + token, ...(etag ? { "if-none-match": etag } : {}) } });
    const first = await read();
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect((await first.json()).profiles.map((p: any) => p.id)).toContain(employee.id);
    const unchanged = await read(etag);
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect((await read(etag, "wrong-token")).status).toBe(401);
    expect((await host.api("/v1/profiles/" + employee.id, "DELETE")).status).toBe(200);
    for (let client = 0; client < 2; client++) {
      const changed = await read(etag);
      expect(changed.status).toBe(200);
      expect(changed.headers.get("etag")).not.toBe(etag);
      expect((await changed.json()).profiles.some((p: any) => p.id === employee.id)).toBe(false);
    }
  });
  it("routes employee models to their device and keeps device defaults independent",async()=>{
    const laptop=await node("Laptop"),mini=await node("Mini");
    const models=[{id:"model",name:"Model",description:"",isDefault:true,speeds:[{id:"default",name:"Обычная",description:""},{id:"priority",name:"Fast",description:""}],provider:"chatgpt"}];
    laptop.runtime.engine.models=async()=>models; mini.runtime.engine.models=async()=>models;
    const profile=mini.runtime.store.createProfile({name:"Remote editor"});
    const chat=mini.runtime.store.profileConversation(profile.id);
    await connect(laptop,mini);
    await eventually(()=>expect(laptop.home.nodeFor("profile",profile.id)).toBe(mini.home.state.nodeId));
    const remote="/v1/settings/models?agentId="+profile.id;
    expect((await laptop.api(remote,"POST",{model:"model",serviceTier:"priority"})).status).toBe(200);
    expect(mini.runtime.store.getProfile(profile.id)?.serviceTier).toBe("priority");
    expect(laptop.runtime.store.getProfile(profile.id)).toBeNull();
    expect((await laptop.api("/v1/settings/models?deviceId="+mini.home.state.nodeId,"POST",{model:"model",serviceTier:"default"})).status).toBe(200);
    expect(mini.runtime.store.getSetting("models.defaults")).toContain("model");
    expect(laptop.runtime.store.getSetting("models.defaults")).toBeNull();
    expect((await laptop.api(remote)).value.effective).toEqual({provider:"chatgpt",model:"model",serviceTier:"priority"});
    await eventually(()=>expect(laptop.home.nodeFor("conversation",chat.id)).toBe(mini.home.state.nodeId));
    const chatPath="/v1/settings/models?conversationId="+chat.id;
    expect((await laptop.api(chatPath,"POST",{model:"model",serviceTier:"default"})).status).toBe(200);
    expect((await laptop.api(chatPath)).value).toMatchObject({selection:{model:"model",serviceTier:"default"},defaults:{model:"model",serviceTier:"priority"}});
    expect(mini.runtime.store.getProfile(profile.id)?.serviceTier).toBe("priority");
    const status=vi.spyOn(mini.runtime.accounts,"statusFor").mockResolvedValue({account:{connected:true,managed:true,provider:"chatgpt"}} as any);
    expect((await laptop.api("/v1/account?conversationId="+chat.id)).status).toBe(200);
    expect(status).toHaveBeenCalledWith(profile.id,false,chat.id);
  }, 15000);
  it("never turns a chat model change into device defaults on an older Home", async () => {
    const primary = await node("Current Home"), old = await node("Older Home");
    const profile = old.runtime.store.createProfile({name:"Legacy employee"});
    const chat = old.runtime.store.profileConversation(profile.id);
    old.runtime.engine.models = async () => [{id:"model",name:"Model",description:"",isDefault:true,provider:"chatgpt",speeds:[{id:"default",name:"Обычная",description:""}]}];
    const dispatch = (old.runtime.api.homeLink as any).dispatch.bind(old.runtime.api.homeLink);
    const requests: string[] = [];
    vi.spyOn(old.runtime.api.homeLink as any,"dispatch").mockImplementation((request: WireRequest) => {
      requests.push(request.path);
      if (request.path.startsWith("/v1/conversations/")) return Promise.resolve(wireJSON({error:"not_found"},404));
      // Build 47 knows device/employee models only and ignores conversationId.
      if (request.path.startsWith("/v1/settings/models")) request = {...request,path:"/v1/settings/models"};
      return dispatch(request);
    });
    await connect(primary,old);
    await eventually(() => expect(primary.home.nodeFor("conversation",chat.id)).toBe(old.home.state.nodeId));
    const result = await primary.api("/v1/settings/models?conversationId="+chat.id,"POST",{model:"model",serviceTier:"default"});
    expect(result.status).toBe(404);
    expect(old.runtime.store.getSetting("models.defaults")).toBeNull();
    expect(requests).toContain("/v1/conversations/"+chat.id+"/model");
  });
  it("keeps an API key on the device it is added to, with owner-only writes", async () => {
    const provider = createServer((request, response) => response.writeHead(request.headers.authorization === "Bearer xai-remote" ? 200 : 401).end("{}"));
    await new Promise<void>(done => provider.listen(0, "127.0.0.1", done));
    process.env.OPENSTRUDEL_PROVIDER_XAI_BASE_URL = `http://127.0.0.1:${(provider.address() as any).port}/v1`;
    try {
      const laptop = await node("Laptop"), mini = await node("Mini");
      await connect(laptop, mini);
      // The primary's command log, its backups and transfers never hold a key, not even while it is delivered.
      const logged: string[] = [], enqueue = laptop.home.enqueue.bind(laptop.home);
      laptop.home.enqueue = (nodeId, request, id) => { logged.push(Buffer.from(request.body ?? "", "base64").toString()); return enqueue(nodeId, request, id); };
      const stored = () => [...logged, ...laptop.home.snapshot().commands.map((c: any) => JSON.stringify(c) + Buffer.from(JSON.parse(c.request).body ?? "", "base64").toString())].join("\n");
      const remote = "/v1/providers/xai?deviceId=" + mini.home.state.nodeId;
      expect((await laptop.api(remote, "PUT", { key: "xai-remote" })).value.provider).toMatchObject({ id: "xai", connected: true, keyHint: "••••ote" });
      expect(mini.runtime.store.getSetting("providers.xai.key")).toBe("xai-remote");
      expect(laptop.runtime.store.getSetting("providers.xai.key")).toBeNull();
      expect((await laptop.api("/v1/providers?deviceId=" + mini.home.state.nodeId)).value.providers.find((p: any) => p.id === "xai").connected).toBe(true);
      expect((await laptop.api("/v1/providers")).value.providers.find((p: any) => p.id === "xai").connected).toBe(false);
      expect(logged.length).toBeGreaterThan(0);
      expect(stored()).not.toContain("xai-remote");
      // A device that stops answering gets nothing queued: the request fails and nothing waits for it.
      await mini.runtime.api.homeLink.stop();
      const late = { method: "PUT", path: "/v1/providers/xai", owner: true, contentType: "application/json", body: Buffer.from(JSON.stringify({ key: "xai-late" })).toString("base64") };
      await expect(laptop.runtime.api.homeLink.call(mini.home.state.nodeId, late, undefined, 200)).rejects.toMatchObject({ status: 503, message: "Устройство не подтвердило ключ. Проверьте, что оно на связи, и добавьте ключ ещё раз." });
      expect(laptop.home.pending(mini.home.state.nodeId)).toEqual([]);
      laptop.runtime.store.db.prepare("UPDATE home_nodes SET info=json_set(info,'$.seenAt',0) WHERE id=?").run(mini.home.state.nodeId);
      const offline = await laptop.api(remote, "PUT", { key: "xai-offline" });
      expect(offline).toEqual({ status: 503, value: { error: "Устройство не подтвердило ключ. Проверьте, что оно на связи, и добавьте ключ ещё раз." } });
      expect(laptop.home.pending(mini.home.state.nodeId)).toEqual([]);
      expect(stored()).not.toMatch(/xai-(remote|late|offline)/);
      // A primary that restarts while relaying a key has lost it, so that command is never delivered.
      laptop.home.enqueue(mini.home.state.nodeId, { method: "PUT", path: "/v1/providers/xai", owner: true });
      const restarted = new HomeLink(laptop.home, async () => wireJSON({}));
      restarted.start(); await restarted.stop();
      expect(laptop.home.pending(mini.home.state.nodeId)).toEqual([]);
      const member = await mini.runtime.api.homeLink.execute({ id: randomUUID(), request: { method: "DELETE", path: "/v1/providers/xai", owner: false } });
      expect(member.status).toBe(403);
      expect(mini.runtime.store.getSetting("providers.xai.key")).toBe("xai-remote");
    } finally { delete process.env.OPENSTRUDEL_PROVIDER_XAI_BASE_URL; provider.close(); }
  });
  it("relays a Grok sign-in only while its device answers, and never queues one", async () => {
    const laptop = await node("Laptop"), mini = await node("Mini");
    // Shipped apps show API keys on `providers: 1`; the Grok subscription has its own flag.
    expect((await laptop.api("/health")).value).toMatchObject({ providers: 1, subscriptionsVersion: 1 });
    await connect(laptop, mini);
    const started = { type: "device", loginId: "l-1", verificationUrl: "https://accounts.x.ai/device?user_code=AB-12", userCode: "AB-12" };
    (mini.runtime.accounts as any).grok = { start: async () => started, status: (loginId: string) => ({ loginId, status: "pending" }), close() {} };
    const remote = (path: string) => `/v1/providers/grok/${path}?deviceId=${mini.home.state.nodeId}`;
    expect(await laptop.api(remote("login"), "POST")).toEqual({ status: 201, value: started });
    expect(await laptop.api(remote("login/l-1"))).toEqual({ status: 200, value: { loginId: "l-1", status: "pending" } });
    const busy = "Устройство не на связи. Войдите в подписку, когда оно подключится.";
    await mini.runtime.api.homeLink.stop();
    await expect(laptop.runtime.api.homeLink.call(mini.home.state.nodeId, { method: "POST", path: "/v1/providers/grok/login", owner: true }, undefined, 200)).rejects.toMatchObject({ status: 503, message: busy });
    expect(laptop.home.pending(mini.home.state.nodeId)).toEqual([]);
    laptop.runtime.store.db.prepare("UPDATE home_nodes SET info=json_set(info,'$.seenAt',0) WHERE id=?").run(mini.home.state.nodeId);
    expect(await laptop.api(remote("logout"), "POST")).toEqual({ status: 503, value: { error: busy } });
    expect(laptop.home.pending(mini.home.state.nodeId)).toEqual([]);
    // After a restart nobody waits for a sign-in that was never delivered.
    laptop.home.enqueue(mini.home.state.nodeId, { method: "POST", path: "/v1/providers/grok/login", owner: true });
    const restarted = new HomeLink(laptop.home, async () => wireJSON({}));
    restarted.start(); await restarted.stop();
    expect(laptop.home.pending(mini.home.state.nodeId)).toEqual([]);
  });
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
    worker.runtime.store.setSetting("models.main", JSON.stringify({ provider: "anthropic", model: "claude-opus-5-5", serviceTier: "default" }));
    await connect(primary, worker);
    const saved = worker.runtime.store.listProfiles().find(p => p.name === "Помощник · Personal Mac")!;
    expect(saved.instructions).toBe("Помни мои планы");
    expect(saved).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", serviceTier: "default" });
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
