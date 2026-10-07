import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpsRequest } from "node:https";

const wire = vi.hoisted(() => ({
  request: vi.fn(), initialize: vi.fn(),
  clients: [] as Array<{ home: string | undefined; closed: boolean; notify?: (message: any) => void }>,
}));
vi.mock("../src/rpc.js", () => ({ CodexRpc: class {
  closed = false;
  constructor(public home?: string, public notify?: (message: any) => void) { wire.clients.push(this); }
  initialize = wire.initialize;
  request = wire.request;
  close() { this.closed = true; }
} }));
import { CodexAccountService } from "../src/account.js";
import { Store } from "../src/store.js";
import { ScopedCodexEngine } from "../src/scopes.js";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { isOpenAIAuthenticationError } from "../src/account-errors.js";

let root: string;
let store: Store;
let account: CodexAccountService;
const identity = { type: "chatgpt", email: "owner@example.invalid", planType: "plus" };
function savedAuth(id = "owner") {
  mkdirSync(join(root, "codex"), { recursive: true });
  writeFileSync(join(root, "codex/auth.json"), JSON.stringify({ tokens: { account_id: id, access_token: "test-access", refresh_token: "never-copy-this-refresh" } }), { mode: 0o600 });
}
function completeLogin(id = "login") {
  const client = wire.clients.find(client => client.notify && !client.closed)!;
  client.notify!({ method: "account/login/completed", params: { loginId: id, success: true } });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "strudel-account-"));
  store = new Store(":memory:");
  account = new CodexAccountService(store, root);
  wire.initialize.mockResolvedValue(undefined);
  wire.request.mockImplementation(async (method: string) => {
    if (method === "account/read") return { account: identity };
    if (method === "account/login/start") return { type: "chatgpt", loginId: "login", authUrl: "https://auth.openai.com/test-login" };
    return {};
  });
});
afterEach(() => {
  account.close(); store.close(); rmSync(root, { recursive: true, force: true });
  wire.clients.length = 0; wire.request.mockReset(); wire.initialize.mockReset();
  vi.unstubAllEnvs(); vi.useRealTimers();
});

describe("one explicitly authorized Home account", () => {
  it("keeps credit balance separate from subscription windows and labels their real duration", async () => {
    store.setSetting("codex.auth.mode", "managed");
    wire.request.mockResolvedValue({ rateLimits: { primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 52, windowDurationMins: 10080, resetsAt: 1800100000 }, credits: { hasCredits: true, unlimited: false, balance: "27.50" } } });
    const usage = await account.usage();
    expect(usage.windows.map(w => w.name)).toEqual(["5 часов", "Неделя"]);
    expect(usage.windows.map(w => w.remainingPercent)).toEqual([69, 48]);
    expect(usage.credits).toEqual({ hasCredits: true, unlimited: false, balance: "27.50" });
    expect(wire.request).not.toHaveBeenCalledWith(expect.stringMatching(/purchase|reset/), expect.anything());
  });
  it("recognizes rejected refresh credentials without calling a network outage a logout", () => {
    for (const message of ["Your refresh token has expired. Please sign in again.", "Refresh token was already used", "invalid access token", "refresh_token_invalidated", "workspace routing discovery unauthorized (401)"]) {
      expect(isOpenAIAuthenticationError(new Error(message)), message).toBe(true);
    }
    for (const message of ["Connection timed out", "OpenAI returned 503", "Connection reset during refresh token request"]) {
      expect(isOpenAIAuthenticationError(new Error(message)), message).toBe(false);
    }
  });

  it("never imports the device's Codex account, including an old unconfirmed local auth file", async () => {
    vi.stubEnv("CODEX_HOME", join(root, "another-product")); savedAuth();
    expect(await account.read()).toEqual({ connected: false, email: null, planType: null, managed: false });
    expect(account.executionHome()).toBeUndefined();
    expect(wire.clients).toHaveLength(0);
    const engine = new ScopedCodexEngine(root);
    expect(() => engine.forContext("personal")).toThrow("Войдите в OpenAI");
    expect(readFileSync(join(root, "codex/auth.json"), "utf8")).toContain("never-copy-this-refresh");
  });

  it("keeps expired authorization separate from network failure and preserves credentials", async () => {
    store.setSetting("codex.auth.mode", "managed"); savedAuth();
    const original = readFileSync(join(root, "codex/auth.json"));
    wire.request.mockRejectedValueOnce(new Error("workspace routing discovery unauthorized (401)"));
    expect(await account.read()).toMatchObject({ connected: false, managed: true, issue: "sign_in_required" });
    wire.request.mockRejectedValueOnce(new Error("connection timed out"));
    expect(await account.read(true)).toMatchObject({ connected: false, issue: "unavailable" });
    expect(readFileSync(join(root, "codex/auth.json"))).toEqual(original);
    expect(wire.clients.every(client => client.closed)).toBe(true);
  });

  it("shares reads and one pending login across devices without authorizing before consent", async () => {
    const [first, second] = await Promise.all([account.startLogin(), account.startLogin("device")]);
    expect(first).toEqual(second);
    expect(wire.request.mock.calls.filter(([method]) => method === "account/login/start")).toHaveLength(1);
    expect(account.loginPending).toBe(true);
    expect((await account.read()).connected).toBe(false);
    savedAuth(); completeLogin();
    const [a, b] = await Promise.all([account.read(), account.read()]);
    expect(a).toEqual(b); expect(a).toMatchObject({ connected: true, email: identity.email });
    expect(account.loginPending).toBe(false);
    expect(wire.clients.every(client => client.home === join(root, "codex"))).toBe(true);
    const restarted = new CodexAccountService(store, root);
    expect((await restarted.read()).connected).toBe(true); restarted.close();
  });

  it("does not reset thread history when the same account signs in again", async () => {
    savedAuth(); store.setSetting("codex.auth.mode", "managed");
    const changed = vi.fn(); account.setOnChange(changed);
    await account.startLogin(); completeLogin();
    expect(changed).toHaveBeenCalledWith(false);
    await account.status("login");
    expect((await account.status("login")).status).toBe("completed");
  });

  it("recognizes an explicit switch to another account", async () => {
    savedAuth(); store.setSetting("codex.auth.mode", "managed");
    const changed = vi.fn(); account.setOnChange(changed);
    await account.startLogin(); savedAuth("different-owner"); completeLogin();
    expect(changed).toHaveBeenCalledWith(true);
  });

  it("handles canceled, expired and interrupted logins without erasing a working account", async () => {
    store.setSetting("codex.auth.mode", "managed"); savedAuth();
    await account.startLogin(); await account.cancel("login");
    expect((await account.status("login")).status).toBe("canceled");
    expect((await account.read()).connected).toBe(true);
    await account.startLogin();
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(account.loginPending).toBe(false);
    expect((await account.status("login")).status).toBe("canceled");
    expect((await account.status("from-before-restart")).status).toBe("canceled");
  });

  it("does not leave a Codex process after initialization fails during login", async () => {
    wire.initialize.mockRejectedValueOnce(new Error("network timeout"));
    await expect(account.startLogin()).rejects.toThrow("Не удалось завершить вход");
    expect(wire.clients[0]!.closed).toBe(true);
  });

  it("stops using the account after explicit logout and never falls back to global credentials", async () => {
    store.setSetting("codex.auth.mode", "managed"); savedAuth();
    await account.logout();
    expect(account.executionHome()).toBeUndefined();
    expect((await account.read()).connected).toBe(false);
    await expect(account.authTokens()).rejects.toThrow("Войдите в OpenAI");
  });

  it("renews OAuth once on the Home and gives workers only access tokens", async () => {
    store.setSetting("codex.auth.mode", "managed"); savedAuth();
    const [a, b] = await Promise.all([account.authTokens(true), account.authTokens(true)]);
    expect(a).toEqual(b);
    expect(a).toEqual({ accessToken: "test-access", chatgptAccountId: "owner", chatgptPlanType: "plus" });
    expect(wire.request.mock.calls.filter(([method, params]) => method === "account/read" && params.refreshToken)).toHaveLength(1);
    const engine = new ScopedCodexEngine(root, join(root, "codex"), () => account.authTokens());
    engine.forContext("personal");
    expect(() => readFileSync(join(root, ".data/contexts/personal/auth.json"))).toThrow();
    expect(readFileSync(join(root, ".data/contexts/personal/config.toml"), "utf8")).toContain('cli_auth_credentials_store = "ephemeral"');
    expect(readFileSync(join(root, ".data/contexts/personal/config.toml"), "utf8")).toContain('[features]\napps = true');
    engine.close();
  });
});

