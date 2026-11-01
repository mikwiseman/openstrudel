import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexExtensions, beginExtensionRun, readToml, shareWithAllChats, sharedWithAllChats } from "../src/extensions.js";
import { ScopedCodexEngine } from "../src/scopes.js";
import { CodexEngineAdapter } from "../src/codex.js";
import { contextServers } from "../src/claude.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
const group = "group-" + "a".repeat(64), employee = "agent-" + "b".repeat(32);
function home() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "strudel-all-chats-"))); roots.push(root);
  const source = join(root, "source"); mkdirSync(source);
  const write = (path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };
  write(".data/extensions/personal/config.toml", [
    '[mcp_servers.company]\nurl = "https://work.example/api/mcp/company"\n[mcp_servers.company.http_headers]\nAuthorization = "Bearer owner"',
    '[mcp_servers.notion]\nurl = "https://mcp.notion.example/mcp"',
    '[mcp_servers.cua_repl]\ncommand = "/Applications/Codex.app/cua"',
    '[mcp_servers.paused]\nurl = "https://paused.example/mcp"\nenabled = false\n[mcp_servers.paused.http_headers]\nAuthorization = "Bearer p"',
    '[apps.connector_calendar]\nenabled = true\n[apps.connector_gmail]\nenabled = true\n[apps.connector_off]\nenabled = false',
  ].join("\n") + "\n");
  write(".data/connections/personal.toml", '[mcp_servers.telegram_history]\nurl = "https://telegram.example/mcp"\n[mcp_servers.telegram_history.http_headers]\nAuthorization = "Bearer t"\n');
  const config = (context: string, account = ".data/contexts") => readToml(join(root, account, context, "config.toml"));
  return { root, source, write, config };
}

it("gives every other chat the owner's services and apps only after the owner shares them", () => {
  const { root, source, config } = home();
  const scoped = new ScopedCodexEngine(root, source);
  try {
    scoped.forContext(group); scoped.forContext(employee);
    expect(config(group).mcp_servers.company).toBeUndefined();
    expect(config(group).apps.connector_calendar).toBeUndefined();
    expect(sharedWithAllChats(root)).toBe(false);
    shareWithAllChats(root, true);
    for (const chat of [group, employee]) {
      scoped.forContext(chat);
      expect(Object.keys(config(chat).mcp_servers).sort()).toEqual(["company", "telegram_history"]);
      expect(config(chat).mcp_servers.company.http_headers.Authorization).toBe("Bearer owner");
      expect(config(chat).apps).toMatchObject({ connector_calendar: { enabled: true }, connector_gmail: { enabled: true } });
      expect(config(chat).apps.connector_off).toBeUndefined();
      // Inherited services are not copied into the chat's own configuration.
      expect(existsSync(join(root, ".data/extensions", chat, "config.toml"))).toBe(false);
    }
    // The owner's own chat is unchanged; a sign-in service, Computer Use and paused services stay there.
    scoped.forContext("personal");
    expect(Object.keys(config("personal").mcp_servers).sort()).toEqual(["company", "cua_repl", "notion", "paused", "telegram_history"]);
  } finally { scoped.close(); }
});

it("keeps a chat's own services and a group's verified-sender service ahead of the owner's", () => {
  const { root, source, write, config } = home();
  shareWithAllChats(root, true);
  write(`.data/extensions/${group}/config.toml`, '[mcp_servers.telegram_history]\nurl = "https://group-own.example/mcp"\n[mcp_servers.telegram_history.http_headers]\nAuthorization = "Bearer group"\n[apps.connector_gmail]\nenabled = false\n');
  write(`.data/connections/${group}.telegram.json`, JSON.stringify({ wai: { url: "https://work.example/api/mcp/company/" } }));
  const scoped = new ScopedCodexEngine(root, source);
  try {
    scoped.forContext(group);
    expect(config(group).mcp_servers.telegram_history.url).toBe("https://group-own.example/mcp");
    // One service per address: the group's verified identity replaces the owner's key.
    expect(config(group).mcp_servers.company).toBeUndefined();
    expect(config(group).apps.connector_gmail).toBeUndefined();
    expect(config(group).apps.connector_calendar.enabled).toBe(true);
    const own = contextServers(root, group, {});
    expect(own.company).toBeUndefined();
    expect(own.telegram_history).toMatchObject({ url: "https://group-own.example/mcp" });
    expect(contextServers(root, employee, {})).toMatchObject({ company: { url: "https://work.example/api/mcp/company" }, telegram_history: { url: "https://telegram.example/mcp" } });
  } finally { scoped.close(); }
});

