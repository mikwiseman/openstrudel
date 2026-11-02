import { createHash } from "node:crypto";
import { z } from "zod";
import { contextServers } from "./claude.js";
import { HomeError } from "./home.js";
import { boundedResponse } from "./restricted-executor.js";
import type { Store } from "./store.js";

/** Business clients for the owner's app, read from the company service the owner connected to the main chat.
 * A fixed adapter: two read tools, strict replies, the connector's own credential, and nothing written anywhere. */

/** The connector name that settles a tie between connectors offering the client tools. */
const COMPANY = "company";

export type ClientsCode = "owner_only" | "no_connector" | "ambiguous" | "service_auth" | "service_denied" | "service_unavailable" | "client_unknown" | "client_source_changed";
const refusals: Record<ClientsCode, [string, number]> = {
  owner_only: ["Клиентов видит владелец устройства.", 403],
  no_connector: ["База клиентов не подключена к этому устройству.", 404],
  ambiguous: ["Клиентов предлагают несколько подключений.", 409],
  service_auth: ["Подключение к базе клиентов нужно обновить.", 502],
  service_denied: ["Доступ к клиентам закрыт для этого подключения.", 403],
  service_unavailable: ["Сервис клиентов не ответил.", 502],
  client_unknown: ["Клиент не найден в текущем списке.", 409],
  client_source_changed: ["Клиент из другого подключения. Уберите контекст и выберите клиента заново.", 409],
};
/** A refusal the app shows as its own state. `detail` is the service's short text or the connector names, never a credential. */
export class ClientsError extends HomeError {
  constructor(readonly code: ClientsCode, message: string, status: number, readonly detail?: string) { super(message, status); }
}
export const clientsRefusal = (code: ClientsCode, detail?: string) => new ClientsError(code, refusals[code][0], refusals[code][1], detail);

/** Which connector, which address and which credential a client was read from. The fingerprint covers the full request
 * address, query included, and the credential, so a renamed, moved, re-tenanted or re-signed connector is another source
 * and a reference made under the old one is refused instead of resolved elsewhere. The endpoint is for display: no query. */
export interface ClientSource { connector: string; endpoint: string; fingerprint: string }
export interface BusinessClient { id: string; slug: string; name: string; company: string | null; aliases: string[]; stage: string | null; brand: string | null; archived: boolean; archiveReason: string | null; fileCount: number; readableFileCount: number }
export interface ClientFile { id: string; name: string; category: string | null; sizeBytes: number | null; createdAt: string; access: "read" | "ask" | "none"; note: string | null }
/** What the app sends back for a client it listed: the source and the authoritative id; the name is display only. */
export interface ClientRef { source: ClientSource; clientId: string; name?: string }

export const CLIENT_TOOLS = ["company_clients_list", "company_client_files_list"] as const;
type Connector = { name: string; url: string; headers: Record<string, string> };

const text = (max: number) => z.string().max(max);
const maybe = (max: number) => z.string().max(max).nullish().transform(value => value ?? null);
const count = z.number().int().nonnegative();
const listResult = z.object({ clients: z.array(z.object({
  clientId: text(160), slug: text(200), name: maybe(300), company: maybe(300), aliases: z.array(text(200)).max(50).optional().default([]),
  stage: maybe(80), brand: maybe(80), archived: z.boolean().optional().default(false), archiveReason: maybe(300),
  fileCount: count.optional().default(0), readableFileCount: count.optional().default(0),
})).max(5000) });
const filesResult = z.object({
  client: z.object({ clientId: text(160), slug: text(200), name: maybe(300), archived: z.boolean().optional().default(false) }).nullable(),
  total: count, offset: count, hasMore: z.boolean(), nextOffset: count.nullable(),
  files: z.array(z.object({ fileId: text(160), fileName: text(500), category: maybe(120), sizeBytes: count.nullish().transform(v => v ?? null), createdAt: text(64),
    access: z.enum(["read", "ask", "none"]), note: maybe(300) })).max(100),
});
export const clientSourceSchema = z.object({ connector: z.string().min(1).max(96), endpoint: z.string().min(1).max(2000), fingerprint: z.string().regex(/^[a-f0-9]{16}$/) });

