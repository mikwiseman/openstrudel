import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { MockCodexEngine } from "../src/codex.js";

it("requires a Home invitation, protects cookie mutations with CSRF, and revokes sessions individually", async () => {
  const root = mkdtempSync(join(tmpdir(), "strudel-web-"));
  const runtime = new OpenStrudelRuntime({ rootDirectory: root, dbPath: ":memory:", apiToken: "test-owner", engine: new MockCodexEngine(), startTelegram: false });
  const address = await runtime.api.listen("127.0.0.1", 0), base = `http://127.0.0.1:${address.port}`;
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    expect((await call("/v1/profiles")).status).toBe(401);
    const page = await (await call("/")).text(); expect(page).not.toContain("test-owner"); expect(page).toContain('nonce="');
    const invite = runtime.api.web.invite(true);
    expect((await call("/auth/session", "POST", { key: invite.key }, { origin: "https://elsewhere.invalid" })).status).toBe(403);
    const login = await call("/auth/session", "POST", { key: invite.key }); expect(login.status).toBe(200);
    const csrf = (await login.json()).csrf, cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect(login.headers.get("set-cookie")).toContain("HttpOnly"); expect(login.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect((await call("/auth/session", "POST", { key: invite.key })).status).toBe(401);
    expect((await call("/v1/profiles", "POST", { name: "Unauthorized" }, { cookie })).status).toBe(403);
    expect((await call("/v1/profiles", "POST", { name: "Allowed" }, { cookie, "x-openstrudel-csrf": csrf })).status).toBe(201);
    expect((await call("/v1/profiles", "GET", undefined, { cookie, "sec-fetch-site": "cross-site" })).status).toBe(401);
    const other = runtime.api.web.invite(false);
    const readOnly = await call("/auth/session", "POST", { key: other.key }); const access = await readOnly.json();
    const secondCookie = readOnly.headers.get("set-cookie")!.split(";")[0]!;
    expect((await call("/v1/devices", "GET", undefined, { cookie: secondCookie })).status).toBe(200);
    const command = runtime.api.home.enqueue(runtime.api.home.state.nodeId, { method: "POST", path: "/v1/accounts", owner: true, body: Buffer.from('{}').toString('base64') });
    expect((await call("/v1/home/requests/" + command, "GET", undefined, { cookie: secondCookie })).status).toBe(403);
    expect((await call("/v1/home/requests/" + command, "GET", undefined, { cookie })).status).toBe(200);
    expect((await call("/v1/devices/invitation", "POST", {}, { cookie: secondCookie, "x-openstrudel-csrf": access.csrf })).status).toBe(403);
    for (const action of ["preview","install","mcp","mcp/remove","change"]) {
      expect((await call("/v1/extensions/"+action,"POST",{},{cookie:secondCookie,"x-openstrudel-csrf":access.csrf})).status).toBe(403);
    }
    for (const [path, method, body] of [["", "POST", {token:"synthetic"}], ["/link", "POST", {}], ["/chats/-100", "PATCH", {profileId:null}], ["", "DELETE", {}]] as const) {
      expect((await call("/v1/integrations/telegram" + path, method, body, { cookie: secondCookie, "x-openstrudel-csrf": access.csrf })).status).toBe(403);
    }
    const sessions = runtime.api.web.list(); expect(sessions).toHaveLength(2);
    runtime.api.web.revoke(sessions.find(s => !s.owner)!.id);
    expect((await call("/v1/profiles", "GET", undefined, { cookie: secondCookie })).status).toBe(401);
    expect((await call("/v1/profiles", "GET", undefined, { cookie })).status).toBe(200);
    expect((await call("/auth/logout", "POST", {}, { cookie, "x-openstrudel-csrf": csrf })).status).toBe(200);
    expect((await call("/v1/profiles", "GET", undefined, { cookie })).status).toBe(401);
  } finally { await runtime.stop(); rmSync(root, { recursive: true, force: true }); }
});
