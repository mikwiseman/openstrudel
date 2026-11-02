import { createHash } from "node:crypto";
import { z } from "zod";
import { contextServers } from "./claude.js";
import { ownerOnlyServers } from "./extensions.js";
import { HomeError } from "./home.js";
import type { Store } from "./store.js";

/** Read through the owner's existing Unipile connection, without exposing its generic request executor.
 * No listener, sync database, provider writes, or account discovery outside the explicit allowlist. */
export const UNIPILE_ACCOUNTS_SETTING = "unipile.accounts";
const origin = "https://api.unipile.com";
const connectorUrl = "https://developer.unipile.com/mcp";
const maxBytes = 1024 * 1024;
const id = z.string().min(1).max(512).regex(/^[A-Za-z0-9_:@=.+~-]+$/).refine(v => v !== "." && v !== "..");
const accountId = z.string().regex(/^acc_[A-Za-z0-9_-]{1,120}$/);
const provider = z.enum(["linkedin", "whatsapp"]);
const instant = z.string().datetime({ offset: true });
const shortText = z.string().max(1000);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);

export const unipileAccountsSchema = z.array(z.object({
  accountId, provider, providerUserId: z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/),
}).strict()).min(1).max(10).refine(items => new Set(items.map(a => a.accountId)).size === items.length);
export type UnipileAllowedAccount = z.infer<typeof unipileAccountsSchema>[number];

export const unipileReadSchema = z.object({
  accountId, sourceFingerprint: fingerprint,
  resource: z.enum(["inboxes", "chats", "messages"]),
  inboxId: id.optional(), chatId: id.optional(),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(100_000).optional(),
  cursor: z.string().min(1).max(4096).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
  before: instant.optional(), after: instant.optional(),
}).strict().superRefine((input, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: "custom", message });
  if (input.cursor !== undefined && input.offset !== undefined) bad("Use cursor or offset, not both.");
  if (input.before && input.after && Date.parse(input.after) >= Date.parse(input.before)) bad("after must precede before.");
  if (input.resource === "inboxes" && [input.inboxId, input.chatId, input.cursor, input.offset, input.before, input.after].some(v => v !== undefined)) bad("Inbox discovery has no page or chat filters.");
  if (input.resource === "chats" && input.chatId !== undefined) bad("Use messages to read one chat.");
  if (input.resource === "messages" && (!input.chatId || input.inboxId !== undefined)) bad("Messages require one chatId and no inboxId.");
});
export type UnipileReadInput = z.input<typeof unipileReadSchema>;

export type UnipileCode = "owner_only" | "not_configured" | "account_denied" | "source_changed" | "account_unavailable" | "service_auth" | "service_denied" | "service_unavailable" | "response_too_large" | "unsupported_resource" | "invalid_arguments";
const messages: Record<UnipileCode, string> = {
  owner_only: "Личные переписки доступны только владельцу в его главном чате.",
  not_configured: "Настройте личное подключение Unipile и разрешённые аккаунты.",
  account_denied: "Этот аккаунт не входит в проверенный личный доступ.",
  source_changed: "Подключение или доступ изменились. Заново прочитайте список аккаунтов.",
  account_unavailable: "Аккаунт сейчас не готов к чтению. Его доступность не подтверждена.",
  service_auth: "Unipile не принял ключ подключения.",
  service_denied: "Unipile не разрешил чтение этого источника.",
  service_unavailable: "Unipile не вернул проверяемый ответ. Охват чтения неизвестен.",
  response_too_large: "Ответ источника слишком большой. Уменьшите размер страницы.",
  unsupported_resource: "Для LinkedIn сначала выберите папку через список inboxes.",
  invalid_arguments: "Проверьте аккаунт, источник и параметры страницы.",
};
export class UnipileError extends HomeError {
  constructor(readonly code: UnipileCode) { super(messages[code], ["owner_only", "account_denied", "service_denied"].includes(code) ? 403 : code === "invalid_arguments" ? 400 : 409); }
}
const fail = (code: UnipileCode): never => { throw new UnipileError(code); };
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value); return result.success ? result.data : fail("service_unavailable"); };
const accountResult = z.object({ object: z.literal("Account"), id: accountId, user_id: z.string(), provider, status: z.string(), is_locked: z.boolean(), name: shortText.optional(),
  metadata: z.object({ products_connection_status: z.record(z.string(), z.string()).optional() }).optional(),
});
const pageResult = z.object({ data: z.array(z.unknown()).max(100), total_count: z.number().int().nonnegative().nullish(), next_cursor: z.string().max(4096).nullish() });
const inboxResult = z.object({ id, disabled: z.boolean(), description: shortText.optional() });
const chatResult = z.object({ id, name: shortText.nullable(), provider, type: z.enum(["1to1", "group", "channel"]), unread_count: z.number().int().nonnegative(),
  is_readonly: z.boolean(), is_archived: z.boolean(), last_message_timestamp: instant.optional(),
});
const attachmentResult = z.object({ id: z.string().min(1).max(512), type: z.string().max(80), filename: shortText.optional(), mimetype: z.string().max(200).optional(), file_size: z.number().nonnegative().optional(), is_unavailable: z.boolean().optional() });
const messageResult = z.object({ id, chat_id: id, sender_id: z.string().max(512), provider, timestamp: instant, is_sender: z.boolean(), is_deleted: z.boolean(), is_hidden: z.boolean(), is_edited: z.boolean(), is_event: z.boolean(),
  text: z.string().max(64_000).optional(), attachments: z.array(attachmentResult).max(100),
});

