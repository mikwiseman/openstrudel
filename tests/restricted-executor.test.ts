import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import type { Accounts } from "../src/accounts.js";
import type { ScopedAuthorization } from "../src/authorization.js";
import { AccountUnavailableError } from "../src/account-errors.js";
import { diagnosticReport } from "../src/diagnostics.js";
import { Store } from "../src/store.js";
import { normalizeModels, saveConversationModelSelection, saveModelSelection } from "../src/model-settings.js";

const runtime = vi.hoisted(() => ({ options: [] as any[], run: vi.fn(), close: vi.fn(), settled: vi.fn(), models: vi.fn() }));
vi.mock("../src/codex.js", async original => ({ ...await original<object>(), CodexEngineAdapter: class {
  constructor(options: unknown) { runtime.options.push(options); }
  run = runtime.run;
  close = runtime.close;
  settled = runtime.settled;
  models = runtime.models;
} }));
import { RestrictedExecutor, restrictedRunsDirectory } from "../src/restricted-executor.js";

const secret = "synthetic-restricted-connector-token";
const allowed = { name: "school_mentor_schedule", capability: "schedule.read" };
const definition = (name = allowed.name) => ({ name, description: "Current permitted lessons", inputSchema: { type: "object", properties: {}, additionalProperties: false } });
const authorization = (): ScopedAuthorization => ({ fingerprint: "a".repeat(64), actor: { userId: "123", chatId: "123", messageId: "123:4" },
  connector: { url: "https://school.invalid/api/mcp/company", headers: { Authorization: "Bearer " + secret } }, tools: [allowed] });
const stores: Store[] = [], executors: RestrictedExecutor[] = [], homes: string[] = [];
const calls: Array<{ body: any; headers: Headers; init: RequestInit }> = [];
let respond: (body: any, headers: Headers) => Response | Promise<Response>;
const result = (id: number, value: unknown, headers: Record<string, string> = {}) => Response.json({ jsonrpc: "2.0", id, result: value }, { headers });
const catalog = (efforts: string[]) => normalizeModels(["pinned-model", "chat-model"].map(model => ({ model, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })), serviceTiers: [{ id: "priority", name: "Fast" }] })), null);

function fixture(auth = authorization()) {
  const store = new Store(":memory:"); stores.push(store);
  saveModelSelection(store, { provider: "chatgpt", model: "pinned-model", serviceTier: "default" });
  const service = { authTokens: vi.fn().mockResolvedValue({ accessToken: "synthetic-account-token", chatgptAccountId: "account" }) };
  const root = mkdtempSync(join(tmpdir(), "restricted-home-")); homes.push(root);
  const accounts = { store, root, active: new Map<string, number>(), choose: vi.fn().mockResolvedValue({ id: "default", service }) } as unknown as Accounts;
  const executor = new RestrictedExecutor(accounts); executors.push(executor);
  const options = { authorization: auth, conversationId: store.primaryConversation().id, messageId: "stored-message", assertCurrent: vi.fn() };
  return { store, root, service, accounts, executor, options };
}

beforeEach(() => {
  calls.length = 0; runtime.options.length = 0; runtime.run.mockReset(); runtime.close.mockReset(); runtime.settled.mockReset().mockResolvedValue(undefined);
  runtime.models.mockReset().mockResolvedValue(catalog(["low", "medium", "xhigh"]));
  respond = body => {
    if (body.method === "initialize") return result(body.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} } }, { "mcp-session-id": "synthetic-session" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return result(body.id, { tools: [definition(), definition("company_finance"), definition("send_telegram_message")] });
    if (body.method === "tools/call") return result(body.id, { content: [{ type: "text", text: '{"ok":true,"lessons":[]}' }] });
    throw new Error("Unexpected method");
  };
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string), headers = new Headers(init.headers);
    calls.push({ body, headers, init });
    return respond(body, headers);
  }));
  runtime.run.mockResolvedValue({ response: "Готово", threadId: "ephemeral", events: [] });
});
afterEach(() => { for (const executor of executors.splice(0)) executor.close(); for (const store of stores.splice(0)) store.close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); vi.unstubAllGlobals(); });