it("gives a group turn without access only the services that verify the sender themselves", () => {
  const { root, write } = home();
  shareWithAllChats(root, true);
  write(`.data/extensions/${group}/config.toml`, '[mcp_servers.notion]\nurl = "https://group-own.example/mcp"\n[mcp_servers.notion.http_headers]\nAuthorization = "Bearer group"\n');
  expect(Object.keys(contextServers(root, group, {})).sort()).toEqual(["company", "notion", "telegram_history"]);
  expect(Object.keys(contextServers(root, group, { access: true })).sort()).toEqual(["company", "notion", "telegram_history"]);
  expect(contextServers(root, group, { access: false })).toEqual({});
  write(`.data/connections/${group}.telegram.json`, JSON.stringify({ wai: { url: "https://work.example/api/mcp/company/" } }));
  const actor = { userId: "77", chatId: "-100", messageId: "-100:5" };
  expect(contextServers(root, group, { access: false, telegramActor: actor, conversationId: "c" })).toEqual({ wai: { type: "http", url: "https://work.example/api/mcp/company/",
    headers: { "x-hermes-platform": "telegram", "x-hermes-user-id": "77", "x-hermes-chat-id": "-100", "x-hermes-message-id": "-100:5", "x-hermes-session-id": "openstrudel:c" } } });
  expect(Object.keys(contextServers(root, group, { access: true, telegramActor: actor })).sort()).toEqual(["notion", "telegram_history", "wai"]);
});

it("reloads an idle chat when the owner's or installer's files change, and never refuses a busy one", () => {
  const { root, source, write, config } = home();
  shareWithAllChats(root, true);
  const scoped = new ScopedCodexEngine(root, source);
  try {
    const first = scoped.forContext(group) as CodexEngineAdapter;
    expect(scoped.forContext(group)).toBe(first);
    write(".data/extensions/personal/config.toml", '[apps.connector_calendar]\nenabled = true\n');
    const busy = vi.spyOn(first, "busy", "get").mockReturnValue(true);
    expect(scoped.forContext(group)).toBe(first);
    busy.mockReturnValue(false);
    const second = scoped.forContext(group);
    expect(second).not.toBe(first);
    expect(config(group).apps.connector_gmail).toBeUndefined();
    expect(config(group).mcp_servers.company).toBeUndefined();
    write(`.data/connections/${group}.telegram.json`, JSON.stringify({ wai: { url: "https://work.example/mcp" } }));
    expect(scoped.forContext(group)).not.toBe(second);
    // A hand-written configuration in another key order is still the same configuration.
    const third = scoped.forContext(group);
    write(`.data/extensions/${group}/config.toml`, '[apps.b]\nenabled = true\n[apps.a]\nenabled = true\n');
    const fourth = scoped.forContext(group);
    expect(fourth).not.toBe(third);
    expect(scoped.forContext(group)).toBe(fourth);
  } finally { scoped.close(); }
});

