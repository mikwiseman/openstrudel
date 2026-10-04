import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
import { CodexRpc } from "../src/rpc.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs(); spawn.mockReset();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function start(processHome?: string) {
  const directory = mkdtempSync(join(tmpdir(), "openstrudel-rpc-home-"));
  directories.push(directory);
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  spawn.mockReturnValue(child);
  const codexHome = join(directory, "credentials");
  const rpc = new CodexRpc(codexHome, undefined, undefined, undefined, processHome);
  return { rpc, codexHome, env: spawn.mock.calls.at(-1)![2].env as NodeJS.ProcessEnv };
}

it("isolates account discovery from the owner's global skills, shell startup and credentials", () => {
  vi.stubEnv("HOME", "/owner-with-protected-Documents");
  vi.stubEnv("CODEX_HOME", "/unrelated-codex-account");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "private-bot-token");
  const { rpc, codexHome, env } = start();
  try {
    expect(env.CODEX_HOME).toBe(codexHome);
    expect(env.HOME).toBe(join(codexHome, "user-home"));
    expect(statSync(env.HOME!).mode & 0o777).toBe(0o700);
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(process.env.HOME).toBe("/owner-with-protected-Documents");
    expect(process.env.CODEX_HOME).toBe("/unrelated-codex-account");
  } finally { rpc.close(); }
});

it("gives a worker its writable workspace as HOME, separate from Codex credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "openstrudel-worker-home-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  const { rpc, codexHome, env } = start(workspace);
  try {
    expect(env.HOME).toBe(workspace);
    expect(env.CODEX_HOME).toBe(codexHome);
    expect(env.HOME).not.toBe(env.CODEX_HOME);
    expect(statSync(workspace).isDirectory()).toBe(true);
  } finally { rpc.close(); }
});
