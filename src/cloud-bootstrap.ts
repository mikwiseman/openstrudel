import { createHash, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { Store } from "./store.js";

type Payload = { installationId: string; privateKeyPEM: string; ownerTokenHash: string };
type Identity = { installationId: string; ownerTokenHash: string; publicKeySHA256: string };
type Result = { status: "created" | "already-initialized"; installationId: string; certificateSHA256: string };
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

function validate(input: unknown): Payload & { identity: Identity } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Cloud bootstrap requires a JSON object");
  const data = input as Record<string, unknown>;
  if (Object.keys(data).sort().join(",") !== "installationId,ownerTokenHash,privateKeyPEM"
      || typeof data.installationId !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(data.installationId)
      || typeof data.ownerTokenHash !== "string" || !/^[a-f0-9]{64}$/.test(data.ownerTokenHash)
      || typeof data.privateKeyPEM !== "string" || data.privateKeyPEM.length > 4096) {
    throw new Error("Invalid cloud bootstrap payload");
  }
  try {
    const key = createPrivateKey(data.privateKeyPEM);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
    const installationId = data.installationId.toLowerCase();
    return {
      installationId, ownerTokenHash: data.ownerTokenHash,
      privateKeyPEM: String(key.export({ type: "pkcs8", format: "pem" })),
      identity: { installationId, ownerTokenHash: data.ownerTokenHash,
        publicKeySHA256: digest(createPublicKey(key).export({ type: "spki", format: "der" })) },
    };
  } catch { throw new Error("Cloud bootstrap requires an unencrypted P-256 private key"); }
}

async function exists(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function installation(db: DatabaseSync): string | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get()) return undefined;
  const row = db.prepare("SELECT value FROM settings WHERE key='cloud.installationId'").get();
  return row ? String(row.value) : undefined;
}

function assertEmpty(db: DatabaseSync) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const row of tables) {
    const table = String(row.name).replaceAll('"', '""');
    if (db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get()) throw new Error("Cloud bootstrap requires an empty store; existing data was not changed");
  }
}

async function readIdentity(directory: string, expected: Identity): Promise<string> {
  try {
    for (const name of ["cloud-bootstrap.json", "private-key.pem", "certificate.pem"]) {
      if (!(await lstat(join(directory, name))).isFile()) throw new Error();
    }
    const saved = JSON.parse(await readFile(join(directory, "cloud-bootstrap.json"), "utf8")) as Identity;
    if (saved.installationId !== expected.installationId || saved.ownerTokenHash !== expected.ownerTokenHash
        || saved.publicKeySHA256 !== expected.publicKeySHA256) throw new Error();
    const certificate = new X509Certificate(await readFile(join(directory, "certificate.pem")));
    const privateKey = createPrivateKey(await readFile(join(directory, "private-key.pem")));
    if (digest(certificate.publicKey.export({ type: "spki", format: "der" })) !== expected.publicKeySHA256
        || digest(createPublicKey(privateKey).export({ type: "spki", format: "der" })) !== expected.publicKeySHA256
        || !certificate.verify(certificate.publicKey)) throw new Error();
    return certificate.fingerprint256.replaceAll(":", "").toLowerCase();
  } catch { throw new Error("Existing TLS identity does not match this cloud installation"); }
}

async function prepareIdentity(directory: string, payload: ReturnType<typeof validate>) {
  const mobile = join(directory, "mobile");
  const present = await exists(mobile);
  if (present) {
    if (!present.isDirectory()) throw new Error("Existing mobile identity is not a directory");
    return readIdentity(mobile, payload.identity);
  }
  const stage = await mkdtemp(join(directory, ".cloud-bootstrap-"));
  try {
    await writeFile(join(stage, "private-key.pem"), payload.privateKeyPEM, { mode: 0o600, flag: "wx" });
    await writeFile(join(stage, "cloud-bootstrap.json"), JSON.stringify(payload.identity), { mode: 0o600, flag: "wx" });
    try {
      await promisify(execFile)("openssl", ["req", "-new", "-x509", "-sha256", "-days", "3650",
        "-key", join(stage, "private-key.pem"), "-out", join(stage, "certificate.pem"), "-subj", "/CN=OpenStrudel"],
      { timeout: 20_000, maxBuffer: 65_536 });
    } catch { throw new Error("Could not create the cloud TLS certificate with OpenSSL"); }
    const pin = await readIdentity(stage, payload.identity);
    // The complete identity is published together. If a later database commit
    // fails, its matching receipt allows the next attempt to finish safely.
    await rename(stage, mobile);
    return pin;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

/** Seed one empty cloud Home before starting any API or Codex process. */
export async function bootstrapCloud(input: unknown, options: { rootDirectory?: string } = {}): Promise<Result> {
  const payload = validate(input);
  const root = resolve(options.rootDirectory ?? process.cwd());
  const data = join(root, ".data");
  const database = join(data, "openstrudel.sqlite");
  const existingData = await exists(data);
  if (existingData && !existingData.isDirectory()) throw new Error("Existing installation data is not a directory");
  const existingDatabase = await exists(database);
  if (existingDatabase) {
    if (!existingDatabase.isFile()) throw new Error("Existing installation database is not a regular file");
    // Inspect first: constructing Store runs migrations, which must never run
    // against an unrelated installation merely because bootstrap was replayed.
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const id = installation(db);
      if (id) {
        if (id !== payload.installationId) throw new Error("This volume belongs to a different cloud installation");
        return { status: "already-initialized", installationId: id,
          certificateSHA256: await readIdentity(join(data, "mobile"), payload.identity) };
      }
      assertEmpty(db);
    } finally { db.close(); }
  }
  if ((await readdir(root)).some(name => name !== ".data")
      || (existingData && (await readdir(data)).some(name => !["openstrudel.sqlite", "openstrudel.sqlite-wal", "openstrudel.sqlite-shm", "mobile"].includes(name) && !name.startsWith(".cloud-bootstrap-")))) {
    throw new Error("Cloud bootstrap refuses an existing filesystem; use an empty data volume");
  }
  if (await exists(join(data, "mobile"))) await readIdentity(join(data, "mobile"), payload.identity);
  await mkdir(data, { recursive: true, mode: 0o700 });
  const store = new Store(database);
  let transaction = false;
  try {
    store.db.exec("BEGIN IMMEDIATE"); transaction = true;
    if (installation(store.db)) throw new Error("Cloud installation was initialized concurrently; retry this bootstrap");
    assertEmpty(store.db);
    const certificateSHA256 = await prepareIdentity(data, payload);
    store.setSetting("mobile.tokens", JSON.stringify([payload.ownerTokenHash]));
    store.setSetting("mobile.owners", JSON.stringify([payload.ownerTokenHash]));
    store.setSetting("cloud.installationId", payload.installationId);
    store.db.exec("COMMIT"); transaction = false;
    return { status: "created", installationId: payload.installationId, certificateSHA256 };
  } finally {
    if (transaction) store.db.exec("ROLLBACK");
    store.close();
  }
}

export async function readCloudBootstrapInput(stream: AsyncIterable<Buffer | string>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const part of stream) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    length += chunk.length;
    if (length > 16_384) throw new Error("Cloud bootstrap input is too large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Cloud bootstrap requires JSON on stdin"); }
}