it("moves app grants out of account homes once, then lets the chat's own file decide", () => {
  const { root, source, write, config } = home();
  const office = ".data/accounts/office/contexts";
  write(`${office}/${employee}/config.toml`, '[apps._default]\nenabled = false\n[apps.connector_gmail]\nenabled = true\n');
  const second = new ScopedCodexEngine(root, source, undefined, join(root, office));
  const first = new ScopedCodexEngine(root, source);
  try {
    second.forContext(employee);
    expect(readToml(join(root, ".data/extensions", employee, "config.toml")).apps).toEqual({ connector_gmail: { enabled: true } });
    first.forContext(employee);
    expect(config(employee).apps.connector_gmail.enabled).toBe(true);
    write(`.data/extensions/${employee}/config.toml`, '[apps.connector_gmail]\nenabled = false\n');
    second.close(); second.forContext(employee);
    expect(config(employee, office).apps.connector_gmail).toBeUndefined();
  } finally { first.close(); second.close(); }
});

it("saves an app grant during the turn that asked for it, without copying inherited services", async () => {
  const { root } = home();
  const homeDir = join(root, ".data/contexts", group), shared = join(root, ".data/extensions", group, "config.toml");
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(join(homeDir, "config.toml"), '[apps.connector_calendar]\nenabled = true\n[mcp_servers.company]\nurl = "https://work.example/api/mcp/company"\n');
  const extensions = new CodexExtensions({ home: homeDir, cwd: join(root, "workspace"), sharedConfigPath: shared, reservedServers: ["company"], inheritedApps: ["connector_calendar"],
    client: async () => { throw Error("Not needed to save a grant"); }, changed: async () => {}, idle: () => true });
  const finish = beginExtensionRun(shared);
  try {
    await expect(extensions.enableApp("connector_drive")).rejects.toThrow(/Дождитесь/);
    extensions.grantApp("connector_drive");
    expect(readToml(shared).apps).toEqual({ connector_drive: { enabled: true } });
  } finally { finish(); }
  await extensions.enableApp("connector_contacts");
  expect(readToml(shared)).toEqual({ apps: { connector_contacts: { enabled: true } } });
});

