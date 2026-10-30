import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { AccountUnavailableError } from "./account-errors.js";
import type { Accounts } from "./accounts.js";
import type { ScopedAuthorization } from "./authorization.js";
import { CodexEngineAdapter, restrictedCodexConfig } from "./codex.js";
import { recordDiagnostic, type DiagnosticReason, type RestrictedStage } from "./diagnostics.js";
import { recommendedModel, restrictedModelSelection } from "./model-settings.js";
import type { DynamicTool } from "./types.js";
import { ownerTimezone } from "./timezone.js";

const supportedCodexVersion = "0.156.1";
/** The reason and status are diagnostics for the owner's journal, never shown to participants. */
const unavailable = (reason: DiagnosticReason = "service_protocol", status?: number) => Object.assign(new Error("Ограниченный доступ сейчас недоступен. Повторите запрос позже."), { reason, status });
const accessChanged = () => new Error("Права доступа изменились. Отправьте запрос заново.");
/** Codex refuses its sandbox helper aliases under the system temp folder, and a restricted
 * thread reads AGENTS.md through that helper, so every turn runs in a private Home folder. */
export const restrictedRunsDirectory = (root: string) => join(root, ".data", "restricted");
const staleRunMs = 24 * 60 * 60 * 1000;

/** A fixed vocabulary: Codex, account and HTTP messages can contain request details. */
function failureReason(error: unknown): DiagnosticReason {
  if (error instanceof AccountUnavailableError) return error.reason === "limits" ? "account_limits" : error.reason === "unavailable" ? "account_unavailable" : "account_sign_in";
  const tagged = error instanceof Error ? (error as Error & { reason?: unknown }).reason : undefined;
  if (typeof tagged === "string") return tagged as DiagnosticReason;
  const message = error instanceof Error ? error.message : "";
  if (/sandbox|bwrap|landlock|seccomp/i.test(message)) return "sandbox";
  if (error instanceof Error && error.name === "TimeoutError" || /не ответил на|timed out/i.test(message)) return "timeout";
  return "codex";
}
const errorClass = (error: unknown) => {
  const name = error instanceof Error ? (error.name !== "Error" ? error.name : error.constructor.name) : typeof error;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Unknown";
};
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const maxResponseBytes = 1024 * 1024;
const safeBusinessErrors: Record<string, string> = {
  forbidden: "Действие недоступно для этого участника.",
  unavailable: "Сервис временно недоступен. Повторите запрос позже.",
  invalid_arguments: "Проверьте параметры действия.",
  report_revision_conflict: "Отчёт изменился. Откройте актуальную версию перед правкой.",
  plan_changed: "Расписание изменилось. Подготовьте новый предварительный просмотр.",
  in_progress: "Действие уже выполняется. Проверьте результат перед повтором.",
};

/** A business refusal is shown to the participant: the service's own short text,
 * never raw JSON, markup or invisible control characters. */
const businessCode = /^[a-z][a-z0-9_]{0,63}$/;
function plainText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}
function businessFailure(result: Record<string, any>): { ok: false; code: string; text: string; issues?: Array<{ path: string; message: string }> } {
  const structured = record(result.structuredContent) ? result.structuredContent : {};
  const first = Array.isArray(result.content) ? result.content.find((item: unknown) => record(item) && item.type === "text" && typeof item.text === "string") : undefined;
  let parsed: Record<string, any> | undefined;
  if (first) try { const value = JSON.parse(first.text); if (record(value)) parsed = value; } catch { /* Plain service text. */ }
  const raw = [structured.code, record(structured.error) ? structured.error.code : undefined, parsed?.code, record(parsed?.error) ? parsed.error.code : undefined]
    .find((value): value is string => typeof value === "string");
  const lowered = raw?.toLowerCase();
  const code = lowered && businessCode.test(lowered) ? lowered : "unavailable";
  // JSON is data for code extraction only; its other fields are never relayed as text.
  const text = plainText(structured.text, 500) ?? (first && !parsed ? plainText(first.text, 500) : undefined)
    ?? (Object.hasOwn(safeBusinessErrors, code) ? safeBusinessErrors[code] : undefined) ?? "Действие сейчас недоступно. Проверьте запрос или повторите позже.";
  const source = record(structured.error) && Array.isArray(structured.error.issues) ? structured.error.issues
    : Array.isArray(structured.issues) ? structured.issues : record(parsed?.error) && Array.isArray(parsed.error.issues) ? parsed.error.issues : [];
  const issues = code === "invalid_arguments" ? source.filter(record).slice(0, 5).flatMap((issue: Record<string, unknown>) => {
    const message = plainText(issue.message, 200);
    return message ? [{ path: plainText(issue.path, 100) ?? "", message }] : [];
  }) : [];
  return { ok: false, code, text, ...(issues.length ? { issues } : {}) };
}

