import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { request } from "node:https";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { OpenStrudelRuntime } from "../src/runtime.js";
import type { CodexEngine } from "../src/types.js";

/** The company service with one client; every exchange is one POST with a JSON reply. */
function company() {
  const secret = "Bearer owner-company-token";
  const result = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
  const server: Server = createServer((req, res) => {
    let body = ""; req.on("data", c => { body += c; }); req.on("end", () => {
      if (req.headers.authorization !== secret) { res.writeHead(401).end("{}"); return; }
      const m = JSON.parse(body); if (m.id === undefined) { res.writeHead(202).end(); return; }
      const value = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "company", version: "1" } }
        : m.method === "tools/list" ? { tools: [{ name: "company_clients_list", description: "", inputSchema: { type: "object" } }, { name: "company_client_files_list", description: "", inputSchema: { type: "object" } }] }
        : m.params.name === "company_clients_list" ? result({ clients: [{ clientId: "c-acme", slug: "acme", name: "Acme", company: "Acme Robotics", aliases: [], stage: "active", brand: "TRINITY", archived: false, archiveReason: null, fileCount: 1, readableFileCount: 1, filesByCategory: { general: 1 } }] })
        : result({ client: { clientId: "c-acme", slug: "acme", name: "Acme", archived: false }, total: 1, offset: 0, hasMore: false, nextOffset: null, files: [{ fileId: "f1", fileName: "deal.docx", category: "contracts", sizeBytes: 10, createdAt: "2026-10-01T00:00:00.000Z", access: "ask", note: null }] });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: value }));
    });
  });
  return { server, async listen() { await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`; } };
}

function send(port: number, path: string, options: { token?: string; method?: string; body?: unknown } = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: options.method ?? (options.body ? "POST" : "GET"), rejectUnauthorized: false,
      headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.body ? { "content-type": "application/json" } : {}) } }, res => {
      let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
    });
    req.on("error", reject); req.end(options.body ? JSON.stringify(options.body) : undefined);
  });
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

it("serves clients and files to the paired owner only, and attaches a verified client or a quote to a main-chat request", async () => {
  const service = company(); const url = await service.listen();
  cleanups.push(() => new Promise<void>(done => { service.server.closeAllConnections(); service.server.close(() => done()); }));
  const root = mkdtempSync(join(tmpdir(), "strudel-clients-routes-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".data/extensions/personal"), { recursive: true });
  writeFileSync(join(root, ".data/extensions/personal/config.toml"), stringify({ mcp_servers: { company: { enabled: true, url, http_headers: { Authorization: "Bearer owner-company-token" } } } }));
  const inputs: string[] = [];
  const engine: CodexEngine = { async run(input) { inputs.push(input); return { threadId: "t", response: "Готово", events: [] }; } };
  const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", engine, rootDirectory: root, startTelegram: false, apiToken: "test-owner", mobilePort: 0 });
  Object.assign((runtime.api.mobile as any).options, { host: "127.0.0.1", hostname: "127.0.0.1" });
  const address = await runtime.api.listen("127.0.0.1", 0);
  cleanups.push(() => runtime.stop());
  const local = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { authorization: "Bearer test-owner", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  };
  const invite = async (owner: boolean) => (await local("/v1/mobile/pairing", "POST", { owner })).body as { url: string };
  const pair = async (invitation: { url: string }) => (await send(runtime.api.mobile.port!, "/pair", { method: "POST", token: new URL(invitation.url).searchParams.get("key")!, body: { name: owner ? "Owner" : "Colleague" } })).body.token as string;
  let owner = true;
  const ownerToken = await pair(await invite(true));
  owner = false;
  const colleagueToken = await pair(await invite(false));
  const port = runtime.api.mobile.port!;

  const list = await send(port, "/v1/clients", { token: ownerToken });
  expect(list.status).toBe(200);
  expect(list.body.clients).toEqual([expect.objectContaining({ id: "c-acme", slug: "acme", name: "Acme", company: "Acme Robotics" })]);
  expect(JSON.stringify(list.body)).not.toContain("owner-company-token");
  const query = new URLSearchParams({ ...list.body.source, offset: "0" }).toString();
  const files = await send(port, "/v1/clients/c-acme/files?" + query, { token: ownerToken });
  expect(files.status).toBe(200);
  expect(files.body.files).toEqual([expect.objectContaining({ id: "f1", name: "deal.docx", access: "ask" })]);
  expect(files.body.client).toEqual({ id: "c-acme", slug: "acme", name: "Acme", archived: false });
  expect(await send(port, "/v1/clients/c-acme/files?offset=0", { token: ownerToken })).toMatchObject({ status: 400 });
  expect(await send(port, "/v1/clients/c-acme/files?" + new URLSearchParams({ ...list.body.source, fingerprint: "0000000000000000" }).toString(), { token: ownerToken })).toMatchObject({ status: 409, body: { code: "client_source_changed" } });
  expect(await send(port, "/v1/clients", { token: colleagueToken })).toMatchObject({ status: 403, body: { code: "owner_only" } });
  expect(await send(port, "/v1/clients/c-acme/files?" + query, { token: colleagueToken })).toMatchObject({ status: 403, body: { code: "owner_only" } });

  const ref = { type: "client", source: list.body.source, clientId: "c-acme", name: "typed" };
  const refused = await send(port, "/v1/messages", { token: colleagueToken, body: { text: "Что по Acme?", context: ref } });
  expect(refused).toMatchObject({ status: 403, body: { code: "owner_only" } });
  const sent = await send(port, "/v1/messages", { token: ownerToken, body: { text: "Что по Acme?", context: ref } });
  expect(sent.status).toBe(200);
  const stale = await send(port, "/v1/messages", { token: ownerToken, body: { text: "Что по Acme?", context: { ...ref, source: { ...ref.source, fingerprint: "ffffffffffffffff" } } } });
  expect(stale).toMatchObject({ status: 409, body: { code: "client_source_changed" } });
  const conversation = await send(port, "/v1/conversation?page=true&timeline=true", { token: ownerToken });
  const asked = conversation.body.messages.find((m: any) => m.direction === "inbound" && m.text === "Что по Acme?");
  expect(asked.context).toMatchObject({ type: "client", clientId: "c-acme", name: "Acme", source: list.body.source });
  expect(inputs.at(-1)).toContain("Business client context");

  // A quote of this device's own message is resolved here; the story flag marks a reader with an edition.
  const editor = runtime.store.createProfile({ name: "Редактор", instructions: "" });
  const chat = runtime.store.profileConversation(editor.id);
  const quoted = runtime.store.addMessage({ conversationId: chat.id, channel: "api", direction: "outbound", text: "Три пункта готовы" });
  runtime.store.addMessage({ conversationId: chat.id, channel: "api", direction: "outbound", text: "s", story: { id: "s1", edition: "2026-11-02", rank: 1, section: "Модели", status: "Вышло", title: "T", summary: "S", body: "B", view: null, check: null, verification: "V", eventAt: null, change: null, sources: [{ title: "x", url: "https://example.com/", role: "r", publishedAt: null }] } });
  const quote = await send(port, "/v1/messages", { token: colleagueToken, body: { text: "Что это значит?", context: { type: "message", conversationId: chat.id, messageId: quoted.id, quote: "ignored" } } });
  expect(quote.status).toBe(200);
  expect(inputs.at(-1)).toContain('conversation "Редактор"');
  expect(inputs.at(-1)).toContain("Три пункта готовы");
  expect(inputs.at(-1)).not.toContain("ignored");
  expect(await send(port, "/v1/messages", { token: ownerToken, body: { text: "?", context: { type: "message", conversationId: chat.id, messageId: "gone" } } })).toMatchObject({ status: 409 });
  const profiles = await send(port, "/v1/profiles", { token: ownerToken });
  expect(profiles.body.profiles.map((p: any) => [p.name, p.news])).toEqual([["Редактор", true]]);
});
