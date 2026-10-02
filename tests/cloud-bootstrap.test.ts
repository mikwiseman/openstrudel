import { afterEach, describe, expect, it } from "vitest";
import { createHash, createPublicKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrapCloud, readCloudBootstrapInput } from "../src/cloud-bootstrap.js";
import { Store } from "../src/store.js";
import { MobileAccess } from "../src/mobile.js";

const installationId = "438425ea-61bb-4ac0-bb4e-1b556bf05bba";
const privateKeyPEM = generateKeyPairSync("ec", {
  namedCurve: "prime256v1", privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const ownerTokenHash = createHash("sha256").update("test-owner-token-never-written-to-disk").digest("hex");
const payload = { installationId, privateKeyPEM, ownerTokenHash };
const roots: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), "strudel-cloud-bootstrap-")); roots.push(path); return path; }
function store(root: string) { return new Store(join(root, ".data/openstrudel.sqlite")); }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("cloud owner bootstrap", () => {
  it("bounds stdin and redacts malformed JSON errors", async () => {
    async function* chunks(value: string) { yield value; }
    await expect(readCloudBootstrapInput(chunks("sensitive-invalid-content"))).rejects.toThrow("requires JSON on stdin");
    await expect(readCloudBootstrapInput(chunks(" ".repeat(16_385)))).rejects.toThrow("too large");
    await expect(readCloudBootstrapInput(chunks(JSON.stringify(payload)))).resolves.toEqual(payload);
  });
  it("creates the known TLS identity and stores only the owner token hash", async () => {
    const root = await directory();
    const result = await bootstrapCloud(payload, { rootDirectory: root });
    expect(result.status).toBe("created");
    const certificate = new X509Certificate(await readFile(join(root, ".data/mobile/certificate.pem")));
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.publicKey.export({ type: "spki", format: "der" })).toEqual(createPublicKey(privateKeyPEM).export({ type: "spki", format: "der" }));
    expect(result.certificateSHA256).toBe(certificate.fingerprint256.replaceAll(":", "").toLowerCase());
    expect((await stat(join(root, ".data/mobile/private-key.pem"))).mode & 0o777).toBe(0o600);
    const db = store(root);
    try {
      expect(db.getSetting("cloud.installationId")).toBe(installationId);
      expect(JSON.parse(db.getSetting("mobile.tokens")!)).toEqual([ownerTokenHash]);
      expect(JSON.parse(db.getSetting("mobile.owners")!)).toEqual([ownerTokenHash]);
      expect(JSON.stringify(db.db.prepare("SELECT * FROM settings").all())).not.toContain(privateKeyPEM);
      expect(db.listConversations()).toEqual([]);
    } finally { db.close(); }
  });

  it("repeats without replacing the certificate, settings or existing conversations", async () => {
    const root = await directory();
    await bootstrapCloud(payload, { rootDirectory: root });
    const before = await readFile(join(root, ".data/mobile/certificate.pem"), "utf8");
    const db = store(root);
    try { db.primaryConversation(); db.setSetting("keep", "owner setting"); } finally { db.close(); }
    expect((await bootstrapCloud(payload, { rootDirectory: root })).status).toBe("already-initialized");
    expect(await readFile(join(root, ".data/mobile/certificate.pem"), "utf8")).toBe(before);
    const restored = store(root);
    try { expect(restored.getSetting("keep")).toBe("owner setting"); expect(restored.listConversations()).toHaveLength(1); }
    finally { restored.close(); }
  });

  it("never restores owner access after revoke, even when bootstrap is replayed", async () => {
    const root = await directory();
    await bootstrapCloud(payload, { rootDirectory: root });
    const db = store(root);
    const mobile = new MobileAccess(db, (_req, res) => res.end("{}"), { directory: join(root, ".data/mobile"), host: "127.0.0.1", port: 0 });
    try { await mobile.revoke(); expect(db.getSetting("cloud.installationId")).toBe(installationId); }
    finally { db.close(); }
    expect((await bootstrapCloud(payload, { rootDirectory: root })).status).toBe("already-initialized");
    const restored = store(root);
    try { expect(restored.getSetting("mobile.tokens")).toBeNull(); expect(restored.getSetting("mobile.owners")).toBeNull(); }
    finally { restored.close(); }
  });

  it("rejects a different installation or credential without changing the first owner", async () => {
    const root = await directory();
    await bootstrapCloud(payload, { rootDirectory: root });
    for (const changed of [{ installationId: "ab88da08-cf55-4d3f-a8cf-75813b32cbf7" }, { ownerTokenHash: "f".repeat(64) }]) {
      await expect(bootstrapCloud({ ...payload, ...changed }, { rootDirectory: root })).rejects.toThrow(/existing|match|installation/i);
    }
    const db = store(root);
    try { expect(db.getSetting("mobile.owners")).toBe(JSON.stringify([ownerTokenHash])); }
    finally { db.close(); }
  });

  it.each(["settings", "conversations", "other-table"])("refuses nonempty existing %s", async kind => {
    const root = await directory();
    const db = store(root);
    try {
      if (kind === "settings") db.setSetting("personal-data", "keep me");
      else if (kind === "conversations") db.primaryConversation();
      else db.db.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep me')");
    } finally { db.close(); }
    await expect(bootstrapCloud(payload, { rootDirectory: root })).rejects.toThrow(/empty|existing/i);
    await expect(stat(join(root, ".data/mobile"))).rejects.toThrow();
  });

  it("does not claim an existing filesystem or overwrite an unowned TLS identity", async () => {
    const root = await directory();
    await mkdir(join(root, ".data/mobile"), { recursive: true });
    await writeFile(join(root, ".data/mobile/private-key.pem"), "keep-existing-key");
    await expect(bootstrapCloud(payload, { rootDirectory: root })).rejects.toThrow(/existing|identity|bootstrap/i);
    expect(await readFile(join(root, ".data/mobile/private-key.pem"), "utf8")).toBe("keep-existing-key");
  });

  it("recovers a matching identity after the database commit failed", async () => {
    const root = await directory();
    const db = store(root);
    db.db.exec("CREATE TRIGGER fail_bootstrap BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'test commit failure'); END;");
    db.close();
    await expect(bootstrapCloud(payload, { rootDirectory: root })).rejects.toThrow();
    const before = await readFile(join(root, ".data/mobile/certificate.pem"), "utf8");
    const retry = store(root);
    try { expect(retry.getSetting("cloud.installationId")).toBeNull(); retry.db.exec("DROP TRIGGER fail_bootstrap"); }
    finally { retry.close(); }
    expect((await bootstrapCloud(payload, { rootDirectory: root })).status).toBe("created");
    expect(await readFile(join(root, ".data/mobile/certificate.pem"), "utf8")).toBe(before);
  });

  it.each([
    null, {}, { ...payload, installationId: "not-a-uuid" }, { ...payload, ownerTokenHash: "short" },
    { ...payload, privateKeyPEM: "not-a-private-key" }, { ...payload, extra: "unrecognized" },
    { ...payload, privateKeyPEM: generateKeyPairSync("ec", { namedCurve: "secp384r1", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey },
  ])("rejects malformed payload without creating an installation", async invalid => {
    const root = await directory();
    await expect(bootstrapCloud(invalid, { rootDirectory: root })).rejects.toThrow();
    await expect(stat(join(root, ".data"))).rejects.toThrow();
  });
});
