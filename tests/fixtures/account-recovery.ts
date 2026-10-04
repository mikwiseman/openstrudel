/** Isolated auth UI scenarios. Never starts a scheduler, Telegram or real agent. */
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenStrudelRuntime } from "../../src/runtime.js";
import type { OpenAIAccount } from "../../src/account.js";

const output = resolve(process.argv[2]!);
const directory = await mkdtemp(join(tmpdir(), "strudel-account-ui-"));
delete process.env.TELEGRAM_BOT_TOKEN;
let mode = "signed-out";
let loginStarts = 0;
let loginStatus: "pending" | "completed" | "canceled" = "pending";
let controlURL = "";
const runtime = new OpenStrudelRuntime({ rootDirectory: directory, dbPath: ":memory:", startTelegram: false,
  engine: { async run() { throw new Error("UI fixture must not run agents"); } } });
runtime.account.read = async (): Promise<OpenAIAccount> => {
  if (mode === "legacy-error") throw new Error("workspace routing discovery unauthorized (401)");
  return { connected: mode === "connected", email: mode === "connected" ? "owner@example.invalid" : null, planType: "plus", managed: mode !== "signed-out",
    ...(mode === "expired" ? { issue: "sign_in_required" as const } : mode === "unavailable" ? { issue: "unavailable" as const } : {}) };
};
runtime.account.startLogin = async method => {
  loginStarts++; loginStatus = "pending";
  return method === "device"
    ? { type: "device", loginId: "fixture-login", verificationUrl: controlURL + "/login", userCode: "TEST-10204" }
    : { type: "browser", loginId: "fixture-login", authUrl: controlURL + "/login" };
};
runtime.account.status = async loginId => ({ loginId, status: loginStatus });
runtime.account.cancel = async loginId => { loginStatus = "canceled"; return { loginId, status: "canceled" }; };
Object.assign((runtime.api.mobile as any).options, { port: 0, host: "127.0.0.1", hostname: "127.0.0.1", directory: join(directory, "mobile") });

const control = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  const path = new URL(req.url ?? "/", "http://127.0.0.1");
  if (path.pathname === "/invite") {
    res.end(JSON.stringify(await runtime.api.mobile.invite(path.searchParams.get("owner") === "1"))); return;
  }
  if (path.pathname === "/mode") mode = path.searchParams.get("value") ?? "signed-out";
  if (path.pathname === "/cancel-login") loginStatus = "canceled";
  if (path.pathname === "/seed" && runtime.store.listProfiles().length === 0) {
    runtime.store.createProfile({ name: "Тестовый помощник" });
    runtime.store.addMessage({ conversationId: runtime.store.primaryConversation().id, channel: "api", direction: "outbound", text: "Эта история остаётся доступной после потери входа." });
  }
  res.end(JSON.stringify({ mode, loginStarts, loginStatus }));
});
await new Promise<void>(done => control.listen(0, "127.0.0.1", done));
controlURL = `http://127.0.0.1:${(control.address() as { port: number }).port}`;
const address = await runtime.api.listen("127.0.0.1", 0);
await writeFile(output, JSON.stringify({ url: controlURL, localURL: `http://127.0.0.1:${address.port}`, pid: process.pid }), { mode: 0o600 });
console.log("Isolated account recovery fixture ready.");
const stop = async () => { control.close(); await runtime.stop(); await rm(directory, { recursive: true, force: true }); process.exit(0); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
