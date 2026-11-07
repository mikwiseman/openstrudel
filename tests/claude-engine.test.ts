import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CanUseTool, Options, query as sdkQuery, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeEngine } from "../src/claude.js";
import { ProviderIncident, ProviderKeyError, providerInfo } from "../src/providers.js";

type Call = { prompt: SDKUserMessage[]; options: Options; interrupted: Promise<void> };
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "claude-engine-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const init = (session = "s-1") => ({ type: "system", subtype: "init", session_id: session });
const success = (result: string, session = "s-1") => ({ type: "result", subtype: "success", is_error: false, result, session_id: session });
/** A stand-in for `query` that records the turn and replays scripted SDK messages. */
function fake(script: (call: Call) => AsyncGenerator<any> | any[] = () => [init(), success("Привет")], models: any[] = []) {
  const calls: Call[] = [];
  const query = (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    let interrupt!: () => void;
    const call: Call = { prompt: [], options, interrupted: new Promise<void>(resolve => { interrupt = resolve; }) };
    return Object.assign((async function* () {
      for await (const message of prompt) call.prompt.push(message);
      calls.push(call);
      yield* script(call);
    })(), { interrupt: async () => interrupt(), supportedModels: async () => models, close: () => interrupt() });
  }) as unknown as typeof sdkQuery;
  return { query, calls };
}
const interrupted = { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Request was aborted."], session_id: "s-1" };
const aborted = (call: Call) => new Promise(resolve => call.options.abortController!.signal.aborted ? resolve(null) : call.options.abortController!.signal.addEventListener("abort", resolve));
const engine = (id: string, query: typeof sdkQuery, key: string | null = "sk-test-key") => new ClaudeEngine({ root, provider: providerInfo(id)!, key: () => key, query });

it("interrupts the CLI's quota retry so the reserve can start immediately", async () => {
  const sdk = fake(async function* (call) {
    yield init();
    yield { type:"system",subtype:"api_retry",error_status:429,error:"rate_limit",session_id:"s-1" };
    await call.interrupted;
    yield interrupted;
  });
  await expect(engine("anthropic",sdk.query).run("Hi")).rejects.toMatchObject({reason:"limits:anthropic"});
}, 1_000);
const allow = (call: Call, name: string, input: Record<string, unknown>, extra: Partial<Parameters<CanUseTool>[2]> = {}) =>
  call.options.canUseTool!(name, input, { signal: new AbortController().signal, ...extra } as Parameters<CanUseTool>[2]);

it("isolates each turn and places the key by the provider's auth style", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-host-leak";
  process.env.OPENSTRUDEL_SECRET_FIXTURE = "host-only";
  try {
    const kimi = fake(), anthropic = fake();
    await engine("kimi", kimi.query).forContext("work").run("Hi");
    await engine("anthropic", anthropic.query).run("Hi");
    const [bearer, apiKey] = [kimi.calls[0]!.options, anthropic.calls[0]!.options];
    expect(bearer.settingSources).toEqual([]);
    expect(bearer.strictMcpConfig).toBe(true);
    expect(bearer.permissionMode).toBe("default");
    expect(bearer.cwd).toBe(join(root, ".data/workspace/work"));
    expect(bearer.env).toMatchObject({ CLAUDE_CONFIG_DIR: join(root, ".data/providers/kimi/claude/work"), HOME: join(root, ".data/providers/kimi/claude/work/home"),
      ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic", ANTHROPIC_AUTH_TOKEN: "sk-test-key", ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k3", ANTHROPIC_SMALL_FAST_MODEL: "kimi-k3", CLAUDE_CODE_SUBAGENT_MODEL: "kimi-k3" });
    expect(bearer.model).toBe("kimi-k3");
    expect(JSON.stringify(bearer.env)).not.toMatch(/sk-host-leak|host-only/);
    expect(apiKey.env).toMatchObject({ ANTHROPIC_API_KEY: "sk-test-key", ANTHROPIC_BASE_URL: "https://api.anthropic.com", CLAUDE_CONFIG_DIR: join(root, ".data/providers/anthropic/claude/personal") });
    expect(apiKey.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(apiKey.env).not.toHaveProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL");
    expect(apiKey.model).toBe("claude-fable-5-1");
    expect(() => engine("kimi", kimi.query).forContext("../personal")).toThrow("Область не найдена");
    await expect(engine("kimi", kimi.query, null).run("Hi")).rejects.toThrow("Подключите Kimi на этом устройстве");
  } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENSTRUDEL_SECRET_FIXTURE; }
});

