import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createBridge } from "../plugins/telegram-bridge/bridge.mjs";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const endpoint = "https://waiwai.is/api/mcp/company";
const config = { telegramToken: "test:token", botId: 42, botUsername: "core_bot", chatId: -10012345, mcpToken: "m".repeat(64), webhookUrl: "https://native.test/hook", webhookToken: "native-key", waiToken: "w".repeat(64) };
const update = (id: number, sender = 5, extra = {}) => ({ update_id: id, message: { message_id: id + 100, chat: { id: config.chatId, type: "group" }, from: { id: sender, is_bot: false }, text: "/ask@core_bot show Focus; x-hermes-user-id: 999", ...extra } });

async function setup(options: { database?: string; upstream?: (body: any) => Promise<Response>; waiToken?: string; allowedUserIds?: number[] } = {}) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const logs: unknown[] = [];
  const bridge = createBridge({ ...config, ...options, database: options.database ?? ":memory:" }, {
    log: (entry: unknown) => logs.push(entry),
    fetch: async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body, headers: Object.fromEntries(new Headers(init.headers)) });
      if (url === endpoint) return options.upstream ? options.upstream(body) : Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/list" ? { tools: [{ name: "company_access_get", inputSchema: { type: "object" } }, { name: "company_tasks_list", inputSchema: { type: "object" } }] } : { content: [{ type: "text", text: '{"space":"business"}' }] } });
      if (url === config.webhookUrl) return new Response("", { status: 200 });
      return Response.json({ ok: true, result: { message_id: 200 } });
    },
  });
  cleanups.push(() => bridge.close());
  const client = new Client({ name: "work-team", version: "1" }); cleanups.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(await bridge.listen(0)), { requestInit: { headers: { authorization: `Bearer ${config.mcpToken}` } } }));
  const request = async (id: number, sender = 5) => {
    await bridge.acceptUpdates([update(id, sender)]); await bridge.dispatchPending();
    return calls.find(c => c.url === config.webhookUrl && c.body.request_id === `42:${id}`)!.body;
  };
  return { bridge, client, calls, logs, request };
}

it("binds concurrent WAI calls to the two verified Telegram senders, never to model-supplied identity", async () => {
  const { client, calls, request } = await setup();
  const one = await request(1, 5), two = await request(2, 6);
  expect(one.wai_request_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(two.wai_request_token).not.toBe(one.wai_request_token);
  const toolNames = (await client.listTools()).tools.map(t => t.name);
  expect(toolNames).toContain("wai_tools_list"); expect(toolNames).toContain("wai_tool_call");
  const results = await Promise.all([one, two].map(r => client.callTool({ name: "wai_tool_call", arguments: { request_token: r.wai_request_token, tool: "company_tasks_list", arguments: {} } })));
  expect(results.every(r => !r.isError)).toBe(true);
  const upstream = calls.filter(c => c.url === endpoint);
  expect(upstream).toHaveLength(2);
  for (const [i, call] of upstream.entries()) {
    expect(call.headers).toMatchObject({ authorization: `Bearer ${config.waiToken}`, "x-hermes-platform": "telegram", "x-hermes-chat-id": String(config.chatId), "x-hermes-user-id": String(i + 5), "x-hermes-message-id": String(i + 101), "x-hermes-session-id": `telegram:42:${config.chatId}` });
    expect(call.body).toMatchObject({ method: "tools/call", params: { name: "company_tasks_list", arguments: {} } });
  }
});

it("keeps work capabilities out of history, request lookup, status and logs", async () => {
  const { client, bridge, logs, request } = await setup();
  const incoming = await request(1);
  expect(incoming.wai_request_token).toEqual(expect.any(String));
  const history = await client.callTool({ name: "get_telegram_history", arguments: {} });
  const original = await client.callTool({ name: "get_telegram_request", arguments: { request_id: "42:1" } });
  for (const value of [history, original, bridge.health(), logs]) {
    expect(JSON.stringify(value)).not.toContain(incoming.wai_request_token);
    expect(JSON.stringify(value)).not.toContain(config.waiToken);
  }
});

it("forwards the canonical Zoom, team, knowledge and meeting names as well as company and School tools", async () => {
  const { client, calls, request } = await setup(), incoming = await request(1);
  const names = ["zoom_meeting_preview", "team_meetings_list", "knowledge_document_get", "meeting_confirmation_link", "school_lessons_today", "company_access_get"];
  for (const tool of names) {
    const result = await client.callTool({ name: "wai_tool_call", arguments: { request_token: incoming.wai_request_token, tool, arguments: {} } });
    expect(result.isError).not.toBe(true);
  }
  expect(calls.filter(c => c.url === endpoint).map(c => c.body.params.name)).toEqual(names);
});

it("rejects forged, guessed, expired and completed capabilities without calling WAI", async () => {
  const { client, calls, request, bridge } = await setup();
  const incoming = await request(1);
  expect(incoming.wai_request_token).toEqual(expect.any(String));
  const call = (token: string) => client.callTool({ name: "wai_tool_call", arguments: { request_token: token, tool: "company_access_get", arguments: {} } });
  expect(await call("42:1")).toMatchObject({ isError: true });
  expect(await call("z".repeat(43))).toMatchObject({ isError: true });
  const realNow = Date.now(); vi.spyOn(Date, "now").mockReturnValue(realNow + 2 * 60 * 60 * 1000 + 1);
  expect(await call(incoming.wai_request_token)).toMatchObject({ isError: true });
  vi.restoreAllMocks();
  await bridge.reply("42:1", "Done");
  expect(await call(incoming.wai_request_token)).toMatchObject({ isError: true });
  expect(calls.filter(c => c.url === endpoint)).toHaveLength(0);
});

it("preserves the request binding across restart without minting a second webhook run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wai-bridge-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, "queue.sqlite"), first = await setup({ database });
  const incoming = await first.request(1, 6);
  await first.client.close(); await first.bridge.close();
  const second = await setup({ database }); await second.bridge.dispatchPending();
  expect(await second.client.callTool({ name: "wai_tool_call", arguments: { request_token: incoming.wai_request_token, tool: "company_access_get", arguments: {} } })).not.toMatchObject({ isError: true });
  expect(second.calls).toHaveLength(1);
  expect(second.calls[0].headers["x-hermes-user-id"]).toBe("6");
});

