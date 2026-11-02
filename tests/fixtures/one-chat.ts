/** Disposable UI acceptance server for the one chat + Clients: a Home with a mock engine that records which service each
 * request used, an employee with history and a News edition, one Telegram group, and a company MCP endpoint behind the
 * main chat's connectors. No real accounts, messages, Telegram or schedules. */
import { createServer } from "node:http";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "smol-toml";
import { OpenStrudelRuntime } from "../../src/runtime.js";
import type { CodexEngine } from "../../src/types.js";

const output = resolve(process.argv[2]!);
const directory = await mkdtemp(join(tmpdir(), "strudel-one-chat-ui-"));
process.chdir(directory);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.OPENSTRUDEL_SETUP_CODE;

/** The company service: one POST per JSON-RPC message, switchable into each refusal the app must tell apart. */
type CompanyMode = "ok" | "empty" | "unauthorized" | "forbidden" | "hang";
let companyMode: CompanyMode = "ok";
const companyCalls: Array<{ at: string; method: string; name?: string; authorized: boolean }> = [];
const companySecret = "Bearer fixture-company-token";
const clients = [
  { clientId: "c-acme", slug: "acme", name: "Acme", company: "Acme Robotics", aliases: ["ACME"], stage: "active", brand: "TRINITY", archived: false, archiveReason: null, fileCount: 3, readableFileCount: 2, filesByCategory: { contracts: 2, general: 1 } },
  { clientId: "c-north", slug: "north-wind", name: "North Wind", company: "North Wind Studio", aliases: [], stage: "proposal", brand: "TRINITY", archived: false, archiveReason: null, fileCount: 0, readableFileCount: 0, filesByCategory: {} },
  { clientId: "c-old", slug: "old-school", name: "Old School", company: "Old School", aliases: [], stage: "done", brand: "SCHOOL", archived: true, archiveReason: "finished", fileCount: 1, readableFileCount: 0, filesByCategory: { general: 1 } },
];
const files = [
  { fileId: "f-contract", fileName: "Acme — договор 2026.docx", category: "contracts", sizeBytes: 48_214, createdAt: "2026-10-12T10:00:00.000Z", access: "ask", note: null, summaryError: null },
  { fileId: "f-act", fileName: "Acme — акт №3.pdf", category: "contracts", sizeBytes: 120_003, createdAt: "2026-10-20T10:00:00.000Z", access: "ask", note: null, summaryError: null },
  { fileId: "f-logo", fileName: "acme-logo.png", category: "general", sizeBytes: 9_000, createdAt: "2026-09-01T10:00:00.000Z", access: "none", note: "Binary file: only its metadata is available here.", summaryError: null },
];
const result = (data: unknown) => ({ resultType: "complete", content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const company = createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    const authorized = req.headers.authorization === companySecret;
    if (companyMode === "hang") return;
    if (companyMode === "unauthorized" || !authorized) { res.writeHead(401, { "content-type": "application/json" }).end('{"error":"Valid meeting actor token required"}'); return; }
    if (companyMode === "forbidden") { res.writeHead(403, { "content-type": "application/json" }).end('{"error":"Owner access required"}'); return; }
    const message = JSON.parse(body);
    companyCalls.push({ at: new Date().toISOString(), method: message.method, name: message.params?.name, authorized });
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const reply = (value: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value }));
    if (message.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture-company", version: "1" } });
    if (message.method === "tools/list") return reply({ tools: [{ name: "company_clients_list", description: "Clients", inputSchema: { type: "object" } }, { name: "company_client_files_list", description: "Files", inputSchema: { type: "object" } }] });
    if (message.params?.name === "company_clients_list") return reply(result({ clients: companyMode === "empty" ? [] : clients }));
    if (message.params?.name === "company_client_files_list") {
      const client = clients.find(c => c.slug === message.params.arguments.client);
      if (!client) return reply(result({ client: null, total: 0, offset: 0, hasMore: false, nextOffset: null, files: [] }));
      const page = client.clientId === "c-acme" ? files : [];
      return reply(result({ client: { clientId: client.clientId, slug: client.slug, name: client.name, archived: client.archived }, total: page.length, offset: 0, hasMore: false, nextOffset: null, files: page }));
    }
    reply(result({ error: { code: "invalid_arguments", issues: [] } }));
  });
});
await new Promise<void>(done => company.listen(0, "127.0.0.1", done));
const companyURL = `http://127.0.0.1:${(company.address() as { port: number }).port}/mcp`;
mkdirSync(join(directory, ".data/extensions/personal"), { recursive: true });
writeFileSync(join(directory, ".data/extensions/personal/config.toml"), stringify({ mcp_servers: { company: { enabled: true, url: companyURL, http_headers: { Authorization: companySecret } } } }));