it("reports the session at once, resumes it and sends a changed SOUL every turn", async () => {
  const { query, calls } = fake(call => [init(call.options.resume ?? "s-new"), success("Ответ", call.options.resume ?? "s-new")]);
  const events: unknown[] = [];
  const first = await engine("zai", query).run("Привет", { profile: "Имя: Ада", model: "glm-5.3-flash", onEvent: event => events.push(event) });
  expect(first).toEqual({ threadId: "s-new", response: "Ответ", events: [] });
  expect(events).toEqual([{ type: "thread.started", payload: { threadId: "s-new" } }]);
  expect(calls[0]!.options.resume).toBeUndefined();
  expect(calls[0]!.options.model).toBe("glm-5.3-flash");
  expect(calls[0]!.prompt).toEqual([{ type: "user", message: { role: "user", content: [{ type: "text", text: "Привет" }] }, parent_tool_use_id: null }]);
  const second = await engine("zai", query).run("Ещё", { threadId: "s-new", profile: "Имя: Ада\nОтвечай стихами" });
  expect(second.threadId).toBe("s-new");
  expect(calls[1]!.options.resume).toBe("s-new");
  const prompt = calls[1]!.options.systemPrompt as { type: string; preset: string; append: string; snapshot: boolean };
  expect(prompt).toMatchObject({ type: "preset", preset: "claude_code", snapshot: false });
  expect(prompt.append).toContain("Current employee SOUL (authoritative):\nИмя: Ада\nОтвечай стихами");
  // The agent answers first; it is not told to stop for a question.
  expect(prompt.append).toContain("Use reasonable assumptions for harmless details");
  expect(prompt.append).not.toMatch(/Codex's|request_user_input/);
});

it("serves employee tools in-process and returns their JSON or error", async () => {
  const { query, calls } = fake();
  const seen: unknown[] = [];
  await engine("deepseek", query).run("Hi", { tools: { definitions: [
    { type: "function", name: "save_schedule", description: "Save", inputSchema: { type: "object", properties: { id: { type: ["string", "null"] }, cron: { type: "string" } }, required: ["id", "cron"], additionalProperties: false } },
    { type: "function", name: "list_employees", description: "List", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
  ], call: async (name, args) => { seen.push([name, args]); if (name === "list_employees") throw new Error("Список недоступен"); return { saved: true }; } } });
  const server = calls[0]!.options.mcpServers!.openstrudel as any;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const { tools } = await client.listTools();
  expect(tools.map(t => t.name)).toEqual(["save_schedule", "list_employees"]);
  expect(tools[0]!.inputSchema).toMatchObject({ properties: { id: { type: ["string", "null"] }, cron: { type: "string" } }, required: ["id", "cron"] });
  expect(await client.callTool({ name: "save_schedule", arguments: { id: null, cron: "0 9 * * *" } })).toMatchObject({ content: [{ type: "text", text: '{"saved":true}' }] });
  expect(await client.callTool({ name: "list_employees", arguments: {} })).toMatchObject({ isError: true, content: [{ type: "text", text: "Список недоступен" }] });
  expect(seen).toEqual([["save_schedule", { id: null, cron: "0 9 * * *" }], ["list_employees", {}]]);
  await client.close();
  expect(await allow(calls[0]!, "mcp__openstrudel__save_schedule", {}, { mcpServer: { name: "openstrudel", source: "sdk" } })).toMatchObject({ behavior: "allow" });
});

it("asks the owner through the same requests Codex makes", async () => {
  const { query, calls } = fake();
  const requests: Array<[string, Record<string, any>]> = [];
  let decision = "accept";
  await engine("kimi", query).run("Hi", { approvalMode: "ask", onRequest: async (method, params) => {
    requests.push([method, params]);
    if (method === "item/tool/requestUserInput") return { answers: { "0": { answers: ["B"] } } };
    if (method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
    return { decision };
  } });
  const call = calls[0]!, cwd = join(root, ".data/workspace/personal"), outside = join(realpathSync(root), "outside.md");
  expect(call.options.sandbox).toEqual({ enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: true, failIfUnavailable: false,
    filesystem: { denyRead: [realpathSync(join(root, ".data")), realpathSync(homedir())], allowRead: [realpathSync(cwd)] } });
  expect(await allow(call, "Bash", { command: "rm -rf build", description: "Clean" })).toMatchObject({ behavior: "allow" });
  decision = "decline";
  expect(await allow(call, "Bash", { command: "curl x", description: "Fetch" })).toMatchObject({ behavior: "deny" });
  expect(await allow(call, "Write", { file_path: join(cwd, "notes/a.md"), content: "x" })).toMatchObject({ behavior: "allow" });
  expect(await allow(call, "Edit", { file_path: outside, old_string: "a", new_string: "b" })).toMatchObject({ behavior: "deny" });
  const question = { question: "Pick one?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] };
  expect(await allow(call, "AskUserQuestion", { questions: [question] })).toEqual({ behavior: "allow", updatedInput: { questions: [question], answers: { "Pick one?": "B" } } });
  expect(await allow(call, "mcp__notion__search", { query: "q" }, { mcpServer: { name: "notion", source: "dynamic" } })).toMatchObject({ behavior: "deny" });
  expect(await allow(call, "Skill", { skill: "x" })).toMatchObject({ behavior: "deny" });
  expect(await allow(call, "WebFetch", { url: "https://example.com" })).toMatchObject({ behavior: "allow" });
  expect(requests).toEqual([
    ["item/commandExecution/requestApproval", { command: "rm -rf build", cwd, reason: "Clean" }],
    ["item/commandExecution/requestApproval", { command: "curl x", cwd, reason: "Fetch" }],
    ["item/fileChange/requestApproval", { reason: `Edit ${outside}`, grantRoot: realpathSync(root) }],
    ["item/tool/requestUserInput", { questions: [{ id: "0", header: "Pick", question: "Pick one?", options: question.options }] }],
    ["mcpServer/elicitation/request", { mode: "form", serverName: "notion", message: 'Allow the notion MCP server to run tool "search"?',
      requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { query: "q" } } }],
  ]);
});

it("keeps approve-all writes in the workspace and a group's commands in its sandbox", async () => {
  const { query, calls } = fake();
  const asked: string[] = [];
  const onRequest = async (method: string) => { asked.push(method); return { decision: "accept" }; };
  const groupContext = "group-" + "a".repeat(64), groupWorkspace = join(root, ".data/workspace", groupContext);
  await engine("kimi", query).run("Hi", { approvalMode: "approve_all", onRequest });
  await engine("kimi", query).forContext(groupContext).run("Hi", { approvalMode: "approve_all", groupContext: true, onRequest });
  await engine("kimi", query).run("Hi", { approvalMode: "ask" });
  await engine("kimi", query).forContext(groupContext).run("Hi", { approvalMode: "approve_all", groupContext: true, scheduled: true });
  await engine("kimi", query).forContext(groupContext).run("Hi", { approvalMode: "ask", groupContext: true, onRequest });
  const [all, group, unattended, scheduledGroup, askingGroup] = calls as [Call, Call, Call, Call, Call];
  const filesystem = (workspace: string) => ({ denyRead: [realpathSync(join(root, ".data")), realpathSync(homedir())], allowRead: [realpathSync(workspace)] });
  expect(all.options.sandbox).toEqual({ enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true, filesystem: filesystem(join(root, ".data/workspace/personal")) });
  expect(await allow(all, "Bash", { command: "make" })).toMatchObject({ behavior: "allow" });
  expect(await allow(all, "mcp__notion__search", {}, { mcpServer: { name: "notion", source: "dynamic" } })).toMatchObject({ behavior: "allow" });
  expect(await allow(all, "Write", { file_path: "report.md", content: "x" })).toMatchObject({ behavior: "allow" });
  expect(await allow(all, "Write", { file_path: "../../outside.md", content: "x" })).toMatchObject({ behavior: "deny" });
  // A group's live turn runs commands only in its sandbox and changes files only in its own workspace, like Codex.
  expect(group.options.sandbox).toEqual({ enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true, filesystem: filesystem(groupWorkspace) });
  expect(await allow(group, "Bash", { command: "ls" })).toMatchObject({ behavior: "allow" });
  expect(await allow(group, "Write", { file_path: "a.md", content: "x" })).toMatchObject({ behavior: "allow" });
  expect(await allow(group, "Write", { file_path: "../personal/a.md", content: "x" })).toMatchObject({ behavior: "deny" });
  // In every mode the sandbox is required in a group: a command cannot leave it, and a change outside the workspace is refused without asking.
  expect(askingGroup.options.sandbox).toEqual(group.options.sandbox);
  expect(await allow(askingGroup, "Bash", { command: "echo x > made.txt" })).toMatchObject({ behavior: "allow" });
  expect(await allow(askingGroup, "Edit", { file_path: join(root, "outside.md"), old_string: "a", new_string: "b" })).toMatchObject({ behavior: "deny" });
  expect(await allow(askingGroup, "Edit", { file_path: "notes.md", old_string: "a", new_string: "b" })).toMatchObject({ behavior: "allow" });
  expect(await allow(unattended, "Bash", { command: "ls" })).toMatchObject({ behavior: "deny" });
  expect(await allow(unattended, "AskUserQuestion", { questions: [] })).toMatchObject({ behavior: "deny" });
  // The owner's schedule in a group runs its saved work like the owner's own chat, sandboxed.
  expect(scheduledGroup.options.sandbox).toMatchObject({ enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true });
  expect(await allow(scheduledGroup, "Bash", { command: "python3 scripts/news/wai-news.py claim" })).toMatchObject({ behavior: "allow" });
  expect(await allow(scheduledGroup, "Write", { file_path: "state.json", content: "x" })).toMatchObject({ behavior: "allow" });
  expect(asked).toEqual([]);
  // Services still ask in a group, as before.
  await allow(askingGroup, "mcp__notion__search", {}, { mcpServer: { name: "notion", source: "dynamic" } });
  expect(asked).toEqual(["mcpServer/elicitation/request"]);
});

it("stops the turn gracefully, and kills it only when the engine closes", async () => {
  // An interrupt lets the CLI finish its transcript and exit before the next turn resumes the session.
  const { query, calls } = fake(async function* (call) { yield init(); await call.interrupted; yield interrupted; });
  const stop = new AbortController();
  const run = engine("kimi", query).run("Hi", { signal: stop.signal });
  setTimeout(() => stop.abort(), 10);
  await expect(run).rejects.toThrow("Ответ остановлен");
  expect(calls[0]!.options.abortController!.signal.aborted).toBe(false);
  const hung = fake(async function* (call) { yield init(); await aborted(call); throw new Error("Claude Code process aborted by user"); });
  const closing = engine("kimi", hung.query);
  const pending = closing.run("Hi");
  setTimeout(() => closing.close(), 10);
  await expect(pending).rejects.toThrow("Ответ остановлен");
});

it("fails fast on a rejected key and keeps other provider errors short", async () => {
  const retrying = fake(async function* (call) {
    yield init();
    yield { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 401, error: "authentication_failed", session_id: "s-1" };
    await call.interrupted;
    yield interrupted;
  });
  const error = await engine("kimi", retrying.query).run("Hi").catch(e => e);
  expect(error).toBeInstanceOf(ProviderKeyError);
  expect(error.provider.id).toBe("kimi");
  expect(retrying.calls[0]!.options.abortController!.signal.aborted).toBe(false);
  const final = fake(() => [init(), { type: "result", subtype: "success", is_error: true, api_error_status: 403, result: "API Error: 403 forbidden", session_id: "s-1" }]);
  await expect(engine("anthropic", final.query).run("Hi")).rejects.toBeInstanceOf(ProviderKeyError);
  const dump = fake(() => [init(), { type: "result", subtype: "success", is_error: true, api_error_status: 400, result: "API Error: 400 model glm-9 does not exist\n" + "x".repeat(600), session_id: "s-1" }]);
  await expect(engine("zai", dump.query).run("Hi")).rejects.toThrow(/^GLM Coding Plan не завершил ответ: 400 model glm-9 does not exist$/);
  const crash = fake(async function* () { yield init(); throw new Error("Claude Code process exited with code 1"); });
  await expect(engine("zai", crash.query).run("Hi")).rejects.toThrow("GLM Coding Plan не завершил ответ: Claude Code process exited with code 1");
  // Kimi Code refuses an exhausted plan with 403, which Claude Code reports as an authentication failure.
  const quota = "Failed to authenticate. API Error: 403 You've reached your usage limit for this billing cycle";
  const exhausted = fake(() => [init(), { type: "assistant", error: "authentication_failed", message: { role: "assistant", content: [{ type: "text", text: quota }] }, session_id: "s-1" },
    { type: "result", subtype: "success", is_error: true, api_error_status: 403, result: quota, session_id: "s-1" }]);
  const limited = await engine("kimicode", exhausted.query).run("Hi").catch(e => e);
  expect(limited).not.toBeInstanceOf(ProviderKeyError);
  expect(limited).toBeInstanceOf(ProviderIncident);
  expect(limited.reason).toBe("limits:kimicode");
  expect(exhausted.calls[0]!.options.env).toMatchObject({ ANTHROPIC_API_KEY: "sk-test-key", ANTHROPIC_BASE_URL: "https://api.kimi.ai/coding", ANTHROPIC_DEFAULT_HAIKU_MODEL: "k3-256k" });
  expect(exhausted.calls[0]!.options.env).not.toHaveProperty("API_TIMEOUT_MS");
  expect(dump.calls[0]!.options.env).toMatchObject({ API_TIMEOUT_MS: "3000000" });
});

it("sends images only to models that accept them", async () => {
  const png = join(root, "photo"), text = join(root, "note.png");
  writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]));
  writeFileSync(text, "not an image");
  const { query, calls } = fake();
  await engine("zai", query).run("Что на фото?", { model: "glm-5.3-flash", images: [png, text] });
  await engine("zai", query).run("Что на фото?", { model: "glm-5.3", images: [png] });
  expect(calls[0]!.prompt[0]!.message.content).toEqual([{ type: "text", text: "Что на фото?" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]).toString("base64") } }]);
  expect(calls[1]!.prompt[0]!.message.content).toEqual([{ type: "text", text: "Что на фото?" }]);
});

