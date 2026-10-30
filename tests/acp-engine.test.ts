import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { AcpEngine, AcpSessionLost, ProviderSignInError, grokCommand } from "../src/acp.js";
import { providerInfo } from "../src/providers.js";

// Every turn starts a real Node process for the scripted agent.
vi.setConfig({ testTimeout: 30_000 });
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "acp-engine-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const fixture = resolve("tests/fixtures/mock-grok.mjs");
const configOptions = [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "grok-4.7",
  options: [{ value: "grok-4.7", name: "Grok 4.7" }, { value: "grok-4.6", name: "Grok 4.6", description: "Faster" }] }];

/** The engine against the scripted agent, which logs every launch and message. */
function mock(scenario: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(root, "mock-")), script = join(dir, "scenario.json"), log = join(dir, "log.jsonl");
  writeFileSync(script, JSON.stringify({ configOptions, ...scenario })); writeFileSync(log, "");
  const models: unknown[] = [];
  const engine = new AcpEngine({ root, provider: providerInfo("grok")!, onModels: list => models.push(list),
    command: () => ({ bin: process.execPath, args: [fixture], env: { MOCK_GROK_SCENARIO: script, MOCK_GROK_LOG: log } }) });
  const messages = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { engine, models, messages, calls: (method: string) => messages().filter(m => m.method === method).map(m => m.params),
    chosen: () => messages().filter(m => m.answered === "session/request_permission").map(m => m.result.outcome.optionId ?? m.result.outcome.outcome) };
}

it("runs the pinned agent in the workspace with a private home, the employee tools and services, and no host secrets", async () => {
  process.env.XAI_API_KEY = "xai-host-leak"; process.env.OPENSTRUDEL_SECRET_FIXTURE = "host-only";
  try {
    expect(grokCommand()).toEqual({ bin: resolve("bin/grok"), args: ["--no-auto-update"] });
    mkdirSync(join(root, ".data/extensions/work"), { recursive: true });
    writeFileSync(join(root, ".data/extensions/work/config.toml"), `[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\nhttp_headers = { Authorization = "Bearer lin" }\n[mcp_servers.files]\ncommand = "files-mcp"\nargs = ["--ro"]\nenv = { ROOT = "/srv" }\n[mcp_servers.cua_repl]\ncommand = "cua"\n`);
    const g = mock({ turn: [{ text: "Сейчас посмотрю." }, { tool: { toolCallId: "t1", title: "Read notes", kind: "read" } }, { text: "Ответ: " }, { thought: "думаю" }, { text: "42" }] });
    const events: unknown[] = [], tools = { definitions: [], call: vi.fn() };
    const result = await g.engine.forContext("work").run("Привет", { profile: "Имя: Ада", model: "grok-4.6", onEvent: event => events.push(event), tools });
    // The reply is the agent's last stretch of text; commentary before its tool calls and its thoughts are dropped.
    // The saved thread is Grok's session with a hash of the rules it started with.
    const threadId = result.threadId;
    expect(threadId).toMatch(/^s-new#[0-9a-f]{16}$/);
    expect(result).toEqual({ threadId, response: "Ответ: 42", events: [] });
    expect(events[0]).toEqual({ type: "thread.started", payload: { threadId } });
    expect(events.slice(1)).toEqual(Array(4).fill({type:"turn.progress",payload:{}}));
    const workspace = realpathSync(join(root, ".data/workspace/work")), home = realpathSync(join(root, ".data/providers/grok/home"));
    const [{ start }] = g.messages();
    expect(start.args).toEqual(["--sandbox", "openstrudel", "agent", "stdio"]);
    expect(start.cwd).toBe(workspace);
    // Grok's own home is private, so it reads no ~/.grok, ~/.claude or ~/.codex of the owner.
    expect(start.env).toMatchObject({ HOME: home, GROK_HOME: home, GROK_DISABLE_AUTOUPDATER: "1" });
    expect(statSync(home).mode & 0o777).toBe(0o700);
    // Grok's own sandbox: the workspace, system paths, installed tools and its home; never the Home's data or the owner's files.
    expect(parse(readFileSync(join(home, "sandbox.toml"), "utf8"))).toEqual({ profiles: { openstrudel: {
      extends: "strict", restrict_network: false, read_write: [home], read_only: ["/opt/homebrew", "/usr/local"].filter(path => existsSync(path)) } } });
    expect(start.env).not.toHaveProperty("XAI_API_KEY");
    expect(JSON.stringify(start.env)).not.toMatch(/xai-host-leak|host-only/);
    expect(g.calls("authenticate")).toEqual([{ methodId: "cached_token" }]);
    const [created] = g.calls("session/new");
    expect(created.cwd).toBe(workspace);
    // The agent answers first; it is not told to stop for a question.
    expect(created._meta.rules).toContain("state the assumption in one short line");
    expect(created._meta.rules).toMatch(/Current employee SOUL \(authoritative\):\nИмя: Ада$/);
    expect(created.mcpServers).toEqual([
      { type: "http", name: "openstrudel", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/), headers: [{ name: "Authorization", value: expect.stringMatching(/^Bearer [0-9a-f]{64}$/) }] },
      { type: "http", name: "linear", url: "https://mcp.linear.app/mcp", headers: [{ name: "Authorization", value: "Bearer lin" }] },
      // A stdio service runs outside Grok's sandbox, behind its own endpoint of this turn.
      { type: "http", name: "files", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/), headers: [{ name: "Authorization", value: expect.stringMatching(/^Bearer [0-9a-f]{64}$/) }] },
    ]);
    expect(g.calls("session/set_config_option")).toEqual([{ sessionId: "s-new", configId: "model", value: "grok-4.6" }]);
    expect(g.calls("session/prompt")).toEqual([{ sessionId: "s-new", prompt: [{ type: "text", text: "Привет" }] }]);
    expect(g.models).toEqual([[{ id: "grok-4.7", name: "Grok 4.7", description: "", isDefault: true, reasoningEfforts: [], speeds: [{ id: "default", name: "Обычная", description: "" }], provider: "grok" },
      { id: "grok-4.6", name: "Grok 4.6", description: "Faster", isDefault: false, reasoningEfforts: [], speeds: [{ id: "default", name: "Обычная", description: "" }], provider: "grok" }]]);
    expect(() => g.engine.forContext("../personal")).toThrow("Область не найдена");
  } finally { delete process.env.XAI_API_KEY; delete process.env.OPENSTRUDEL_SECRET_FIXTURE; }
});

