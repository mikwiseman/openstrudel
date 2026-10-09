/** Disposable UI acceptance server. No real accounts, messages, or schedules. */
import { createServer } from "node:http";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenStrudelRuntime } from "../../src/runtime.js";
import type { CodexEngine } from "../../src/types.js";

const output = resolve(process.argv[2]!);
const directory = await mkdtemp(join(tmpdir(), "strudel-release-ui-"));
process.chdir(directory);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.OPENSTRUDEL_SETUP_CODE;
let offline = false;
let privateTelegramLinked = true;
let loginStarts = 0;
let loginCanceled = 0;
let serviceConnected = false;
let releaseQueuedRun: (() => void) | undefined;
let queueFixture: Record<string, string> | undefined;
const engine: CodexEngine = {
  async run(input, options) {
    const message = input.split("Current user message:\n").at(-1)!;
    options?.onEvent?.({ type: "thread.started", payload: { threadId: options.threadId ?? "qa-thread" } });
    if (message === "Удерживаем ответ для проверки очереди") {
      await new Promise<void>(done => { releaseQueuedRun = done; options?.signal?.addEventListener("abort", () => done(), { once: true }); });
      releaseQueuedRun = undefined;
    }
    if (message.includes("Проверка свободного места")) {
      throw new Error("ENOSPC: no space left on device, open '/private/qa/history.jsonl.tmp'");
    }
    if (message.includes("Проверка подтверждения")) {
      await new Promise(done => setTimeout(done, 900));
      const answer = await options!.onRequest!("mcpServer/elicitation/request", {
        mode: "form", serverName: "qa-service",
        message: 'Allow the qa-service MCP server to run tool "check_ready"?',
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} },
        requestedSchema: { type: "object", properties: {} },
      }) as { action: string };
      await new Promise(done => setTimeout(done, 400));
      return { threadId: options?.threadId ?? "qa-thread", response: answer.action === "accept" ? "Проверка выполнена." : "Действие не выполнено.", events: [] };
    }
    if (message.includes("Проверка выбора")) {
      const answer = await options!.onRequest!("item/tool/requestUserInput", {
        questions: [{ id: "choice", question: "Когда подготовить черновик?", options: [{ label: "Утром" }, { label: "Вечером" }] }],
      }) as { answers: Record<string, { answers: string[] }> };
      return { threadId: options?.threadId ?? "qa-thread", response: `Выбрано: ${answer.answers.choice!.answers[0]}`, events: [] };
    }
    await new Promise(done => setTimeout(done, 1200));
    return { threadId: options?.threadId ?? "qa-thread", response: `Принято: ${message}`, events: [] };
  },
  async connections() {
    return [{ id: "qa-documents", name: "Документы", connected: serviceConnected, status: serviceConnected ? "ready" : "sign_in", kind: "app", detail: "Тестовое подключение", url: `${controlURL}/connect` }];
  },
  async connect() { return { url: `${controlURL}/connect` }; },
};
const runtime = new OpenStrudelRuntime({ rootDirectory: directory, dbPath: ":memory:", engine, startTelegram: false });
runtime.account.read = async () => ({ connected: true, email: "preview@example.com", managed: true, planType: "plus" });
runtime.account.startLogin = async () => {
  loginStarts++;
  await new Promise(done => setTimeout(done, 800));
  return { type: "device", loginId: "qa-login", verificationUrl: `${controlURL}/login`, userCode: "TEST-56789" };
};
runtime.account.status = async () => ({ loginId: "qa-login", status: "pending" });
runtime.account.cancel = async () => { loginCanceled++; return { loginId: "qa-login", status: "canceled" }; };