it("exposes only granted business tools and sends verified transport outside the model", async () => {
  const { executor, options, accounts } = fixture();
  runtime.run.mockImplementation(async (_text, turn) => {
    expect(turn.tools.definitions).toEqual([{ type: "function", ...definition() }]);
    expect(JSON.stringify(turn)).not.toContain(secret);
    expect(turn).toMatchObject({ model: "pinned-model", employees: [], approvalMode: "approve_all" });
    expect(turn.threadId).toBeUndefined(); expect(turn.profile).toBeUndefined();
    await expect(turn.tools.call("company_finance", {})).rejects.toThrow("недоступно");
    await expect(turn.tools.call("send_telegram_message", {})).rejects.toThrow("недоступно");
    await expect(turn.tools.call("exec_command", {})).rejects.toThrow("недоступно");
    await expect(turn.tools.call(allowed.name, {})).resolves.toMatchObject({ content: [{ type: "text" }] });
    expect(accounts.active.get("default")).toBe(1);
    return { response: "Расписание проверено" };
  });
  expect(await executor.run("Проверь занятия", options)).toEqual({ response: "Расписание проверено" });
  expect(accounts.choose).toHaveBeenCalledExactlyOnceWith("main", false);
  expect(calls.map(c => c.body.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  for (const { headers, init } of calls) {
    expect(Object.fromEntries(headers)).toMatchObject({ authorization: "Bearer " + secret, "x-hermes-platform": "telegram", "x-hermes-user-id": "123", "x-hermes-chat-id": "123", "x-hermes-message-id": "123:4", "x-hermes-session-id": `openstrudel:${options.conversationId}:123` });
    expect(init.redirect).toBe("error");
  }
  expect(calls[2]!.headers.get("mcp-session-id")).toBe("synthetic-session");
  expect(calls[2]!.headers.get("mcp-protocol-version")).toBe("2025-03-26");
  expect(options.assertCurrent.mock.calls.length).toBeGreaterThan(8);
  expect(accounts.active.size).toBe(0);
  expect(runtime.close).toHaveBeenCalledOnce();
});

it("creates fresh empty isolated homes every turn and removes them even on failure", async () => {
  const { executor, options, root } = fixture();
  const roots: string[] = [];
  runtime.run.mockImplementation(async () => {
    const config = runtime.options.at(-1);
    roots.push(dirname(config.codexHome));
    // Codex creates its sandbox helper only outside the system temp folder.
    expect(dirname(dirname(config.codexHome))).toBe(restrictedRunsDirectory(root));
    expect(statSync(restrictedRunsDirectory(root)).mode & 0o777).toBe(0o700);
    expect(config.restricted).toBe(true);
    expect(config.provider).toBeUndefined(); expect(config.sharedExtensionsPath).toBeUndefined(); expect(config.telegramServers).toBeUndefined();
    expect(readdirSync(config.workingDirectory)).toEqual([]);
    const toml = parse(readFileSync(join(config.codexHome, "config.toml"), "utf8")) as any;
    expect(toml).toMatchObject({ default_permissions: "restricted", approval_policy: "never", web_search: "disabled", permissions: { restricted: { network: { enabled: false } } }, features: { shell_tool: false, unified_exec: false, apps: false, plugins: false, memories: false, code_mode_host: true } });
    expect(toml.permissions.restricted.filesystem).toEqual({ ":minimal": "read", [config.workingDirectory]: "read" });
    expect(JSON.stringify(toml)).not.toContain(secret);
    if (roots.length === 2) throw Error("internal secret " + secret);
    return { response: "OK" };
  });
  await executor.run("one", options);
  await expect(executor.run("two", options)).rejects.toThrow("сейчас недоступен");
  expect(new Set(roots).size).toBe(2);
  expect(roots.every(root => !existsSync(root))).toBe(true);
});

it("refuses a non-ChatGPT conversation selection without fallback or MCP traffic", async () => {
  const { executor, options, store, accounts } = fixture();
  saveConversationModelSelection(store, options.conversationId, { provider: "openai", model: "api-model", serviceTier: "default" });
  await expect(executor.run("test", options)).rejects.toThrow("недоступен");
  expect(accounts.choose).not.toHaveBeenCalled(); expect(calls).toEqual([]); expect(runtime.run).not.toHaveBeenCalled();
});

it("does not retry a partial turn or disclose auth failures", async () => {
  const { executor, options, accounts, service } = fixture();
  service.authTokens.mockRejectedValue(Error("Authorization: Bearer " + secret));
  runtime.run.mockImplementation(async () => { await runtime.options[0].authTokens(); });
  await expect(executor.run("test", options)).rejects.toThrow("сейчас недоступен");
  expect(accounts.choose).toHaveBeenCalledOnce(); expect(runtime.run).toHaveBeenCalledOnce();
  expect(accounts.active.size).toBe(0);
});

it("rejects revoked access before and after a remote mutation and after the turn", async () => {
  const { executor, options } = fixture();
  let active = true;
  options.assertCurrent.mockImplementation(() => { if (!active) throw Error("revoked"); });
  const standard = respond;
  respond = (body, headers) => { if (body.method === "tools/call") active = false; return standard(body, headers); };
  let retained: any;
  runtime.run.mockImplementation(async (_text, turn) => {
    retained = turn.tools.call;
    await expect(retained(allowed.name, {})).rejects.toThrow("Права доступа изменились");
    const before = calls.length;
    await expect(retained(allowed.name, {})).rejects.toThrow("Права доступа изменились");
    expect(calls).toHaveLength(before);
    return { response: "must not be delivered" };
  });
  await expect(executor.run("test", options)).rejects.toThrow("Права доступа изменились");
  active = true;
  await expect(retained(allowed.name, {})).rejects.toThrow("Права доступа изменились");
});

it("pins identity even when arguments try to claim another user or chat", async () => {
  const auth = authorization(); auth.connector.headers["X-Hermes-User-Id"] = "999";
  const { executor, options } = fixture(auth);
  runtime.run.mockImplementation(async (_text, turn) => {
    await turn.tools.call(allowed.name, { userId: "999", chatId: "-999", authorization: "other" });
    return { response: "OK" };
  });
  await executor.run("test", options);
  expect(calls.at(-1)!.headers.get("x-hermes-user-id")).toBe("123");
  expect(calls.at(-1)!.headers.get("x-hermes-chat-id")).toBe("123");
  expect(calls.at(-1)!.headers.get("authorization")).toBe("Bearer " + secret);
});

it.each(["http", "rpc", "echo", "fetch"])("sanitizes %s errors without returning credentials", async mode => {
  const { executor, options } = fixture();
  respond = body => {
    if (mode === "http") return new Response("Bearer " + secret, { status: 500 });
    if (mode === "rpc") return Response.json({ jsonrpc: "2.0", id: body.id, error: { message: secret } });
    if (mode === "echo") return result(body.id, { protocolVersion: "2025-03-26", secret });
    throw Error(secret);
  };
  await expect(executor.run("test", options)).rejects.toThrow("сейчас недоступен");
  expect(runtime.run).not.toHaveBeenCalled();
});

it("preserves safe business error codes and replaces upstream text", async () => {
  const { executor, options } = fixture();
  const standard = respond;
  respond = (body, headers) => body.method === "tools/call" ? result(body.id, { isError: true, content: [{ type: "text", text: JSON.stringify({ code: "report_revision_conflict", text: "private service internals" }) }] }) : standard(body, headers);
  runtime.run.mockImplementation(async (_text, turn) => {
    const failure = await turn.tools.call(allowed.name, {});
    expect(failure).toMatchObject({ ok: false, code: "report_revision_conflict" });
    expect(JSON.stringify(failure)).not.toContain("private service internals");
    return { response: "OK" };
  });
  await executor.run("test", options);
});

it("uses only service workflow and validated timezone, never the Home's SOUL", async () => {
  const { executor, options, store } = fixture();
  store.setSetting("owner.timezone", "Europe/Moscow");
  store.setSetting("agent.soul", "PRIVATE CORPORATE DETAILS");
  const standard = respond;
  respond = (body, headers) => body.method === "initialize" ? result(body.id, { protocolVersion: "2025-03-26", instructions: "Show preview and use its fingerprint." }) : standard(body, headers);
  await executor.run("test", options);
  expect(runtime.options[0].restrictedInstructions).toContain("Europe/Moscow");
  expect(runtime.options[0].restrictedInstructions).toContain("Show preview and use its fingerprint.");
  expect(JSON.stringify(runtime.options[0])).not.toContain("PRIVATE CORPORATE DETAILS");
});

it("paginates the filtered catalogue and accepts bounded SSE responses", async () => {
  const { executor, options } = fixture();
  const standard = respond;
  respond = (body, headers) => {
    if (body.method !== "tools/list") return standard(body, headers);
    if (!body.params.cursor) return result(body.id, { tools: [definition("company_finance")], nextCursor: "page-2" });
    expect(body.params.cursor).toBe("page-2");
    const data = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [definition()] } });
    return new Response("event: message\ndata: " + data + "\n\n", { headers: { "content-type": "text/event-stream" } });
  };
  await executor.run("test", options);
  expect(runtime.run.mock.calls[0]![1].tools.definitions.map((t: any) => t.name)).toEqual([allowed.name]);
  expect(calls.filter(c => c.body.method === "tools/list")).toHaveLength(2);
});

