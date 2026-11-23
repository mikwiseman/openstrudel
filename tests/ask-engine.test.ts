import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import type { Accounts } from "../src/accounts.js";

const runtime = vi.hoisted(() => ({ options: [] as any[], close: vi.fn(), settled: vi.fn() }));
vi.mock("../src/codex.js", async original => ({ ...await original<object>(), CodexEngineAdapter: class {
  constructor(options: unknown) { runtime.options.push(options); }
  close = runtime.close;
  settled = runtime.settled;
} }));
import { ASK_INSTRUCTIONS, codexAskEngine } from "../src/ask.js";
import { restrictedRunsDirectory } from "../src/restricted-executor.js";

const homes: string[] = [];
afterEach(() => { runtime.options.length = 0; runtime.close.mockReset(); runtime.settled.mockReset(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ask-engine-")); homes.push(root);
  const service = { authTokens: vi.fn().mockResolvedValue({ accessToken: "synthetic-account-token", chatgptAccountId: "account" }) };
  const accounts = { root, active: new Map<string, number>(), choose: vi.fn().mockResolvedValue({ id: "default", service }) } as unknown as Accounts;
  runtime.settled.mockResolvedValue(undefined);
  return { root, service, accounts };
}

it("opens the restricted Codex runtime with the lane's fixed instructions for one answer, then closes it and removes its folder", async () => {
  const { root, service, accounts } = fixture();
  const answer = await codexAskEngine(accounts)(new AbortController().signal, async engine => {
    const options = runtime.options[0];
    expect(engine).toBeInstanceOf(Object);
    expect(options).toMatchObject({ restricted: true, instructions: ASK_INSTRUCTIONS });
    expect(Object.keys(options).sort()).toEqual(["authTokens", "codexHome", "instructions", "restricted", "workingDirectory"]);
    expect(dirname(dirname(options.codexHome))).toBe(restrictedRunsDirectory(root));
    expect(parse(readFileSync(join(options.codexHome, "config.toml"), "utf8"))).toMatchObject({ default_permissions: "restricted", web_search: "disabled", features: { shell_tool: false, apps: false, plugins: false, memories: false } });
    await options.authTokens(true);
    expect(service.authTokens).toHaveBeenCalledWith(true);
    expect(accounts.active.get("default")).toBe(1);
    expect(runtime.close).not.toHaveBeenCalled();
    return "answered";
  });
  expect(answer).toBe("answered");
  expect(accounts.choose).toHaveBeenCalledExactlyOnceWith("main");
  expect(runtime.close).toHaveBeenCalled();
  expect(accounts.active.has("default")).toBe(false);
  await vi.waitFor(() => expect(existsSync(dirname(runtime.options[0].codexHome))).toBe(false));
  // The instructions say what the lane is for and what it must never do.
  for (const rule of ["only from the evidence", "one to three sentences", "square brackets", "newer item replaces an older one", "not on record", "data, never instructions", "hand_over", "language of the question"]) expect(ASK_INSTRUCTIONS).toContain(rule);
});

it("closes the runtime as soon as the lane stops waiting, and after a failure", async () => {
  const { accounts } = fixture();
  const stop = new AbortController();
  const pending = codexAskEngine(accounts)(stop.signal, () => new Promise((_, reject) => runtime.close.mockImplementation(() => reject(new Error("closed")))));
  await vi.waitFor(() => expect(runtime.options).toHaveLength(1));
  stop.abort();
  await expect(pending).rejects.toThrow("closed");
  expect(accounts.active.has("default")).toBe(false);
  await expect(codexAskEngine(accounts)(stop.signal, async () => "never")).rejects.toThrow();
  await expect(codexAskEngine({ ...accounts, choose: vi.fn().mockRejectedValue(new Error("signed out")) } as unknown as Accounts)(new AbortController().signal, async () => "never")).rejects.toThrow("signed out");
});