const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const invisible = new RegExp("[" + ([[0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]] as Array<[number, number]>).map(([a, b]) => String.fromCodePoint(a) + "-" + String.fromCodePoint(b)).join("") + "]", "g");
const plain = (value: unknown, max: number) => typeof value === "string" ? value.replace(invisible, " ").replace(/\s+/g, " ").trim().slice(0, max) || undefined : undefined;
const unexpected = () => clientsRefusal("service_unavailable", "Неожиданный ответ сервиса.");
function sourceOf(connector: Connector): ClientSource {
  const url = new URL(connector.url);
  const canonical = url.origin + url.pathname + url.search;
  const credential = Object.entries(connector.headers).map(([k, v]) => k.toLowerCase() + "=" + v).sort().join("\n");
  return { connector: connector.name, endpoint: url.origin + url.pathname.replace(/\/+$/, ""), fingerprint: createHash("sha256").update([connector.name, canonical, credential].join("\n")).digest("hex").slice(0, 16) };
}
const sameSource = (a: ClientSource, b: ClientSource) => a.connector === b.connector && a.endpoint === b.endpoint && a.fingerprint === b.fingerprint;

/** One JSON-RPC exchange per POST, as the company service answers. Every reply is bounded and searched for the
 * connector's own credential before a word of it is read; an echo refuses the whole reply, error or result. */
class McpHttp {
  private nextId = 0;
  private sessionId?: string;
  private protocolVersion = "2025-06-18";
  private readonly headers: Headers;
  private readonly secrets: string[];
  constructor(private readonly connector: Connector, private readonly timeoutMs: number) {
    this.headers = new Headers(connector.headers);
    for (const key of [...this.headers.keys()]) if (/^host$|^content-length$|^connection$|^mcp-/i.test(key)) this.headers.delete(key);
    this.headers.set("content-type", "application/json");
    this.headers.set("accept", "application/json, text/event-stream");
    this.secrets = Object.values(connector.headers).flatMap(value => [value, value.replace(/^Bearer\s+/i, "")]).filter(value => value.length >= 8);
  }
  async initialize() {
    const init = await this.request("initialize", { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo: { name: "openstrudel-clients", version: "1" } });
    if (typeof init.protocolVersion === "string" && init.protocolVersion.length < 32) this.protocolVersion = init.protocolVersion;
    await this.request("notifications/initialized", {}, true);
  }
  async tools(): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const list = await this.request("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(list.tools)) throw unexpected();
      for (const tool of list.tools) if (record(tool) && typeof tool.name === "string") names.push(tool.name);
      if (typeof list.nextCursor !== "string" || !list.nextCursor) return names;
      cursor = list.nextCursor;
    }
    return names;
  }
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.request("tools/call", { name, arguments: args });
    if (result.isError) throw refusalOf(result);
    if (record(result.structuredContent)) return result.structuredContent;
    const first = Array.isArray(result.content) ? result.content.find((item: unknown) => record(item) && item.type === "text" && typeof item.text === "string") : undefined;
    try { return first ? JSON.parse(first.text) : undefined; } catch { throw unexpected(); }
  }
  private async request(method: string, params: Record<string, unknown>, notification = false): Promise<Record<string, any>> {
    const id = ++this.nextId, headers = new Headers(this.headers);
    if (this.sessionId) headers.set("mcp-session-id", this.sessionId);
    if (method !== "initialize") headers.set("mcp-protocol-version", this.protocolVersion);
    let response: Response;
    try {
      response = await fetch(this.connector.url, { method: "POST", redirect: "error", headers, signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }) });
    } catch (error) {
      throw clientsRefusal("service_unavailable", error instanceof Error && error.name === "TimeoutError" ? "Сервис не ответил вовремя." : "Нет соединения с сервисом.");
    }
    // Refusals from the transport are never read: their bodies could carry request details.
    if (response.status === 401) { await response.body?.cancel(); throw clientsRefusal("service_auth"); }
    if (response.status === 403) { await response.body?.cancel(); throw clientsRefusal("service_denied"); }
    if (!response.ok) { await response.body?.cancel(); throw clientsRefusal("service_unavailable", "HTTP " + response.status); }
    const session = response.headers.get("mcp-session-id");
    if (session && /^[\x21-\x7e]{1,512}$/.test(session)) this.sessionId = session;
    if (notification) { await response.body?.cancel(); return {}; }
    let body: unknown;
    try { body = await boundedResponse(response, id); } catch { throw unexpected(); }
    if (this.secrets.some(secret => JSON.stringify(body).includes(secret))) throw clientsRefusal("service_unavailable", "Сервис вернул учётные данные в ответе.");
    if (!record(body) || body.jsonrpc !== "2.0" || body.id !== id) throw unexpected();
    if (body.error) throw clientsRefusal("service_unavailable", plain(record(body.error) ? body.error.message : undefined, 200));
    if (!record(body.result)) throw unexpected();
    return body.result;
  }
}