it("lets the owner turn sharing on and off through the Home API", async () => {
  const { root } = home();
  const { OpenStrudelRuntime } = await import("../src/runtime.js");
  const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", startTelegram: false, apiToken: "owner", rootDirectory: root, engine: { run: async () => ({ threadId: "t", response: "OK", events: [] }) } });
  const address = await runtime.api.listen("127.0.0.1", 0);
  const call = async (method: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${address.port}/v1/extensions/all-chats`, { method, headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, value: await r.json() };
  };
  try {
    expect(await call("GET")).toEqual({ status: 200, value: { enabled: false } });
    expect(await call("POST", { enabled: true })).toEqual({ status: 200, value: { enabled: true } });
    expect(sharedWithAllChats(root)).toBe(true);
    expect((await call("POST", { enabled: "yes" })).status).toBe(400);
    expect(await call("POST", { enabled: false })).toEqual({ status: 200, value: { enabled: false } });
  } finally { await runtime.stop(); }
});

it("lets the owner keep this Home's access list through the Home API", async () => {
  const { root } = home();
  const { OpenStrudelRuntime } = await import("../src/runtime.js");
  const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", startTelegram: false, apiToken: "owner", rootDirectory: root, engine: { run: async () => ({ threadId: "t", response: "OK", events: [] }) } });
  runtime.store.linkTelegramChat({ chatId: "139287108", title: "Mik", allowedSenders: ["139287108"] });
  runtime.store.linkTelegramChat({ chatId: "-100", title: "Team", allowedSenders: ["139287108"] });
  const address = await runtime.api.listen("127.0.0.1", 0);
  const call = async (method: string, body?: unknown, headers: Record<string, string> = { authorization: "Bearer owner" }) => {
    const r = await fetch(`http://127.0.0.1:${address.port}/v1/settings/access`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, value: await r.json() };
  };
  try {
    expect(await call("GET")).toEqual({ status: 200, value: { people: [], owners: ["139287108"], managers: [] } });
    expect(await call("POST", { people: ["139287108", "241196252"] })).toEqual({ status: 200, value: { people: ["139287108", "241196252"], owners: ["139287108"], managers: [] } });
    expect(JSON.parse(runtime.store.getSetting("access.people")!)).toEqual(["139287108", "241196252"]);
    for (const people of ["241196252", ["-100"], ["abc"], [241196252], ["0"]]) expect((await call("POST", { people })).status, JSON.stringify(people)).toBe(400);
    expect((await call("POST", { managers: ["77", "77"] })).value).toMatchObject({ managers: ["77"], people: ["139287108", "241196252"] });
    expect((await call("POST", { people: [], managers: ["-100"] })).status).toBe(400);
    expect((await call("GET")).value.managers).toEqual(["77"]);
    const session = await fetch(`http://127.0.0.1:${address.port}/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: runtime.api.web.invite(false).key }) });
    const { csrf } = await session.json();
    const member = { cookie: session.headers.get("set-cookie")!.split(";")[0]!, "x-openstrudel-csrf": csrf, "x-openstrudel-owner": "1" };
    expect((await call("POST", { people: [] }, member)).status).toBe(403);
    expect((await call("POST", { managers: [] }, member)).status).toBe(403);
    expect((await call("GET")).value.managers).toEqual(["77"]);
    expect(JSON.parse(runtime.store.getSetting("access.people")!)).toEqual(["139287108", "241196252"]);
  } finally { await runtime.stop(); }
});

it("keeps a chat's own opt-out and address over the owner's after the chat's services change", async () => {
  const { root, source, write, config } = home();
  shareWithAllChats(root, true);
  write(`.data/extensions/${group}/config.toml`, '[apps.connector_gmail]\nenabled = false\n[mcp_servers.group_wai]\nurl = "https://work.example/api/mcp/company/"\n[mcp_servers.group_wai.http_headers]\nAuthorization = "Bearer group"\n');
  const scoped = new ScopedCodexEngine(root, source);
  try {
    scoped.forContext(group);
    expect(config(group).mcp_servers.company).toBeUndefined();
    expect(config(group).mcp_servers.group_wai.http_headers.Authorization).toBe("Bearer group");
    const homeDir = join(root, ".data/contexts", group), shared = join(root, ".data/extensions", group, "config.toml");
    const extensions = new CodexExtensions({ home: homeDir, cwd: join(root, ".data/workspace", group), sharedConfigPath: shared, reservedServers: ["telegram_history"], inheritedApps: ["connector_calendar"],
      client: async () => { throw Error("Not needed"); }, changed: async () => {}, idle: () => true });
    await extensions.enableApp("connector_drive");
    expect(readToml(shared).apps).toEqual({ connector_gmail: { enabled: false }, connector_drive: { enabled: true } });
    scoped.close(); scoped.forContext(group);
    expect(config(group).apps.connector_gmail).toBeUndefined();
  } finally { scoped.close(); }
});

it("lets only the owner grant a service from chat, and reports an immediate grant as connected", async () => {
  const { Store } = await import("../src/store.js");
  const { Interactions } = await import("../src/interactions.js");
  const { employeeTools } = await import("../src/personality.js");
  const store = new Store(":memory:");
  const connect = vi.fn(async () => ({ url: null }));
  const engine = { run: vi.fn(), connections: async () => [{ id: "gmail", name: "Gmail", kind: "app" as const, connected: false, url: null, status: "available" as const }], connect, isConnected: async () => true };
  const tools = (byOwner: boolean) => employeeTools(store, engine, new Interactions(store), { profile: null, conversationId: store.primaryConversation().id, messageId: "m", channel: "api", byOwner });
  try {
    await expect(tools(false).call("connect_service", { id: "gmail" })).rejects.toThrow(/владелец/);
    expect(connect).not.toHaveBeenCalled();
    expect(await tools(true).call("connect_service", { id: "gmail" })).toEqual({ connected: true, name: "Gmail" });
  } finally { store.close(); }
});
