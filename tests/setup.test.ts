import { describe, expect, it, vi } from "vitest";
import { createSetupServer } from "../src/setup.js";
import type { AddressInfo } from "node:net";

describe("server setup", () => {
  it("never grants a pairing invitation without the installation's private setup code", async () => {
    const mobile = { invite: vi.fn(async () => ({ url: "openstrudel://connect?test", expiresAt: new Date().toISOString() })) };
    const server = createSetupServer(mobile, "a".repeat(64));
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const page = await fetch(url);
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(await page.text()).not.toContain("a".repeat(64));
      expect((await fetch(url + "/pairing", { method: "POST" })).status).toBe(401);
      expect((await fetch(url + "/pairing", { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await fetch(url + "/pairing", { method: "POST", headers: { authorization: "Bearer " + "a".repeat(64), origin: "https://other.test" } })).status).toBe(403);
      expect(mobile.invite).not.toHaveBeenCalled();
      const paired = await fetch(url + "/pairing", { method: "POST", headers: { authorization: "Bearer " + "a".repeat(64), origin: url } });
      expect(paired.status).toBe(201);
      expect(mobile.invite).toHaveBeenCalledWith(true);
      expect((await paired.json()).url).toBe("openstrudel://connect?test");
      expect((await fetch(url + "/v1/profiles")).status).toBe(404);
    } finally { await new Promise<void>(done => server.close(() => done())); }
  });
  it("rejects a missing or guessable setup credential", () => {
    const mobile = { invite: vi.fn() };
    for (const secret of ["", "123456", "password", "a".repeat(32)]) {
      expect(() => createSetupServer(mobile, secret)).toThrow();
    }
  });
});
