import { afterEach, expect, it, vi } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ServerShell, serverNotice } from "../src/server-shell.js";
import { employeeTools } from "../src/personality.js";
import { Interactions } from "../src/interactions.js";
import { Store } from "../src/store.js";
import type { TelegramToolContext } from "../src/telegram-tools.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const runnerScript = resolve("deploy/server-shell/runner.py");
const until = async (ready: () => boolean) => { for (let i = 0; i < 200 && !ready(); i++) await new Promise(done => setTimeout(done, 50)); expect(ready()).toBe(true); };

/** A Home whose server administrator installed the shell for Telegram user 42. 42 and 77 both paired a private chat. */
function fixture(options: { installed?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "strudel-server-shell-"))), spool = join(root, ".data/server-shell");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(":memory:"); cleanups.push(() => store.close());
  store.linkTelegramChat({ chatId: "42", title: "Owner", allowedSenders: ["42"] });
  store.linkTelegramChat({ chatId: "77", title: "Partner", allowedSenders: ["77"] });
  store.linkTelegramChat({ chatId: "-100", title: "Team", allowedSenders: ["42"] });
  store.setSetting("access.managers", JSON.stringify(["77"]));
  mkdirSync(join(root, ".data"), { recursive: true });
  if (options.installed !== false) { mkdirSync(spool); writeFileSync(join(spool, "owners.json"), JSON.stringify(["42"])); }
  let runner: ChildProcess | undefined;
  const startRunner = async () => {
    runner = spawn("python3", [runnerScript, spool], { stdio: "ignore" });
    await until(() => existsSync(join(spool, "runner.json")));
  };
  const stopRunner = () => { runner?.kill("SIGKILL"); runner = undefined; };
  cleanups.push(stopRunner);
  const notices: Array<{ text: string; chat?: string }> = [];
  const shell = () => { const shell = new ServerShell(store, root, async (notice, chat) => { notices.push({ text: notice.text, chat }); }); shell.start(); cleanups.push(() => shell.stop()); return shell; };
  const conversationId = store.primaryConversation().id;
  const owner: TelegramToolContext = { conversationId, messageId: "m", channel: "telegram", telegramSenderId: "42", scope: "personal" };
  return { root, spool, store, notices, shell, startRunner, stopRunner, owner, conversationId, ready: options.installed === false ? Promise.resolve() : startRunner() };
}

it("gives the server shell only to the people its installation names, in their own private chat or the app", async () => {
  const { store, shell, owner, ready } = fixture(); await ready;
  const offered = (context: TelegramToolContext) => shell().tools(context).definitions.map(tool => tool.name);
  expect(offered(owner)).toEqual(["run_server_command"]);
  expect(offered({ ...owner, channel: "api", telegramSenderId: undefined, byOwner: true })).toEqual(["run_server_command"]);
  for (const context of [
    { ...owner, telegramSenderId: "77" },                                   // paired and an administrator, but not named on the server
    { ...owner, telegramSenderId: "99" },
    { ...owner, scope: "group-" + "a".repeat(64) },                           // the owner's own message in a group
    { ...owner, scheduled: true }, { ...owner, access: false },
    { ...owner, channel: "api" as const, telegramSenderId: undefined },         // an app device that is not the owner's
    { ...owner, channel: "api" as const, telegramSenderId: undefined, byOwner: true, scheduled: true },
  ]) {
    expect(offered(context)).toEqual([]);
    await expect(shell().tools(context).call({ command: "id", background: false, timeoutSeconds: null })).rejects.toThrow("belongs to this Home's owner");
  }
  // The tool reaches the model through the employee tools, and nothing was written for the refused calls.
  const tools = employeeTools(store, { run: vi.fn() } as never, new Interactions(), { profile: null, ...owner, serverShell: shell() });
  expect(tools.definitions.map(tool => tool.name)).toContain("run_server_command");
  expect(employeeTools(store, { run: vi.fn() } as never, new Interactions(), { profile: null, ...owner, telegramSenderId: "77", serverShell: shell() }).definitions.map(tool => tool.name)).not.toContain("run_server_command");
  expect(fixture({ installed: false }).shell().tools(owner).definitions).toEqual([]);
});

it("asks the owner before a server command unless they work without confirmations", async () => {
  const { store, shell, owner, spool, ready } = fixture(); await ready;
  const interactions = new Interactions(), answer = { decision: "Отказать" };
  const ask = vi.spyOn(interactions, "ask").mockImplementation(async () => answer);
  const run = () => employeeTools(store, { run: vi.fn() } as never, interactions, { profile: null, ...owner, serverShell: shell() }).call("run_server_command", { command: "echo asked", background: false, timeoutSeconds: null });
  await expect(run()).rejects.toThrow("declined");
  expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: "Разрешить действие?", detail: "Server command, as root\necho asked" }));
  expect(readdirSync(join(spool, "requests"))).toEqual([]);
  answer.decision = "Разрешить";
  expect(await run()).toMatchObject({ exitCode: 0, output: "asked\n" });
  store.setSetting("agents.approval_mode", "approve_all");
  expect(await run()).toMatchObject({ exitCode: 0 });
  expect(ask).toHaveBeenCalledTimes(2);
}, 30_000);

