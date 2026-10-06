import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:https";
import { X509Certificate, randomUUID } from "node:crypto";
import { Store } from "../src/store.js";
import { Home, encryptBackup } from "../src/home.js";
import { HomeLink } from "../src/home-link.js";
import { homeRequest, publicKeyPin, requestJSON, wireJSON } from "../src/home-transport.js";
import { validateSnapshot } from "../src/home-snapshot.js";

const stores: Store[] = [];
const fixture = () => { const store = new Store(":memory:"); stores.push(store); return new Home(store); };
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe("Home recovery boundaries", () => {
  it("replays a lost pairing response only to the same invitation and node", () => {
    const home = fixture(), worker = fixture(), invite = home.invite({ url: "http://127.0.0.1:7788" });
    const first = home.pair(invite.key, worker.self());
    expect(home.pair(invite.key, worker.self())).toEqual(first);
    expect(() => home.pair(invite.key, { ...worker.self(), id: randomUUID() })).toThrow("истекло");
    expect(() => home.pair(invite.key, { ...worker.self(), name: "Replacement" })).toThrow("истекло");
    expect(home.nodes()).toHaveLength(2);
  });
  it("recovers an executor using an explicit invitation for its existing identity", () => {
    const home = fixture(), worker = fixture();
    const initial = home.invite({ url: "http://127.0.0.1:7788" });
    const link = home.pair(initial.key, worker.self()); worker.join({ ...initial.endpoint, ...link });
    const replacement = home.invite(initial.endpoint, worker.state.nodeId);
    const next = home.pair(replacement.key, worker.self());
    worker.join({ ...initial.endpoint, ...next, epoch: next.epoch + 1 });
    expect(home.authorize(link.token)).toBeUndefined(); expect(home.authorize(next.token)).toBe(worker.state.nodeId);
    expect(worker.state.role).toBe("executor"); expect(home.nodes()).toHaveLength(2);
  });
  it("cancels a preparation interrupted before retirement", async () => {
    const home = fixture(), id = randomUUID();
    home.saveOperation({ id, phase: "preparing", token: "private", proof: "private" }); home.store.setSetting("home.transfer", id);
    const link = new HomeLink(home, async () => wireJSON({}));
    link.start();
    expect(home.operation(id).phase).toBe("canceled"); expect(home.state.role).toBe("primary");
    expect(home.store.getSetting("home.transfer")).toBeNull(); expect(JSON.stringify(link.publicTransfer(home.operation(id)))).not.toContain("private");
    await link.stop();
  });
  it("does not mutate a clean target for a malformed encrypted snapshot", () => {
    const source = fixture(), target = fixture(), before = target.state;
    const broken = source.snapshot(); broken.access.push({ key: "api.local_token", value: "unexpected" });
    expect(() => validateSnapshot(broken)).toThrow();
    const link = new HomeLink(target, async () => wireJSON({}));
    expect(() => link.restore(encryptBackup(broken, "long backup password"), "long backup password", true)).toThrow();
    expect(target.state).toEqual(before);
  });
  it("clears delivered request content and expires the short response cache without allowing a duplicate action", () => {
    const home = fixture(), request = { method: "POST", path: "/v1/messages?async=true", owner: true, body: requestJSON({ text: "private-message" }) };
    const id = home.enqueue(home.state.nodeId, request);
    home.finish(home.state.nodeId, id, wireJSON({ reply: "private-reply" }));
    expect(home.command(id)!.request).not.toContain(request.body);
    home.store.db.prepare("UPDATE home_commands SET finished_at=? WHERE id=?").run(Date.now() - 600_000, id); home.prune();
    expect(JSON.parse(home.command(id)!.response).status).toBe(410);
    expect(home.enqueue(home.state.nodeId, request, id)).toBe(id); expect(home.pending()).toHaveLength(0);
    expect(() => home.enqueue(home.state.nodeId, { ...request, body: requestJSON({ text: "changed" }) }, id)).toThrow("уже использован");
  });
});

it("checks the TLS key before credentials, accepts renewal with the same key, and refuses redirects", async () => {
  const root = mkdtempSync(join(tmpdir(), "strudel-key-test-"));
  const key = join(root, "key.pem"), certPath = join(root, "cert.pem"), renewed = join(root, "renewed.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", key, "-out", certPath], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-x509", "-new", "-key", key, "-days", "2", "-subj", "/CN=localhost", "-out", renewed], { stdio: "ignore" });
  const pin = publicKeyPin(new X509Certificate(readFileSync(certPath))), seen: string[] = [];
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certPath) }, (req, res) => {
    seen.push(req.headers.authorization ?? "");
    if (req.url === "/redirect") { res.writeHead(302, { location: "https://untrusted.invalid/" }).end(); return; }
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `https://127.0.0.1:${(server.address() as any).port}`;
  try {
    await expect(homeRequest({ url, pin: "0".repeat(64) }, "/", "must-not-leak")).rejects.toThrow("подтвердить устройство");
    expect(seen).toEqual([]);
    expect((await homeRequest({ url, pin }, "/", "owner")).status).toBe(200);
    server.setSecureContext({ key: readFileSync(key), cert: readFileSync(renewed) });
    expect((await homeRequest({ url, pin }, "/", "owner")).status).toBe(200);
    expect((await homeRequest({ url, pin }, "/redirect", "owner")).status).toBe(302);
    expect(seen).toEqual(["Bearer owner", "Bearer owner", "Bearer owner"]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