function remote(port: number, path: string, token: string, method = "GET", body?: object) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = httpsRequest({ hostname: "127.0.0.1", port, path, method, rejectUnauthorized: false,
      headers: { authorization: "Bearer " + token, "content-type": "application/json" } }, res => {
      let data = ""; res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
    });
    req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
it("shares account status over the real paired transport but only lets the owner manage login", async () => {
  const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", rootDirectory: root,
    engine: { async run() { throw new Error("must not execute"); } }, startTelegram: false });
  Object.assign((runtime.api.mobile as any).options, { port: 0, host: "127.0.0.1", directory: join(root, "mobile") });
  try {
    const ownerInvite = new URL((await runtime.api.mobile.invite(true)).url);
    const port = runtime.api.mobile.port!;
    const owner = (await remote(port, "/pair", ownerInvite.searchParams.get("key")!, "POST")).body.token;
    const phoneInvite = new URL((await runtime.api.mobile.invite()).url);
    const phone = (await remote(port, "/pair", phoneInvite.searchParams.get("key")!, "POST")).body.token;
    expect((await remote(port, "/v1/account", phone)).body).toMatchObject({ canManage: false, account: { connected: false } });
    for (const path of ["/v1/account/login", "/v1/account/logout", "/v1/account/login/login/cancel"]) {
      expect((await remote(port, path, phone, "POST")).status).toBe(403);
    }
    expect(wire.request).not.toHaveBeenCalled();
    const started = await remote(port, "/v1/account/login", owner, "POST", { method: "browser" });
    expect(started.status).toBe(201);
    expect(wire.request).toHaveBeenCalledWith("account/login/start", { type: "chatgptDeviceCode" });
    expect((await remote(port, "/v1/account", phone)).body.loginPending).toBe(true);
    const loginRpc = wire.clients.find(client => client.notify)!;
    loginRpc.notify!({ method: "account/login/completed", params: { loginId: "login", success: true } });
    const first = (await remote(port, "/v1/account", owner)).body;
    const second = (await remote(port, "/v1/account", phone)).body;
    expect(first.account).toEqual(second.account);
    expect(second).toMatchObject({ account: { connected: true }, canManage: false, loginPending: false });
    expect((await remote(port, "/v1/account/login/login", phone)).status).toBe(403);
  } finally { await runtime.stop(); }
});
