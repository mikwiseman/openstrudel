/** Two independent hosts, ordinary invitations, no real accounts or Telegram. */
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenStrudelRuntime } from "../../src/runtime.js";

const root = await mkdtemp(join(tmpdir(), "strudel-remote-creation-ui-"));
const hosts = await Promise.all(["MacBook · Проверка", "Mac mini · Проверка"].map(async name => {
  const directory = join(root, name);
  const runtime = new OpenStrudelRuntime({ rootDirectory: directory, dbPath: ":memory:", startTelegram: false, mobilePort: 0,
    engine: { async run() { return { threadId: "qa-creation", response: "Готов помогать на «" + name + "».", events: [] }; } },
  });
  runtime.api.home.save({ ...runtime.api.home.state, name });
  runtime.account.read = async () => ({ connected: true, managed: true, email: "preview@example.invalid", planType: "plus" });
  Object.assign((runtime.api.mobile as any).options, { hostname: "127.0.0.1", host: "127.0.0.1", directory: join(directory, "mobile") });
  let offline = false;
  const api = runtime.api as unknown as { handle: (...args: any[]) => Promise<void> };
  const handle = api.handle.bind(runtime.api);
  api.handle = async (req, res, ...rest) => {
    if (offline) { res.writeHead(503).end('{"error":"Устройство недоступно"}'); return; }
    await handle(req, res, ...rest);
  };
  const address = await runtime.api.listen("127.0.0.1", 0);
  return { runtime, name, url: `http://127.0.0.1:${address.port}`, setOffline: (value: boolean) => { offline = value; } };
}));
const control = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const host = hosts[url.searchParams.get("host") === "mini" ? 1 : 0]!;
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/invite") {
    const invitation = await host.runtime.api.mobile.invite(false);
    const link = new URL(invitation.url); link.searchParams.set("name", host.name);
    res.end(JSON.stringify({ ...invitation, url: link.toString() })); return;
  }
  if (url.pathname === "/offline") host.setOffline(url.searchParams.get("value") === "1");
  res.end(JSON.stringify({ hosts: hosts.map(h => ({ name: h.name, profiles: h.runtime.store.listProfiles(), messages: h.runtime.store.listConversations().flatMap(c => h.runtime.store.listMessages(c.id)) })) }));
});
await new Promise<void>(done => control.listen(0, "127.0.0.1", done));
await writeFile(resolve(process.argv[2]!), JSON.stringify({ url: `http://127.0.0.1:${(control.address() as { port: number }).port}`, pid: process.pid, localURL: hosts[0]!.url }), { mode: 0o600 });
console.log("Independent-host creation fixture ready.");
const stop = async () => { control.close(); for (const host of hosts) await host.runtime.stop(); await rm(root, { recursive: true, force: true }); process.exit(0); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
