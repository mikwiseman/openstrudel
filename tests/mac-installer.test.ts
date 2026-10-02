import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
});