it("runs the owner's command on the server and returns its real exit code and output", async () => {
  const { shell, owner, spool, store, notices, ready } = fixture(); await ready;
  const run = shell().tools(owner).call;
  expect(await run({ command: "echo out; echo err >&2; exit 3", background: false, timeoutSeconds: null })).toMatchObject({ exitCode: 3, output: "out\nerr\n" });
  expect(await run({ command: "printf 'x%.0s' $(seq 1 300000)", background: false, timeoutSeconds: 60 })).toMatchObject({ exitCode: 0, truncated: true });
  expect(await run({ command: "sleep 30", background: false, timeoutSeconds: 1 })).toMatchObject({ exitCode: null, timedOut: true });
  for (const args of [{ command: " ", background: false, timeoutSeconds: null }, { command: "id", background: false, timeoutSeconds: 1501 }, { command: "id", background: true, timeoutSeconds: 21601 }, { command: "id", background: false, timeoutSeconds: 1.5 }])
    await expect(run(args)).rejects.toThrow();
  // Everything was handed over: no request, result or record stays behind, and a waited result is not repeated as a message.
  expect(["requests", "running", "results"].flatMap(folder => readdirSync(join(spool, folder)))).toEqual([]);
  expect(store.db.prepare("SELECT count(*) AS n FROM settings WHERE key GLOB 'serverShell.command.*'").get()!.n).toBe(0);
  expect(notices).toEqual([]);
}, 30_000);

it("brings a background command's result to the chat that asked, also when the Home restarted meanwhile", async () => {
  const { shell, owner, store, notices, conversationId, ready } = fixture(); await ready;
  const first = shell();
  expect(await first.tools(owner).call({ command: "sleep 1; echo Updated to abc1234", background: true, timeoutSeconds: null })).toMatchObject({ started: true });
  first.stop();                                  // the Home stops while the command runs on the server
  await new Promise(done => setTimeout(done, 1500));
  expect(notices).toEqual([]);
  shell();                                        // and starts again
  await until(() => notices.length === 1);
  expect(notices[0]).toMatchObject({ chat: "42" });
  expect(notices[0]!.text).toContain("Server command finished");
  expect(notices[0]!.text).toContain("Updated to abc1234");
  expect(store.listMessages(conversationId, 10).filter(message => message.kind === "notice").map(message => message.text)).toEqual([notices[0]!.text]);
  // From the app there is no Telegram chat to write to; the message stays in the conversation.
  await shell().tools({ ...owner, channel: "api", telegramSenderId: undefined, byOwner: true }).call({ command: "false", background: true, timeoutSeconds: null });
  await until(() => notices.length === 2);
  expect(notices[1]!.chat).toBeUndefined();
  expect(notices[1]!.text).toContain("failed (exit 1)");
}, 30_000);

it("runs nothing without a live runner, and never runs a command twice after the runner restarts", async () => {
  const { shell, owner, spool, startRunner, stopRunner, notices, ready } = fixture(); await ready;
  stopRunner();
  rmSync(join(spool, "runner.json"));
  await expect(shell().tools(owner).call({ command: "id", background: false, timeoutSeconds: null })).rejects.toThrow("not answering");
  expect(readdirSync(join(spool, "requests"))).toEqual([]);
  await startRunner();
  const marker = join(spool, "ran");
  await shell().tools(owner).call({ command: `echo run >> ${marker}; sleep 20`, background: true, timeoutSeconds: null });
  await until(() => existsSync(marker));
  stopRunner();                                   // the server reboots mid-command
  rmSync(join(spool, "runner.json"));
  await startRunner();
  await until(() => notices.length === 1);
  expect(notices[0]!.text).toContain("was interrupted");
  expect(readFileSync(marker, "utf8")).toBe("run\n");
  expect(readdirSync(join(spool, "running"))).toEqual([]);
}, 30_000);

it("writes a short, readable message", () => {
  expect(serverNotice("openstrudel-update", { exitCode: 0, output: "building\nUpdated to abc1234 \"Fix\".\n", seconds: 200 })).toBe("**Server command finished** · 3 min\n`openstrudel-update`\n\n```\nbuilding\nUpdated to abc1234 \"Fix\".\n```");
  expect(serverNotice("a\n`b`", { exitCode: 2, output: "", seconds: 4 })).toBe("**Server command failed (exit 2)** · 4 s\n`a 'b'`");
});

it("rolls an update back for lost data, not for a setting that normal work removed", () => {
  const missing = (before: Record<string, number>, after: Record<string, number>) => JSON.parse(execFileSync("python3", ["-c",
    "import json, sys; sys.path.insert(0, 'deploy/server-shell'); import update; print(json.dumps(update.missing_rows(*json.loads(sys.argv[1]))))", JSON.stringify([before, after])],
    { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }));
  expect(missing({ messages: 10, schedules: 3, settings: 5 }, { messages: 11, schedules: 3, settings: 4 })).toEqual({});
  expect(missing({ messages: 10, settings: 5 }, { messages: 9, settings: 6 })).toEqual({ messages: [10, 9] });
  expect(missing({ conversations: 2 }, {})).toEqual({ conversations: [2, 0] });
});