/** The main runtime's model: it names the service it would use, so one conversation shows two services in a row. */
const turns: Array<{ at: string; conversationId?: string; text: string; service: string | null; context: boolean }> = [];
let holdReply: (() => void) | undefined;
const engine: CodexEngine = {
  async run(input, options) {
    const message = input.split("Current user message:\n").at(-1)!.trim();
    const context = input.includes("Business client context") || input.includes("Quoted message") || input.includes("Quoted News story");
    const service = /календар/i.test(message) ? "calendar" : /почт/i.test(message) ? "mail" : null;
    turns.push({ at: new Date().toISOString(), conversationId: options?.conversationId, text: message, service, context });
    options?.onEvent?.({ type: "thread.started", payload: { threadId: options.threadId ?? "one-chat-thread" } });
    if (message.includes("Подожди с ответом")) {
      await new Promise<void>(done => { holdReply = done; options?.signal?.addEventListener("abort", () => done(), { once: true }); });
      holdReply = undefined;
    } else await new Promise(done => setTimeout(done, 600));
    const answer = service === "calendar" ? "Календарь: завтра в 11:00 встреча с Acme." : service === "mail" ? "Почта: от Acme пришёл подписанный акт." : context ? `Про это: ${message}` : `Принято: ${message}`;
    return { threadId: options?.threadId ?? "one-chat-thread", response: answer, events: [] };
  },
  async connections() {
    return [
      { id: "calendar", name: "Календарь", connected: true, status: "ready", kind: "app", detail: "Тестовое подключение", url: `${controlURL}/connect` },
      { id: "mail", name: "Почта", connected: true, status: "ready", kind: "app", detail: "Тестовое подключение", url: `${controlURL}/connect` },
    ];
  },
  async connect() { return { url: `${controlURL}/connect` }; },
};
const runtime = new OpenStrudelRuntime({ rootDirectory: directory, dbPath: ":memory:", engine, startTelegram: false, mobilePort: 0 });
Object.assign((runtime.api.mobile as any).options, { host: "127.0.0.1", hostname: "127.0.0.1" });
runtime.account.read = async () => ({ connected: true, email: "preview@example.com", managed: true, planType: "plus" });

const api = runtime.api as unknown as { handle: (...args: any[]) => Promise<void> };
const originalHandle = api.handle.bind(runtime.api);
let offline = false;
let messageRequests = 0;
api.handle = async (req, res, ...rest) => {
  // Count the paired app's request, not the Home executor's second HTTP hop for the same send.
  if (rest[0] === true && req.method === "POST" && new URL(req.url, "http://127.0.0.1").pathname === "/v1/messages") messageRequests += 1;
  if (req.method !== "GET") await appendFile(output + ".requests.jsonl", JSON.stringify({ at: new Date().toISOString(), method: req.method, path: new URL(req.url, "http://127.0.0.1").pathname }) + "\n", { mode: 0o600 });
  if (offline) { res.writeHead(503).end('{"error":"Тестовое отключение"}'); return; }
  await originalHandle(req, res, ...rest);
};

