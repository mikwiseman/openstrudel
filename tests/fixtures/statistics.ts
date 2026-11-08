/** Disposable Homes for the Statistics screen. Each argument `Name` or `Name=path/to/copy.sqlite` starts one Home with a mock
 * engine and owner pairing: a named copy of a database (the original file is never opened for writing), or a seeded history
 * of thirty days. Schedules never run here and nothing reaches Telegram or a model.
 *   npx tsx tests/fixtures/statistics.ts <output.json> Личный Работа=/path/work.sqlite
 * The output lists each Home's control URL; GET <control>/invite returns a fresh owner invitation. */
import { createServer } from "node:http";
import { copyFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenStrudelRuntime } from "../../src/runtime.js";
import type { CodexEngine } from "../../src/types.js";
import { recordTurnUsage, TICKS_PER_USD } from "../../src/usage.js";
import { normalizeModels } from "../../src/model-settings.js";
import { providerInfo, providerModels } from "../../src/providers.js";

const output = resolve(process.argv[2]!);
const specs = process.argv.slice(3).map(arg => { const [name, path] = arg.split("="); return { name: name!, path: path ? resolve(path) : undefined }; });
if (!specs.length) throw new Error("Name at least one Home");
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.OPENSTRUDEL_SETUP_CODE;

/** The catalog ChatGPT reports, so the Settings models pane renders as it does on a real Home. */
const catalog = normalizeModels([
  { model: "gpt-6-astra", displayName: "GPT-6-Astra", isDefault: true, defaultReasoningEffort: "xhigh", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }], serviceTiers: [{ id: "priority", name: "Fast" }] },
  { model: "gpt-6-sol", displayName: "GPT-6-Sol", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }], serviceTiers: [{ id: "priority", name: "Fast" }] },
], null);
const engine: CodexEngine = {
  async models() { return [...catalog, ...providerModels(providerInfo("anthropic")!)]; },
  async run(input, options) { return { threadId: options?.threadId ?? "statistics-thread", response: "Принято: " + input.slice(-60), events: [] }; },
};
const day = 86_400_000;

/** Thirty days of a believable Home: the owner in the app, a Telegram group, two schedules, mail events, with spend recorded for the last week. */
function seed(runtime: OpenStrudelRuntime, index: number) {
  const store = runtime.store, now = Date.now();
  store.setSetting("owner.timezone", "Europe/Moscow");
  const main = store.primaryConversation().id;
  const editor = store.createProfile({ name: index ? "Юрист" : "News", instructions: "", purpose: "" });
  const editorChat = store.profileConversation(editor.id).id;
  store.linkTelegramChat({ chatId: "-10" + index, title: index ? "Команда" : "Семья", allowedSenders: ["42"] });
  store.connectTelegramGroup("-10" + index);
  const group = store.telegramChats().find(chat => chat.chatId === "-10" + index)!.conversationId!;
  const radar = runtime.scheduler.save({ conversationId: editorChat, name: index ? "Договоры и сроки" : "Радар новостей", prompt: "Проверить", cron: "5 * * * *", timezone: "Europe/Moscow", enabled: true });
  const morning = runtime.scheduler.save({ conversationId: editorChat, name: index ? "Сводка CRM" : "Утренний выпуск", prompt: "Собрать", cron: "0 7 * * *", timezone: "Europe/Moscow", enabled: true });
  store.db.prepare("UPDATE schedules SET next_run_at='2099-01-01T00:00:00.000Z'").run();
  let sequence = 0;
  const add = (conversationId: string, at: number, options: { channel?: "api" | "telegram"; externalId?: string; reply?: string; status?: string; usage?: [string, string, number, number, number | null] }) => {
    const input = store.addMessage({ conversationId, channel: options.channel ?? "api", direction: "inbound", text: "Запрос " + ++sequence, externalId: options.externalId });
    store.db.prepare("UPDATE messages SET created_at=?,status=?,hidden=? WHERE id=?").run(new Date(at).toISOString(), options.status ?? "completed", options.externalId ? 1 : 0, input.id);
    if (options.reply !== undefined) {
      const reply = store.addMessage({ conversationId, channel: options.channel ?? "api", direction: "outbound", replyToId: input.id, text: options.reply });
      store.db.prepare("UPDATE messages SET created_at=?,hidden=? WHERE id=?").run(new Date(at + 20_000).toISOString(), options.reply === "NO_REPLY" ? 1 : 0, reply.id);
    }
    if (options.usage) {
      const [provider, model, input_, output_, cost] = options.usage;
      recordTurnUsage(store, input.id, { provider, model }, [{ provider, model, usage: { inputTokens: input_, cachedReadTokens: Math.round(input_ * 0.6), cacheCreationTokens: 0, outputTokens: output_, reasoningTokens: 0,
        ...(cost === null ? {} : { costUsdTicks: Math.round(cost * TICKS_PER_USD) }) } }]);
    }
  };
  for (let ago = 29; ago >= 0; ago--) {
    const base = now - ago * day - 6 * 3_600_000, weekday = new Date(base).getUTCDay(), recent = ago < 7;
    const busy = (weekday === 0 || weekday === 6 ? 0.5 : 1) * (index ? 1.6 : 1) * (1 + (29 - ago) / 30);
    for (let i = 0; i < Math.round(4 * busy); i++) add(main, base + i * 1_800_000, { reply: "Готово", usage: recent ? ["chatgpt", "gpt-6-astra", 42_000, 900, 0.31] : undefined });
    for (let i = 0; i < Math.round(3 * busy); i++) add(group, base + i * 2_400_000 + 600_000, { channel: "telegram", reply: i % 2 ? "NO_REPLY" : "Ответил", usage: recent ? ["chatgpt", "gpt-6-astra", 18_000, 300, 0.12] : undefined });
    for (let i = 0; i < 6; i++) {
      const runId = `seed-${index}-${ago}-${i}`, at = base + i * 3_600_000;
      store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at) VALUES(?,?,?,?,?,?)").run(runId, i ? radar.id : morning.id, editorChat, new Date(at).toISOString(), i % 3 ? "quiet" : "completed", new Date(at).toISOString());
      add(editorChat, at, { externalId: "schedule:" + runId, reply: i % 3 ? "NO_REPLY" : "Выпуск готов", usage: recent ? index ? ["anthropic", "claude-opus-5-5", 60_000, 1_200, 0.45] : ["grok", "grok-4.7", 90_000, 1_400, 0.9] : undefined });
    }
    if (index) for (let i = 0; i < Math.round(5 * busy); i++) add(main, base + i * 900_000 + 300_000, { externalId: `correspondence:gmail:${ago}-${i}`, reply: "NO_REPLY", status: i === 3 ? "failed" : "completed" });
  }
}

