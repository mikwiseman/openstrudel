import { afterEach, beforeEach, expect, it, onTestFinished } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeEngine } from "../src/claude.js";
import { ProviderKeyError, providerInfo } from "../src/providers.js";
import { mockAnthropic, type MockRequest } from "./fixtures/mock-anthropic.js";

// The real Claude Code binary from the pinned SDK against a local Messages endpoint.
let root: string, mock: Awaited<ReturnType<typeof mockAnthropic>> | undefined, engines: ClaudeEngine[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "claude-e2e-")); });
// close() stops a CLI process that a failed test left running.
afterEach(async () => { for (const engine of engines) engine.close(); engines = []; await mock?.close(); mock = undefined; rmSync(root, { recursive: true, force: true }); });

const claude = (id: string, key: string) => { const engine = new ClaudeEngine({ root, provider: { ...providerInfo(id)!, baseUrl: mock!.url }, key: () => key }); engines.push(engine); return engine; };
// Claude Code may follow a tool result with its own system-role messages.
const toolResult = (request: MockRequest) => {
  const content = request.body?.messages?.findLast((m: any) => m.role === "user")?.content;
  return Array.isArray(content) ? content.find((b: any) => b.type === "tool_result") : undefined;
};
const results = (request: MockRequest): any[] => request.body?.messages?.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_result") : []) ?? [];
const endpoints = () => [...new Set(mock!.requests.map(r => `${r.method} ${r.path}`))];

it("answers, resumes the same session with a changed SOUL and sends a bearer token", async () => {
  let turn = 0;
  mock = await mockAnthropic(() => ({ text: `Ответ ${++turn}` }));
  const engine = claude("kimi", "sk-kimi-secret");
  const started: unknown[] = [];
  const first = await engine.run("Привет", { profile: "Имя: Ада", onEvent: event => started.push(event) });
  expect(first.response).toBe("Ответ 1");
  expect(first.threadId).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
  expect(started.filter((e: any) => e.type !== "turn.usage")).toEqual([{ type: "thread.started", payload: { threadId: first.threadId } },{type:"turn.progress",payload:{}}]);
  // The CLI's totals for a resumed session include its earlier turns; the saved totals leave just this turn.
  const spent = (events: unknown[]) => (events as Array<{ type: string; payload: any }>).filter(e => e.type === "turn.usage").map(e => e.payload);
  const [firstUsage] = spent(started);
  expect(firstUsage).toMatchObject({ model: "kimi-k3", engine: { thread: first.threadId, totals: { modelUsage: { "kimi-k3": { inputTokens: 10, outputTokens: 5 } } } },
    usage: { inputTokens: 10, outputTokens: 5 } });
  // Kimi has no list price in the CLI, so no cost is claimed.
  expect(firstUsage.usage.costUsdTicks).toBeUndefined();
  const later: unknown[] = [];
  const second = await engine.run("Как тебя зовут?", { threadId: first.threadId, profile: "Имя: Бета", usageBaseline: firstUsage.engine.totals, onEvent: event => later.push(event) });
  expect(spent(later)).toMatchObject([{ usage: { inputTokens: 10, outputTokens: 5 }, engine: { totals: { modelUsage: { "kimi-k3": { inputTokens: 20, outputTokens: 10 } } } } }]);
  expect(second).toEqual({ threadId: first.threadId, response: "Ответ 2", events: [] });
  const last = mock.requests.at(-1)!;
  expect(JSON.stringify(last.body.messages)).toContain("Ответ 1");
  expect(JSON.stringify(last.body.system)).toContain("Имя: Бета");
  expect(JSON.stringify(last.body.system)).not.toContain("Имя: Ада");
  expect(endpoints()).toEqual(["POST /v1/messages?beta=true"]);
  for (const request of mock.requests) {
    expect(request.headers.authorization).toBe("Bearer sk-kimi-secret");
    expect(request.headers["x-api-key"]).toBeUndefined();
    expect(request.body.model).toBe("kimi-k3");
  }
  const config = join(root, ".data/providers/kimi/claude/personal");
  expect(readdirSync(config, { recursive: true }).map(String).filter(f => f.endsWith(".jsonl"))).toEqual([expect.stringContaining(first.threadId + ".jsonl")]);
}, 90_000);