// An employee with history and a News edition; the main chat's own history; one Telegram group served by the employee.
const editor = runtime.store.createProfile({ name: "Редактор", instructions: "Пиши понятно и сохраняй смысл.", purpose: "Редактор текстов" });
const editorChat = runtime.store.profileConversation(editor.id);
runtime.store.importHistory(editorChat.id, [
  { sourceId: "e1", author: "Вы", date: "2026-10-28T06:40:00Z", direction: "inbound", text: "Покажи пример оформления" },
  { sourceId: "e2", author: "Редактор", date: "2026-10-28T06:41:00Z", direction: "outbound", text: "## Черновик готов\n\n**Главное** уже выделено.\n\n- Первый пункт\n- Второй пункт" },
]);
const main = runtime.store.primaryConversation();
const seededQuestion = runtime.store.addMessage({ conversationId: main.id, channel: "api", direction: "inbound", text: "Что у нас на этой неделе?" });
runtime.store.addMessage({ conversationId: main.id, channel: "api", direction: "outbound", text: "Три встречи и один акт на подпись." });
const story = (id: string, rank: number, title: string, summary: string) => runtime.store.addMessage({ conversationId: editorChat.id, channel: "api", direction: "outbound", text: `**${title}**\n\n${summary}`,
  story: { id, edition: new Date().toISOString().slice(0, 10), rank, section: "Модели", status: "Вышло", title, summary, body: summary + "\n\nПодробности в источнике.", view: "Для нас это повод проверить пайплайн.", check: null, verification: "Прочитан блог компании.", eventAt: null, change: null,
    sources: [{ title: "Блог компании", url: "https://example.com/blog", role: "Первоисточник", publishedAt: null }] } });
story("mistral-large-4", 1, "Mistral открыла веса Large 4", "Веса модели опубликованы под открытой лицензией.");
story("agibot-g2", 2, "AGIBOT показала G2 Max", "Новый гуманоид с двумя часами автономной работы.");
runtime.store.linkTelegramChat({ chatId: "-100", title: "Рабочая группа", allowedSenders: ["42"] });
runtime.store.connectTelegramGroup("-100");
runtime.store.bindTelegramChat("-100", editor.id);
const group = runtime.store.telegramChats().find(c => c.chatId === "-100")!;
runtime.store.addMessage({ conversationId: group.conversationId!, channel: "telegram", direction: "inbound", text: "Даша: когда будет готов акт?", externalId: "-100:7", author: "Даша" });
runtime.store.addMessage({ conversationId: group.conversationId!, channel: "telegram", direction: "outbound", text: "Акт будет готов к четвергу." });
runtime.telegram.status = () => ({ configured: true, running: true, botUsername: "openstrudel_preview_bot", linkedChats: ["-100"], chats: runtime.store.telegramChats() } as any);

let controlURL = "";
const control = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  const path = new URL(req.url ?? "/", "http://127.0.0.1");
  if (path.pathname === "/invite") {
    const invitation = await runtime.api.mobile.invite(true);
    const url = new URL(invitation.url); url.searchParams.set("name", "Тестовый Mac");
    res.end(JSON.stringify({ ...invitation, url: url.toString() })); return;
  }
  if (path.pathname === "/offline") offline = path.searchParams.get("value") === "1";
  if (path.pathname === "/company") companyMode = (path.searchParams.get("mode") as CompanyMode) ?? "ok";
  if (path.pathname === "/release") holdReply?.();
  // Read the accepted context from storage, after the Home verified the client's identity and source.
  const sentMessages = runtime.store.listMessages(main.id, 100)
    .filter(message => message.direction === "inbound" && message.id !== seededQuestion.id)
    .map(message => ({ id: message.id, conversationId: message.conversationId, text: message.text, context: message.context ?? null }));
  res.end(JSON.stringify({ editor: editor.id, main: main.id, group: group.conversationId, offline, companyMode, companyURL, companyCalls, turns, messageRequests, sentMessages, profiles: runtime.store.listProfiles().map(p => ({ id: p.id, name: p.name, news: p.news })) }));
});
await new Promise<void>(done => control.listen(0, "127.0.0.1", done));
controlURL = `http://127.0.0.1:${(control.address() as { port: number }).port}`;
const address = await runtime.api.listen("127.0.0.1", 0);
await writeFile(output, JSON.stringify({ url: controlURL, localURL: `http://127.0.0.1:${address.port}`, token: runtime.api.localCredential(), editor: editor.id, main: main.id, pid: process.pid }), { mode: 0o600 });
console.log("Isolated one-chat UI fixture ready.");
const stop = async () => { holdReply?.(); control.close(); company.close(); await runtime.stop(); await rm(directory, { recursive: true, force: true }); process.exit(0); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