// The native UI and real API handle requests; only external dependencies are fake.
const api = runtime.api as unknown as { handle: (...args: any[]) => Promise<void> };
const originalHandle = api.handle.bind(runtime.api);
api.handle = async (req, res, ...rest) => {
  if (req.method !== "GET") await appendFile(output + ".requests.jsonl", JSON.stringify({ at: new Date().toISOString(), method: req.method, path: new URL(req.url, "http://127.0.0.1").pathname }) + "\n", { mode: 0o600 });
  if (offline) { res.writeHead(503).end('{"error":"Тестовое отключение"}'); return; }
  await originalHandle(req, res, ...rest);
};
Object.assign((runtime.api.mobile as any).options, { port: 0, host: "127.0.0.1", hostname: "127.0.0.1", directory: join(directory, "mobile") });
const editor = runtime.store.createProfile({ name: "Редактор", instructions: "Пиши понятно и сохраняй смысл.", domain: "work" });
runtime.store.createProfile({ name: "Личный помощник", instructions: "Помогай с повседневными делами.", domain: "personal" });
runtime.store.importHistory(runtime.store.profileConversation(editor.id).id, [
  { sourceId: "qa-one", author: "Вы", date: "2026-10-02T06:40:00Z", direction: "inbound", text: "Покажи пример оформления" },
  { sourceId: "qa-two", author: "Редактор", date: "2026-10-02T06:41:00Z", direction: "outbound", text: "## Черновик готов\n\n**Главное** уже выделено.\n\n- Первый пункт\n- Второй пункт\n\n> Цитата для проверки\n\n```js\nconst ready = true;\n```" },
]);
if (process.env.OPENSTRUDEL_QA_LONG_HISTORY === "1") {
  const longChat = runtime.store.createProfile({ name: "Большая история", instructions: "Изолированная проверка длинной переписки.", domain: "personal" });
  runtime.store.importHistory(runtime.store.profileConversation(longChat.id).id, Array.from({ length: 5000 }, (_, index) => ({
    sourceId: `long-${index}`, author: index % 2 ? "Сотрудник" : "Вы",
    date: new Date(Date.UTC(2026, 8, 1) + index * 120_000).toISOString(),
    direction: index % 2 ? "outbound" as const : "inbound" as const,
    text: `## Сообщение ${index + 1}\n\n` + "Проверка длинной истории: **выделение**, [ссылка](https://example.com), обычный текст и сохранение позиции прокрутки.\n\n".repeat(12)
      + "- Первый пункт\n- Второй пункт\n\n```swift\nlet value = 42\n```",
  })));
}
runtime.store.linkTelegramChat({ chatId: "42", title: "Личный чат", allowedSenders: ["42"] });
const direct = runtime.store.getOrCreateConversation({channel:"telegram",externalId:"42",title:"Личный чат"});
runtime.store.addMessage({conversationId:direct.id,channel:"telegram",direction:"outbound",text:"Пример личной переписки"});
const archive = runtime.store.getOrCreateConversation({channel:"telegram",externalId:"import::qa-archive",title:"Старые заметки"});
runtime.store.importHistory(archive.id,[{sourceId:"qa-archive",date:"2026-10-01T08:00:00Z",author:"Вы",direction:"inbound",text:"Сохранённая заметка"}]);
runtime.store.linkTelegramChat({ chatId: "-100", title: "Рабочая группа", allowedSenders: ["42"] });
runtime.store.connectTelegramGroup("-100");
runtime.telegram.status = () => ({ configured: true, running: true, botUsername: "openstrudel_preview_bot", linkedChats: ["42", "-100"], chats: runtime.store.telegramChats().filter(chat => privateTelegramLinked || chat.chatId.startsWith("-")), lastError: null });
runtime.telegram.createLink = () => ({ code: "preview", expiresAt: new Date(Date.now() + 600_000).toISOString(), url: `${controlURL}/telegram` });

let controlURL = "";
const control = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  const path = new URL(req.url ?? "/", "http://127.0.0.1");
  if (path.pathname === "/invite") {
    const invitation = await runtime.api.mobile.invite(true);
    const url = new URL(invitation.url); url.searchParams.set("name", "Тестовая команда");
    res.end(JSON.stringify({ ...invitation, url: url.toString() })); return;
  }
  if (path.pathname === "/offline") offline = path.searchParams.get("value") === "1";
  if (path.pathname === "/connect") serviceConnected = true;
  if (path.pathname === "/telegram-private") privateTelegramLinked = path.searchParams.get("value") !== "0";
  if (path.pathname === "/queue-fixture" && !queueFixture) {
    const submit = (text: string) => runtime.messages.submit({ channel: "api", profile: editor.id, text, mode: "queue" });
    const active = await submit("Удерживаем ответ для проверки очереди");
    const first = await submit("Первый черновик");
    const second = await submit("Второй черновик");
    for (const submission of [active, first, second]) void submission.completion.catch(() => undefined);
    queueFixture = { conversationId: active.receipt.conversationId, active: active.receipt.messageId, first: first.receipt.messageId, second: second.receipt.messageId };
  }
  if (path.pathname === "/release-queue") releaseQueuedRun?.();
  if (path.pathname === "/queue-fixture" || path.pathname === "/queue-state") {
    res.end(JSON.stringify({ ...queueFixture, messages: queueFixture ? runtime.messages.queuedMessages(queueFixture.conversationId!) : [] })); return;
  }
  res.end(JSON.stringify({ editor: editor.id, loginStarts, loginCanceled, serviceConnected, offline, profiles: runtime.store.listProfiles(), telegram: runtime.store.telegramChats() }));
});
await new Promise<void>(done => control.listen(0, "127.0.0.1", done));
controlURL = `http://127.0.0.1:${(control.address() as { port: number }).port}`;
const address = await runtime.api.listen("127.0.0.1", 0);
await writeFile(output, JSON.stringify({ url: controlURL, localURL: `http://127.0.0.1:${address.port}`, editor: editor.id, pid: process.pid }), { mode: 0o600 });
console.log("Isolated release UI fixture ready.");
const stop = async () => { releaseQueuedRun?.(); control.close(); await runtime.stop(); await rm(directory, { recursive: true, force: true }); process.exit(0); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
