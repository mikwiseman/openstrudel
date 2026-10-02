import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const installer = resolve("scripts/install-server.sh");
const directories: string[] = [];
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "strudel-server-install-"));
  directories.push(root);
  mkdirSync(join(root, "deploy", "docker"), { recursive: true });
  writeFileSync(join(root, "deploy", "compose.yaml"), "services: {}\n");
  writeFileSync(join(root, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(root, "package.json"), '{"name":"openstrudel"}\n');
  return root;
}
function shell(code: string, args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", `source ${quote(installer)}\n${code}`, "test", ...args], {
    encoding: "utf8", env: { ...process.env, ...env }, timeout: 15_000,
  });
}
const mainOverrides = `
check_platform() { :; }
check_dependencies() { :; }
ensure_docker() { DOCKER=(fake_docker); }
take_lock() { :; }
load_apparmor() { printf 'apparmor\\n' >> "$TEST_LOG"; }
fake_docker() {
  printf '%s\\n' "$*" >> "$TEST_LOG"
  case "$*" in
    "ps -a"*) printf '%s' "\${TEST_OTHER_PROJECT:-}" ;;
    "volume inspect"*) return 1 ;;
    *"up -d --build"*) [ "\${TEST_FAIL_START:-}" != 1 ] ;;
    *"node /opt/openstrudel/dist/cli.js pair"*) printf 'openstrudel://connect?host=example.com&key=fixture\\n' ;;
  esac
}
wait_ready() { [ "\${TEST_FAIL_READY:-}" != 1 ]; }
main "$@"
`;
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("personal server installer", () => {
  it("rejects unsupported systems before making changes", () => {
    const result = shell('uname() { printf "Darwin\\n"; }; check_platform');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Ubuntu");
  });

  it.each(["localhost", "127.0.0.1", "10.0.0.3", "224.0.0.1", "https://example.com", "example.com:7789", "a;touch /tmp/unsafe", "bad_host.com"])("rejects unsuitable public host %s", host => {
    expect(shell('validate_host "$1"', [host]).status).not.toBe(0);
  });

  it.each(["8.8.8.8", "home.example.com"])("accepts a public server address %s", host => {
    expect(shell('validate_host "$1"', [host]).status).toBe(0);
  });

  it("refuses an invalid port without creating configuration", () => {
    const root = fixture();
    const result = shell(mainOverrides, ["--dir", root, "--host", "example.com", "--port", "65536"], { TEST_LOG: join(root, "calls") });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("порт");
    expect(() => readFileSync(join(root, "deploy", ".env"))).toThrow();
  });

  it("preserves existing configuration and data across repeated runs", () => {
    const root = fixture();
    const envFile = join(root, "deploy", ".env");
    const original = "# owner configuration\nOPENSTRUDEL_PUBLIC_HOST=example.com\nOPENSTRUDEL_PUBLIC_PORT=28789\nTZ=Europe/Moscow\nCOMPOSE_PROJECT_NAME=strudel-test\nEXTRA=leave-me-alone\n";
    writeFileSync(envFile, original);
    const args = ["--dir", root];
    for (let run = 0; run < 2; run++) {
      const result = shell(mainOverrides, args, { TEST_LOG: join(root, "calls") });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("openstrudel://connect?");
      expect(readFileSync(envFile, "utf8")).toBe(original);
    }
    const calls = readFileSync(join(root, "calls"), "utf8");
    expect(calls).toContain("--project-name strudel-test");
    expect(calls).not.toMatch(/down|volume rm|--privileged|apparmor=unconfined/);
  });

  it("never evaluates values in an existing dotenv file", () => {
    const root = fixture();
    const sentinel = join(root, "must-not-exist");
    writeFileSync(join(root, "deploy", ".env"), `OPENSTRUDEL_PUBLIC_HOST=$(touch ${sentinel})\nOPENSTRUDEL_PUBLIC_PORT=7789\n`);
    const result = shell(mainOverrides, ["--dir", root], { TEST_LOG: join(root, "calls") });
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(sentinel)).toThrow();
  });

  it("refuses silently moving an existing installation to another address", () => {
    const root = fixture();
    const original = "OPENSTRUDEL_PUBLIC_HOST=example.com\nOPENSTRUDEL_PUBLIC_PORT=7789\n";
    writeFileSync(join(root, "deploy", ".env"), original);
    const result = shell(mainOverrides, ["--dir", root, "--host", "other.example.com"], { TEST_LOG: join(root, "calls") });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("существующ");
    expect(readFileSync(join(root, "deploy", ".env"), "utf8")).toBe(original);
  });

  it("will not reuse another Compose project's containers", () => {
    const root = fixture();
    const result = shell(mainOverrides, ["--dir", root, "--host", "example.com"], { TEST_LOG: join(root, "calls"), TEST_OTHER_PROJECT: "/some/other/home/deploy" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("другой установк");
    expect(readFileSync(join(root, "calls"), "utf8")).not.toContain("up -d");
  });

  it.each(["TEST_FAIL_START", "TEST_FAIL_READY"])("does not emit a pairing link when the service fails (%s)", failure => {
    const root = fixture();
    const result = shell(mainOverrides, ["--dir", root, "--host", "example.com"], { TEST_LOG: join(root, "calls"), [failure]: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("openstrudel://");
    expect(result.stderr).toContain("запуст");
  });

  it("refuses a release archive containing a symlink", () => {
    const root = fixture();
    const archive = join(root, "unsafe.tar.gz");
    execFileSync("python3", ["-c", 'import tarfile,sys\nwith tarfile.open(sys.argv[1],"w:gz") as t:\n i=tarfile.TarInfo("OpenStrudel-Home/escape"); i.type=tarfile.SYMTYPE; i.linkname="/etc"; t.addfile(i)', archive]);
    const result = shell('extract_release "$1" "$2"', [archive, join(root, "stage")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("архив");
  });

  it("rejects a damaged download before creating the installation", () => {
    const root = fixture();
    const target = join(root, "new-install");
    const result = shell(`
      INSTALL_ROOT="$1"
      curl() { while [ "$1" != -o ]; do shift; done; printf 'damaged' > "$2"; }
      prepare_release
    `, [target]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Контрольная сумма");
    expect(() => readFileSync(join(target, "deploy", ".env"))).toThrow();
  });

  it("refuses a remote Docker endpoint before running a container", () => {
    const result = shell('docker() { :; }; ensure_docker', [], { DOCKER_HOST: "ssh://someone-else" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("другой машине");
  });

  it("keeps the Codex sandbox restrictions in Compose", () => {
    const compose = readFileSync("deploy/compose.yaml", "utf8");
    expect(compose).toContain('user: "1000:1000"');
    expect(compose).toContain("cap_drop: [ALL]");
    expect(compose).toContain("apparmor=openstrudel-container");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).not.toContain("docker.sock");
    expect(compose).not.toContain("privileged:");
  });
});
