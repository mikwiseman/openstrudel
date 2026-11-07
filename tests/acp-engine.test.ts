import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { AcpEngine, AcpRefusal, AcpSessionLost, ProviderSignInError, grokCommand } from "../src/acp.js";
import { ProviderIncident, providerFailure, providerInfo } from "../src/providers.js";

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
  // Every turn starts the agent again, so a new script applies from the engine's next turn.
  const rescript = (next: Record<string, unknown>) => writeFileSync(script, JSON.stringify({ configOptions, ...next }));
  rescript(scenario); writeFileSync(log, "");
  const models: unknown[] = [];
  const engine = new AcpEngine({ root, provider: providerInfo("grok")!, onModels: list => models.push(list),
    command: () => ({ bin: process.execPath, args: [fixture], env: { MOCK_GROK_SCENARIO: script, MOCK_GROK_LOG: log } }) });
  const messages = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { engine, models, messages, rescript, calls: (method: string) => messages().filter(m => m.method === method).map(m => m.params),
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
    // Its cross-session memory is off: notes the employee never sees steered News, and every write to them was refused anyway.
    expect(start.env).toMatchObject({ HOME: home, GROK_HOME: home, GROK_DISABLE_AUTOUPDATER: "1", GROK_MEMORY: "0" });
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
    expect(created._meta.rules).toContain("Use reasonable assumptions for harmless details.");
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

// A schedule under approve-all, as on WaiClaw: nobody can approve anything.
const unattended = { approvalMode: "approve_all" as const, onRequest: () => { throw new Error("Выпуск остановлен: нужно разрешение пользователя. Продолжите в чате."); } };
// A schedule on a Home that asks first: nobody can approve, and nothing beyond the workspace runs by itself.
const asking = { onRequest: unattended.onRequest };

it("lets a turn that nobody approves create scratch files in the OS temp directory and use only the ones it created", async () => {
  // Grok keeps large tool inputs and its own cursors in scratch files such as /tmp/publish-cursor.json.
  const temp = realpathSync(tmpdir()), id = randomUUID(), home = realpathSync(root), cwd = join(home, ".data/workspace/personal");
  const own = join(temp, `grok-own-${id}.json`), other = join(temp, `grok-other-${id}.json`), keys = join(home, ".data/openstrudel.sqlite");
  const link = join(temp, `grok-link-${id}`), folder = join(temp, `grok-folder-${id}`);
  mkdirSync(join(home, ".data"), { recursive: true }); writeFileSync(keys, "keys"); writeFileSync(other, "another employee's");
  symlinkSync(keys, link); symlinkSync(join(home, ".data"), folder);
  const permission = (toolCallId: string, kind: string, path: string, write = false) =>
    ({ permission: { toolCall: { toolCallId, kind, title: `${kind} ${path}`, rawInput: {}, locations: [{ path }] } }, ...write ? { write: path } : {} });
  try {
    const g = mock({ turn: [
      // A new file there is this turn's own: it may read it back, search it and change it.
      permission("w1", "edit", own, true), permission("r1", "read", own), permission("s1", "search", own), permission("e1", "edit", own),
      // A file it did not create stays closed, also through a link, and nothing new reaches into the Home.
      permission("r2", "read", other), permission("e2", "edit", other), permission("r3", "read", link), permission("e3", "edit", link),
      permission("w2", "edit", join(folder, "planted.json")), permission("w3", "edit", join(cwd, "..", "work", `grok-${id}.md`)),
      // A path is normalized before it is checked, and a directory beside the temp directory is not inside it.
      permission("w4", "edit", `${temp}/grok-sub-${id}/../../grok-outside-${id}.json`), permission("w5", "edit", `${temp}-${id}/x.json`),
    ] });
    await g.engine.run("Выпуск", asking);
    expect(g.chosen()).toEqual(["once", "once", "once", "once", "no", "no", "no", "no", "no", "no", "no", "no"]);
    expect(readFileSync(own, "utf8")).toBe("scratch");
    expect(readFileSync(keys, "utf8")).toBe("keys");
    // The next turn did not create it, although one engine runs every turn of every employee.
    g.rescript({ turn: [permission("r4", "read", own), permission("e4", "edit", own)] });
    await g.engine.run("Дальше", asking);
    expect(g.chosen().slice(-2)).toEqual(["no", "no"]);
  } finally { for (const path of [own, other, link, folder]) try { unlinkSync(path); } catch {} }
});

it("opens the temp directory like the workspace under approve-all, where Grok's own commands already read and write it", async () => {
  // A refused permission ends Grok's whole turn. The container's /tmp keeps every scratch file between runs, News writes the
  // same names again (/tmp/wai-card.txt, /tmp/publish-cursor.json), and its commands could overwrite them anyway.
  const temp = realpathSync(tmpdir()), id = randomUUID(), home = realpathSync(root), cwd = join(home, ".data/workspace/personal");
  const queue = join(temp, `q-1205-${id}.json`), cursor = join(temp, `publish-cursor-${id}.json`), keys = join(home, ".data/openstrudel.sqlite");
  const link = join(temp, `grok-link-${id}`), folder = join(temp, `grok-folder-${id}`);
  mkdirSync(join(home, ".data"), { recursive: true }); writeFileSync(keys, "keys");
  symlinkSync(keys, link); symlinkSync(join(home, ".data"), folder);
  const permission = (toolCallId: string, kind: string, title: string, path: string | null, write?: string) =>
    ({ permission: { toolCall: { toolCallId, kind, title, rawInput: {}, locations: path ? [{ path }] : [] } }, ...write ? { write } : {} });
  const radar = { ...unattended, scheduled: true };
  try {
    // The 10:05 run writes the queue with a command, edits and reads it, and creates its cursor.
    const g = mock({ cancelOnReject: true, turn: [permission("x1", "execute", `python3 wai-news.py queue > ${queue}`, null, queue),
      permission("e1", "edit", "search_replace", queue), permission("r1", "read", "read_file", queue), permission("w1", "edit", "write", cursor, cursor), { text: "NO_REPLY" }] });
    expect(await g.engine.run("Радар 10:05", radar)).toMatchObject({ response: "NO_REPLY" });
    // The 11:05 run, the engine's next turn, writes both names again.
    g.rescript({ cancelOnReject: true, turn: [permission("w2", "edit", "write", cursor, cursor), permission("e2", "edit", "search_replace", queue), { text: "NO_REPLY" }] });
    expect(await g.engine.run("Радар 11:05", radar)).toMatchObject({ response: "NO_REPLY" });
    expect(g.chosen()).toEqual(["once", "once", "once", "once", "once", "once"]);
    // The Home stays closed: through a link, into another workspace, out of the temp directory, or beside it.
    g.rescript({ turn: [permission("r3", "read", "read_file", link), permission("e3", "edit", "write", link), permission("w3", "edit", "write", join(folder, "planted.json")),
      permission("w4", "edit", "write", join(cwd, "..", "work", `grok-${id}.md`)), permission("w5", "edit", "write", `${temp}/grok-sub-${id}/../../grok-outside-${id}.json`),
      permission("w6", "edit", "write", `${temp}-${id}/x.json`)] });
    await g.engine.run("Проверка", radar);
    expect(g.chosen().slice(-6)).toEqual(["no", "no", "no", "no", "no", "no"]);
    expect(readFileSync(keys, "utf8")).toBe("keys");
  } finally { for (const path of [queue, cursor, link, folder]) try { unlinkSync(path); } catch {} }
});

it("names the refused permission when Grok then ends the turn, instead of a stop", async () => {
  // Grok Build ends the whole turn when a permission is refused: its own memory notes were outside the workspace.
  const memory = join(realpathSync(root), ".data/providers/grok/home/memory-v2/workspaces/w/topics/news.md");
  const g = mock({ cancelOnReject: true, turn: [{ text: "Запомню." },
    { permission: { toolCall: { toolCallId: "m1", kind: "edit", title: "Write news.md", rawInput: {}, locations: [{ path: memory }] } } }, { text: "not reached" }] });
  await expect(g.engine.run("Выпуск", unattended)).rejects.toThrow(`Grok прервал ответ: не разрешено «Write news.md» (${memory})`);
  // A title that already names the path is not repeated.
  const hosts = mock({ cancelOnReject: true, turn: [{ permission: { toolCall: { toolCallId: "e1", kind: "edit", title: "Write /etc/hosts", rawInput: {}, locations: [{ path: "/etc/hosts" }] } } }] });
  await expect(hosts.engine.run("Выпуск", unattended)).rejects.toThrow(/^Grok прервал ответ: не разрешено «Write \/etc\/hosts»$/);
  // The model names the path, often after a story about prices and limits; a refusal is never read as the subscription limit.
  const credits = mock({ cancelOnReject: true, turn: [{ permission: { toolCall: { toolCallId: "e3", kind: "edit", title: "Write /etc/openai-credits-quota.json", rawInput: {}, locations: [{ path: "/etc/openai-credits-quota.json" }] } } }] });
  const refused = await credits.engine.run("Выпуск", unattended).catch(e => e);
  expect(refused).toBeInstanceOf(AcpRefusal);
  expect(refused.message).toBe("Grok прервал ответ: не разрешено «Write /etc/openai-credits-quota.json»");
  expect(providerFailure(providerInfo("grok")!, refused)).toBe(refused);
  // Stopped by the owner, it stays a stop.
  const owner = mock({ turn: [{ permission: { toolCall: { toolCallId: "e2", kind: "edit", title: "Write /etc/hosts", rawInput: {}, locations: [{ path: "/etc/hosts" }] } } }, { waitCancel: true }] }), stop = new AbortController();
  const pending = owner.engine.run("Правка", { signal: stop.signal, onRequest: async () => ({ decision: "decline" }) });
  await vi.waitFor(() => expect(owner.chosen()).toEqual(["no"]));
  stop.abort();
  await expect(pending).rejects.toThrow(/^Ответ остановлен$/);
});

it("keeps Grok's cause of a failed prompt, so a spent weekly allowance is the subscription limit", async () => {
  // Grok Build 1.0.52 sends HTTP 402 as JSON-RPC -32603 "Internal error" with the cause in data.
  const exhausted = { code: -32603, message: "Internal error", data: { message: "API error (status 402 Payment Required): Grok Build usage balance exhausted", http_status: 402 } };
  const error = await mock({ turn: [], prompt: exhausted }).engine.run("Радар").catch(e => e);
  expect(error.message).toBe("Grok не завершил ответ: Internal error (HTTP 402): API error (status 402 Payment Required): Grok Build usage balance exhausted");
  expect(error.cause).toMatchObject({ code: -32603, data: exhausted.data });
  const grok = providerInfo("grok")!, limit = providerFailure(grok, error);
  expect(limit).toBeInstanceOf(ProviderIncident);
  expect(limit).toMatchObject({ status: 429, reason: "limits:grok", message: "Лимит подписки Grok исчерпан. Повторите позже или выберите другую модель." });
  // The words alone are the same limit.
  const worded = await mock({ turn: [], prompt: { code: -32603, message: "Internal error", data: "Grok Build usage balance exhausted" } }).engine.run("Радар").catch(e => e);
  expect(providerFailure(grok, worded)).toMatchObject({ reason: "limits:grok" });
  // Another failure keeps its own words and is not a limit.
  const outage = await mock({ turn: [], prompt: { code: -32603, message: "Internal error", data: { message: "upstream connect error", http_status: 503 } } }).engine.run("Радар").catch(e => e);
  expect(outage.message).toBe("Grok не завершил ответ: Internal error (HTTP 503): upstream connect error");
  expect(providerFailure(grok, outage)).toBe(outage);
  // Grok's own status decides before its words, which may quote a tool or a page.
  const worded503 = await mock({ turn: [], prompt: { code: -32603, message: "Internal error", data: { message: "credit balance service: rate limit of upstream load balancer", http_status: 503 } } }).engine.run("Радар").catch(e => e);
  expect(providerFailure(grok, worded503)).toBe(worded503);
});

it("reports every turn's usage and, after a scheduled prompt, one reading of the subscription's allowance", async () => {
  const usage = { inputTokens: 52_000, cachedReadTokens: 41_000, outputTokens: 900, totalTokens: 52_900, reasoningTokens: 600, modelCalls: 3, numTurns: 2,
    costUsdTicks: 312_000_000, modelUsage: { "grok-4.7": { inputTokens: 52_000, cachedReadTokens: 41_000, outputTokens: 900, modelCalls: 3, costUsdTicks: 312_000_000 } } };
  const billing = { config: { creditUsagePercent: 17.5, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-11-05T16:00:00Z", end: "2026-11-12T16:00:00Z" },
    prepaidBalance: { val: 0 }, isUnifiedBillingUser: true }, on_demand_enabled: false, subscription_tier: "Super" };
  const reported = (events: Array<{ type: string; payload: unknown }>) => events.filter(e => e.type === "turn.usage");
  const owner = mock({ usage, billing }), seen: any[] = [];
  await owner.engine.run("Привет", { byOwner: true, onEvent: e => seen.push(e) });
  expect(reported(seen)).toEqual([{ type: "turn.usage", payload: { usage } }]);
  expect(owner.calls("_x.ai/billing")).toEqual([]);
  const scheduled = mock({ usage, billing }), events: any[] = [];
  await scheduled.engine.run("Радар", { scheduled: true, onEvent: e => events.push(e) });
  expect(reported(events)).toEqual([{ type: "turn.usage", payload: { usage, billing } }]);
  expect(scheduled.messages().flatMap(m => m.method ? [m.method] : []).slice(-2)).toEqual(["session/prompt", "_x.ai/billing"]);
  // A failed reading is noted and never fails the run.
  const refused = mock({ usage, billingError: { code: -32000, message: "Authentication required", data: "Authentication required to fetch billing data" } }), noted: any[] = [];
  expect(await refused.engine.run("Радар", { scheduled: true, onEvent: e => noted.push(e) })).toMatchObject({ response: "ok" });
  expect(reported(noted)).toEqual([{ type: "turn.usage", payload: { usage, billing: { error: "Authentication required: Authentication required to fetch billing data" } } }]);
  // A turn that ends badly still reports what it spent.
  const cancelled = mock({ usage, cancelOnReject: true, turn: [{ permission: { toolCall: { toolCallId: "e1", kind: "edit", title: "Write /etc/hosts", rawInput: {}, locations: [{ path: "/etc/hosts" }] } } }] }), spent: any[] = [];
  await expect(cancelled.engine.run("Радар", { ...unattended, scheduled: true, onEvent: e => spent.push(e) })).rejects.toThrow("не разрешено");
  expect(reported(spent)).toEqual([{ type: "turn.usage", payload: { usage, billing: {} } }]);
});

it("starts only the employee tools and the workspace's own services for a scheduled turn", async () => {
  // The owner shares his services with every chat; a schedule needs none of them, and each one starts with every run.
  const group = "group-" + "a".repeat(64);
  for (const dir of ["personal", group]) mkdirSync(join(root, ".data/extensions", dir), { recursive: true });
  writeFileSync(join(root, ".data/extensions/all-chats.json"), '{"enabled":true}\n');
  writeFileSync(join(root, ".data/extensions/personal/config.toml"), `[mcp_servers.company]\nurl = "https://company.invalid/mcp"\nhttp_headers = { Authorization = "Bearer c" }\n`);
  writeFileSync(join(root, ".data/extensions", group, "config.toml"), `[mcp_servers.wai-news-sources]\nurl = "https://sources.invalid/mcp"\nhttp_headers = { Authorization = "Bearer s" }\n`);
  const g = mock(), tools = { definitions: [], call: vi.fn() };
  await g.engine.forContext(group).run("Что нового?", { tools, byOwner: true });
  await g.engine.forContext(group).run("Радар", { tools, scheduled: true });
  expect(g.calls("session/new").map(c => c.mcpServers.map((s: { name: string }) => s.name))).toEqual([["openstrudel", "company", "wai-news-sources"], ["openstrudel", "wai-news-sources"]]);
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

it("preserves a provider balance failure hidden behind a generic ACP error", async () => {
  const g=mock({turn:[{stderr:"API error (status 402 Payment Required): Grok Build usage balance exhausted\ncleanup complete\n"}],prompt:{code:-32603,message:"Internal error"}});
  const failure=await g.engine.run("Check the news").catch(error=>error);
  expect(failure).toMatchObject({reason:"limits:grok",status:429});
  expect(failure.message).toContain("Лимит подписки Grok");
  expect(failure.message).not.toContain("Internal error");
});

it("reads Grok's stderr for a limit only when the failed request carries no status of its own", async () => {
  // Grok logs what it was doing, here a story about credits it was publishing; the status in its failed request decides.
  const log = "publish_story failed: OpenAI cuts the credit balance and rate limits of free accounts\n";
  const outage = await mock({ turn: [{ stderr: log }], prompt: { code: -32603, message: "Internal error", data: { message: "upstream connect error", http_status: 503 } } }).engine.run("Радар").catch(e => e);
  expect(outage).not.toBeInstanceOf(ProviderIncident);
  expect(outage.message).toBe("Grok не завершил ответ: Internal error (HTTP 503): upstream connect error");
  expect(providerFailure(providerInfo("grok")!, outage)).toBe(outage);
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
