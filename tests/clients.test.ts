import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { Store } from "../src/store.js";
import { ClientsAdapter, ClientsError } from "../src/clients.js";

/** A company MCP endpoint as waiwai serves it: one POST per JSON-RPC message, JSON replies. */
type Mode = "ok" | "empty" | "unauthorized" | "forbidden" | "refused" | "hang" | "sse" | "other" | "swapped";
function companyServer(initial: Mode = "ok") {
  const state = { mode: initial, calls: [] as Array<{ method: string; name?: string; args?: any; headers: Record<string, string> }>, secret: "Bearer company-secret-1", onToolsList: undefined as (() => void) | undefined };
  const clients = [
    { clientId: "c-acme", slug: "acme", name: "Acme", company: "Acme Robotics", aliases: ["ACME"], stage: "active", brand: "TRINITY", archived: false, archiveReason: null, fileCount: 3, readableFileCount: 2, filesByCategory: { contracts: 2, general: 1 } },
    { clientId: "c-old", slug: "old-school", name: null, company: "Old School", aliases: [], stage: "done", brand: "SCHOOL", archived: true, archiveReason: "finished", fileCount: 1, readableFileCount: 0, filesByCategory: { general: 1 } },
  ];
  const files = Array.from({ length: 60 }, (_, i) => ({ fileId: "f" + i, fileName: i % 3 ? `contract-${i}.pdf` : `scan-${i}.jpg`, category: i % 3 ? "contracts" : "general", sizeBytes: 1000 + i, createdAt: "2026-10-0" + ((i % 9) + 1) + "T10:00:00.000Z", access: i % 3 ? "ask" : "none", note: i % 3 ? null : "Binary file: only its metadata is available here.", summaryError: null }));
  const result = (data: unknown, isError = false) => ({ resultType: "complete", content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, ...(isError ? { isError: true } : {}) });
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
      if (state.mode === "unauthorized") { res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Valid meeting actor token required" })); return; }
      if (state.mode === "forbidden") { res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Owner access required" })); return; }
      if (state.mode === "hang") return;
      const message = JSON.parse(body);
      state.calls.push({ method: message.method, name: message.params?.name, args: message.params?.arguments, headers });
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      const reply = (value: unknown) => {
        const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value });
        if (state.mode === "sse") res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${payload}\n\n`);
        else res.writeHead(200, { "content-type": "application/json" }).end(payload);
      };
      if (message.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "waiwai-company", version: "1" } });
      if (message.method === "tools/list") state.onToolsList?.();
      if (message.method === "tools/list") return reply({ tools: state.mode === "other" ? [{ name: "company_finance_summary", description: "x", inputSchema: { type: "object" } }]
        : [{ name: "company_clients_list", description: "Clients", inputSchema: { type: "object" } }, { name: "company_client_files_list", description: "Files", inputSchema: { type: "object" } }, { name: "company_contract_ask", description: "Ask", inputSchema: { type: "object" } }] });
      if (message.method === "tools/call") {
        if (state.mode === "refused") return reply({ resultType: "complete", content: [{ type: "text", text: "Only an owner or operations team member can read client documents" }], isError: true });
        if (message.params.name === "company_clients_list") return reply(result({ clients: state.mode === "empty" ? [] : clients }));
        if (message.params.name === "company_client_files_list") {
          const slug = message.params.arguments.client, offset = Number(message.params.arguments.offset ?? 0), limit = Number(message.params.arguments.limit ?? 25);
          const client = clients.find(c => c.slug === slug);
          if (!client) return reply(result({ client: null, total: 0, offset, hasMore: false, nextOffset: null, files: [] }));
          const page = files.slice(offset, offset + limit);
          // "swapped": the slug now resolves to another client, as after a merge or a reused slug.
          const answered = state.mode === "swapped" ? { clientId: "c-other", slug: client.slug, name: "Other", archived: false } : { clientId: client.clientId, slug: client.slug, name: client.name, archived: client.archived };
          return reply(result({ client: answered, total: files.length, offset, hasMore: offset + page.length < files.length, nextOffset: offset + page.length < files.length ? offset + page.length : null, files: page }));
        }
        return reply(result({ error: { code: "invalid_arguments", issues: [] } }, true));
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
    });
  });
  return { state, server, async listen() { await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`; }, close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) };
}