/** Every configured header is a transport credential. Also catch the forms an
 * echoing service would most likely produce: encoded or JSON-escaped copies. */
function credentialForms(headers: Record<string, string>): string[] {
  const forms = new Set<string>();
  for (const value of Object.values(headers)) for (const secret of [value, value.replace(/^Bearer\s+/i, "")]) {
    if (secret.length < 8) continue;
    for (const form of [secret, Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url"), encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) forms.add(form);
  }
  return [...forms];
}

export interface RestrictedRunOptions {
  authorization: ScopedAuthorization;
  conversationId: string;
  messageId: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
}

/** No shared Codex state, stored history, native Home tools or model-visible
 * connector credentials. Each dynamic call uses the same verified transport. */
export class RestrictedExecutor {
  private readonly running = new Set<{ controller: AbortController; engine?: CodexEngineAdapter }>();
  private closed = false;
  constructor(private readonly accounts: Accounts) {
    // A Home stopped mid-turn leaves its turn folder behind; a live turn is never this old.
    try {
      const parent = restrictedRunsDirectory(accounts.root);
      for (const name of readdirSync(parent)) if (name.startsWith("turn-") && Date.now() - statSync(join(parent, name)).mtimeMs > staleRunMs) rmSync(join(parent, name), { recursive: true, force: true });
    } catch { /* No folder yet. */ }
  }

  async run(text: string, options: RestrictedRunOptions): Promise<{ response: string }> {
    const run: { controller: AbortController; engine?: CodexEngineAdapter } = { controller: new AbortController() };
    const signal = AbortSignal.any([run.controller.signal, ...(options.signal ? [options.signal] : [])]);
    let finished = false, root: string | undefined, accountId: string | undefined;
    let stage: RestrictedStage = "prepare";
    const started = Date.now();
    const current = () => {
      if (this.closed || finished || signal.aborted) throw accessChanged();
      try { options.assertCurrent(); } catch { throw accessChanged(); }
    };
    this.running.add(run);
    try {
      current();
      const version = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("@openai/codex/package.json"), "utf8")).version;
      if (version !== supportedCodexVersion) throw unavailable("runtime_version");
      const selection = restrictedModelSelection(this.accounts.store, options.conversationId);
      if (selection.provider !== "chatgpt") throw unavailable("model_provider");
      stage = "account";
      // Deliberately no provider or quota fallback and no retry of a partial turn.
      const chosen = await this.accounts.choose("main", false);
      current();
      accountId = chosen.id;
      this.accounts.active.set(accountId, (this.accounts.active.get(accountId) ?? 0) + 1);
      stage = "discovery";
      const authorization = structuredClone(options.authorization);
      const proxy = new RestrictedMcpProxy(authorization, options.conversationId, signal, current);
      const definitions = await proxy.discover();
      current();
      stage = "runtime";
      const parent = restrictedRunsDirectory(this.accounts.root);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      root = mkdtempSync(join(parent, "turn-"));
      const cwd = join(root, "workspace"), codexHome = join(root, "codex");
      mkdirSync(cwd, { mode: 0o500 });
      mkdirSync(codexHome, { mode: 0o700 });
      // Startup discovery is restricted too, before the first thread exists.
      const config: Record<string, any> = {};
      for (const [key, value] of Object.entries(restrictedCodexConfig(cwd))) {
        const parts = key.split("."); let cursor = config;
        for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
        cursor[parts.at(-1)!] = value;
      }
      writeFileSync(join(codexHome, "config.toml"), stringify(config), { mode: 0o600 });
      let timezone: string | undefined;
      try { const saved = ownerTimezone(this.accounts.store); if (saved) timezone = new Intl.DateTimeFormat("en", { timeZone: saved }).resolvedOptions().timeZone; } catch { /* An invalid preference must not become instructions. */ }
      const clock = `Current time: ${new Date().toISOString()}. ` + (timezone ? `Default timezone: ${timezone}; use it unless the user gives another.` : "No default timezone is configured; use the lesson's timezone or ask before moving it. The server clock is not the user's timezone.");
      const engine = new CodexEngineAdapter({ restricted: true, workingDirectory: cwd, codexHome,
        restrictedInstructions: [clock, proxy.instructions].filter(Boolean).join("\n\n"),
        authTokens: async refresh => { current(); const tokens = await chosen.service.authTokens(refresh); current(); return tokens; } });
      run.engine = engine;
      // A level the chosen model does not offer falls back to the model's own instead of failing the turn.
      const models = await engine.models();
      const model = selection.model ? models.find(choice => choice.id === selection.model) : recommendedModel(models);
      if (selection.reasoningEffort != null && model && !model.reasoningEfforts?.some(effort => effort.id === selection.reasoningEffort)) delete selection.reasoningEffort;
      current();
      const result = await engine.run(text, { ...selection, conversationId: options.conversationId, messageId: options.messageId,
        signal, employees: [], approvalMode: "approve_all", tools: { definitions, call: (name, args) => proxy.call(name, args) },
        onEvent: event => { if (event.type === "thread.started") stage = "turn"; } });
      current();
      return { response: result.response };
    } catch (error) {
      // A changed grant is expected. Any other failure leaves only its stage, class and a fixed reason.
      if (!(error instanceof Error && error.message === accessChanged().message)) {
        const reason = failureReason(error), status = reason === "service_http" ? (error as { status?: number }).status : undefined;
        recordDiagnostic(this.accounts.store, "restricted.failed", { stage, errorClass: errorClass(error), reason, durationMs: Date.now() - started, status });
      }
      // Account/provider/HTTP exceptions can contain request details or headers.
      if (error instanceof Error && [accessChanged().message, unavailable().message].includes(error.message)) throw error;
      throw unavailable();
    } finally {
      finished = true;
      run.controller.abort();
      run.engine?.close();
      // Codex writes thread locks while it exits; removing the folder earlier lets it recreate one.
      if (run.engine) await Promise.race([run.engine.settled(), new Promise(resolve => setTimeout(resolve, 5_000).unref())]);
      this.running.delete(run);
      if (accountId) {
        const remaining = (this.accounts.active.get(accountId) ?? 1) - 1;
        if (remaining) this.accounts.active.set(accountId, remaining); else this.accounts.active.delete(accountId);
      }
      if (root) rmSync(root, { recursive: true, force: true });
    }
  }

  close(): void {
    this.closed = true;
    for (const run of this.running) { run.controller.abort(); run.engine?.close(); }
  }
}