it.each(["too-many", "repeated-cursor", "duplicate", "oversized"])("fails closed on invalid discovery: %s", async mode => {
  const { executor, options } = fixture();
  const standard = respond;
  respond = (body, headers) => {
    if (body.method !== "tools/list") return standard(body, headers);
    if (mode === "too-many") return result(body.id, { tools: Array.from({ length: 101 }, (_, i) => definition("tool" + i)) });
    if (mode === "repeated-cursor") return result(body.id, { tools: [], nextCursor: "loop" });
    if (mode === "duplicate") return result(body.id, { tools: [definition(), definition()] });
    return result(body.id, { tools: [definition()], padding: "x".repeat(1024 * 1024) });
  };
  await expect(executor.run("test", options)).rejects.toThrow("недоступен");
  expect(runtime.run).not.toHaveBeenCalled();
});

it("rechecks authorization after account choice and never starts an already cancelled turn", async () => {
  const { executor, options, accounts } = fixture();
  vi.mocked(accounts.choose).mockImplementation(async () => { options.assertCurrent.mockImplementation(() => { throw Error("revoked"); }); return { id: "default", service: {} as any }; });
  await expect(executor.run("test", options)).rejects.toThrow("Права доступа изменились");
  expect(calls).toEqual([]); expect(runtime.run).not.toHaveBeenCalled();
  const controller = new AbortController(); controller.abort();
  await expect(executor.run("test", { ...options, signal: controller.signal })).rejects.toThrow("Права доступа изменились");
  expect(accounts.choose).toHaveBeenCalledOnce();
});