it("resumes the saved session while the employee's rules are unchanged, keeps only the new reply, and reports a session the agent lost", async () => {
  const g = mock({ turn: [{ text: "Продолжаем" }] });
  const { threadId } = await g.engine.run("Привет", { profile: "Имя: Ада" });
  expect(await g.engine.run("Дальше", { threadId, model: "grok-4.7", profile: "Имя: Ада" })).toEqual({ threadId, response: "Продолжаем", events: [] });
  expect(g.calls("session/new")).toHaveLength(1);
  expect(g.calls("session/load")).toEqual([{ sessionId: "s-new", cwd: realpathSync(join(root, ".data/workspace/personal")), mcpServers: [] }]);
  expect(g.calls("session/set_config_option")).toEqual([]);
  // Grok keeps the rules a session started with, so an edited SOUL, or a thread saved without its rules, starts a new session.
  await expect(g.engine.run("Дальше", { threadId, profile: "Имя: Ева" })).rejects.toBeInstanceOf(AcpSessionLost);
  await expect(g.engine.run("Дальше", { threadId: "s-new", profile: "Имя: Ада" })).rejects.toBeInstanceOf(AcpSessionLost);
  expect(g.calls("session/load")).toHaveLength(1);
  const lost = mock({ load: { code: -32002, message: "Session not found" } });
  await expect(lost.engine.run("Дальше", { threadId, profile: "Имя: Ада" })).rejects.toBeInstanceOf(AcpSessionLost);
  expect(lost.calls("session/load")).toHaveLength(1);
  expect(lost.calls("session/prompt")).toEqual([]);
});

