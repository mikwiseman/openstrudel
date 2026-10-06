/** Disposable visual/interaction fixture. No real OAuth, scheduler or provider calls. */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { OpenStrudelRuntime } from "../../src/runtime.js";
import { MockCodexEngine } from "../../src/codex.js";
import { characterKinds } from "../../src/agent-appearance.js";

const root = await mkdtemp(join(tmpdir(), "strudel-characters-ui-"));
const runtime = new OpenStrudelRuntime({ dbPath: join(root, "home.db"), rootDirectory: root, engine: new MockCodexEngine(), startTelegram: false, mobilePort: 0 });
runtime.api.home.save({ ...runtime.api.home.state, name: "Тестовая команда" });
runtime.account.read = async () => ({ connected: true, email: "qa@example.invalid", managed: true, planType: "plus" });
for (const [index, name] of ["Редактор", "Исследователь", "Планировщик", "Помощник", "Идеи", "Проверка"].entries()) {
  const profile = runtime.store.createProfile({ name, instructions: "Помогай с задачами. Пиши коротко и понятно.", purpose: "У каждого свой образ", appearance: { version: 1, kind: characterKinds[index]!, tone: [0,4,3,7,6,2][index]! } });
  const chat = runtime.store.profileConversation(profile.id);
  runtime.store.addMessage({ conversationId: chat.id, channel: "api", direction: "outbound", text: "Готов помочь. С чего начнём?" });
}
const address = await runtime.api.listen("127.0.0.1", 0), url = "http://127.0.0.1:" + address.port;
runtime.api.home.setEndpoint({ url });
let worker: OpenStrudelRuntime | undefined;
if (process.env.OPENSTRUDEL_MULTI_DEVICE_QA === "1") {
  const directory = join(root, "worker"); await mkdir(directory);
  worker = new OpenStrudelRuntime({ dbPath: join(directory, "home.db"), rootDirectory: directory, engine: new MockCodexEngine(), startTelegram: false, mobilePort: 0 });
  worker.api.home.save({ ...worker.api.home.state, name: "Второе устройство" });
  const workerAddress = await worker.api.listen("127.0.0.1", 0);
  worker.api.home.setEndpoint({ url: "http://127.0.0.1:" + workerAddress.port });
  const person = worker.store.createProfile({ name: "Архивариус", instructions: "Сохраняй важное." });
  worker.store.addMessage({ conversationId: worker.store.profileConversation(person.id).id, channel: "api", direction: "outbound", text: "История на втором устройстве." });
  await worker.api.homeLink.join(runtime.api.home.invite({ url }));
}
const controller = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/invite") { res.end(JSON.stringify(await runtime.api.mobile.invite(true))); return; }
  if (req.url === "/web") { res.end(JSON.stringify({ url: url + "/#invite=" + runtime.api.web.invite(true).key })); return; }
  if (req.url === "/state") { res.end(JSON.stringify({ profiles: runtime.store.listProfiles(), mobile: runtime.api.mobile.status() })); return; }
  if (req.url === "/offline" && worker) { await worker.api.homeLink.stop(); res.end('{}'); return; }
  if (req.url === "/online" && worker) { worker.api.homeLink.start(); res.end('{}'); return; }
  res.writeHead(404).end('{}');
});
await new Promise<void>(done => controller.listen(0, "127.0.0.1", done));
await writeFile(resolve(process.argv[2] ?? "/tmp/openstrudel-characters-ui.json"), JSON.stringify({ url, browser: url + "/#invite=" + runtime.api.web.invite(true).key, controller: "http://127.0.0.1:" + (controller.address() as any).port, root }), { mode: 0o600 });
console.log("Synthetic character and sign-out fixture ready.");
const stop = async () => { controller.close(); await worker?.stop(); await runtime.stop(); await rm(root, { recursive: true, force: true }); process.exit(0); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
