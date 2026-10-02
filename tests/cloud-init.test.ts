import { afterEach, describe, expect, it } from "vitest";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/cloud-init.sh");
const roots: string[] = [];
const id = "438425ea-61bb-4ac0-bb4e-1b556bf05bba";
const privateKeyPEM = generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "strudel-cloud-init-")); roots.push(root);
  writeFileSync(join(root, "bootstrap.json"), JSON.stringify({ installationId: id, privateKeyPEM, ownerTokenHash: "a".repeat(64) }));
  writeFileSync(join(root, "release.sha256"), "b".repeat(64));
  return root;
}
function shell(code: string, root: string, args: string[] = []) {
  return spawnSync("bash", ["-c", `source ${quote(script)}\nSTATE_DIR=${quote(root)}\nINSTALL_ROOT=${quote(join(root, "home"))}\n${code}`, "test", ...args], { encoding: "utf8", timeout: 20_000 });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("DigitalOcean cloud-init", () => {
  it("blocks metadata in forwarded container traffic before Docker, idempotently and fail closed", () => {
    const root = fixture(); const bin = join(root, "bin"); mkdirSync(bin);
    const fake = join(bin, "iptables");
    writeFileSync(fake, `#!/usr/bin/env python3\nimport json,os,pathlib,sys\nroot=pathlib.Path(os.environ['GUARD_TEST_ROOT'])\na=sys.argv[1:]\nwith (root/'iptables.calls').open('a') as f: f.write(' '.join(a)+'\\n')\nif os.environ.get('FAIL_GUARD'): sys.exit(1)\nif a[:2]==['-w','10']: a=a[2:]\nfile=root/'iptables.state'\nstate=json.loads(file.read_text()) if file.exists() else []\ncommand=a[0]\nkey=('chain:'+a[1]) if command in ['-N','-S'] else ('rule:'+a[1]+' '+ ' '.join(a[3:] if command=='-I' else a[2:]))\nif command in ['-C','-S']: sys.exit(0 if key in state else 1)\nif command=='-N' and key in state: sys.exit(1)\nif command in ['-N','-I']: state.append(key); file.write_text(json.dumps(state)); sys.exit(0)\nsys.exit(9)\n`);
    chmodSync(fake, 0o755);
    const generate = shell('metadata_guard_script > "$STATE_DIR/guard.sh"; metadata_guard_unit > "$STATE_DIR/guard.service"', root);
    expect(generate.status, generate.stderr).toBe(0);
    const env = { ...process.env, PATH: bin + ":" + process.env.PATH, GUARD_TEST_ROOT: root };
    for (let run = 0; run < 2; run++) {
      const result = spawnSync("sh", [join(root, "guard.sh")], { encoding: "utf8", env });
      expect(result.status, result.stderr).toBe(0);
    }
    const state = JSON.parse(readFileSync(join(root, "iptables.state"), "utf8"));
    expect(state.filter((value: string) => value.includes("169.254.169.254/32"))).toHaveLength(1);
    expect(state).toContain("rule:FORWARD -j DOCKER-USER");
    expect(state.join("\n")).not.toContain("OUTPUT");
    const failed = spawnSync("sh", [join(root, "guard.sh")], { encoding: "utf8", env: { ...env, FAIL_GUARD: "1" } });
    expect(failed.status).not.toBe(0);
    const unit = readFileSync(join(root, "guard.service"), "utf8");
    expect(unit).toContain("Before=docker.service");
    expect(unit).toContain("RequiredBy=docker.service");
    expect(unit).toContain("PartOf=docker.service");
    expect(unit).not.toContain("Requires=docker.service");
    expect(unit).not.toContain("ExecStart=-");
  });
  it.skipIf(process.platform !== "darwin")("renders the actual Swift resource into bounded cloud-config without shell interpolation", () => {
    const root = fixture();
    const main = join(root, "main.swift");
    writeFileSync(main, `import Foundation\nimport CryptoKit\nlet key = P256.Signing.PrivateKey()\nlet installer = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))\nlet rendered = try DigitalOceanBootstrap.userData(installationID: "${id}", privateKeyPEM: key.pemRepresentation, ownerTokenHash: "${"a".repeat(64)}", releaseSHA256: "${"b".repeat(64)}", installer: installer)\nvar rejected = false\ndo { _ = try DigitalOceanBootstrap.userData(installationID: "not-an-id", privateKeyPEM: key.pemRepresentation, ownerTokenHash: "${"a".repeat(64)}", releaseSHA256: "${"b".repeat(64)}", installer: installer) } catch { rejected = true }\nlet json = try JSONSerialization.data(withJSONObject: ["userData": rendered, "publicKey": key.publicKey.derRepresentation.base64EncodedString(), "invalidRejected": rejected])\nprint(String(decoding: json, as: UTF8.self))\n`);
    const executable = join(root, "render");
    execFileSync("swiftc", [resolve("native/OpenStrudel/Sources/DigitalOceanBootstrap.swift"), main, "-o", executable], { timeout: 60_000, stdio: "pipe" });
    const result = JSON.parse(execFileSync(executable, [script], { encoding: "utf8", timeout: 10_000 }));
    expect(result.invalidRejected).toBe(true);
    expect(Buffer.byteLength(result.userData)).toBeLessThan(65_536);
    expect(result.userData.startsWith("#cloud-config\n")).toBe(true);
    const contents = [...result.userData.matchAll(/content: ([A-Za-z0-9+/=]+)/g)].map(match => Buffer.from(match[1], "base64"));
    expect(contents).toHaveLength(3);
    const boot = JSON.parse(contents[0]!.toString("utf8"));
    expect(boot.installationId).toBe(id);
    expect(boot.ownerTokenHash).toBe("a".repeat(64));
    expect(createPublicKey(boot.privateKeyPEM).export({ type: "spki", format: "der" }).toString("base64")).toBe(result.publicKey);
    expect(contents[1]!.toString()).toBe("b".repeat(64));
    expect(contents[2]).toEqual(readFileSync(script));
    expect(result.userData).not.toContain("BEGIN PRIVATE KEY");
  }, 70_000);
  it("validates input without printing the private key or token hash", () => {
    const root = fixture();
    const result = shell('check_input; printf "%s" "$INSTALLATION_ID"', root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(id);
    expect(result.stdout + result.stderr).not.toContain("PRIVATE KEY");
    expect(result.stdout + result.stderr).not.toContain("a".repeat(64));
  });
  it("fails before installation when the trusted release checksum is invalid", () => {
    const root = fixture(); writeFileSync(join(root, "release.sha256"), "bad");
    const result = shell("check_input", root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum");
  });
  it("can resume a matching Docker repository setup without replacing a different one", () => {
    const root = fixture(); const target = join(root, "docker.sources");
    const first = shell('write_docker_source "$1" amd64; write_docker_source "$1" amd64', root, [target]);
    expect(first.status, first.stderr).toBe(0);
    const original = readFileSync(target, "utf8");
    expect(original).toContain("https://download.docker.com/linux/ubuntu");
    expect(original).toContain("Suites: noble");
    const changed = shell('write_docker_source "$1" arm64', root, [target]);
    expect(changed.status).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe(original);
  });
  it("rejects a corrupt archive instead of extracting it", () => {
    const root = fixture(); writeFileSync(join(root, "archive.tar.gz"), "not the release");
    const result = shell('check_input; verify_archive "$STATE_DIR/archive.tar.gz"', root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum");
  });
  it.each(["symlink", "traversal"])("rejects archive %s entries", kind => {
    const root = fixture(); const archive = join(root, "archive.tar.gz");
    execFileSync("python3", ["-c", `import tarfile,sys\nwith tarfile.open(sys.argv[1], 'w:gz') as t:\n i=tarfile.TarInfo('OpenStrudel-Home/escape' if sys.argv[2]=='symlink' else 'OpenStrudel-Home/../../escape')\n if sys.argv[2]=='symlink': i.type=tarfile.SYMTYPE; i.linkname='/etc'\n else: i.type=tarfile.DIRTYPE\n t.addfile(i)`, archive, kind]);
    const result = shell('extract_archive "$1" "$STATE_DIR/extracted"', root, [archive]);
    expect(result.status).not.toBe(0);
  });
  it("preserves an existing matching installation without downloading again", () => {
    const root = fixture(); const home = join(root, "home"); mkdirSync(home);
    writeFileSync(join(home, ".cloud-installation-id"), id);
    writeFileSync(join(home, ".cloud-release.sha256"), "b".repeat(64));
    writeFileSync(join(home, "keep"), "do not modify");
    const result = shell('curl() { exit 55; }; check_input; prepare_release', root);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(home, "keep"), "utf8")).toBe("do not modify");
  });
  it("refuses to replace another installation or changed release", () => {
    const root = fixture(); mkdirSync(join(root, "home"));
    writeFileSync(join(root, "home", ".cloud-installation-id"), "someone-else");
    const result = shell("check_input; prepare_release", root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("existing");
  });
  it("uses the existing Compose sandbox and stdin bootstrap, without publishing setup", () => {
    const root = fixture();
    const result = shell(`
      compose() { printf '%s\\n' "$*" >> "$STATE_DIR/calls"; case "$*" in *cloud-bootstrap*) cat > "$STATE_DIR/received.json" ;; esac; }
      bootstrap_home
    `, root);
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(join(root, "calls"), "utf8");
    expect(calls).toContain("run --rm -T --no-deps --entrypoint node home /opt/openstrudel/dist/cli.js cloud-bootstrap");
    expect(calls).not.toMatch(/--privileged|--publish|--service-ports|PRIVATE KEY|8080/);
    expect(JSON.parse(readFileSync(join(root, "received.json"), "utf8"))).toMatchObject({ installationId: id, privateKeyPEM });
  });
});
