import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { ScopedCodexEngine } from "../dist/scopes.js";

// No account or model request: test the real Codex boundary with disposable files.
// Codex intentionally refuses helper aliases when CODEX_HOME is under /tmp.
const root = mkdtempSync(join(process.cwd(), ".openstrudel-sandbox-"));
const engine = new ScopedCodexEngine(root, join(root, "empty-account"));
try {
  engine.forContext("personal");
  const cwd = join(root, ".data/workspace/personal");
  const home = join(root, ".data/contexts/personal");
  writeFileSync(join(cwd, "allowed.txt"), "sandbox-ready");
  const privateFile = join(root, "private.txt");
  writeFileSync(privateFile, "must-not-be-readable");
  const cli = join(dirname(createRequire(import.meta.url).resolve("@openai/codex/package.json")), "bin/codex.js");
  const read = file => spawnSync(process.execPath, [cli, "sandbox", "-P", "openstrudel", "-C", cwd, "--", "/bin/cat", file], {
    env: { HOME: home, CODEX_HOME: home, PATH: process.env.PATH }, encoding: "utf8", timeout: 20_000,
  });
  const allowed = read(join(cwd, "allowed.txt"));
  if (allowed.status !== 0 || allowed.stdout !== "sandbox-ready") {
    throw new Error("Codex cannot run inside this server's sandbox. " + (allowed.stderr || allowed.error?.message || ""));
  }
  const denied = read(privateFile);
  if (denied.status === 0 || denied.stdout.includes("must-not-be-readable")) throw new Error("Codex filesystem isolation failed.");
  console.log("Codex sandbox ready: workspace readable, private file inaccessible.");
} finally {
  engine.close();
  rmSync(root, { recursive: true, force: true });
}
