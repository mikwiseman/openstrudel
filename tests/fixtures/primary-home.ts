/** Synthetic UI acceptance only. No scheduler, Telegram, real OAuth or provider calls. */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { OpenStrudelRuntime } from "../../src/runtime.js";
import { MockCodexEngine } from "../../src/codex.js";

const root = await mkdtemp(join(tmpdir(), "strudel-primary-ui-"));
async function make(name: string) {
  const directory = join(root, name); await mkdir(directory);
  const runtime = new OpenStrudelRuntime({ dbPath: join(directory, "home.db"), rootDirectory: directory, apiToken: "synthetic-acceptance-owner", engine: new MockCodexEngine(), startTelegram: false, mobilePort: 0 });
  runtime.api.home.save({ ...runtime.api.home.state, name });
  for (const entry of [runtime.accounts.entries()[0]!, runtime.accounts.add("Рабочий")]) {
    const service = runtime.accounts.get(entry.id);
    service.read = async () => ({ connected: true, email: entry.id === "default" ? "personal@example.invalid" : "work@example.invalid", managed: true, planType: "plus" });
    service.usage = async () => ({ checkedAt: new Date().toISOString(), ordinaryUsageAllowed: true, windows: [{ name: "5 часов", usedPercent: 26, remainingPercent: 74, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 9000 }] });
  }
  const address = await runtime.api.listen("127.0.0.1", 0), url = "http://127.0.0.1:" + address.port;
  runtime.api.home.setEndpoint({ url });
  return { runtime, url };
}
const main = await make("Главное"), worker = await make("Рабочий Mac");
const profile = worker.runtime.store.createProfile({ name: "Редактор", instructions: "Пиши коротко и понятно." });
const chat = worker.runtime.store.profileConversation(profile.id);
worker.runtime.store.addMessage({ conversationId: chat.id, channel: "api", direction: "outbound", text: "Это тестовая история. Агент работает на дополнительном Mac." });
await worker.runtime.api.homeLink.join(main.runtime.api.home.invite({ url: main.url }));
const controller = createServer(async (req, res) => {
  if (req.url === "/offline") { await worker.runtime.api.homeLink.stop(); res.end("offline"); return; }
  if (req.url === "/online") { worker.runtime.api.homeLink.start(); res.end("online"); return; }
  res.writeHead(404).end();
});
await new Promise<void>(done => controller.listen(0, "127.0.0.1", done));
const invitation = main.runtime.api.web.invite(true);
const output = resolve(process.argv[2] ?? "/tmp/openstrudel-primary-ui.json");
await writeFile(output, JSON.stringify({ url: main.url, workerURL: worker.url, browser: main.url + "/#invite=" + invitation.key, controller: "http://127.0.0.1:" + (controller.address() as any).port, profileId: profile.id, root }), { mode: 0o600 });
console.log("Synthetic primary Home fixture ready.");
const stop = async () => { controller.close(); await worker.runtime.stop(); await main.runtime.stop(); await rm(root, { recursive: true, force: true }); process.exit(0); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
