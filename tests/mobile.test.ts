import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { MobileAccess } from "../src/mobile.js";

function call(port: number, path: string, token?: string, origin?: string) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: path === "/pair" ? "POST" : "GET", rejectUnauthorized: false,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) },
    }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
    });
    req.on("error", reject); req.end();
  });
}

describe("iPhone pairing", () => {
  it("issues owner access only from an owner invitation and retains ordinary clients as clients", async () => {
    const directory=await mkdtemp(join(tmpdir(),"strudel-owner-"));const store=new Store(":memory:");
    const mobile=new MobileAccess(store,(_req,res,owner)=>res.end(JSON.stringify({owner})),{directory,port:0,host:"127.0.0.1"});
    try {
      const ownerInvite=new URL((await mobile.invite(true)).url);
      const owner=await call(mobile.port!,"/pair",ownerInvite.searchParams.get("key")!);
      expect((await call(mobile.port!,"/v1/mobile",owner.body.token)).body.owner).toBe(true);
      const phoneInvite=new URL((await mobile.invite()).url);
      const phone=await call(mobile.port!,"/pair",phoneInvite.searchParams.get("key")!);
      expect((await call(mobile.port!,"/v1/mobile",phone.body.token)).status).toBe(403);
      expect(store.getSetting("mobile.owners")).not.toContain(owner.body.token);
    } finally {await mobile.close();store.close();await rm(directory,{recursive:true,force:true});}
  });
  it("advertises a public endpoint while keeping the private listener separate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "strudel-public-"));
    const store = new Store(":memory:");
    const mobile = new MobileAccess(store, (_req, res) => res.end("{}"), {directory,port:0,host:"127.0.0.1",hostname:"8.8.8.8",advertisedPort:17789});
    try {
      const invitation = new URL((await mobile.invite()).url);
      expect(invitation.searchParams.get("host")).toBe("8.8.8.8");
      expect(invitation.searchParams.get("port")).toBe("17789");
      expect(mobile.port).not.toBe(17789);
    } finally { await mobile.close(); store.close(); await rm(directory,{recursive:true,force:true}); }
  });
  it.skipIf(process.platform !== "darwin")("negotiates TLS 1.3 with Apple's client and the launch agent's system OpenSSL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "strudel-tls-"));
    const store = new Store(":memory:");
    const mobile = new MobileAccess(store, (_req, res) => res.end("{}"), { directory, port: 0, host: "127.0.0.1" });
    vi.stubEnv("PATH", "/usr/bin:/bin");
    try {
      await mobile.invite();
      const result = await promisify(execFile)("/usr/bin/curl", ["-ksSv", "--max-time", "10", `https://127.0.0.1:${mobile.port}/health`]);
      expect(JSON.parse(result.stdout).error).toContain("Подключите iPhone");
      expect(result.stderr).toContain("SSL connection using TLSv1.3");
    } finally { vi.unstubAllEnvs(); await mobile.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it("requires a one-use invitation, persists only token hashes, and revokes access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "strudel-mobile-"));
    const store = new Store(":memory:");
    const mobile = new MobileAccess(store, (_req, res) => res.end(JSON.stringify({ ok: true })), { directory, port: 0, host: "127.0.0.1", hostname: "test.local" });
    try {
      const invite = await mobile.invite();
      const url = new URL(invite.url);
      const port = Number(url.searchParams.get("port"));
      const key = url.searchParams.get("key")!;
      expect(url.searchParams.get("pin")).toMatch(/^[a-f0-9]{64}$/);
      expect((await call(port, "/health")).status).toBe(401);
      expect((await call(port, "/pair", "wrong")).status).toBe(401);
      expect((await call(port, "/pair", key, "https://evil.test")).status).toBe(403);
      const paired = await call(port, "/pair", key);
      expect(paired.status).toBe(200);
      expect((await call(port, "/pair", key)).status).toBe(401);
      expect((await call(port, "/health", paired.body.token)).body.ok).toBe(true);
      expect(store.getSetting("mobile.tokens")).not.toContain(paired.body.token);
      expect(mobile.status().connections).toBe(1);
      await mobile.close();
      await mobile.restore();
      expect((await call(mobile.port!, "/health", paired.body.token)).status).toBe(200);
      await mobile.revoke();
      expect(mobile.status().connections).toBe(0);
      const next = new URL((await mobile.invite()).url);
      expect((await call(Number(next.searchParams.get("port")), "/health", paired.body.token)).status).toBe(401);
    } finally { await mobile.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("expires invitations and invalidates a previous QR when a new one is created", async () => {
    const directory = await mkdtemp(join(tmpdir(), "strudel-mobile-"));
    const store = new Store(":memory:");
    let now = Date.now();
    const mobile = new MobileAccess(store, (_req, res) => res.end("{}"), { directory, port: 0, host: "127.0.0.1", hostname: "test.local", now: () => now });
    try {
      const first = new URL((await mobile.invite()).url);
      const second = new URL((await mobile.invite()).url);
      const port = Number(second.searchParams.get("port"));
      expect((await call(port, "/pair", first.searchParams.get("key")!)).status).toBe(401);
      now += 301_000;
      expect((await call(port, "/pair", second.searchParams.get("key")!)).status).toBe(401);
    } finally { await mobile.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
