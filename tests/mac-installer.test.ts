import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("packaged Mac installation", () => {
  it("creates a launch agent with escaped paths using only the bundled Node runtime", async () => {
    const { launchAgent } = await import("../scripts/mac-launch-agent.mjs");
    const directory = mkdtempSync(join(tmpdir(), "strudel-install-"));
    const root = '/Users/a & b/Library/Application Support/OpenStrudel/runtime';
    try {
      const file = join(directory, "agent.plist");
      const dataRoot = '/Users/a & b/Library/Application Support/OpenStrudel/data';
      writeFileSync(file, launchAgent(root, root + "/bin/node", "/Users/a & b", dataRoot, "release-2"));
      if (process.platform === "darwin") {
        const result = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
        expect(result.ProgramArguments).toEqual([root + "/bin/node", root + "/dist/cli.js", "start"]);
        expect(result.EnvironmentVariables.PATH).toContain(root + "/bin");
        expect(result.WorkingDirectory).toBe(dataRoot);
        expect(result.EnvironmentVariables.OPENSTRUDEL_DB).toBe(dataRoot + "/.data/openstrudel.sqlite");
        expect(result.StandardOutPath).toBe(dataRoot + "/.data/home.log");
        expect(result.OpenStrudelRuntimeVersion).toBe("release-2");
        expect(result.KeepAlive).toBe(true);
        expect(result.EnvironmentVariables.TZ).toBeUndefined();
      }
      expect(readFileSync("scripts/install-prebuilt-mac.sh", "utf8")).not.toContain("python");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("waits for a stopping Home, retries launchd registration, and leaves a current service alone", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "strudel-launchd-")));
    try {
      const runtime = join(directory, "runtime"), testHome = join(directory, "user"), commands = join(directory, "commands");
      for (const path of [join(runtime, "scripts"), join(runtime, "bin"), join(runtime, "dist"), testHome, commands]) mkdirSync(path, { recursive: true });
      for (const file of ["install-prebuilt-mac.sh", "mac-launch-agent.mjs"]) copyFileSync(join("scripts", file), join(runtime, "scripts", file));
      symlinkSync(process.execPath, join(runtime, "bin/node"));
      writeFileSync(join(runtime, "dist/cli.js"), "");
      writeFileSync(join(runtime, "release.txt"), "release-1");
      const dataDirectory = join(directory, "data");
      mkdirSync(dataDirectory);
      const settings = "# User-owned connection settings\nOPENSTRUDEL_PUBLIC_HOST=home.example.com\nOPENSTRUDEL_PUBLIC_PORT=17789\n";
      writeFileSync(join(dataDirectory, ".env"), settings);
      writeFileSync(join(commands, "sleep"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(commands, "launchctl"), `#!/bin/bash
set -eu
state="$TEST_LAUNCHD/state"
case "$1" in
  bootout) echo bootout >> "$TEST_LAUNCHD/events"; if [[ -f "$state" ]]; then echo 3 > "$state"; fi ;;
  print)
    [[ -f "$state" ]] || exit 1
    [[ ! -f "$TEST_LAUNCHD/hung" ]] || exit 0
    value="$(cat "$state")"
    if [[ "$value" == running ]]; then exit 0; fi
    if [[ "$value" == 0 ]]; then rm "$state"; exit 1; fi
    echo "$((value-1))" > "$state"; exit 0 ;;
  bootstrap)
    [[ ! -f "$state" ]] || { echo overlap >> "$TEST_LAUNCHD/events"; exit 5; }
    echo bootstrap >> "$TEST_LAUNCHD/events"
    if [[ ! -f "$TEST_LAUNCHD/retried" ]]; then touch "$TEST_LAUNCHD/retried"; exit 5; fi
    echo running > "$state" ;;
esac
`, { mode: 0o755 });
      const run = () => spawnSync("/bin/bash", [join(runtime, "scripts/install-prebuilt-mac.sh"), join(directory, "data")], {
        env: { ...process.env, HOME: testHome, PATH: commands + ":" + process.env.PATH, TEST_LAUNCHD: directory }, encoding: "utf8",
      });
      const installed = run();
      expect(installed.status, installed.stdout + installed.stderr).toBe(0);
      const first = readFileSync(join(directory, "events"), "utf8");
      expect(first).toBe("bootout\nbootstrap\nbootstrap\n");
      expect(run().status).toBe(0);
      expect(readFileSync(join(directory, "events"), "utf8")).toBe(first);
      writeFileSync(join(runtime, "release.txt"), "release-2");
      expect(run().status).toBe(0);
      expect(readFileSync(join(directory, "events"), "utf8")).toBe(first + "bootout\nbootstrap\n");
      expect(readFileSync(join(directory, "state"), "utf8")).toBe("running\n");
      const plist = join(testHome, "Library/LaunchAgents/is.openstrudel.home.plist");
      const previous = readFileSync(plist, "utf8");
      writeFileSync(join(runtime, "release.txt"), "release-3");
      writeFileSync(join(directory, "hung"), "");
      expect(run().status).toBe(1);
      expect(readFileSync(plist, "utf8")).toBe(previous);
      rmSync(join(directory, "hung"));
      expect(run().status).toBe(0);
      expect(readFileSync(plist, "utf8")).toContain("release-3");
      expect(readFileSync(join(dataDirectory, ".env"), "utf8")).toBe(settings);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 15_000);

  it.skipIf(process.platform !== "darwin")("keeps an existing public endpoint and TLS identity when regenerating a Mac launch agent", async () => {
    const { launchAgent } = await import("../scripts/mac-launch-agent.mjs");
    const directory = mkdtempSync(join(tmpdir(), "strudel-network-update-"));
    try {
      const testHome = join(directory, "user");
      const agents = join(testHome, "Library/LaunchAgents");
      const runtime = join(directory, "new-runtime");
      mkdirSync(agents, { recursive: true });
      mkdirSync(runtime);
      const old = join(agents, "is.openstrudel.home.plist");
      const network = { OPENSTRUDEL_PUBLIC_HOST: "home.example.com", OPENSTRUDEL_PUBLIC_PORT: "17789", OPENSTRUDEL_TLS_CERT: "/certs/a & b.pem", OPENSTRUDEL_TLS_KEY: "/certs/private.pem" };
      writeFileSync(old, launchAgent("/old-runtime", "/old-node", testHome, "/data", "old", network));
      const prepared = join(directory, "prepared.plist");
      execFileSync(process.execPath, ["scripts/mac-launch-agent.mjs", runtime, "/data", prepared], { env: { ...process.env, HOME: testHome } });
      const result = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", prepared], { encoding: "utf8" }));
      expect(result.EnvironmentVariables).toMatchObject(network);
      expect(result.EnvironmentVariables.OPENSTRUDEL_DB).toBe("/data/.data/openstrudel.sqlite");
      expect(result.ProgramArguments[1]).toBe(runtime + "/dist/cli.js");
      expect(readFileSync(old, "utf8")).toContain("/old-runtime");
      expect(readFileSync(old, "utf8")).not.toContain("new-runtime");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
