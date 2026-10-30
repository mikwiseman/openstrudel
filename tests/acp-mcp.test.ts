import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { stdioBridge, toolBridge } from "../src/acp-mcp.js";

const tools = (seen: unknown[] = []) => ({ definitions: [
  { type: "function" as const, name: "save_schedule", description: "Save", inputSchema: { type: "object", properties: { id: { type: ["string", "null"] }, cron: { type: "string" } }, required: ["id", "cron"], additionalProperties: false } },
  { type: "function" as const, name: "list_employees", description: "List", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
], call: async (name: string, args: Record<string, unknown>) => { seen.push([name, args]); if (name === "list_employees") throw new Error("Список недоступен"); return { saved: true }; } });
const post = (url: string, token: string, method = "tools/list") => fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` } });

it("serves the employee tools to an MCP client that holds the turn's token", async () => {
  const seen: unknown[] = [];
  const bridge = await toolBridge(tools(seen));
  expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}$/);
  expect(bridge.token).toMatch(/^[a-f0-9]{64}$/);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { authorization: `Bearer ${bridge.token}` } } }));
  const { tools: listed } = await client.listTools();
  expect(listed.map(t => t.name)).toEqual(["save_schedule", "list_employees"]);
  expect(listed[0]).toMatchObject({ description: "Save", inputSchema: { properties: { id: { type: ["string", "null"] }, cron: { type: "string" } }, required: ["id", "cron"] } });
  expect(await client.callTool({ name: "save_schedule", arguments: { id: null, cron: "0 9 * * *" } })).toMatchObject({ content: [{ type: "text", text: '{"saved":true}' }] });
  expect(await client.callTool({ name: "list_employees", arguments: {} })).toMatchObject({ isError: true, content: [{ type: "text", text: "Список недоступен" }] });
  expect(await client.callTool({ name: "delete_everything", arguments: {} })).toMatchObject({ isError: true });
  expect(seen).toEqual([["save_schedule", { id: null, cron: "0 9 * * *" }], ["list_employees", {}]]);
  await client.close();
  await bridge.close();
});

it("refuses another token or path, and is gone once the turn ends", async () => {
  const bridge = await toolBridge(tools()), other = await toolBridge(tools());
  expect(other.url).not.toBe(bridge.url);
  expect(other.token).not.toBe(bridge.token);
  expect((await post(bridge.url, other.token)).status).toBe(401);
  expect((await post(new URL("/" + "0".repeat(32), bridge.url).href, bridge.token)).status).toBe(404);
  expect((await fetch(bridge.url, { headers: { authorization: `Bearer ${bridge.token}` } })).status).toBe(405);
  const listed = await post(bridge.url, bridge.token);
  expect(listed.status).toBe(200);
  expect((await listed.json()).result.tools).toHaveLength(2);
  await Promise.all([bridge.close(), other.close()]);
  await expect(post(bridge.url, bridge.token)).rejects.toThrow();
});

it("runs a stdio service outside the agent's sandbox behind the turn's endpoint, in the workspace, without host secrets, and stops it with the turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stdio-mcp-")), pidFile = join(dir, "pid");
  const server = join(dir, "server.mjs");
  writeFileSync(server, `import { createInterface } from "node:readline"; import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const send = m => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", line => { const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "news", version: "1" } } });
  else if (m.method === "tools/list") { send({ jsonrpc: "2.0", id: 99, method: "roots/list" }); send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "claim", inputSchema: { type: "object" } }] } }); }
  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ cwd: process.cwd(), key: process.env.NEWS_KEY_FILE ?? null, leak: process.env.OPENSTRUDEL_SECRET_FIXTURE ?? null, args: m.params.arguments }) }] } });
});`);
  process.env.OPENSTRUDEL_SECRET_FIXTURE = "host-only";
  try {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "workspace-")));
    const bridge = await stdioBridge({ command: process.execPath, args: [server], env: { NEWS_KEY_FILE: "/secrets/key" } }, workspace);
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}$/);
    expect((await post(bridge.url, "0".repeat(64))).status).toBe(401);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { authorization: `Bearer ${bridge.token}` } } }));
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(["claim"]);
    const called = await client.callTool({ name: "claim", arguments: { item: "AI-1" } }) as { content: Array<{ text: string }> };
    expect(JSON.parse(called.content[0]!.text)).toEqual({ cwd: workspace, key: "/secrets/key", leak: null, args: { item: "AI-1" } });
    await client.close();
    const pid = Number(readFileSync(pidFile, "utf8"));
    await bridge.close();
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    await expect(post(bridge.url, bridge.token)).rejects.toThrow();
  } finally { delete process.env.OPENSTRUDEL_SECRET_FIXTURE; }
});

it("answers with an error when a stdio service cannot start", async () => {
  const bridge = await stdioBridge({ command: "openstrudel-missing-mcp" }, tmpdir());
  const reply = await (await post(bridge.url, bridge.token, "initialize")).json();
  expect(reply).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: expect.stringContaining("openstrudel-missing-mcp") } });
  await bridge.close();
});