const roots: string[] = [], stores: Store[] = [], servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function home(servers: Record<string, { url: string; token?: string }>, context = "personal") {
  const root = mkdtempSync(join(tmpdir(), "strudel-clients-")); roots.push(root);
  mkdirSync(join(root, ".data/extensions", context), { recursive: true });
  writeFileSync(join(root, ".data/extensions", context, "config.toml"), stringify({ mcp_servers: Object.fromEntries(Object.entries(servers).map(([name, s]) => [name, { enabled: true, url: s.url, ...(s.token ? { http_headers: { Authorization: "Bearer " + s.token } } : {}) }])) }));
  const store = new Store(":memory:"); stores.push(store);
  return { root, store };
}
async function company(mode: Mode = "ok") { const s = companyServer(mode); servers.push(s); return { ...s, url: await s.listen() }; }
const failure = async (work: Promise<unknown>) => { try { await work; } catch (error) { return error as ClientsError; } throw new Error("expected a refusal"); };

describe("business clients through the owner's company connector", () => {
  it("reads the authoritative list and paged files from the one connector that offers the client tools, never exposing its credential", async () => {
    const service = await company(), other = await company("other");
    const { root, store } = home({ linear: { url: other.url, token: "linear-secret" }, company: { url: service.url, token: "company-secret-1" } });
    const adapter = new ClientsAdapter(root, store);
    const list = await adapter.list();
    expect(list.source).toEqual({ connector: "company", endpoint: service.url, fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/) });
    expect(list.clients.map(c => [c.id, c.slug, c.name, c.archived])).toEqual([["c-acme", "acme", "Acme", false], ["c-old", "old-school", "Old School", true]]);
    expect(list.clients[0]).toMatchObject({ company: "Acme Robotics", aliases: ["ACME"], stage: "active", brand: "TRINITY", fileCount: 3, readableFileCount: 2 });
    expect(JSON.stringify(list)).not.toMatch(/company-secret|linear-secret/);
    // The service received the configured credential, and only the two fixed read tools are ever called.
    expect(service.state.calls.find(c => c.method === "tools/call")?.headers.authorization).toBe("Bearer company-secret-1");
    const ref = { source: list.source, clientId: "c-acme" };
    const first = await adapter.files(ref), second = await adapter.files(ref, first.nextOffset!);
    expect(first.files).toHaveLength(50); expect(first.hasMore).toBe(true); expect(first.total).toBe(60);
    expect(second.files).toHaveLength(10); expect(second.hasMore).toBe(false); expect(second.nextOffset).toBeNull();
    expect(first.files[1]).toEqual({ id: "f1", name: "contract-1.pdf", category: "contracts", sizeBytes: 1001, createdAt: "2026-10-02T10:00:00.000Z", access: "ask", note: null });
    expect(first.client).toEqual({ id: "c-acme", slug: "acme", name: "Acme", archived: false });
    // Every file read first verifies the selected client against a fresh list.
    expect(service.state.calls.filter(c => c.method === "tools/call").map(c => c.name)).toEqual(["company_clients_list", "company_clients_list", "company_client_files_list", "company_clients_list", "company_client_files_list"]);
    expect(service.state.calls.find(c => c.name === "company_client_files_list")?.args).toEqual({ client: "acme", limit: 50, offset: 0 });
    expect(store.getSetting("clients.source")).toContain('"connector":"company"');
    // The tab's list is cached briefly; a refresh asks again. Each file read verified its client against a fresh list.
    const listed = () => service.state.calls.filter(c => c.name === "company_clients_list").length;
    const before = listed();
    await adapter.list(); expect(listed()).toBe(before);
    await adapter.list(true); expect(listed()).toBe(before + 1);
  });

  it("tells empty data, a missing connector, an expired sign-in, a denial, an outage and ambiguity apart", async () => {
    const service = await company("empty");
    const { root, store } = home({ company: { url: service.url, token: "t" } });
    const adapter = new ClientsAdapter(root, store, { timeoutMs: 400 });
    expect((await adapter.list()).clients).toEqual([]);
    service.state.mode = "unauthorized";
    expect(await failure(adapter.list(true))).toMatchObject({ code: "service_auth", status: 502 });
    service.state.mode = "forbidden";
    expect(await failure(adapter.list(true))).toMatchObject({ code: "service_denied", status: 403 });
    service.state.mode = "refused";
    expect(await failure(adapter.list(true))).toMatchObject({ code: "service_denied", detail: "Only an owner or operations team member can read client documents" });
    service.state.mode = "hang";
    expect(await failure(adapter.list(true))).toMatchObject({ code: "service_unavailable", status: 502 });
    await service.close();
    expect(await failure(adapter.list(true))).toMatchObject({ code: "service_unavailable" });

    const none = new ClientsAdapter(home({}).root, new Store(":memory:"));
    expect(await failure(none.list())).toMatchObject({ code: "no_connector", status: 404 });
    const unrelated = await company("other");
    const onlyOther = home({ linear: { url: unrelated.url, token: "x" } });
    expect(await failure(new ClientsAdapter(onlyOther.root, onlyOther.store).list())).toMatchObject({ code: "no_connector" });

    const a = await company(), b = await company();
    const two = home({ "company-a": { url: a.url, token: "a" }, "company-b": { url: b.url, token: "b" } });
    const ambiguous = await failure(new ClientsAdapter(two.root, two.store).list());
    expect(ambiguous).toMatchObject({ code: "ambiguous", status: 409, detail: "company-a, company-b" });
    expect(ambiguous.message).not.toMatch(/удал|delete|remove/i);
    // The owner's personal MCP mirrors the company tools: the connector named «company» is the business source.
    const c = await company(), mirror = await company();
    const mirrored = home({ personal: { url: mirror.url, token: "p" }, company: { url: c.url, token: "c" } });
    expect((await new ClientsAdapter(mirrored.root, mirrored.store).list()).source.connector).toBe("company");
    expect(JSON.parse(mirrored.store.getSetting("clients.source")!)).toMatchObject({ connector: "company" });
  });

  it("accepts event-stream replies and refuses a reply that echoes the credential or breaks the contract", async () => {
    const service = await company("sse");
    const { root, store } = home({ company: { url: service.url, token: "company-secret-1" } });
    expect((await new ClientsAdapter(root, store).list()).clients).toHaveLength(2);
    const echo = createServer((req, res) => { let b = ""; req.on("data", c => { b += c; }); req.on("end", () => { const m = JSON.parse(b); if (m.id === undefined) { res.writeHead(202).end(); return; }
      const value = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "echo", version: "1" } } : m.method === "tools/list" ? { tools: [{ name: "company_clients_list", description: "", inputSchema: { type: "object" } }, { name: "company_client_files_list", description: "", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: "{}" }], structuredContent: { clients: [{ clientId: "x", slug: "x", name: req.headers.authorization, company: null, aliases: [], stage: null, brand: null, archived: false, archiveReason: null, fileCount: 0, readableFileCount: 0, filesByCategory: {} }] } };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: value })); }); });
    await new Promise<void>(done => echo.listen(0, "127.0.0.1", done)); servers.push({ close: () => new Promise(done => { echo.closeAllConnections(); echo.close(() => done()); }) });
    const leaking = home({ company: { url: `http://127.0.0.1:${(echo.address() as { port: number }).port}/mcp`, token: "company-secret-2" } });
    expect(await failure(new ClientsAdapter(leaking.root, leaking.store).list())).toMatchObject({ code: "service_unavailable" });
  });

  it("binds a client reference to its source and authoritative id, so a renamed, replaced or unknown client cannot be substituted", async () => {
    const service = await company();
    const { root, store } = home({ company: { url: service.url, token: "company-secret-1" } });
    const adapter = new ClientsAdapter(root, store);
    const { source } = await adapter.list();
    const verified = await adapter.verify({ source, clientId: "c-acme", name: "Acme (typed by the app)" });
    expect(verified.client).toMatchObject({ id: "c-acme", slug: "acme", name: "Acme", company: "Acme Robotics", stage: "active" });
    expect(verified.source).toEqual(source);
    expect(await failure(adapter.verify({ source, clientId: "c-none", name: "Acme" }))).toMatchObject({ code: "client_unknown", status: 409 });
    // The same adapter, moments after a good list: a client removed or access revoked is seen at send time, not after a cache expires.
    service.state.mode = "empty";
    expect(await failure(adapter.verify({ source, clientId: "c-acme" }))).toMatchObject({ code: "client_unknown" });
    service.state.mode = "refused";
    expect(await failure(adapter.verify({ source, clientId: "c-acme" }))).toMatchObject({ code: "service_denied" });
    service.state.mode = "unauthorized";
    expect(await failure(adapter.verify({ source, clientId: "c-acme" }))).toMatchObject({ code: "service_auth" });
    service.state.mode = "ok";
    expect(await failure(adapter.verify({ source: { ...source, fingerprint: "0000000000000000" }, clientId: "c-acme", name: "Acme" }))).toMatchObject({ code: "client_source_changed", status: 409 });
    expect(await failure(adapter.verify({ source: { ...source, connector: "company-old" }, clientId: "c-acme", name: "Acme" }))).toMatchObject({ code: "client_source_changed" });
    // The same connector name with a replaced credential is another account: its fingerprint differs.
    writeFileSync(join(root, ".data/extensions/personal/config.toml"), stringify({ mcp_servers: { company: { enabled: true, url: service.url, http_headers: { Authorization: "Bearer company-secret-2" } } } }));
    const replaced = new ClientsAdapter(root, store);
    expect((await replaced.list()).source.fingerprint).not.toBe(source.fingerprint);
    expect(await failure(replaced.verify({ source, clientId: "c-acme", name: "Acme" }))).toMatchObject({ code: "client_source_changed" });
    expect(await failure(replaced.files({ source, clientId: "c-acme" }))).toMatchObject({ code: "client_source_changed" });
  });

  it("treats the same connector at another tenant query as another source, within one adapter, after the config changes", async () => {
    const service = await company();
    const { root, store } = home({ company: { url: service.url + "?tenant=a", token: "same-token" } });
    const adapter = new ClientsAdapter(root, store);
    const { source } = await adapter.list();
    expect(source.endpoint).toBe(service.url);
    expect(source.endpoint).not.toContain("tenant");
    writeFileSync(join(root, ".data/extensions/personal/config.toml"), stringify({ mcp_servers: { company: { enabled: true, url: service.url + "?tenant=b", http_headers: { Authorization: "Bearer same-token" } } } }));
    const moved = await adapter.list(true);
    expect(moved.source.fingerprint).not.toBe(source.fingerprint);
    expect(await failure(adapter.verify({ source, clientId: "c-acme" }))).toMatchObject({ code: "client_source_changed" });
    expect(await failure(adapter.files({ source, clientId: "c-acme" }))).toMatchObject({ code: "client_source_changed" });
  });

  it("refuses files answered for another client than the one selected", async () => {
    const service = await company();
    const { root, store } = home({ company: { url: service.url, token: "t" } });
    const adapter = new ClientsAdapter(root, store);
    const { source } = await adapter.list();
    const mine = await adapter.files({ source, clientId: "c-acme" });
    expect(mine.client.id).toBe("c-acme");
    // The service now resolves the slug to someone else: a reused slug after a merge, say.
    service.state.mode = "swapped";
    expect(await failure(adapter.files({ source, clientId: "c-acme" }))).toMatchObject({ code: "client_unknown" });
  });

  it("never lets a JSON-RPC error carry an echoed credential into a refusal", async () => {
    const echo = createServer((req, res) => { let b = ""; req.on("data", c => { b += c; }); req.on("end", () => { const m = JSON.parse(b); if (m.id === undefined) { res.writeHead(202).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "bad token " + req.headers.authorization } })); }); });
    await new Promise<void>(done => echo.listen(0, "127.0.0.1", done)); servers.push({ close: () => new Promise(done => { echo.closeAllConnections(); echo.close(() => done()); }) });
    const { root, store } = home({ company: { url: `http://127.0.0.1:${(echo.address() as { port: number }).port}/mcp`, token: "company-secret-3" } });
    const refusal = await failure(new ClientsAdapter(root, store).list());
    expect(refusal).toMatchObject({ code: "service_unavailable", detail: "company" });
    expect(JSON.stringify(refusal)).not.toContain("company-secret-3");
    expect(refusal.message + (refusal.detail ?? "")).not.toContain("secret");
  });

  it("reports a first read's own discovery failures as they are, and a missing source only once discovery finished", async () => {
    for (const [mode, code] of [["unauthorized", "service_auth"], ["forbidden", "service_denied"], ["hang", "service_unavailable"]] as const) {
      const service = await company(mode);
      const { root, store } = home({ company: { url: service.url, token: "t" } });
      const refusal = await failure(new ClientsAdapter(root, store, { timeoutMs: 400 }).list());
      expect(refusal).toMatchObject({ code, detail: "company" });
      expect(store.getSetting("clients.source") ?? null).toBeNull();
    }
    // A healthy unrelated connector beside a refusing one: discovery did not finish, so no verdict of "missing".
    const unrelated = await company("other"), refusing = await company("unauthorized");
    const mixed = home({ linear: { url: unrelated.url, token: "l" }, crm: { url: refusing.url, token: "c" } });
    expect(await failure(new ClientsAdapter(mixed.root, mixed.store).list())).toMatchObject({ code: "service_auth", detail: "crm" });
    // Two refusing connectors with different states: unavailable, naming each one's state.
    const denied = await company("forbidden");
    const both = home({ a: { url: refusing.url, token: "a" }, b: { url: denied.url, token: "b" } });
    expect(await failure(new ClientsAdapter(both.root, both.store).list())).toMatchObject({ code: "service_unavailable", detail: "a: service_auth, b: service_denied" });
  });

  it("verifies against one consistent snapshot when the configuration changes between discovery and the list read", async () => {
    const first = await company(), second = await company("empty");
    const { root, store } = home({ company: { url: first.url, token: "t1" } });
    const adapter = new ClientsAdapter(root, store);
    const { source } = await adapter.list();
    // The owner re-points the connector while a verification is in flight: it lands after discovery, before the list read.
    let switched = false;
    first.state.onToolsList = () => { if (!switched) { switched = true; writeFileSync(join(root, ".data/extensions/personal/config.toml"), stringify({ mcp_servers: { company: { enabled: true, url: second.url, http_headers: { Authorization: "Bearer t2" } } } })); } };
    const verified = await adapter.verify({ source, clientId: "c-acme" });
    expect(verified.source).toEqual(source);
    expect(verified.client.id).toBe("c-acme");
    expect(second.state.calls.filter(c => c.method === "tools/call")).toHaveLength(0);
    // The next read sees the new connector, under which the old reference is refused.
    const moved = await adapter.list(true);
    expect(moved.source.fingerprint).not.toBe(source.fingerprint);
    expect(moved.clients).toEqual([]);
    expect(await failure(adapter.verify({ source, clientId: "c-acme" }))).toMatchObject({ code: "client_source_changed" });
  });

  it("keeps the remembered source's own failure instead of switching to another connector that offers clients", async () => {
    const first = await company();
    const { root, store } = home({ company: { url: first.url, token: "t1" } });
    const adapter = new ClientsAdapter(root, store);
    await adapter.list();
    first.state.mode = "unauthorized";
    const second = await company();
    writeFileSync(join(root, ".data/extensions/personal/config.toml"), stringify({ mcp_servers: { company: { enabled: true, url: first.url, http_headers: { Authorization: "Bearer t1" } }, backup: { enabled: true, url: second.url, http_headers: { Authorization: "Bearer t2" } } } }));
    expect(await failure(adapter.list(true))).toMatchObject({ code: "service_auth" });
    // Caches expire without a refresh: still the remembered connector's failure, not the other one's list.
    const later = new ClientsAdapter(root, store, { now: () => Date.now() + 3_600_000 });
    expect(await failure(later.list())).toMatchObject({ code: "service_auth" });
    expect(store.getSetting("clients.source")).toContain('"connector":"company"');
    // Once the owner removes the failing connector, the remaining one is the source again, and old references stay refused.
    writeFileSync(join(root, ".data/extensions/personal/config.toml"), stringify({ mcp_servers: { backup: { enabled: true, url: second.url, http_headers: { Authorization: "Bearer t2" } } } }));
    const remaining = await new ClientsAdapter(root, store).list(true);
    expect(remaining.source.connector).toBe("backup");
    const old = JSON.parse(store.getSetting("clients.source")!);
    expect(old.connector).toBe("backup");
  });

  it("reports the remembered connector's own failure instead of a missing connector once it stops answering", async () => {
    const service = await company();
    const { root, store } = home({ company: { url: service.url, token: "t" } });
    await new ClientsAdapter(root, store).list();
    service.state.mode = "unauthorized";
    expect(await failure(new ClientsAdapter(root, store).list(true))).toMatchObject({ code: "service_auth" });
  });
});