it("forwards each permission request by kind and answers only once", async () => {
  const permission = (toolCallId: string, kind: string | undefined, title: string, rawInput: unknown = {}, locations: unknown[] = []) => ({ permission: { toolCall: { toolCallId, kind, title, rawInput, locations } } });
  const cwd = join(realpathSync(root), ".data/workspace/personal"), data = join(root, ".data/openstrudel.sqlite");
  const turn = [permission("c1", "execute", "Run tests", { command: "npm test" }), permission("e1", "edit", "Edit notes.md", {}, [{ path: "/w/notes.md" }]),
    permission("r1", "read", "Read notes.md"), permission("m1", undefined, "linear__save_issue", { title: "Bug" }), permission("o1", undefined, "openstrudel__save_schedule"),
    permission("x1", "switch_mode", "Leave plan mode"),
    // Reads stay in the workspace, as with the Claude engine: Grok never reads the Home's keys, even when it asks.
    permission("r2", "read", "Read notes.md", {}, [{ path: join(cwd, "notes.md") }]), permission("r3", "read", "Read keys", {}, [{ path: data }]),
    permission("r4", "search", "Search the Home", {}, [{ path: "notes.md" }, { path: join(cwd, "../..") }]),
    // Changes inside the workspace need nobody, as with the Claude engine; one that also reaches beyond it needs the owner.
    permission("e2", "edit", "Edit notes.md", {}, [{ path: join(cwd, "notes.md") }]), permission("d1", "move", "Move notes.md", {}, [{ path: "notes.md" }, { path: data }])];
  const g = mock({ turn });
  const onRequest = vi.fn(async (method: string, params: Record<string, any>) =>
    method === "mcpServer/elicitation/request" ? { action: "accept" } : { decision: params.command === "npm test" ? "accept" : "decline" });
  await g.engine.run("Работай", { onRequest });
  expect(onRequest.mock.calls).toEqual([
    ["item/commandExecution/requestApproval", { command: "npm test", cwd, reason: "Run tests" }],
    ["item/fileChange/requestApproval", { reason: "Edit notes.md /w/notes.md" }],
    ["mcpServer/elicitation/request", { mode: "form", serverName: "linear", message: 'Allow the linear MCP server to run tool "save_issue"?', requestedSchema: { type: "object", properties: {} },
      _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { title: "Bug" } } }],
    ["item/fileChange/requestApproval", { reason: `Move notes.md notes.md ${data}` }],
  ]);
  // Never "allow always": a later request asks again.
  expect(g.chosen()).toEqual(["once", "no", "once", "once", "once", "no", "once", "no", "no", "once", "no"]);
  // Approve-all runs commands in the sandbox and services by itself, but never changes beyond the workspace.
  const all = mock({ turn });
  await all.engine.run("Работай", { approvalMode: "approve_all", onRequest });
  expect(onRequest).toHaveBeenCalledTimes(4);
  expect(all.chosen()).toEqual(["once", "no", "once", "once", "once", "once", "once", "no", "no", "once", "no"]);
  // A schedule has nobody to ask, and still writes its report into the workspace.
  const scheduled = mock({ turn: [permission("c1", "execute", "Run tests", { command: "npm test" }), permission("e3", "edit", "Write report.md", {}, [{ path: join(cwd, "report.md") }])] });
  await scheduled.engine.run("Выпуск", { onRequest: () => { throw new Error("Выпуск остановлен: нужно разрешение пользователя. Продолжите в чате."); } });
  expect(scheduled.chosen()).toEqual(["no", "once"]);
});

it("asks Grok's questions in OpenStrudel and serves the employee tools", async () => {
  const g = mock({ turn: [
    { ask: { toolCallId: "q1", questions: [{ question: "Какой формат?", header: "Формат", options: [{ label: "Кратко", description: "" }, { label: "Подробно", description: "" }], multiSelect: false }] } },
    { mcp: { name: "save_note", arguments: { text: "купить молоко" } } }] });
  const onRequest = vi.fn(async () => ({ answers: { "0": { answers: ["Кратко"] } } }));
  const call = vi.fn(async (_name: string, args: Record<string, unknown>) => ({ saved: args.text }));
  const tools = { definitions: [{ type: "function" as const, name: "save_note", description: "Save a note", inputSchema: { type: "object", properties: { text: { type: "string" } } } }], call };
  const result = await g.engine.run("Запиши", { onRequest, tools });
  expect(onRequest).toHaveBeenCalledWith("item/tool/requestUserInput", { questions: [{ id: "0", header: "Формат", question: "Какой формат?", options: [{ label: "Кратко", description: "" }, { label: "Подробно", description: "" }] }] });
  expect(g.messages().find(m => m.answered === "x.ai/ask_user_question").result).toEqual({ outcome: "accepted", answers: { "Какой формат?": "Кратко" } });
  expect(call).toHaveBeenCalledWith("save_note", { text: "купить молоко" });
  expect(JSON.parse(result.response)).toEqual({ content: [{ type: "text", text: JSON.stringify({ saved: "купить молоко" }) }] });
});

