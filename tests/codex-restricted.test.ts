import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const wire = vi.hoisted(() => ({ request: vi.fn(), constructors: [] as any[], notify: undefined as undefined | ((message: any) => void), serverRequest: undefined as undefined | ((method: string, params: any) => Promise<unknown>) }));
vi.mock("../src/rpc.js", () => ({ CodexRpc: class {
  closed = false;
  exited = Promise.resolve();
  constructor(...args: any[]) { wire.constructors.push(args); wire.notify = args[1]; wire.serverRequest = args[2]; }
  initialize = async () => undefined;
  request = wire.request;
  close() { this.closed = true; }
} }));
import { CodexEngineAdapter } from "../src/codex.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); wire.request.mockReset(); wire.constructors.length = 0; vi.restoreAllMocks(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "restricted-adapter-test-")); roots.push(root);
  const home = join(root, "codex"), cwd = join(root, "empty"); mkdirSync(home); mkdirSync(cwd);
  wire.request.mockImplementation(async (method, params) => {
    if (method === "configRequirements/read") return { requirements: null };
    if (method === "model/list") return { data: [] };
    if (method === "thread/start") return { thread: { id: "restricted-thread" } };
    if (method === "turn/start") { queueMicrotask(() => wire.notify?.({ method: "turn/completed", params: { threadId: params.threadId, turn: { status: "completed" } } })); return { turn: { id: "turn" } }; }
    throw new Error("Unexpected RPC method " + method);
  });
  return { home, cwd, engine: new CodexEngineAdapter({ restricted: true, codexHome: home, workingDirectory: cwd, restrictedInstructions: "Preview before confirming the permitted move." }) };
}

it("starts an isolated runtime with a fixed read-only profile and no broad Home instructions", async () => {
  const { home, cwd, engine } = fixture();
  const extensions = vi.spyOn(engine, "extensions");
  try {
    await engine.run("one", { employees: [], approvalMode: "auto", byOwner: true });
    const start = wire.request.mock.calls.find(([method]) => method === "thread/start")![1];
    expect(start).toMatchObject({ approvalPolicy: "never", approvalsReviewer: "user", cwd, dynamicTools: [] });
    expect(start.sandbox).toBeUndefined();
    expect(start.config).toMatchObject({ default_permissions: "restricted", "permissions.restricted.filesystem": { ":minimal": "read", [cwd]: "read" }, "permissions.restricted.network.enabled": false, "features.apps": false, "features.shell_tool": false, "features.unified_exec": false, "features.view_image": false, "features.multi_agent": false, "features.plugins": false, "features.memories": false, "features.code_mode_host": true, web_search: "disabled", approval_policy: "never" });
    expect(Object.keys(start.config).some(key => key.startsWith("mcp_servers"))).toBe(false);
    expect(start.developerInstructions).toContain("Preview before confirming");
    expect(start.developerInstructions).not.toContain("update_employee");
    expect(start.developerInstructions).not.toContain("send_telegram_message");
    expect(extensions).not.toHaveBeenCalled();
    expect(wire.constructors[0][0]).toBe(home);
    expect(wire.constructors[0][4]).toBeUndefined(); // Rpc chooses a separate home beneath CODEX_HOME.
    expect(wire.constructors[0][6]).toBe(cwd); // Startup cwd is isolated too.
    expect(wire.request.mock.calls.find(([m]) => m === "turn/start")![1]).toMatchObject({ approvalPolicy: "never", approvalsReviewer: "user" });
  } finally { engine.close(); }
});

it.each([{ threadId: "old-thread" }, { employees: [{ id: "wide" }] }, { images: ["/private/data"] }, { readPaths: ["/private"] }, { provider: "openai" }, { profile: "Owner SOUL" }, { onRequest: async () => ({ decision: "accept" }) }])("rejects a restricted turn that would import wider state: %j", async options => {
  const { engine } = fixture();
  try { await expect(engine.run("test", options as any)).rejects.toThrow("Invalid restricted turn"); expect(wire.constructors).toHaveLength(0); }
  finally { engine.close(); }
});

it.each([{ config: { "features.shell_tool": true } }, { sharedExtensionsPath: "/home/owner" }, { telegramServers: { company: { url: "https://example.invalid" } } }, { inheritedApps: ["email"] }, { provider: { info: {}, key: () => "key" } }])("refuses broad engine options: %j", extra => {
  expect(() => new CodexEngineAdapter({ restricted: true, codexHome: "/isolated/home", workingDirectory: "/isolated/cwd", ...extra } as any)).toThrow("Invalid restricted runtime configuration");
});

it("rejects native permission/command requests instead of offering owner approvals", async () => {
  const { engine } = fixture();
  wire.request.mockImplementation(async method => {
    if (method === "configRequirements/read") return { requirements: null };
    if (method === "model/list") return { data: [] };
    if (method === "thread/start") return { thread: { id: "restricted-thread" } };
    if (method === "turn/start") return { turn: { id: "turn" } };
    throw Error(method);
  });
  const pending = engine.run("test", { employees: [] });
  await vi.waitFor(() => expect(wire.request.mock.calls.some(([m]) => m === "turn/start")).toBe(true));
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]) {
    await expect(wire.serverRequest!(method, { threadId: "restricted-thread" })).rejects.toThrow("No user is available");
  }
  wire.notify?.({ method: "turn/completed", params: { threadId: "restricted-thread", turn: { status: "completed" } } });
  await pending; engine.close();
});