/** The service's own short refusal. A denial stays a denial; anything else is the service being unavailable for this read. */
function refusalOf(result: Record<string, any>): ClientsError {
  const structured = record(result.structuredContent) ? result.structuredContent : {};
  const first = Array.isArray(result.content) ? result.content.find((item: unknown) => record(item) && item.type === "text" && typeof item.text === "string") : undefined;
  let parsed: Record<string, any> | undefined;
  if (first) try { const value = JSON.parse(first.text); if (record(value)) parsed = value; } catch { /* Plain service text. */ }
  const code = [structured.code, record(structured.error) ? structured.error.code : undefined, parsed?.code, record(parsed?.error) ? parsed.error.code : undefined]
    .find((value): value is string => typeof value === "string")?.toLowerCase();
  const message = plain(structured.text, 300) ?? (first && !parsed ? plain(first.text, 300) : undefined);
  const denied = code === "forbidden" || /only an owner|operations team member|forbidden|not allowed|denied|access required|cannot access/i.test(message ?? "");
  return clientsRefusal(denied ? "service_denied" : "service_unavailable", message ?? code);
}

export class ClientsAdapter {
  /** Per process: which tools each connector offered, and the last list read, so the tab opens without a round of handshakes.
   * A send never trusts them: a reference is verified against a fresh read. */
  private static readonly discovered = new Map<string, { at: number; tools: string[] }>();
  private static readonly lists = new Map<string, { at: number; value: { source: ClientSource; clients: BusinessClient[] } }>();
  constructor(private readonly root: string, private readonly store: Store, private readonly options: { timeoutMs?: number; now?: () => number } = {}) {}
  private get now() { return this.options.now?.() ?? Date.now(); }
  private get timeout() { return this.options.timeoutMs ?? 20_000; }

  /** The main chat's HTTP services, as the owner connected them; a stdio service cannot be read from here. */
  private connectors(): Connector[] {
    return Object.entries(contextServers(this.root, "personal", {})).flatMap(([name, service]: [string, any]) =>
      service?.type === "http" && typeof service.url === "string" ? [{ name, url: service.url, headers: { ...(service.headers ?? {}) } }] : []);
  }
  private remembered(): ClientSource | undefined {
    try { const saved = clientSourceSchema.safeParse(JSON.parse(this.store.getSetting("clients.source") ?? "null")); return saved.success ? saved.data : undefined; } catch { return undefined; }
  }

  /** The one connector offering the client tools. The source read last keeps its identity: while it is configured, its
   * failure is reported and no other connector stands in for it. None is a missing source; several are ambiguous and
   * nobody is chosen for the owner. */
  async source(refresh = false): Promise<{ source: ClientSource; connector: Connector }> {
    const offering: Array<{ source: ClientSource; connector: Connector }> = [], failures = new Map<string, ClientsError>(), seen = new Set<string>();
    for (const connector of this.connectors()) {
      seen.add(connector.name);
      const source = sourceOf(connector), cached = refresh ? undefined : ClientsAdapter.discovered.get(source.fingerprint);
      let tools: string[];
      if (cached && this.now - cached.at < 600_000) tools = cached.tools;
      else {
        try { const http = new McpHttp(connector, this.timeout); await http.initialize(); tools = await http.tools(); }
        catch (error) { failures.set(connector.name, error instanceof ClientsError ? error : clientsRefusal("service_unavailable")); continue; }
        ClientsAdapter.discovered.set(source.fingerprint, { at: this.now, tools });
      }
      if (CLIENT_TOOLS.every(tool => tools.includes(tool))) offering.push({ source, connector });
    }
    const known = this.remembered();
    if (known && seen.has(known.connector)) {
      const failure = failures.get(known.connector);
      if (failure) throw failure;
      const current = offering.find(o => o.connector.name === known.connector);
      if (!current) throw clientsRefusal("no_connector", known.connector);
      if (offering.length > 1 && current.connector.name !== COMPANY) throw clientsRefusal("ambiguous", offering.map(o => o.connector.name).join(", "));
      if (!sameSource(current.source, known)) this.store.setSetting("clients.source", JSON.stringify(current.source));
      return current;
    }
    // The owner's personal MCP can mirror the company tools; the connector the owner named «company» is the business
    // source then. Any other tie stays ambiguous for the owner to trim.
    const chosen = offering.length === 1 ? offering[0] : offering.find(o => o.connector.name === COMPANY);
    if (chosen) { this.store.setSetting("clients.source", JSON.stringify(chosen.source)); return chosen; }
    if (offering.length > 1) throw clientsRefusal("ambiguous", offering.map(o => o.connector.name).join(", "));
    // Discovery that could not finish is not a missing source: a connector that refused or did not answer keeps its own state,
    // named in the detail, without calling it the company connector.
    if (failures.size) {
      const codes = new Set([...failures.values()].map(f => f.code));
      if (codes.size === 1) throw clientsRefusal([...codes][0]!, [...failures.keys()].join(", "));
      throw clientsRefusal("service_unavailable", [...failures].map(([name, f]) => name + ": " + f.code).join(", "));
    }
    throw clientsRefusal("no_connector");
  }