it("close revokes outstanding tool handles and prevents subsequent runs", async () => {
  const { executor, options } = fixture();
  runtime.run.mockImplementation(async (_text, turn) => {
    executor.close();
    expect(turn.signal.aborted).toBe(true);
    await expect(turn.tools.call(allowed.name, {})).rejects.toThrow("Права доступа изменились");
    return { response: "late" };
  });
  await expect(executor.run("test", options)).rejects.toThrow("Права доступа изменились");
  await expect(executor.run("again", options)).rejects.toThrow("Права доступа изменились");
});

it("relays business refusals with their code and safe text, never raw JSON or control characters", async () => {
  const { executor, options } = fixture();
  const standard = respond;
  let reply: unknown;
  respond = (body, headers) => body.method === "tools/call" ? result(body.id, reply) : standard(body, headers);
  runtime.run.mockImplementation(async (_text, turn) => {
    // School refuses with HTTP 200 ok:false; the gateway marks it isError with a structured code and text.
    reply = { isError: true, structuredContent: { ok: false, code: "schedule_editor_required", text: "Изменить занятие может только назначенный ментор.‮\u0007 " + "x".repeat(600) }, content: [{ type: "text", text: "{}" }] };
    const refusal = await turn.tools.call(allowed.name, {});
    expect(refusal).toMatchObject({ ok: false, code: "schedule_editor_required" });
    expect(refusal.text.startsWith("Изменить занятие может только назначенный ментор.")).toBe(true);
    expect(refusal.text).not.toMatch(/[\u0000-\u001f‮]/);
    expect(refusal.text.length).toBeLessThanOrEqual(500);
    // The gateway's own argument validation nests an uppercase code with issues.
    reply = { isError: true, content: [{ type: "text", text: "Проверьте параметры: lessonId" }], structuredContent: { error: { code: "INVALID_ARGUMENTS", issues: Array.from({ length: 7 }, (_, i) => ({ path: "items." + i, message: "Неверное значение" })) } } };
    const invalid = await turn.tools.call(allowed.name, {});
    expect(invalid).toMatchObject({ ok: false, code: "invalid_arguments", text: "Проверьте параметры: lessonId" });
    expect(invalid.issues).toHaveLength(5);
    expect(invalid.issues[0]).toEqual({ path: "items.0", message: "Неверное значение" });
    // A failure without a code keeps the service's plain sentence but stays "unavailable".
    reply = { isError: true, content: [{ type: "text", text: "Школа не ответила." }] };
    expect(await turn.tools.call(allowed.name, {})).toEqual({ ok: false, code: "unavailable", text: "Школа не ответила." });
    // Prototype names never become text; malformed codes and JSON payload text fail closed.
    reply = { isError: true, structuredContent: { code: "constructor" } };
    const proto = await turn.tools.call(allowed.name, {});
    expect(proto.code).toBe("constructor"); expect(typeof proto.text).toBe("string");
    reply = { isError: true, structuredContent: { code: "Bad-Code!" }, content: [{ type: "text", text: JSON.stringify({ text: "internal detail" }) }] };
    expect(await turn.tools.call(allowed.name, {})).toEqual({ ok: false, code: "unavailable", text: "Сервис временно недоступен. Повторите запрос позже." });
    return { response: "OK" };
  });
  await executor.run("test", options);
});

