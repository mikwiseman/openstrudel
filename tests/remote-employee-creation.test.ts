import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { MockCodexEngine } from "../src/codex.js";
import { homeRequest, requestJSON, resultJSON } from "../src/home-transport.js";

const runtimes: OpenStrudelRuntime[] = [], roots: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function host(name: string) {
  const root = await mkdtemp(join(tmpdir(), "strudel-remote-create-")); roots.push(root);
  const runtime = new OpenStrudelRuntime({ rootDirectory: root, dbPath: join(root, "home.sqlite"), engine: new MockCodexEngine(), apiToken: randomUUID(), startTelegram: false, mobilePort: 0 });
  runtimes.push(runtime);
  runtime.api.home.save({ ...runtime.api.home.state, name });
  const address = await runtime.api.listen("127.0.0.1", 0);
  runtime.api.home.setEndpoint({ url: `http://127.0.0.1:${address.port}` });
  return runtime;
}

async function pairedClient(runtime: OpenStrudelRuntime) {
  const invite = new URL((await runtime.api.mobile.invite(false)).url);
  const target = { url: `https://127.0.0.1:${runtime.api.mobile.port}`, pin: invite.searchParams.get("keyPin")! };
  const { token } = resultJSON(await homeRequest(target, "/pair", invite.searchParams.get("key")!, { method: "POST" }));
  const call = (path: string, method = "GET", body?: unknown) => homeRequest(target, path, token, { method, ...(body ? { body: requestJSON(body) } : {}) });
  return { call, target };
}

describe("employees on independent connected devices", () => {
  it("lets ordinary paired users create and chat on the chosen host without account administration", async () => {
    const laptop = await host("MacBook"), mini = await host("Mac mini");
    const first = await pairedClient(mini), second = await pairedClient(mini);
    const creation = { creationId: randomUUID(), name: "Редактор на Mac mini", instructions: "Сохраняй смысл и пиши понятно.", deviceId: mini.api.home.state.nodeId };
    const created = await first.call("/v1/profiles", "POST", creation);
    expect(created.status).toBe(201);
    const profile = resultJSON(created).profile;
    expect(mini.store.getProfile(profile.id)).toMatchObject({ name: creation.name, instructions: creation.instructions });
    expect(laptop.store.listProfiles()).toHaveLength(0);
    // A retry after a lost response must not create a second employee.
    expect(resultJSON(await first.call("/v1/profiles", "POST", creation)).profile.id).toBe(profile.id);
    expect(mini.store.listProfiles()).toHaveLength(1);
    expect(resultJSON(await second.call("/v1/profiles")).profiles).toContainEqual(expect.objectContaining({ id: profile.id, deviceId: mini.api.home.state.nodeId }));
    const reply = resultJSON(await first.call("/v1/messages", "POST", { channel: "api", externalChatId: "home", profile: profile.id, text: "Проверь этот текст" }));
    expect(reply.profileId).toBe(profile.id);
    expect(reply.text).toContain("Принял задачу");
    expect(mini.store.getConversation(reply.conversationId)?.profileId).toBe(profile.id);
    expect(laptop.store.listConversations()).toHaveLength(0);
    for (const [path, method] of [["/v1/profiles/" + profile.id, "DELETE"], ["/v1/mobile/pairing", "POST"], ["/v1/accounts", "POST"], ["/v1/settings/approvals", "PUT"]]) {
      expect((await first.call(path!, method!, {})).status).toBe(403);
    }
    // The host persists the employee after its creator disconnects.
    expect((await first.call("/auth/device/logout", "POST")).status).toBe(200);
    expect((await first.call("/v1/profiles", "POST", { name: "Revoked" })).status).toBe(401);
    expect(resultJSON(await second.call("/v1/profiles")).profiles).toHaveLength(1);
    expect((await homeRequest(first.target, "/v1/profiles", "", { method: "POST", body: requestJSON({ name: "Anonymous" }) })).status).toBe(401);
  });
});