  /** The list read from one discovered connector: the address and credential captured with that discovery, so a
   * configuration that changes meanwhile cannot tag another connector's clients with this source. */
  private async readList(snapshot: { source: ClientSource; connector: Connector }, fresh: boolean): Promise<{ source: ClientSource; clients: BusinessClient[] }> {
    const cached = fresh ? undefined : ClientsAdapter.lists.get(snapshot.source.fingerprint);
    if (cached && this.now - cached.at < 60_000) return cached.value;
    const http = new McpHttp(snapshot.connector, this.timeout);
    await http.initialize();
    const parsed = listResult.safeParse(await http.call("company_clients_list", {}));
    if (!parsed.success) throw unexpected();
    const value = { source: snapshot.source, clients: parsed.data.clients.map(c => ({ id: c.clientId, slug: c.slug, name: c.name ?? c.company ?? c.slug, company: c.company, aliases: c.aliases, stage: c.stage, brand: c.brand,
      archived: c.archived, archiveReason: c.archiveReason, fileCount: c.fileCount, readableFileCount: c.readableFileCount })) };
    ClientsAdapter.lists.set(snapshot.source.fingerprint, { at: this.now, value });
    return value;
  }

  async list(refresh = false): Promise<{ source: ClientSource; clients: BusinessClient[] }> {
    return this.readList(await this.source(refresh), refresh);
  }

  /** A reference the owner made earlier is honoured only under the same source, discovered again now, and only for a
   * client the list read from that very connector still has. Nothing cached stands in for the service's current answer. */
  async verify(ref: ClientRef): Promise<{ client: BusinessClient; source: ClientSource; connector: Connector }> {
    const snapshot = await this.source(true);
    if (!sameSource(ref.source, snapshot.source)) throw clientsRefusal("client_source_changed");
    const { clients } = await this.readList(snapshot, true);
    const client = clients.find(c => c.id === ref.clientId);
    if (!client) throw clientsRefusal("client_unknown");
    return { client, ...snapshot };
  }

  /** The files of one client the owner selected: read under that client's source, for that client's id. A reused slug
   * or a replaced connector answering with another client is refused, never shown. */
  async files(ref: ClientRef, offset = 0): Promise<{ source: ClientSource; client: { id: string; slug: string; name: string; archived: boolean }; total: number; offset: number; hasMore: boolean; nextOffset: number | null; files: ClientFile[] }> {
    const { client, source, connector } = await this.verify(ref);
    const http = new McpHttp(connector, this.timeout);
    await http.initialize();
    const parsed = filesResult.safeParse(await http.call("company_client_files_list", { client: client.slug, limit: 50, offset: Math.max(0, Math.min(100_000, Math.trunc(offset))) }));
    if (!parsed.success) throw unexpected();
    const { client: answered, files, ...page } = parsed.data;
    if (!answered || answered.clientId !== client.id) throw clientsRefusal("client_unknown");
    return { source, client: { id: answered.clientId, slug: answered.slug, name: answered.name ?? client.name, archived: answered.archived }, ...page,
      files: files.map(f => ({ id: f.fileId, name: f.fileName, category: f.category, sizeBytes: f.sizeBytes, createdAt: f.createdAt, access: f.access, note: f.note })) };
  }
}
