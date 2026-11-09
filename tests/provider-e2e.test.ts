import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { mockResponses } from "./fixtures/mock-responses.js";

const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true, recursive: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));

it("runs an xAI turn through the real Codex app-server with only the provider's key", async () => {
  const provider = await mockResponses("pong from grok");
  const root = mkdtempSync(join(tmpdir(), "openstrudel-provider-e2e-"));
  vi.stubEnv("OPENSTRUDEL_CODEX_MODE", "");
  vi.stubEnv("OPENSTRUDEL_PROVIDER_XAI_BASE_URL", provider.url);
  // Never started: no local connection file is published and no Telegram or setup server runs.
  const runtime = new OpenStrudelRuntime({ rootDirectory: root, dbPath: join(root, ".data/openstrudel.sqlite"), startTelegram: false, apiToken: "e2e" });
  try {
    runtime.store.setSetting("providers.xai.key", "xai-e2e-key");
    expect((await runtime.messages.handle({ channel: "api", text: "Say pong", externalChatId: "home" })).text).toBe("pong from grok");
    const turns = provider.requests.filter(request => request.url.startsWith("/v1/responses"));
    expect(turns.length).toBeGreaterThan(0);
    for (const turn of turns) {
      expect(turn.headers.authorization).toBe("Bearer xai-e2e-key");
      expect(Object.keys(turn.headers).filter(name => /chatgpt|openai/i.test(name))).toEqual([]);
      expect(turn.body.model).toBe("grok-4.7");
      expect(turn.body.tools.map((tool: any) => tool.type)).not.toContain("web_search");
    }
    for (const file of files(join(root, ".data/providers"))) expect(readFileSync(file).includes("xai-e2e-key"), file).toBe(false);
  } finally {
    await runtime.stop(); await provider.close(); vi.unstubAllEnvs();
    // A stopped Codex releases its thread-writer lock a moment later.
    for (let attempt = 0; attempt < 20 && existsSync(root); attempt++) { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); await new Promise(done => setTimeout(done, 300)); }
  }
}, 120_000);

it("keeps a group sender without access on a thread without the owner's services, and resumes the listed thread after", async () => {
  const provider = await mockResponses("pong from grok");
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
  const root = mkdtempSync(join(tmpdir(), "openstrudel-provider-e2e-"));
  vi.stubEnv("OPENSTRUDEL_CODEX_MODE", "");
  vi.stubEnv("OPENSTRUDEL_PROVIDER_XAI_BASE_URL", provider.url);
  const runtime = new OpenStrudelRuntime({ rootDirectory: root, dbPath: join(root, ".data/openstrudel.sqlite"), startTelegram: false, apiToken: "e2e" });
  try {
    runtime.store.setSetting("providers.xai.key", "xai-e2e-key");
    mkdirSync(join(root, ".data/extensions/personal"), { recursive: true });
    writeFileSync(join(root, ".data/extensions/personal/config.toml"), `[mcp_servers.svc]\nurl = "http://127.0.0.1:${(service.address() as { port: number }).port}/mcp"\n[mcp_servers.svc.http_headers]\nAuthorization = "Bearer OWNER"\n`);
    writeFileSync(join(root, ".data/extensions/all-chats.json"), '{"enabled":true}\n');
    runtime.store.linkTelegramChat({ chatId: "42", title: "Owner", allowedSenders: ["42"] });
    runtime.store.linkTelegramChat({ chatId: "-100", title: "Team", allowedSenders: ["42"] });
    // This group admits guests to replies, without granting the owner's services.
    runtime.telegram.setGroupReplyAccess("-100", "members", undefined);
    const turn = async (sender: string, text: string, id: number) => {
      const before = provider.requests.length, requests = seen.length;
      await runtime.messages.handle({ channel: "telegram", text, externalChatId: "-100", externalId: `-100:${id}`, telegramSenderId: sender, title: "Team" });
      const turns = provider.requests.slice(before).filter(request => request.url.startsWith("/v1/responses"));
      return { turns, tools: turns.flatMap(t => (t.body.tools ?? []).map((tool: any) => String(tool.name ?? tool.type))).filter(name => name.includes("svc") || name.includes("private_lookup")), owner: seen.slice(requests).filter(a => a === "Bearer OWNER").length };
    };
    const first = await turn("42", "Listed first", 1);
    expect(first.tools.length).toBeGreaterThan(0);
    expect(seen).toContain("Bearer OWNER");
    const conversation = runtime.store.listConversations().find(c => c.externalId === "-100")!.id;
    const listedThread = runtime.store.getSetting("codex.thread.provider-xai." + conversation);
    const guest = await turn("77", "Guest second", 2);
    expect(guest.turns.length).toBeGreaterThan(0);
    expect(guest.tools).toEqual([]);
    expect(guest.owner).toBe(0);
    expect(runtime.store.getSetting("codex.thread.provider-xai.guest." + conversation)).not.toBe(listedThread);
    expect(JSON.stringify(guest.turns.at(-1)!.body.input)).toContain("Listed first");
    const last = await turn("42", "Listed third", 3);
    expect(last.tools.length).toBeGreaterThan(0);
    expect(runtime.store.getSetting("codex.thread.provider-xai." + conversation)).toBe(listedThread);
    expect(JSON.stringify(last.turns.at(-1)!.body.input)).toMatch(/Listed first[\s\S]*Guest second[\s\S]*Listed third/);
  } finally {
    await runtime.stop(); await provider.close(); vi.unstubAllEnvs();
    service.closeAllConnections(); await new Promise(resolve => service.close(resolve));
    for (let attempt = 0; attempt < 20 && existsSync(root); attempt++) { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); await new Promise(done => setTimeout(done, 300)); }
  }
}, 180_000);