type Snapshot = { account: UnipileAllowedAccount; key: string; fingerprint: string };
export interface UnipileSource extends UnipileAllowedAccount { connector: "unipile"; endpoint: string; sourceFingerprint: string; checkedAt: string }
export interface UnipilePage {
  source: UnipileSource;
  resource: UnipileReadInput["resource"];
  inboxId?: string; chatId?: string;
  items: Array<Record<string, unknown>>;
  coverage: { returned: number; total: number | null; limit: number; offset: number | null; nextCursor: string | null; nextOffset: number | null; hasMore: boolean | null; complete: boolean | null; truncated: boolean; note: string };
}

export class UnipileAdapter {
  constructor(private readonly root: string, private readonly store: Pick<Store, "getSetting">,
    private readonly options: { owner?: boolean; fetch?: typeof fetch; now?: () => Date; timeoutMs?: number } = {}) {}
  private get now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private allowed(): UnipileAllowedAccount[] {
    if (this.options.owner !== true) return fail("owner_only");
    let value: unknown;
    try { value = JSON.parse(this.store.getSetting(UNIPILE_ACCOUNTS_SETTING) ?? "null"); } catch { return fail("not_configured"); }
    const result = unipileAccountsSchema.safeParse(value);
    return result.success ? result.data : fail("not_configured");
  }
  private snapshot(requested: string): Snapshot {
    const account = this.allowed().find(a => a.accountId === requested);
    if (!account) return fail("account_denied");
    let privateNames: string[];
    try { privateNames = ownerOnlyServers(this.root); } catch { return fail("not_configured"); }
    if (!privateNames.includes("unipile")) return fail("not_configured");
    let connection: ReturnType<typeof contextServers>[string] | undefined;
    try { connection = contextServers(this.root, "personal", {}).unipile; } catch { return fail("not_configured"); }
    if (!connection || connection.type !== "http" || connection.url.replace(/\/$/, "") !== connectorUrl || !connection.toolLists?.disabled?.includes("execute_request")) return fail("not_configured");
    const keys = Object.entries(connection.headers ?? {}).filter(([name]) => name.toLowerCase() === "x-api-key").map(([, value]) => value);
    const key = keys.length === 1 ? keys[0] : undefined;
    if (typeof key !== "string" || key.length < 8 || key.length > 16_000 || /[\x00-\x20\x7f]/.test(key)) return fail("not_configured");
    return { account, key, fingerprint: createHash("sha256").update(JSON.stringify([origin, connectorUrl, key, account])).digest("hex") };
  }
  private unchanged(snapshot: Snapshot) {
    if (this.snapshot(snapshot.account.accountId).fingerprint !== snapshot.fingerprint) fail("source_changed");
  }
  private source(snapshot: Snapshot): UnipileSource {
    return { connector: "unipile", endpoint: origin + "/v2", ...snapshot.account, sourceFingerprint: snapshot.fingerprint, checkedAt: this.now };
  }
  private async get(snapshot: Snapshot, path: string, query?: URLSearchParams): Promise<unknown> {
    const url = new URL("/v2" + path, origin);
    if (query) url.search = query.toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(30_000, this.options.timeoutMs ?? 10_000)));
    try {
      const response = await (this.options.fetch ?? fetch)(url, { method: "GET", redirect: "error", signal: controller.signal, headers: { "X-API-KEY": snapshot.key, accept: "application/json" } });
      if (!response.ok) {
        await response.body?.cancel();
        return fail(response.status === 401 ? "service_auth" : response.status === 403 ? "service_denied" : "service_unavailable");
      }
      if (Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); return fail("response_too_large"); }
      if (!response.body) return fail("service_unavailable");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const abort = () => { void reader.cancel().catch(() => undefined); };
      controller.signal.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          const part = await reader.read();
          if (controller.signal.aborted) return fail("service_unavailable");
          if (part.done) break;
          size += part.value.byteLength;
          if (size > maxBytes) { await reader.cancel(); return fail("response_too_large"); }
          chunks.push(part.value);
        }
      } finally { controller.signal.removeEventListener("abort", abort); reader.releaseLock(); }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.includes(snapshot.key)) return fail("service_unavailable");
      const decoded: unknown = JSON.parse(raw);
      if (JSON.stringify(decoded).includes(JSON.stringify(snapshot.key).slice(1, -1))) return fail("service_unavailable");
      return decoded;
    } catch (error) { if (error instanceof UnipileError) throw error; return fail("service_unavailable"); }
    finally { clearTimeout(timer); }
  }
  private async verify(snapshot: Snapshot) {
    const result = parse(accountResult, await this.get(snapshot, "/accounts/" + encodeURIComponent(snapshot.account.accountId)));
    if (result.id !== snapshot.account.accountId || result.provider !== snapshot.account.provider || result.user_id !== snapshot.account.providerUserId) return fail("account_denied");
    if (result.status !== "running" || result.is_locked || result.provider === "linkedin" && result.metadata?.products_connection_status?.classic && result.metadata.products_connection_status.classic !== "running") return fail("account_unavailable");
    this.unchanged(snapshot);
    return result;
  }
  async accounts(): Promise<{ accounts: Array<{ source: UnipileSource; name: string | null }>; checkedAt: string }> {
    const accounts = [], snapshots = [];
    for (const configured of this.allowed()) {
      const snapshot = this.snapshot(configured.accountId), verified = await this.verify(snapshot);
      snapshots.push(snapshot);
      accounts.push({ source: this.source(snapshot), name: verified.name ?? null });
    }
    for (const snapshot of snapshots) this.unchanged(snapshot);
    return { accounts, checkedAt: this.now };
  }
  async read(input: UnipileReadInput): Promise<UnipilePage> {
    if (this.options.owner !== true) return fail("owner_only");
    const validated = unipileReadSchema.safeParse(input);
    if (!validated.success) return fail("invalid_arguments");
    const request = validated.data, snapshot = this.snapshot(request.accountId);
    if (snapshot.fingerprint !== request.sourceFingerprint) return fail("source_changed");
    if (request.resource === "chats" && snapshot.account.provider === "linkedin" && !request.inboxId) return fail("unsupported_resource");
    await this.verify(snapshot);
    const path = "/" + encodeURIComponent(request.accountId) + (request.resource === "inboxes" ? "/inboxes" : request.resource === "messages"
      ? "/chats/" + encodeURIComponent(request.chatId!) + "/messages" : (request.inboxId ? "/inboxes/" + encodeURIComponent(request.inboxId) : "") + "/chats");
    const query = new URLSearchParams();
    if (request.resource !== "inboxes") {
      query.set("limit", String(request.limit));
      for (const key of ["cursor", "offset", "before", "after"] as const) if (request[key] !== undefined) query.set(key, String(request[key]));
    }
    const page = parse(pageResult, await this.get(snapshot, path, query));
    this.unchanged(snapshot);
    if (request.resource !== "inboxes" && page.data.length > request.limit) return fail("service_unavailable");
    const selected = page.data.slice(0, request.limit), truncated = selected.length !== page.data.length;
    const items = selected.map(item => {
      if (request.resource === "inboxes") { const row = parse(inboxResult, item); return { id: row.id, disabled: row.disabled, description: row.description ?? null }; }
      if (request.resource === "chats") {
        const row = parse(chatResult, item);
        if (row.provider !== snapshot.account.provider) return fail("account_denied");
        return { id: row.id, name: row.name, provider: row.provider, type: row.type, unreadCount: row.unread_count, readOnly: row.is_readonly, archived: row.is_archived, lastMessageAt: row.last_message_timestamp ?? null };
      }
      const row = parse(messageResult, item);
      if (row.provider !== snapshot.account.provider || row.chat_id !== request.chatId) return fail("account_denied");
      return { id: row.id, chatId: row.chat_id, senderId: row.sender_id, provider: row.provider, timestamp: row.timestamp, fromMe: row.is_sender,
        deleted: row.is_deleted, hidden: row.is_hidden, edited: row.is_edited, event: row.is_event, text: row.is_deleted || row.is_hidden ? null : row.text ?? null,
        attachments: row.is_deleted || row.is_hidden ? [] : row.attachments.map(a => ({ id: a.id, type: a.type, fileName: a.filename ?? null, mimeType: a.mimetype ?? null, sizeBytes: a.file_size ?? null, unavailable: a.is_unavailable ?? false })),
      };
    });
    const offset = request.cursor ? null : request.offset ?? 0;
    const total = page.total_count ?? null, nextCursor = page.next_cursor || null;
    // An underfilled page does not prove exhaustion: providers may return fewer than requested.
    const hasMore = truncated || nextCursor ? true : total !== null && offset !== null ? offset + items.length < total : null;
    const nextOffset = request.resource !== "inboxes" && !truncated && !nextCursor && hasMore !== false && offset !== null && items.length > 0 ? offset + items.length : null;
    return { source: this.source(snapshot), resource: request.resource, inboxId: request.inboxId, chatId: request.chatId, items,
      coverage: { returned: items.length, total, limit: request.limit, offset, nextCursor, nextOffset, hasMore, complete: hasMore === null ? null : !hasMore && offset === 0, truncated,
        note: truncated ? "Inbox result exceeds this page; coverage is incomplete." : "One live provider page, not a frozen account snapshot. Missing pagination totals do not prove full coverage. Attachment bodies are not read." } };
  }
}