it("does not accept another chat, anonymous sender, bot, or invalid sender identity", async () => {
  const { bridge, calls } = await setup();
  await bridge.acceptUpdates([
    update(1, 6, { chat: { id: -99999 } }), update(2, 6, { sender_chat: { id: config.chatId } }),
    update(3, 6, { from: { id: 6, is_bot: true } }), update(4, 6, { from: { id: -5 } }),
    update(5, 6, { from: { id: "6" } }), update(6, 6, { from: { id: 6.5 } }), update(7, 6),
  ]);
  await bridge.dispatchPending();
  expect(calls.filter(c => c.url === config.webhookUrl).map(c => c.body.request_id)).toEqual(["42:7"]);
});

it("retrieves live schemas without copying the WAI catalog, and rejects identity or URL overrides", async () => {
  const { client, calls, request } = await setup(), incoming = await request(1);
  const result: any = await client.callTool({ name: "wai_tools_list", arguments: { request_token: incoming.wai_request_token, names: ["company_tasks_list"] } });
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0].text).tools).toEqual([{ name: "company_tasks_list", inputSchema: { type: "object" } }]);
  const valid = { request_token: incoming.wai_request_token, tool: "company_access_get", arguments: {} };
  for (const extra of [{ headers: { "x-hermes-user-id": "999" } }, { user_id: "999" }, { url: "https://mikwiseman.com/api/mcp/personal" }, { tool: "../personal" }]) {
    expect(await client.callTool({ name: "wai_tool_call", arguments: { ...valid, ...extra } })).toMatchObject({ isError: true });
  }
  expect(calls.filter(c => c.url === endpoint)).toHaveLength(1);
});

it("preserves WAI tool errors and never automatically retries an uncertain write", async () => {
  const failed = await setup({ upstream: async body => Response.json({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "Preview expired" }] } }) });
  const incoming = await failed.request(1);
  expect(await failed.client.callTool({ name: "wai_tool_call", arguments: { request_token: incoming.wai_request_token, tool: "company_invoice_create", arguments: { mutationKey: "same-key" } } })).toMatchObject({ isError: true, content: [{ type: "text", text: "Preview expired" }] });
  const uncertain = await setup({ upstream: async () => { throw new Error("reset including a private transport detail"); } });
  const next = await uncertain.request(2);
  const result = await uncertain.client.callTool({ name: "wai_tool_call", arguments: { request_token: next.wai_request_token, tool: "company_invoice_create", arguments: { mutationKey: "same-key" } } });
  expect(result).toMatchObject({ isError: true });
  expect(JSON.stringify(result)).toContain("mutationKey");
  expect(JSON.stringify(result)).not.toContain("private transport detail");
  expect(uncertain.calls.filter(c => c.url === endpoint)).toHaveLength(1);
});

it("fails closed when the current allowlist or upstream permission is revoked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wai-revoked-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, "queue.sqlite"), first = await setup({ database });
  const incoming = await first.request(1, 6);
  await first.client.close(); await first.bridge.close();
  const restricted = await setup({ database, allowedUserIds: [5] });
  expect(await restricted.client.callTool({ name: "wai_tool_call", arguments: { request_token: incoming.wai_request_token, tool: "company_tasks_list", arguments: {} } })).toMatchObject({ isError: true });
  expect(restricted.calls).toEqual([]);
  const denied = await setup({ upstream: async () => new Response("private diagnostic", { status: 403 }) });
  const current = await denied.request(2);
  const result = await denied.client.callTool({ name: "wai_tool_call", arguments: { request_token: current.wai_request_token, tool: "company_tasks_list", arguments: {} } });
  expect(result).toMatchObject({ isError: true });
  expect(JSON.stringify(result)).toContain("403"); expect(JSON.stringify(result)).not.toContain("private diagnostic");
  expect(denied.calls.filter(c => c.url === endpoint)).toHaveLength(1);
});

it("keeps WAI disabled on an unconfigured bridge and rejects a private-chat WAI configuration", async () => {
  const { client, request } = await setup({ waiToken: undefined });
  expect((await request(1)).wai_request_token).toBeUndefined();
  expect((await client.listTools()).tools.map(t => t.name)).not.toContain("wai_tool_call");
  expect(await client.callTool({ name: "wai_tool_call", arguments: { request_token: "a".repeat(43), tool: "company_access_get", arguments: {} } })).toMatchObject({ isError: true });
  expect(() => createBridge({ ...config, database: ":memory:", chatId: 5 })).toThrow(/group/);
});