it("records what each turn spent through the real Codex app-server, measuring a resumed thread from its saved totals", async () => {
  const provider = await mockResponses("pong from grok");
  const root = mkdtempSync(join(tmpdir(), "openstrudel-provider-e2e-"));
  vi.stubEnv("OPENSTRUDEL_CODEX_MODE", "");
  vi.stubEnv("OPENSTRUDEL_PROVIDER_XAI_BASE_URL", provider.url);
  const runtime = new OpenStrudelRuntime({ rootDirectory: root, dbPath: join(root, ".data/openstrudel.sqlite"), startTelegram: false, apiToken: "e2e" });
  try {
    runtime.store.setSetting("providers.xai.key", "xai-e2e-key");
    for (const text of ["Say pong", "Again", "Once more"]) {
      // The last turn resumes a thread whose saved totals are gone, as on a Home's first turn after an upgrade.
      if (text === "Once more") runtime.store.db.exec("DELETE FROM engine_totals");
      // The owner's turns bring a new tool bridge each, so Codex resumes the thread and repeats its last reading first.
      expect((await runtime.messages.handle({ channel: "api", text, externalChatId: "home", byOwner: true })).text).toBe("pong from grok");
    }
    const calls = provider.requests.filter(request => request.url.startsWith("/v1/responses")).length;
    const rows = runtime.store.db.prepare(`SELECT i.text,u.provider,u.model,u.input_tokens,u.cached_tokens,u.output_tokens,u.cost_ticks,u.engine_thread
      FROM turn_usage u JOIN messages i ON i.id=u.message_id ORDER BY i.rowid`).all() as Array<Record<string, unknown>>;
    // The mock answers every model call with 10 input and 5 output tokens; xAI has no OpenAI price.
    expect(rows.map(row => [row.text, row.provider, row.model, row.cost_ticks])).toEqual([["Say pong", "xai", "grok-4.7", null], ["Again", "xai", "grok-4.7", null], ["Once more", "xai", "grok-4.7", null]]);
    // One model call per turn: each turn is its own 10 and 5, never the thread's running total.
    expect(calls).toBe(3);
    expect(rows.map(row => [row.input_tokens, row.cached_tokens, row.output_tokens])).toEqual([[10, 0, 5], [10, 0, 5], [10, 0, 5]]);
    expect(new Set(rows.map(row => row.engine_thread)).size).toBe(1);
  } finally {
    await runtime.stop(); await provider.close(); vi.unstubAllEnvs();
    for (let attempt = 0; attempt < 20 && existsSync(root); attempt++) { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); await new Promise(done => setTimeout(done, 300)); }
  }
}, 120_000);