const homes: Array<{ name: string; control: string; local: string; token: string }> = [];
const stops: Array<() => Promise<void>> = [];
for (const [index, spec] of specs.entries()) {
  const directory = await mkdtemp(join(tmpdir(), "strudel-statistics-ui-"));
  let dbPath = ":memory:";
  if (spec.path) { dbPath = join(directory, "home.sqlite"); copyFileSync(spec.path, dbPath); }
  const runtime = new OpenStrudelRuntime({ rootDirectory: directory, dbPath, engine, startTelegram: false, mobilePort: 0 });
  runtime.api.home.rename(spec.name);
  Object.assign((runtime.api.mobile as any).options, { host: "127.0.0.1", hostname: "127.0.0.1" });
  runtime.account.read = async () => ({ connected: true, email: "preview@example.com", managed: true, planType: "plus" });
  // A copy keeps its schedules in place, so the screen can name them, but none of them ever comes due here.
  if (spec.path) runtime.store.db.prepare("UPDATE schedules SET next_run_at='2099-01-01T00:00:00.000Z'").run();
  else seed(runtime, index);
  const control = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const path = new URL(req.url ?? "/", "http://127.0.0.1");
    if (path.pathname === "/invite") {
      const invitation = await runtime.api.mobile.invite(true);
      const url = new URL(invitation.url); url.searchParams.set("name", spec.name);
      res.end(JSON.stringify({ ...invitation, url: url.toString() })); return;
    }
    res.end(JSON.stringify({ name: spec.name }));
  });
  await new Promise<void>(done => control.listen(0, "127.0.0.1", done));
  const address = await runtime.api.listen("127.0.0.1", 0);
  homes.push({ name: spec.name, control: `http://127.0.0.1:${(control.address() as { port: number }).port}`, local: `http://127.0.0.1:${address.port}`, token: runtime.api.localCredential() });
  stops.push(async () => { control.close(); await runtime.stop(); await rm(directory, { recursive: true, force: true }); });
}
await writeFile(output, JSON.stringify({ homes, pid: process.pid }), { mode: 0o600 });
console.log("Isolated statistics fixture ready: " + homes.map(home => `${home.name} ${home.control}`).join(", "));
const stop = async () => { for (const halt of stops) await halt(); process.exit(0); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