it("brings the context's MCP services like Codex, from a private file instead of the command line", async () => {
  mkdirSync(join(root, ".data/extensions/work"), { recursive: true });
  mkdirSync(join(root, ".data/connections"), { recursive: true });
  writeFileSync(join(root, ".data/extensions/work/config.toml"), `[mcp_servers.notion]\nenabled = true\nurl = "https://mcp.notion.com/mcp"\n[mcp_servers.notion.http_headers]\nAuthorization = "Bearer n"\n
[mcp_servers.files]\ncommand = "/usr/bin/files-mcp"\nargs = ["--root", "."]\n[mcp_servers.files.env]\nMODE = "read"\n
[mcp_servers.off]\nenabled = false\ncommand = "off"\n[mcp_servers.cua_repl]\nenabled = true\ncommand = "/Applications/Codex.app/cua"\n`);
  // Installer-provisioned services, and Telegram services that act as the verified sender only.
  writeFileSync(join(root, ".data/connections/work.toml"), `[mcp_servers.wai_company]\nurl = "https://wai.example/mcp"\n[mcp_servers.wai_company.http_headers]\nAuthorization = "Bearer w"\n`);
  writeFileSync(join(root, ".data/connections/work.telegram.json"), JSON.stringify({ wai_telegram: { url: "https://tg.example/mcp", http_headers: { Authorization: "Bearer t", "x-hermes-user-id": "1" } } }));
  const files: Array<{ servers: Record<string, unknown>; mode: number }> = [];
  const { query, calls } = fake(call => {
    const path = call.options.extraArgs!["mcp-config"]!;
    files.push({ servers: JSON.parse(readFileSync(path, "utf8")).mcpServers, mode: statSync(path).mode & 0o777 });
    return [init(), success("Привет")];
  });
  await engine("openrouter", query).forContext("work").run("Hi", { tools: { definitions: [], call: async () => null },
    telegramActor: { userId: "42", chatId: "-100123", messageId: "7" }, conversationId: "c-1" });
  await engine("openrouter", query).forContext("work").run("Hi");
  const [telegram, plain] = files as [typeof files[0], typeof files[0]];
  expect(Object.keys(calls[0]!.options.mcpServers!)).toEqual(["openstrudel"]);
  expect(calls[1]!.options.mcpServers).toEqual({});
  expect(telegram.mode).toBe(0o600);
  expect(telegram.servers).toEqual({
    notion: { type: "http", url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer n" } },
    files: { type: "stdio", command: "/usr/bin/files-mcp", args: ["--root", "."], env: { MODE: "read" } },
    wai_company: { type: "http", url: "https://wai.example/mcp", headers: { Authorization: "Bearer w" } },
    wai_telegram: { type: "http", url: "https://tg.example/mcp", headers: { Authorization: "Bearer t", "x-hermes-platform": "telegram",
      "x-hermes-user-id": "42", "x-hermes-chat-id": "-100123", "x-hermes-message-id": "7", "x-hermes-session-id": "openstrudel:c-1" } },
  });
  expect(Object.keys(plain.servers).sort()).toEqual(["files", "notion", "wai_company"]);
  expect(readdirSync(join(root, ".data/providers/openrouter/claude/work")).filter(f => f.startsWith("mcp-"))).toEqual([]);
  expect(calls[0]!.options.disallowedTools).toContain("WebSearch");
});

it("keeps Codex's per-service tool lists and environment credentials", async () => {
  process.env.OPENSTRUDEL_TEST_TUTU = "tutu-token"; process.env.OPENSTRUDEL_TEST_MAPS = "maps-key";
  try {
    mkdirSync(join(root, ".data/extensions/work"), { recursive: true });
    writeFileSync(join(root, ".data/extensions/work/config.toml"), `[mcp_servers.tutu]\nurl = "https://mcp.tutu.ru/mcp"\nbearer_token_env_var = "OPENSTRUDEL_TEST_TUTU"\ndisabled_tools = ["register_checkout_passengers"]\n
[mcp_servers.maps]\nurl = "https://maps.example/mcp"\nenabled_tools = ["search"]\n[mcp_servers.maps.http_headers]\nX-Client = "home"\n[mcp_servers.maps.env_http_headers]\nX-Goog-Api-Key = "OPENSTRUDEL_TEST_MAPS"\n
[mcp_servers.files]\ncommand = "/usr/bin/files-mcp"\ndisabled_tools = ["delete"]\n`);
    const written: unknown[] = [];
    const { query, calls } = fake(call => { written.push(JSON.parse(readFileSync(call.options.extraArgs!["mcp-config"]!, "utf8")).mcpServers); return [init(), success("ok")]; });
    await engine("anthropic", query).forContext("work").run("Hi", { approvalMode: "approve_all" });
    expect(written[0]).toEqual({ tutu: { type: "http", url: "https://mcp.tutu.ru/mcp", headers: { Authorization: "Bearer tutu-token" } },
      maps: { type: "http", url: "https://maps.example/mcp", headers: { "X-Client": "home", "X-Goog-Api-Key": "maps-key" } },
      files: { type: "stdio", command: "/usr/bin/files-mcp", args: [] } });
    const call = calls[0]!, from = (name: string) => ({ mcpServer: { name, source: "dynamic" as const } });
    // The model never sees a turned-off tool, and a call to one is refused anyway.
    expect(call.options.disallowedTools).toEqual(expect.arrayContaining(["mcp__tutu__register_checkout_passengers", "mcp__files__delete"]));
    expect(await allow(call, "mcp__tutu__register_checkout_passengers", {}, from("tutu"))).toMatchObject({ behavior: "deny" });
    expect(await allow(call, "mcp__tutu__search_avia", {}, from("tutu"))).toMatchObject({ behavior: "allow" });
    expect(await allow(call, "mcp__maps__search", {}, from("maps"))).toMatchObject({ behavior: "allow" });
    expect(await allow(call, "mcp__maps__directions", {}, from("maps"))).toMatchObject({ behavior: "deny" });
    expect(await allow(call, "mcp__files__delete", {}, from("files"))).toMatchObject({ behavior: "deny" });
    expect(await allow(call, "mcp__files__read", {}, from("files"))).toMatchObject({ behavior: "allow" });
  } finally { delete process.env.OPENSTRUDEL_TEST_TUTU; delete process.env.OPENSTRUDEL_TEST_MAPS; }
});

it("reads and changes only the real workspace, in every mode", async () => {
  const { query, calls } = fake();
  const asked: string[] = [];
  const onRequest = async (method: string, params: any) => { asked.push(`${method} ${params.reason}`); return { decision: "accept" }; };
  await engine("kimi", query).run("Hi", { approvalMode: "approve_all", onRequest });
  await engine("kimi", query).run("Hi", { approvalMode: "ask", onRequest });
  await engine("kimi", query).forContext("group-" + "b".repeat(64)).run("Hi", { approvalMode: "approve_all", groupContext: true, onRequest });
  const [all, ask, group] = calls as [Call, Call, Call];
  const cwd = join(root, ".data/workspace/personal"), data = realpathSync(join(root, ".data"));
  mkdirSync(join(root, ".data/codex"));
  writeFileSync(join(root, ".data/codex/auth.json"), "{}");
  writeFileSync(join(cwd, "notes.md"), "x");
  // A command inside the workspace can leave links that point anywhere.
  symlinkSync(join(root, ".data"), join(cwd, "escape"));
  symlinkSync(join(root, ".data/extensions/new.toml"), join(cwd, "dangling"));
  for (const call of [all, ask, group]) for (const path of [join(root, ".data/codex/auth.json"), join(cwd, "escape/codex/auth.json"), "/etc/hosts"])
    expect(await allow(call, "Read", { file_path: path }), path).toMatchObject({ behavior: "deny" });
  for (const call of [all, ask]) expect(await allow(call, "Read", { file_path: join(cwd, "notes.md") })).toMatchObject({ behavior: "allow" });
  for (const path of ["escape/extensions/work/config.toml", "dangling"])
    expect(await allow(all, "Write", { file_path: join(cwd, path), content: "x" }), path).toMatchObject({ behavior: "deny" });
  expect(await allow(all, "Workflow", { script: "x" })).toMatchObject({ behavior: "deny" });
  expect(asked).toEqual([]);
  // Asking shows the owner where the change really goes.
  expect(await allow(ask, "Write", { file_path: join(cwd, "escape/pwned.txt"), content: "x" })).toMatchObject({ behavior: "allow" });
  expect(asked).toEqual([`item/fileChange/requestApproval Write ${join(data, "pwned.txt")}`]);
});

it("states turn failures and stops as catalog text", async () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync("public/localization.js", "utf8"), context);
  const english = context.StrudelLocale.create(JSON.parse(readFileSync("public/localizations.json", "utf8")), "en");
  const failed = fake(() => [init(), { type: "result", subtype: "success", is_error: true, api_error_status: 400, result: "API Error: 400 model glm-9 does not exist", session_id: "s-1" }]);
  const failure = await engine("zai", failed.query).run("Hi").catch(e => e.message);
  expect(english.error(failure)).toBe("GLM Coding Plan did not finish the reply: 400 model glm-9 does not exist");
  const stop = new AbortController();
  stop.abort();
  const stopped = fake(async function* (call) { yield init(); await call.interrupted; yield interrupted; });
  expect(english.error(await engine("zai", stopped.query).run("Hi", { signal: stop.signal }).catch(e => e.message))).toBe("Reply stopped");
});

it('gets only reported Anthropic effort levels and passes an explicit choice to the native SDK', async()=>{
 const f=fake(undefined,[{value:'fable',resolvedModel:'claude-fable-5-1',supportsEffort:true,supportedEffortLevels:['low','high']}]);
 const e=engine('anthropic',f.query);
 expect((await e.models()).find(m=>m.id==='claude-fable-5-1')?.reasoningEfforts?.map(x=>x.id)).toEqual(['low','high']);
 expect(f.calls).toHaveLength(0); // Listing models submits no user turn.
 await e.run('Think',{reasoningEffort:'high'});
 expect(f.calls[0].options.effort).toBe('high');
 await expect(e.run('Unsupported',{reasoningEffort:'ultra'})).rejects.toThrow('обдумывания');
 expect(f.calls).toHaveLength(1);
 const kimi=engine('kimi',f.query);
 expect((await kimi.models()).every(m=>!m.reasoningEfforts?.length)).toBe(true);
 await expect(kimi.run('No inherited Claude controls',{reasoningEffort:'high'})).rejects.toThrow('обдумывания');
});
