import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/server-setup.sh");
const roots: string[] = [];
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "strudel-server-setup-")); roots.push(root);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/docker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const privateKeyPEM = generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  const payload = { installationId: "438425ea-61bb-4ac0-bb4e-1b556bf05bba", host: "server.example.com", privateKeyPEM, ownerTokenHash: "a".repeat(64), releaseHash: "b".repeat(64), installer: Buffer.from("#!/usr/bin/env bash\ntrue\n").toString("base64") };
  return { root, payload };
}
function shell(root: string, action: string, payload?: unknown) {
  return spawnSync("bash", ["-c", `source ${quote(script)}\nexport PATH=${quote(join(root, "bin"))}:$PATH\nSETUP_STATE_DIR=${quote(join(root, "state"))}\nSETUP_INSTALL_ROOT=${quote(join(root, "home"))}\n${action}`], { encoding: "utf8", input: payload === undefined ? undefined : JSON.stringify(payload), timeout: 15_000 });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Server setup over SSH", () => {
  it("stages the same identity idempotently without logging credentials", () => {
    const { root, payload } = fixture();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = shell(root, "stage_setup", payload);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout + result.stderr).not.toContain(payload.privateKeyPEM);
      expect(result.stdout + result.stderr).not.toContain(payload.ownerTokenHash);
    }
    expect(readFileSync(join(root, "state/installation-id"), "utf8").trim()).toBe(payload.installationId);
    expect(JSON.parse(readFileSync(join(root, "state/bootstrap.json"), "utf8")).privateKeyPEM).toBe(payload.privateKeyPEM);
    expect(readFileSync(join(root, "state/connection-host"), "utf8")).toBe(payload.host);
    // A recipe saved before the file was pinned keeps the installer's alias.
    expect(existsSync(join(root, "state/release.file"))).toBe(false);
  });
  it("stages the pinned versioned release file with its hash", () => {
    const { root, payload } = fixture();
    const pinned = { ...payload, releaseFile: "OpenStrudel-Home-1.0-59.tar.gz" };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = shell(root, "stage_setup", pinned);
      expect(result.status, result.stderr).toBe(0);
    }
    expect(readFileSync(join(root, "state/release.file"), "utf8")).toBe(pinned.releaseFile);
    expect(readFileSync(join(root, "state/release.sha256"), "utf8")).toBe(pinned.releaseHash);
    expect(shell(root, "stage_setup", { ...pinned, releaseFile: "OpenStrudel-Home-1.0-60.tar.gz" }).status).not.toBe(0);
    expect(readFileSync(join(root, "state/release.file"), "utf8")).toBe(pinned.releaseFile);
  });
  it.each(["../OpenStrudel-Home-1.0-59.tar.gz", "OpenStrudel-Home-1.0-59.tar.gz\nx", "OpenStrudel-Home-1.0.tar.gz", "https://other.example/OpenStrudel-Home-1.0-59.tar.gz", "", 59])("rejects an unsafe release file %j before creating state", releaseFile => {
    const { root, payload } = fixture();
    expect(shell(root, "stage_setup", { ...payload, releaseFile }).status).not.toBe(0);
    expect(existsSync(join(root, "state"))).toBe(false);
  });
  it("refuses a different installation or changed recipe before overwriting data", () => {
    const { root, payload } = fixture();
    expect(shell(root, "stage_setup", payload).status).toBe(0);
    const original = readFileSync(join(root, "state/bootstrap.json"));
    for (const changed of [{ ...payload, installationId: "238425ea-61bb-4ac0-bb4e-1b556bf05bba" }, { ...payload, ownerTokenHash: "c".repeat(64) }, { ...payload, releaseHash: "c".repeat(64) }]) {
      expect(shell(root, "stage_setup", changed).status).not.toBe(0);
      expect(readFileSync(join(root, "state/bootstrap.json"))).toEqual(original);
    }
  });
  it.each([undefined, "OpenStrudel-Home-1.0-59.tar.gz"])("updates a failed, not-yet-installed release pinned to %j without changing its owner or identity", releaseFile => {
    const { root, payload } = fixture();
    expect(shell(root, "stage_setup", { ...payload, releaseFile }).status).toBe(0);
    writeFileSync(join(root, "bin/systemctl"), "#!/bin/sh\nprintf 'failed\\n'\n", { mode: 0o700 });
    const original = readFileSync(join(root, "state/bootstrap.json"));
    const retry = { ...payload, previousReleaseHash: payload.releaseHash, releaseHash: "c".repeat(64), releaseFile: "OpenStrudel-Home-1.0-60.tar.gz", installer: Buffer.from("#!/usr/bin/env bash\necho updated\n").toString("base64") };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = shell(root, "stage_setup", retry);
      expect(result.status, result.stderr).toBe(0);
    }
    expect(readFileSync(join(root, "state/release.sha256"), "utf8")).toBe(retry.releaseHash);
    expect(readFileSync(join(root, "state/release.file"), "utf8")).toBe(retry.releaseFile);
    expect(readFileSync(join(root, "state/bootstrap.json"))).toEqual(original);
    expect(readFileSync(join(root, "state/installation-id"), "utf8").trim()).toBe(payload.installationId);
  });
  it.each(["running", "installed", "completed", "wrong-owner", "wrong-release"])("does not replace a %s installation while updating a failed release", kind => {
    const { root, payload } = fixture();
    const pinned = { ...payload, releaseFile: "OpenStrudel-Home-1.0-59.tar.gz" };
    expect(shell(root, "stage_setup", pinned).status).toBe(0);
    writeFileSync(join(root, "bin/systemctl"), `#!/bin/sh\nprintf '${kind === "running" ? "activating" : "failed"}\\n'\n`, { mode: 0o700 });
    if (kind === "installed") mkdirSync(join(root, "home"));
    if (kind === "completed") writeFileSync(join(root, "state/complete"), "complete");
    const retry = { ...pinned, previousReleaseHash: kind === "wrong-release" ? "d".repeat(64) : payload.releaseHash, releaseHash: "c".repeat(64), releaseFile: "OpenStrudel-Home-1.0-60.tar.gz", ownerTokenHash: kind === "wrong-owner" ? "e".repeat(64) : payload.ownerTokenHash };
    expect(shell(root, "stage_setup", retry).status).not.toBe(0);
    expect(readFileSync(join(root, "state/release.sha256"), "utf8")).toBe(payload.releaseHash);
    expect(readFileSync(join(root, "state/release.file"), "utf8")).toBe(pinned.releaseFile);
  }, 30_000); // Two external staging commands, each with its own 15-second process deadline.
  it("lets a failed retry replace only the installer bundled with a newer app for the same release", () => {
    const { root, payload } = fixture();
    expect(shell(root, "stage_setup", payload).status).toBe(0);
    writeFileSync(join(root, "bin/systemctl"), "#!/bin/sh\nprintf 'failed\\n'\n", { mode: 0o700 });
    const original = readFileSync(join(root, "state/bootstrap.json"));
    const installer = "#!/usr/bin/env bash\necho newer\n";
    // The app sends no previous release when only its bundled installer changed.
    const retry = { ...payload, installer: Buffer.from(installer).toString("base64") };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = shell(root, "stage_setup", retry);
      expect(result.status, result.stderr).toBe(0);
    }
    expect(readFileSync(join(root, "state/install.sh"), "utf8")).toBe(installer);
    expect(readFileSync(join(root, "state/release.sha256"), "utf8")).toBe(payload.releaseHash);
    expect(readFileSync(join(root, "state/bootstrap.json"))).toEqual(original);
    expect(readFileSync(join(root, "state/connection-host"), "utf8")).toBe(payload.host);
    expect(readFileSync(join(root, "state/installation-id"), "utf8").trim()).toBe(payload.installationId);
  });
  it.each(["running", "installed", "completed", "wrong-owner", "wrong-host", "other-installation", "symlink"])("keeps a %s installation when only the bundled installer changed", kind => {
    const { root, payload } = fixture();
    expect(shell(root, "stage_setup", payload).status).toBe(0);
    writeFileSync(join(root, "bin/systemctl"), `#!/bin/sh\nprintf '${kind === "running" ? "activating" : "failed"}\\n'\n`, { mode: 0o700 });
    if (kind === "installed") mkdirSync(join(root, "home"));
    if (kind === "completed") writeFileSync(join(root, "state/complete"), "complete");
    const elsewhere = join(root, "elsewhere.sh");
    if (kind === "symlink") {
      writeFileSync(elsewhere, "#!/usr/bin/env bash\nkeep\n");
      rmSync(join(root, "state/install.sh")); symlinkSync(elsewhere, join(root, "state/install.sh"));
    }
    const retry = { ...payload, installer: Buffer.from("#!/usr/bin/env bash\necho newer\n").toString("base64"),
      ownerTokenHash: kind === "wrong-owner" ? "e".repeat(64) : payload.ownerTokenHash,
      host: kind === "wrong-host" ? "other.example.com" : payload.host,
      installationId: kind === "other-installation" ? "238425ea-61bb-4ac0-bb4e-1b556bf05bba" : payload.installationId };
    const result = shell(root, "stage_setup", retry);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENSTRUDEL_EXISTING");
    if (kind === "symlink") expect(readFileSync(elsewhere, "utf8")).toBe("#!/usr/bin/env bash\nkeep\n");
    else expect(readFileSync(join(root, "state/install.sh"), "utf8")).toBe("#!/usr/bin/env bash\ntrue\n");
    expect(readFileSync(join(root, "state/connection-host"), "utf8")).toBe(payload.host);
  });
  it("preserves an unrelated installation and does not adopt a public staging directory", () => {
    const { root, payload } = fixture();
    mkdirSync(join(root, "home")); writeFileSync(join(root, "home/user-data"), "keep");
    expect(shell(root, "stage_setup", payload).status).not.toBe(0);
    expect(readFileSync(join(root, "home/user-data"), "utf8")).toBe("keep");
    expect(existsSync(join(root, "state/installation-id"))).toBe(false);
    rmSync(join(root, "home"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true }); chmodSync(join(root, "state"), 0o755);
    expect(shell(root, "stage_setup", payload).status).not.toBe(0);
  });
  it("refuses a server with other containers before staging or changing the host", () => {
    const { root, payload } = fixture();
    writeFileSync(join(root, "bin/docker"), "#!/bin/sh\nprintf 'existing-user-container\\n'\n", { mode: 0o700 });
    const result = shell(root, `export PATH=${quote(join(root, "bin"))}:$PATH\nstage_setup`, payload);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENSTRUDEL_SHARED");
    expect(existsSync(join(root, "state/installation-id"))).toBe(false);
  });
  it("resumes an interrupted atomic staging write only inside its own private directory", () => {
    const { root, payload } = fixture();
    mkdirSync(join(root, "state"), { mode: 0o700 });
    writeFileSync(join(root, "state/installation-id"), payload.installationId + "\n");
    writeFileSync(join(root, "state/.bootstrap.json.new"), "interrupted");
    expect(shell(root, "stage_setup", payload).status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "state/bootstrap.json"), "utf8")).installationId).toBe(payload.installationId);
  });
  it("replays after interruption before the identity marker, without adopting unidentified data", () => {
    const { root, payload } = fixture();
    mkdirSync(join(root, "state"), { mode: 0o700 });
    writeFileSync(join(root, "state/setup.lock"), "", { mode: 0o600 });
    expect(shell(root, "stage_setup", payload).status).toBe(0);
    expect(readFileSync(join(root, "state/installation-id"), "utf8").trim()).toBe(payload.installationId);

    const other = fixture();
    mkdirSync(join(other.root, "state"), { mode: 0o700 });
    const unidentified = "unidentified-existing-recipe";
    writeFileSync(join(other.root, "state/bootstrap.json"), unidentified);
    expect(shell(other.root, "stage_setup", other.payload).status).not.toBe(0);
    expect(readFileSync(join(other.root, "state/bootstrap.json"), "utf8")).toBe(unidentified);
    expect(existsSync(join(other.root, "state/installation-id"))).toBe(false);
  });
  it("recovers after the process stops partway through writing its identity", () => {
    const { root, payload } = fixture();
    const hook = join(root, "fault"); mkdirSync(hook);
    writeFileSync(join(hook, "sitecustomize.py"), `import os
original = os.fdopen
class InterruptedWriter:
    def __init__(self, out): self.out = out
    def __enter__(self): return self
    def __exit__(self, *args): self.out.close()
    def write(self, text):
        self.out.write(text[:8]); self.out.flush(); os._exit(77)
def fdopen(fd, mode="r", *args, **kwargs):
    out = original(fd, mode, *args, **kwargs)
    return InterruptedWriter(out) if mode == "w" else out
os.fdopen = fdopen
`);
    const interrupted = shell(root, `export PYTHONPATH=${quote(hook)}\nstage_setup`, payload);
    expect(interrupted.status).toBe(77);
    expect(existsSync(join(root, "state/installation-id"))).toBe(false);
    const replay = shell(root, "stage_setup", payload);
    expect(replay.status, replay.stderr).toBe(0);
    expect(readFileSync(join(root, "state/installation-id"), "utf8").trim()).toBe(payload.installationId);
    expect(existsSync(join(root, "state/.installation-id.new"))).toBe(false);
  });
  it("refuses symlink staging paths without modifying the destination", () => {
    const { root, payload } = fixture();
    mkdirSync(join(root, "other"), { mode: 0o700 });
    symlinkSync(join(root, "other"), join(root, "state"));
    expect(shell(root, "stage_setup", payload).status).not.toBe(0);
    expect(existsSync(join(root, "other/bootstrap.json"))).toBe(false);
  });
  it.each(["example.com\nOTHER=value", "-option", "example.com/path", "a;whoami", "999.1.2.3"])("rejects an unsafe advertised host %s before creating state", host => {
    const { root, payload } = fixture();
    expect(shell(root, "stage_setup", { ...payload, host }).status).not.toBe(0);
    expect(existsSync(join(root, "state"))).toBe(false);
  });
  it("returns a bounded compatibility result without installing anything", () => {
    const { root } = fixture();
    const result = shell(root, "check_server");
    expect(result.status, result.stderr).toBe(0);
    const check = JSON.parse(result.stdout);
    expect(typeof check.os).toBe("string");
    expect(typeof check.existing).toBe("boolean");
    expect(existsSync(join(root, "state"))).toBe(false);
  });
});