it.each([
  ["base64", { Authorization: "Bearer " + secret }, Buffer.from(secret).toString("base64")],
  ["base64url", { Authorization: "Bearer tok/en+with=special?chars" }, Buffer.from("tok/en+with=special?chars").toString("base64url")],
  ["URI-encoded", { Authorization: "Bearer tok/en+with=special?chars" }, encodeURIComponent("tok/en+with=special?chars")],
  ["JSON-escaped", { Authorization: 'Bearer quote"and\\slash-token' }, JSON.stringify('quote"and\\slash-token').slice(1, -1)],
  ["custom header name", { "X-Auth": "custom-credential-value" }, "custom-credential-value"],
])("treats an echoed %s credential as a leak", async (_name, headers, echoed) => {
  const auth = authorization(); auth.connector.headers = headers as Record<string, string>;
  const { executor, options } = fixture(auth);
  const standard = respond;
  respond = (body, requestHeaders) => body.method === "tools/call" ? result(body.id, { content: [{ type: "text", text: "echo " + echoed }] }) : standard(body, requestHeaders);
  runtime.run.mockImplementation(async (_text, turn) => {
    await expect(turn.tools.call(allowed.name, {})).rejects.toThrow("недоступен");
    return { response: "OK" };
  });
  await executor.run("test", options);
});

it("records where a turn failed with a fixed reason and never the error text", async () => {
  const { executor, options, store, accounts } = fixture();
  const events = () => diagnosticReport(store).events.filter(event => event.event === "restricted.failed");
  // The Wolf failure: Codex could not start a thread because its sandbox helper was missing.
  runtime.run.mockRejectedValueOnce(Error("error creating thread: failed to load AGENTS.md instructions: fs sandbox helper failed: bwrap: execvp codex-linux-sandbox: No such file or directory " + secret));
  await expect(executor.run("test", options)).rejects.toThrow("сейчас недоступен");
  expect(events()[0]).toMatchObject({ stage: "runtime", errorClass: "Error", reason: "sandbox" });
  expect(events()[0]!.durationMs).toBeGreaterThanOrEqual(0);
  runtime.run.mockImplementationOnce(async (_text, turn) => { turn.onEvent({ type: "thread.started", payload: { threadId: "t" } }); throw Error("model said " + secret); });
  await expect(executor.run("test", options)).rejects.toThrow("сейчас недоступен");
  expect(events()[0]).toMatchObject({ stage: "turn", errorClass: "Error", reason: "codex" });
  const standard = respond;
  respond = (body, headers) => body.method === "tools/list" ? new Response("Bearer " + secret, { status: 502 }) : standard(body, headers);
  await expect(executor.run("test", options)).rejects.toThrow("сейчас недоступен");
  expect(events()[0]).toMatchObject({ stage: "discovery", reason: "service_http", status: 502 });
  respond = (body, headers) => body.method === "tools/list" ? result(body.id, { tools: [], note: secret }) : standard(body, headers);
  await expect(executor.run("test", options)).rejects.toThrow("сейчас недоступен");
  expect(events()[0]).toMatchObject({ stage: "discovery", reason: "credential_echo" });
  expect(events()[0]!.status).toBeUndefined();
  respond = standard;
  vi.mocked(accounts.choose).mockRejectedValueOnce(new AccountUnavailableError("limits"));
  await expect(executor.run("test", options)).rejects.toThrow();
  expect(events()[0]).toMatchObject({ stage: "account", errorClass: "AccountUnavailableError", reason: "account_limits" });
  expect(events()).toHaveLength(5);
  expect(JSON.stringify(diagnosticReport(store))).not.toMatch(new RegExp(`${secret}|AGENTS|bwrap|model said|test`));
  // A revoked grant is expected and stays out of the journal.
  options.assertCurrent.mockImplementation(() => { throw Error("revoked"); });
  await expect(executor.run("test", options)).rejects.toThrow("Права доступа изменились");
  expect(events()).toHaveLength(5);
});

