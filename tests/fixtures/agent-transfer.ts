/** Disposable native/web acceptance Home. No accounts, schedules or real agents start. */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { OpenStrudelRuntime } from "../../src/runtime.js";
import { AgentArchives } from "../../src/agent-archive.js";

const output = resolve(process.argv[2]!);
const root = await mkdtemp(join(tmpdir(), "strudel-transfer-ui-"));
let turns = 0;
const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", rootDirectory: root, startTelegram: false, engine: {
  async run() { turns++; return { threadId: "fixture", response: "Ответ тестовой команды", events: [] }; },
} });
runtime.account.read = async () => ({ connected: true, email: "owner@example.invalid", managed: true, planType: "plus" });
const editor = runtime.store.createProfile({ name: "Редактор", instructions: "Пиши понятно. Сохраняй мой голос.", domain: "work" });
const chat = runtime.store.profileConversation(editor.id);
runtime.store.addMessage({ conversationId: chat.id, channel: "api", direction: "outbound", text: "История сотрудника сохранится вместе с его инструкциями." });
runtime.store.primaryConversation();
runtime.scheduler.save({ conversationId: chat.id, name: "Обзор недели", prompt: "Собери новости недели", cron: "0 9 * * 1", timezone: "Europe/Moscow" });
await mkdir(runtime.messages.files.workspace("work"), { recursive: true });
await writeFile(join(runtime.messages.files.workspace("work"), "MEMORY.md"), "Предпочитаю короткие тексты.");
const archive = new AgentArchives(runtime.store, runtime.messages).export();
const archivePath = resolve(output, "../example.openstrudel");
await writeFile(archivePath, JSON.stringify(archive), { mode: 0o600 });
Object.assign((runtime.api.mobile as any).options, { directory: join(root, "mobile"), port: 0, host: "127.0.0.1", hostname: "127.0.0.1" });
const address = await runtime.api.listen("127.0.0.1", 0);
let delay = 6000, offline = false;
const proxy = createServer(async (req, res) => {
  try {
    if (req.url === "/fixture/status") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ turns, employees: runtime.store.listProfiles().length, enabled: runtime.store.db.prepare("SELECT COUNT(*) AS count FROM schedules WHERE enabled=1").get() })); return; }
    if (req.url === "/fixture/invite") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(await runtime.api.mobile.invite(true))); return; }
    if (req.url === "/fixture/offline") { offline = true; res.end("ok"); return; }
    if (req.url === "/fixture/online") { offline = false; res.end("ok"); return; }
    if (req.url === "/health") { const ms = delay; delay = 0; await new Promise(done => setTimeout(done, ms)); }
    if (offline) { res.writeHead(503, { "content-type": "application/json" }); res.end('{"error":"Нет связи"}'); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const response = await fetch(`http://127.0.0.1:${address.port}` + req.url, { method: req.method, body: body.length ? body : undefined });
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end("fixture failure"); }
});
await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
await writeFile(output, JSON.stringify({ url: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, archivePath, editor: editor.id, root }), { mode: 0o600 });
console.log("Isolated transfer fixture ready; synthetic content only; scheduler not started.");
const stop = async () => { proxy.close(); await runtime.stop(); await rm(root, { recursive: true, force: true }); process.exit(0); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