it("counts a resumed session's turn alone after another session ran in the same workspace", async () => {
  mock = await mockAnthropic(() => ({ text: "Ок" }));
  const engine = claude("kimi", "sk-kimi-secret");
  const usage = (events: unknown[]) => (events as Array<{ type: string; payload: any }>).find(e => e.type === "turn.usage")?.payload;
  const a1: unknown[] = [], b1: unknown[] = [], a2: unknown[] = [];
  const a = await engine.run("Первый", { onEvent: event => a1.push(event) });
  await engine.run("Второй", { onEvent: event => b1.push(event) });
  await engine.run("Снова первый", { threadId: a.threadId, usageBaseline: usage(a1).engine.totals, onEvent: event => a2.push(event) });
  // The CLI restores each resumed session's own running totals, not only the workspace's latest session.
  expect(usage(a2).engine.totals).toMatchObject({ modelUsage: { "kimi-k3": { inputTokens: 20, outputTokens: 10 } } });
  expect(usage(a2).usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
});

it("calls an OpenStrudel tool with an Anthropic key and returns its result to the model", async () => {
  mock = await mockAnthropic(request => {
    const result = toolResult(request);
    return result ? { text: "Сохранено: " + JSON.stringify(result.content) } : { tool: { name: "mcp__openstrudel__save_schedule", input: { id: null, cron: "0 9 * * *" } } };
  });
  const engine = claude("anthropic", "sk-ant-secret");
  const calls: unknown[] = [];
  const result = await engine.run("Напоминай каждое утро", { tools: { definitions: [{ type: "function", name: "save_schedule", description: "Save a schedule",
    inputSchema: { type: "object", properties: { id: { type: ["string", "null"] }, cron: { type: "string" } }, required: ["id", "cron"], additionalProperties: false } }],
  call: async (name, args) => { calls.push([name, args]); return { saved: true, id: "sch-1" }; } } });
  expect(calls).toEqual([["save_schedule", { id: null, cron: "0 9 * * *" }]]);
  expect(result.response).toContain('{\\"saved\\":true,\\"id\\":\\"sch-1\\"}');
  expect(mock.requests[0]!.body.tools.map((t: any) => t.name)).toContain("mcp__openstrudel__save_schedule");
  expect(endpoints()).toEqual(["POST /v1/messages?beta=true"]);
  for (const request of mock.requests) {
    expect(request.headers["x-api-key"]).toBe("sk-ant-secret");
    expect(request.headers.authorization).toBeUndefined();
    expect(request.body.model).toBe("claude-fable-5-1");
  }
}, 90_000);

it("stops at once when the provider rejects the key instead of retrying for minutes", async () => {
  mock = await mockAnthropic(() => ({ status: 401, type: "authentication_error", message: "invalid key" }));
  const started = Date.now();
  await expect(claude("zai", "sk-revoked").run("Привет")).rejects.toBeInstanceOf(ProviderKeyError);
  expect(Date.now() - started).toBeLessThan(15_000);
}, 90_000);

it("returns a quota refusal immediately, before the CLI retries", async () => {
  mock = await mockAnthropic(() => ({status:429,type:"rate_limit_error",message:"usage limit reached"}));
  const started = Date.now();
  await expect(claude("anthropic","sk-limited").run("Привет")).rejects.toMatchObject({reason:"limits:anthropic"});
  expect(Date.now()-started).toBeLessThan(15_000);
  expect(mock.requests.filter(r=>r.path.startsWith("/v1/messages?"))).toHaveLength(1);
}, 30_000);

it("keeps the key out of command environments and a private HOME", async () => {
  mock = await mockAnthropic(request => toolResult(request) ? { text: "Готово" } : { tool: { name: "Bash", input: { command: "env", description: "Show environment" } } });
  const engine = claude("deepseek", "sk-deepseek-secret");
  // Without a sandbox (Linux without bubblewrap) the command asks; with one it runs without asking.
  await engine.run("Покажи окружение", { onRequest: async () => ({ decision: "accept" }) });
  const output = JSON.stringify(toolResult(mock.requests.at(-1)!));
  expect(output).toContain(`HOME=${join(root, ".data/providers/deepseek/claude/personal/home")}`);
  expect(output).not.toContain("sk-deepseek-secret");
}, 90_000);

it("keeps an approve-all turn out of the Home's private data", async () => {
  const data = join(root, ".data"), cwd = join(data, "workspace/personal");
  mkdirSync(join(data, "codex"), { recursive: true });
  writeFileSync(join(data, "openstrudel.sqlite"), "providers.anthropic.key=sk-ant-PLANTED\n");
  writeFileSync(join(data, "codex/auth.json"), '{"access_token":"CHATGPT-PLANTED"}\n');
  // The owner's own files, like ~/.ssh, stay closed too.
  const owner = mkdtempSync(join(homedir(), ".openstrudel-sandbox-test-"));
  writeFileSync(join(owner, "id_ed25519"), "OWNER-PLANTED\n");
  onTestFinished(() => rmSync(owner, { recursive: true, force: true }));
  const steps = [
    { name: "Bash", input: { command: `cat ${join(owner, "id_ed25519")}`, description: "Read the owner's key" } },
    { name: "Bash", input: { command: "cat ../../openstrudel.sqlite", description: "Read the database" } },
    { name: "Bash", input: { command: `ln -s ${data} escape && echo inside > note.txt && cat note.txt`, description: "Link" } },
    { name: "Read", input: { file_path: join(cwd, "escape/codex/auth.json") } },
    { name: "Write", input: { file_path: join(cwd, "escape/pwned.txt"), content: "pwned" } },
  ];
  mock = await mockAnthropic(request => { const step = steps[results(request).length]; return step ? { tool: step } : { text: "Готово" }; });
  const asked: unknown[] = [];
  await claude("deepseek", "sk-deepseek-secret").run("Покажи", { approvalMode: "approve_all", onRequest: async (...request) => { asked.push(request); return { decision: "accept" }; } });
  const outputs = results(mock.requests.at(-1)!).map(r => JSON.stringify(r.content));
  expect(outputs).toHaveLength(5);
  expect(outputs[2]).toContain("inside");
  expect(outputs.join("\n")).not.toContain("PLANTED");
  expect(existsSync(join(data, "pwned.txt"))).toBe(false);
  expect(asked).toEqual([]);
}, 90_000);

it("runs a group's commands in its sandbox and changes files only in its workspace, without asking", async () => {
  const group = "group-" + "d".repeat(64), cwd = join(root, ".data/workspace", group), data = join(root, ".data");
  const steps = [
    { name: "Bash", input: { command: "echo made > made.txt && cat made.txt", description: "Make a file" } },
    { name: "Write", input: { file_path: join(cwd, "notes.md"), content: "group notes" } },
    { name: "Bash", input: { command: `echo pwned > ${join(data, "bash.txt")}; echo pwned > ${join(root, "bash.txt")}`, description: "Write outside" } },
    { name: "Bash", input: { command: `echo pwned > ${join(data, "unsandboxed.txt")}`, description: "Write outside", dangerouslyDisableSandbox: true } },
    { name: "Write", input: { file_path: join(data, "write.txt"), content: "pwned" } },
  ];
  mock = await mockAnthropic(request => { const step = steps[results(request).length]; return step ? { tool: step } : { text: "Готово" }; });
  const asked: unknown[] = [];
  await claude("deepseek", "sk-deepseek-secret").forContext(group).run("Сделай", { groupContext: true, approvalMode: "ask", onRequest: async (...request) => { asked.push(request); return { decision: "decline" }; } });
  expect(results(mock.requests.at(-1)!)).toHaveLength(5);
  expect(readFileSync(join(cwd, "made.txt"), "utf8")).toBe("made\n");
  expect(readFileSync(join(cwd, "notes.md"), "utf8")).toBe("group notes");
  for (const file of [join(data, "bash.txt"), join(root, "bash.txt"), join(data, "unsandboxed.txt"), join(data, "write.txt")]) expect(existsSync(file), file).toBe(false);
  expect(asked).toEqual([]);
}, 90_000);

it("keeps MCP service tokens out of the CLI's process arguments", async () => {
  const seen: string[] = [];
  const service = createServer((req, res) => { seen.push(String(req.headers.authorization)); res.writeHead(500).end(); });
  await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(service.address() as AddressInfo).port}/mcp`;
    mkdirSync(join(root, ".data/extensions/personal"), { recursive: true });
    writeFileSync(join(root, ".data/extensions/personal/config.toml"), `[mcp_servers.svc]\nurl = "${url}"\n[mcp_servers.svc.http_headers]\nAuthorization = "Bearer MCP-SECRET-TOKEN"\n`);
    let cli: string[] = [];
    // While the CLI waits for the model, list what every process on this machine can read about it.
    mock = await mockAnthropic(() => {
      cli = execFileSync("ps", ["-ww", "-ax", "-o", "args="], { encoding: "utf8" }).split("\n").filter(line => line.includes("--mcp-config") && (line.includes(root) || line.includes(url)));
      return { text: "Готово" };
    });
    await claude("kimi", "sk-kimi-secret").run("Привет");
    expect(cli).toEqual([expect.stringContaining(`--mcp-config ${join(root, ".data/providers/kimi/claude/personal/mcp-")}`)]);
    expect(cli.join("\n")).not.toContain("MCP-SECRET-TOKEN");
    expect(seen).toContain("Bearer MCP-SECRET-TOKEN");
  } finally { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); }
}, 90_000);

it("never starts the owner's keyed services for a group sender without access", async () => {
  const seen: string[] = [];
  const service = createServer(async (req, res) => {
    seen.push(String(req.headers.authorization));
    let raw = ""; for await (const chunk of req) raw += chunk;
    const message = raw ? JSON.parse(raw) : {};
    if (req.method !== "POST" || message.id === undefined) { res.writeHead(req.method === "POST" ? 202 : 405).end(); return; }
    const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "svc", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "private_lookup", description: "Owner's private data", inputSchema: { type: "object", properties: {} } }] } : {};
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(service.address() as AddressInfo).port}/mcp`, group = "group-" + "c".repeat(64);
    mkdirSync(join(root, ".data/extensions/personal"), { recursive: true });
    writeFileSync(join(root, ".data/extensions/personal/config.toml"), `[mcp_servers.svc]\nurl = "${url}"\n[mcp_servers.svc.http_headers]\nAuthorization = "Bearer OWNER"\n`);
    writeFileSync(join(root, ".data/extensions/all-chats.json"), '{"enabled":true}\n');
    mock = await mockAnthropic(() => ({ text: "Готово" }));
    const engine = claude("kimi", "sk-kimi-secret").forContext(group);
    await engine.run("Что у владельца?", { access: false, groupContext: true });
    expect(seen).toEqual([]);
    const tools = mock.requests.flatMap(r => (r.body?.tools ?? []).map((t: any) => String(t.name)));
    expect(tools.filter(name => name.startsWith("mcp__svc__"))).toEqual([]);
    await engine.run("Что у владельца?", { access: true, groupContext: true });
    expect(seen).toContain("Bearer OWNER");
  } finally { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); }
}, 90_000);