it("stops with session/cancel, kills an agent that ignores it after 5 s, and names failures", async () => {
  const waiting = mock({ turn: [{ text: "…" }, { waitCancel: true }] }), stop = new AbortController();
  const pending = waiting.engine.run("Долго", { signal: stop.signal });
  await vi.waitFor(() => expect(waiting.calls("session/prompt")).toHaveLength(1));
  stop.abort();
  await expect(pending).rejects.toThrow("Ответ остановлен");
  expect(waiting.calls("session/cancel")).toEqual([{ sessionId: "s-new" }]);
  // A pending approval answers "cancelled" at once.
  const asking = mock({ turn: [{ permission: { toolCall: { toolCallId: "c1", kind: "execute", title: "Run", rawInput: { command: "make" } } } }, { waitCancel: true }] }), quit = new AbortController();
  const approval = asking.engine.run("Собери", { signal: quit.signal, onRequest: () => new Promise(() => {}) });
  await vi.waitFor(() => expect(asking.calls("session/prompt")).toHaveLength(1));
  quit.abort();
  await expect(approval).rejects.toThrow("Ответ остановлен");
  expect(asking.chosen()).toEqual(["cancelled"]);
  const stuck = mock({ turn: [{ hang: true }] }), halt = new AbortController();
  const hanging = stuck.engine.run("Долго", { signal: halt.signal });
  await vi.waitFor(() => expect(stuck.calls("session/prompt")).toHaveLength(1));
  const started = Date.now(); halt.abort();
  await expect(hanging).rejects.toThrow("Ответ остановлен");
  expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
  const closing = mock({ turn: [{ hang: true }] });
  const closed = closing.engine.run("Долго");
  await vi.waitFor(() => expect(closing.calls("session/prompt")).toHaveLength(1));
  closing.engine.close();
  await expect(closed).rejects.toThrow("Ответ остановлен");

  const signedOut = await mock({ authenticate: { code: -32000, message: "Authentication required" } }).engine.run("Привет").catch(e => e);
  expect(signedOut).toBeInstanceOf(ProviderSignInError);
  expect(signedOut).toMatchObject({ status: 409, reason: "auth:grok", message: "Войдите в Grok снова в настройках аккаунтов." });
  // Grok answers -32000 also when its sign-in server cannot be reached (as the pinned CLI does offline); that is an outage, not a lost sign-in.
  const offline = await mock({ authenticate: { code: -32000, message: "error sending request for url (https://auth.x.ai/.well-known/openid-configuration)" } }).engine.run("Привет").catch(e => e);
  expect(offline).not.toBeInstanceOf(ProviderSignInError);
  expect(offline.message).toBe("Grok не завершил ответ: error sending request for url (https://auth.x.ai/.well-known/openid-configuration)");
  await expect(mock({ prompt: { code: -32603, message: "rate limit exceeded\nretry later" } }).engine.run("Привет")).rejects.toThrow(/^Grok не завершил ответ: rate limit exceeded$/);
  await expect(mock({ turn: [{ stderr: "panic: out of memory\n", exit: 3 }] }).engine.run("Привет")).rejects.toThrow(/^Grok не завершил ответ: panic: out of memory$/);
});

it("reads the agent's model catalog for the picker from a scratch session that sends no prompt", async () => {
  const g = mock();
  expect((await g.engine.models()).map(m => [m.id, m.isDefault])).toEqual([["grok-4.7", true], ["grok-4.6", false]]);
  expect(g.calls("session/new")).toEqual([expect.objectContaining({ mcpServers: [] })]);
  expect(g.calls("session/prompt")).toEqual([]);
});

it('uses the native thought-level option, validates after a model switch, and rejects unsupported values before prompting', async()=>{
 const thinking={id:'effort',name:'Thinking',category:'thought_level',type:'select',currentValue:'low',options:[{value:'low',name:'Low'},{value:'high',name:'High'}]};
 const g=mock({configOptions:[...configOptions,thinking]});
 const models=await g.engine.models();
 expect(models.find(m=>m.id==='grok-4.7')?.reasoningEfforts?.map(e=>e.id)).toEqual(['low','high']);
 expect(models.find(m=>m.id==='grok-4.6')?.reasoningEfforts).toEqual([]);
 await g.engine.run('Think',{model:'grok-4.6',reasoningEffort:'high'});
 expect(g.calls('session/set_config_option').slice(-2)).toEqual([
  {sessionId:'s-new',configId:'model',value:'grok-4.6'},
  {sessionId:'s-new',configId:'effort',value:'high'},
 ]);
 await expect(g.engine.run('Wrong level',{reasoningEffort:'ultra'})).rejects.toThrow('обдумывания');
 expect(g.calls('session/prompt')).toHaveLength(1);
});