it("removes only turn folders a stopped Home left behind", () => {
  const root = mkdtempSync(join(tmpdir(), "restricted-home-")); homes.push(root);
  const parent = restrictedRunsDirectory(root), old = join(parent, "turn-old"), live = join(parent, "turn-live"), other = join(parent, "keep");
  for (const path of [old, live, other]) mkdirSync(join(path, "codex"), { recursive: true });
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(old, twoDaysAgo, twoDaysAgo); utimesSync(other, twoDaysAgo, twoDaysAgo);
  const store = new Store(":memory:"); stores.push(store);
  executors.push(new RestrictedExecutor({ store, root, active: new Map(), choose: vi.fn() } as unknown as Accounts));
  expect(existsSync(old)).toBe(false); expect(existsSync(live)).toBe(true); expect(existsSync(other)).toBe(true);
});

it("removes the turn folder only after Codex has exited, because it writes thread locks while exiting", async () => {
  const { executor, options } = fixture();
  let folder = "", existedAtExit = false;
  runtime.run.mockImplementation(async () => { folder = dirname(runtime.options.at(-1).codexHome); return { response: "OK" }; });
  runtime.settled.mockImplementation(async () => { expect(runtime.close).toHaveBeenCalledOnce(); existedAtExit = existsSync(folder); });
  await executor.run("test", options);
  expect(existedAtExit).toBe(true);
  expect(existsSync(folder)).toBe(false);
});

it("runs the device model and level at Fast unless the owner set another level or chose this chat's model", async () => {
  const { executor, options, store } = fixture();
  const turn = async () => { runtime.run.mockClear(); await executor.run("test", options); return runtime.run.mock.calls[0]![1]; };
  saveModelSelection(store, { provider: "chatgpt", model: "pinned-model", serviceTier: "default", reasoningEffort: "xhigh" });
  expect(await turn()).toMatchObject({ model: "pinned-model", serviceTier: "default", reasoningEffort: "xhigh", fast: true });
  // The owner can trade depth for speed, or return these chats to the device's own speed.
  store.setSetting("models.restricted", JSON.stringify({ reasoningEffort: "medium", fast: true }));
  expect(await turn()).toMatchObject({ reasoningEffort: "medium", fast: true });
  store.setSetting("models.restricted", JSON.stringify({ reasoningEffort: null, fast: false }));
  expect(await turn()).toMatchObject({ model: "pinned-model", reasoningEffort: "xhigh", fast: false });
  // A damaged value falls back to the default instead of failing the turn.
  store.setSetting("models.restricted", "{broken");
  expect(await turn()).toMatchObject({ reasoningEffort: "xhigh", fast: true });
  // A model chosen for this chat runs exactly as chosen.
  saveConversationModelSelection(store, options.conversationId, { provider: "chatgpt", model: "chat-model", serviceTier: "default", reasoningEffort: "medium" });
  expect(await turn()).toMatchObject({ model: "chat-model", reasoningEffort: "medium", fast: false });
});

it("falls back to the model's own level when the chosen model does not offer the restricted one", async () => {
  const { executor, options, store } = fixture();
  store.setSetting("models.restricted", JSON.stringify({ reasoningEffort: "low", fast: true }));
  runtime.models.mockResolvedValue(catalog(["medium", "high"]));
  await executor.run("test", options);
  const turn = runtime.run.mock.calls[0]![1];
  expect(turn).toMatchObject({ model: "pinned-model", fast: true });
  expect(turn.reasoningEffort).toBeUndefined();
});