class RestrictedMcpProxy {
  instructions = "";
  private nextId = 0;
  private sessionId?: string;
  private protocolVersion = "2025-03-26";
  private readonly allowed: Set<string>;
  private readonly exposed = new Set<string>();
  private readonly headers: Headers;
  private readonly secrets: string[];
  constructor(private readonly authorization: ScopedAuthorization, conversationId: string,
    private readonly signal: AbortSignal, private readonly current: () => void) {
    const url = new URL(authorization.connector.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw unavailable();
    const actor = authorization.actor;
    if (!/^[1-9][0-9]{0,19}$/.test(actor.userId) || !/^-?[1-9][0-9]{0,19}$/.test(actor.chatId)
      || !new RegExp(`^${actor.chatId}:[1-9][0-9]*$`).test(actor.messageId)
      || !/^[A-Za-z0-9_.:-]{1,160}$/.test(conversationId)) throw unavailable();
    if (authorization.tools.length > 100 || authorization.tools.some(t => !/^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(t.name))) throw unavailable();
    this.allowed = new Set(authorization.tools.map(t => t.name));
    if (this.allowed.size !== authorization.tools.length) throw unavailable();
    this.headers = new Headers(authorization.connector.headers);
    this.secrets = credentialForms(authorization.connector.headers);
    for (const key of [...this.headers.keys()]) if (/^x-hermes-|^mcp-|^host$|^content-length$|^connection$/i.test(key)) this.headers.delete(key);
    this.headers.set("content-type", "application/json");
    this.headers.set("accept", "application/json, text/event-stream");
    this.headers.set("x-hermes-platform", "telegram");
    this.headers.set("x-hermes-user-id", actor.userId);
    this.headers.set("x-hermes-chat-id", actor.chatId);
    this.headers.set("x-hermes-message-id", actor.messageId);
    // One audience may hold several participants: the service never shares state between them.
    this.headers.set("x-hermes-session-id", `openstrudel:${conversationId}:${actor.userId}`);
  }

  async discover(): Promise<DynamicTool[]> {
    const initialized = await this.request("initialize", { protocolVersion: this.protocolVersion,
      capabilities: {}, clientInfo: { name: "openstrudel-restricted", version: "1" } });
    if (!["2024-11-05", "2025-03-26", "2025-06-18"].includes(initialized.protocolVersion)) throw unavailable();
    if (initialized.instructions !== undefined && (typeof initialized.instructions !== "string" || initialized.instructions.length > 32_000)) throw unavailable();
    this.instructions = initialized.instructions ?? "";
    this.protocolVersion = initialized.protocolVersion;
    await this.request("notifications/initialized", {}, true);
    const definitions: DynamicTool[] = [], seen = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const list = await this.request("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(list.tools) || seen.size + list.tools.length > 100) throw unavailable();
      for (const tool of list.tools) {
        if (!record(tool) || typeof tool.name !== "string" || seen.has(tool.name)) throw unavailable();
        seen.add(tool.name);
        if (!this.allowed.has(tool.name)) continue;
        if (!record(tool.inputSchema) || tool.inputSchema.type !== "object" || typeof tool.description !== "string") throw unavailable();
        definitions.push({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
        this.exposed.add(tool.name);
      }
      if (list.nextCursor === undefined || list.nextCursor === null) return definitions;
      if (typeof list.nextCursor !== "string" || !list.nextCursor || list.nextCursor.length > 1000 || cursors.has(list.nextCursor)) throw unavailable();
      cursor = list.nextCursor; cursors.add(cursor);
    }
    throw unavailable();
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.current();
    if (!this.allowed.has(name) || !this.exposed.has(name) || !record(args)) throw new Error("Действие недоступно для этого участника.");
    const result = await this.request("tools/call", { name, arguments: args });
    // The model learns why the service refused, so it neither invents an outage nor repeats the request.
    if (result.isError) return businessFailure(result);
    return result;
  }

  /** Decoded strings are checked as well as the serialized result: escaping must not hide an echoed credential. */
  private leaks(result: unknown): boolean {
    const serialized = JSON.stringify(result);
    if (this.secrets.some(secret => serialized.includes(secret))) return true;
    const strings: string[] = [];
    const visit = (value: unknown, depth: number): void => {
      if (typeof value === "string") strings.push(value);
      else if (depth < 64 && Array.isArray(value)) for (const item of value) visit(item, depth + 1);
      else if (depth < 64 && record(value)) for (const [key, item] of Object.entries(value)) { strings.push(key); visit(item, depth + 1); }
    };
    visit(result, 0);
    return strings.some(text => this.secrets.some(secret => text.includes(secret)));
  }

  private async request(method: string, params: Record<string, unknown>, notification = false): Promise<Record<string, any>> {
    this.current();
    const id = ++this.nextId, headers = new Headers(this.headers);
    if (this.sessionId) headers.set("mcp-session-id", this.sessionId);
    if (method !== "initialize") headers.set("mcp-protocol-version", this.protocolVersion);
    try {
      const response = await fetch(this.authorization.connector.url, { method: "POST", redirect: "error", headers,
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]),
        body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }) });
      this.current();
      if (!response.ok) { await response.body?.cancel(); throw unavailable("service_http", response.status); }
      const session = response.headers.get("mcp-session-id");
      if (session) {
        if (!/^[\x21-\x7e]{1,512}$/.test(session) || this.sessionId && session !== this.sessionId) throw unavailable();
        this.sessionId = session;
      }
      if (notification) { await response.body?.cancel(); return {}; }
      const body = await boundedResponse(response, id);
      this.current();
      if (!record(body) || body.jsonrpc !== "2.0" || body.id !== id || body.error || !record(body.result)) throw unavailable();
      if (this.leaks(body.result)) throw unavailable("credential_echo");
      return body.result;
    } catch (error) {
      this.current();
      // Only a classified refusal leaves this method; the original error may hold request details.
      if (error instanceof Error && error.message === unavailable().message) throw error;
      throw unavailable(error instanceof Error && error.name === "TimeoutError" ? "timeout" : error instanceof TypeError && error.message === "fetch failed" ? "network" : "service_protocol");
    }
  }
}

async function boundedResponse(response: Response, id: number): Promise<unknown> {
  if (!response.body || Number(response.headers.get("content-length") ?? 0) > maxResponseBytes) throw unavailable();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = "";
  const streaming = response.headers.get("content-type")?.includes("text/event-stream");
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxResponseBytes) throw unavailable();
      text += decoder.decode(chunk.value, { stream: true });
      if (streaming) {
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(text))) {
          const event = text.slice(0, boundary.index); text = text.slice(boundary.index + boundary[0].length);
          const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          const message = JSON.parse(data);
          if (message.id === id) return message;
        }
      }
    }
    text += decoder.decode();
    if (streaming) throw unavailable();
    return JSON.parse(text);
  } finally { await reader.cancel(); }
}
