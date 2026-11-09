import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubTools, type GitHubOptions } from "../src/github.js";
import { ConversationFiles } from "../src/files.js";
import { Store } from "../src/store.js";
import type { TelegramToolContext } from "../src/telegram-tools.js";

const cleanups: Array<() => void> = [];
afterEach(() => { vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

function fixture(options: { configured?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "strudel-github-"))), root = join(dir, "home");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(":memory:"); cleanups.push(() => store.close());
  const files = new ConversationFiles(store, root);
  if (options.configured !== false) {
    mkdirSync(join(root, ".data/github"), { recursive: true });
    writeFileSync(join(root, ".data/github/app.json"), JSON.stringify({ clientId: "Iv23fixture" }));
    writeFileSync(join(root, ".data/github/private-key.pem"), privateKey, { mode: 0o600 });
  }
  // Upstream repositories stand in for GitHub's Git service.
  const upstream = (fullName: string) => join(dir, "upstream", fullName + ".git");
  for (const fullName of ["o/r", "o/s"]) {
    const seed = join(dir, "seed", fullName);
    mkdirSync(seed, { recursive: true });
    git(dir, "init", "-q", "--bare", "-b", "main", upstream(fullName));
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "README.md"), "# Fixture\n");
    git(seed, "add", "README.md"); git(seed, "commit", "-qm", "Seed");
    git(seed, "push", "-q", upstream(fullName), "main");
  }
  // GitHub's REST API: the App's JWT for app routes, an installation token for the rest.
  const tokens: Array<{ token: string; permissions: Record<string, string>; repositories?: string[] }> = [];
  const pulls: any[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input), method = init.method ?? "GET", auth = String((init.headers as Record<string, string>).authorization ?? "").replace(/^Bearer /, "");
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const appRoute = url.pathname.startsWith("/app") && !url.pathname.startsWith("/app/installations/") || /^\/repos\/[^/]+\/[^/]+\/installation$/.test(url.pathname) || url.pathname.endsWith("/access_tokens");
    if (appRoute) {
      const [header, payload, signature] = auth.split(".");
      if (!createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature!, "base64url") || JSON.parse(Buffer.from(payload!, "base64url").toString()).iss !== "Iv23fixture") return json(401, { message: "Bad JWT" });
    } else if (!tokens.some(t => t.token === auth)) return json(401, { message: "Bad credentials" });
    const repository = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)/);
    if (repository && !["o/r", "o/s"].includes(`${repository[1]}/${repository[2]}`.toLowerCase())) return json(404, { message: "Not Found" });
    if (method === "GET" && url.pathname === "/app") return json(200, { slug: "wai-wolf" });
    if (method === "GET" && url.pathname === "/app/installations") return json(200, [{ id: 7, account: { login: "o" } }]);
    if (method === "POST" && url.pathname === "/app/installations/7/access_tokens") {
      const body = JSON.parse(String(init.body)), token = `ghs_fixture_${tokens.length + 1}`;
      tokens.push({ token, ...body }); return json(201, { token });
    }
    if (method === "GET" && url.pathname === "/installation/repositories") return json(200, { repositories: [
      { full_name: "o/r", description: "Main app", private: true, default_branch: "main", pushed_at: "2026-11-08T10:00:00Z" },
      { full_name: "o/s", description: "Site", private: false, default_branch: "main", pushed_at: "2026-11-01T10:00:00Z" }] });
    if (method === "GET" && decodeURIComponent(url.pathname) === "/users/wai-wolf[bot]") return json(200, { id: 4242 });
    if (method === "GET" && repository && url.pathname.endsWith("/installation")) return json(200, { id: 7 });
    if (method === "GET" && repository && url.pathname === repository[0]) return json(200, { full_name: `o/${repository[2]!.toLowerCase()}`, default_branch: "main" });
    if (method === "POST" && repository && url.pathname.endsWith("/pulls")) {
      const body = JSON.parse(String(init.body));
      if (pulls.some(p => p.head === body.head)) return json(422, { message: "Validation Failed" });
      pulls.push(body); return json(201, { html_url: `https://github.com/o/r/pull/${pulls.length}`, number: pulls.length });
    }
    if (method === "GET" && repository && url.pathname.endsWith("/pulls")) return json(200, pulls.filter(p => `o:${p.head}` === url.searchParams.get("head")).map(() => ({ html_url: "https://github.com/o/r/pull/1", number: 1 })));
    return json(404, { message: `No fixture for ${method} ${url.pathname}` });
  });
  const conversation = store.getOrCreateConversation({ channel: "api", externalId: "fixture" });
  const request = store.addMessage({ conversationId: conversation.id, channel: "api", direction: "inbound", text: "Fix the README", author: "Mik @mikwiseman" });
  const context: TelegramToolContext = { conversationId: conversation.id, messageId: request.id, channel: "api", byOwner: true, scope: "personal", access: true, files };
  const tools = (overrides: Partial<TelegramToolContext> = {}, extra: GitHubOptions = {}) => githubTools(store, { ...context, ...overrides }, { remote: upstream, minimumFree: 0, ...extra });
  const copy = join(root, ".data/workspace/personal/github/o/r");
  return { dir, root, store, files, upstream, tokens, pulls, context, tools, copy };
}

describe("GitHub repositories through the Home's App", () => {
  it("offers the tools only to people with access, in their own requests, on a Home with the App installed", async () => {
    const f = fixture(), names = (overrides: Partial<TelegramToolContext> = {}) => f.tools(overrides).definitions.map(t => t.name);
    expect(names()).toEqual(["github_repositories", "github_checkout", "github_open_pull_request"]);
    const unconfigured = fixture({ configured: false });
    expect(unconfigured.tools().definitions).toEqual([]);
    for (const overrides of [{ byOwner: false }, { scheduled: true }, { access: false }, { scope: undefined }, { files: undefined }]) expect(names(overrides)).toEqual([]);
    f.store.setSetting("access.people", JSON.stringify(["777"]));
    const dm = f.store.getOrCreateConversation({ channel: "telegram", externalId: "777" });
    const telegram = { conversationId: dm.id, channel: "telegram" as const, byOwner: false, telegramSenderId: "777", scope: "work" };
    expect(names(telegram)).toHaveLength(3);
    expect(names({ ...telegram, telegramSenderId: "888" })).toEqual([]);
    const group = f.store.getOrCreateConversation({ channel: "telegram", externalId: "-100" });
    f.store.linkTelegramChat({ chatId: "-100", title: "Team", allowedSenders: ["777"] });
    f.store.db.prepare("UPDATE telegram_chats SET conversation_id=? WHERE chat_id='-100'").run(group.id);
    const inGroup = { ...telegram, conversationId: group.id, scope: "group-" + "a".repeat(64) };
    expect(names(inGroup)).toHaveLength(3);
    expect(names({ ...inGroup, telegramSenderId: "888" })).toEqual([]);
    f.store.setSetting("telegram.paused.-100", "true");
    expect(names(inGroup)).toEqual([]);
    // Access removed while the request runs ends it at the next call.
    const granted = f.tools(telegram);
    f.store.setSetting("access.people", "[]");
    await expect(granted.call("github_repositories", { query: null })).rejects.toThrow("people with access");
  });

  it("lists repositories and clones into the chat workspace without leaving a credential", async () => {
    const f = fixture(), tools = f.tools();
    expect(await tools.call("github_repositories", { query: "site" })).toEqual({ total: 1, repositories: [expect.objectContaining({ repository: "o/s", private: false })] });
    const result = await tools.call("github_checkout", { repository: "r", fresh: true }) as any;
    expect(result).toMatchObject({ path: f.copy, repository: "o/r", url: "https://github.com/o/r", defaultBranch: "main", reused: false, commit: git(f.upstream("o/r"), "rev-parse", "main") });
    expect(result.lineLinks).toBe(`https://github.com/o/r/blob/${result.commit}/<path>#L<start>-L<end>`);
    expect(readFileSync(join(f.copy, "README.md"), "utf8")).toBe("# Fixture\n");
    expect(git(f.copy, "remote", "get-url", "origin")).toBe("https://github.com/o/r.git");
    expect(git(f.copy, "config", "--local", "user.email")).toBe("4242+wai-wolf[bot]@users.noreply.github.com");
    const header = Buffer.from("x-access-token:").toString("base64").slice(0, 16);
    for (const secret of ["ghs_fixture", header]) expect(() => execFileSync("grep", ["-rlF", secret, f.copy])).toThrow();
    expect(f.tokens.find(t => t.permissions.contents)).toMatchObject({ permissions: { contents: "read" }, repositories: ["r"] });
    expect(readdir(join(f.root, ".data/github/work"))).toEqual([]);
    // Continuing keeps local work; a fresh copy replaces it with GitHub's state.
    writeFileSync(join(f.copy, "README.md"), "local work\n");
    expect(await tools.call("github_checkout", { repository: "o/r", fresh: false })).toMatchObject({ path: f.copy, reused: true });
    expect(readFileSync(join(f.copy, "README.md"), "utf8")).toBe("local work\n");
    await tools.call("github_checkout", { repository: "https://github.com/o/r.git", fresh: true });
    expect(readFileSync(join(f.copy, "README.md"), "utf8")).toBe("# Fixture\n");
    await expect(tools.call("github_checkout", { repository: "o/private", fresh: true })).rejects.toThrow("not available");
    await expect(tools.call("github_checkout", { repository: "../../etc", fresh: true })).rejects.toThrow("owner/name");
    await expect(f.tools({}, { minimumFree: Number.MAX_SAFE_INTEGER }).call("github_checkout", { repository: "o/r", fresh: true })).rejects.toThrow("low on disk space");
  });

  it("pushes only a wolf/ branch, never runs code from the copy, and opens or returns the pull request", async () => {
    const f = fixture(), tools = f.tools();
    await tools.call("github_checkout", { repository: "o/r", fresh: true });
    git(f.copy, "switch", "-qc", "wolf/readme");
    writeFileSync(join(f.copy, "README.md"), "# Fixture\n\nBetter.\n");
    git(f.copy, "commit", "-qam", "Improve README");
    // The model controls everything in the copy, including Git's own configuration and hooks.
    const marker = join(f.dir, "executed"), script = join(f.dir, "evil.sh"), hooks = join(f.dir, "hooks");
    writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`); chmodSync(script, 0o755); mkdirSync(hooks);
    for (const hook of ["pre-push", "post-update", "reference-transaction", "pre-receive", "post-checkout", "fsmonitor-watchman", "pre-auto-gc"]) {
      for (const directory of [hooks, join(f.copy, ".git/hooks")]) { writeFileSync(join(directory, hook), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`); chmodSync(join(directory, hook), 0o755); }
    }
    writeFileSync(join(f.copy, ".git/config"), readFileSync(join(f.copy, ".git/config"), "utf8")
      + `[core]\n\tfsmonitor = ${script}\n\thooksPath = ${hooks}\n\tsshCommand = ${script}\n\talternateRefsCommand = ${script}\n[uploadpack]\n\tpackObjectsHook = ${script}\n[filter "evil"]\n\tclean = ${script}\n\tsmudge = ${script}\n[gc]\n\tauto = 1\n`);
    writeFileSync(join(f.copy, ".git/info/attributes"), "* filter=evil\n");
    for (const branch of ["main", "feature/x", "wolf/", "wolf/../main", "wolf/x.lock", "wolf/.hidden", "wolf/a..b"]) {
      await expect(tools.call("github_open_pull_request", { repository: "o/r", branch, title: "Change", body: "", draft: false })).rejects.toThrow("wolf/");
    }
    expect(git(f.upstream("o/r"), "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
    // The model's own Git commands in its sandbox may run that code; Home's must not. Each Home call starts without the marker.
    const inCopy = (...args: string[]) => git(f.copy, "-c", "core.fsmonitor=false", "-c", "filter.evil.clean=cat", "-c", "filter.evil.smudge=cat", "-c", "gc.auto=0", ...args);
    const publish = async (branch: string, title: string, body: string) => {
      rmSync(marker, { force: true });
      try { return await tools.call("github_open_pull_request", { repository: "o/r", branch, title, body, draft: false }); }
      finally { expect(existsSync(marker)).toBe(false); }
    };
    const opened = await publish("wolf/readme", " Improve the README ", "Ran: nothing to test.");
    const commit = inCopy("rev-parse", "wolf/readme");
    expect(opened).toEqual({ url: "https://github.com/o/r/pull/1", number: 1, branch: "wolf/readme", commit, created: true });
    expect(git(f.upstream("o/r"), "rev-parse", "wolf/readme")).toBe(commit);
    expect(f.pulls[0]).toEqual({ title: "Improve the README", head: "wolf/readme", base: "main", draft: false, body: "Ran: nothing to test.\n\n---\nRequested by Mik mikwiseman in the OpenStrudel app." });
    expect(f.tokens.at(-1)).toMatchObject({ permissions: { contents: "write", pull_requests: "write" }, repositories: ["r"] });
    // New commits update the same branch and pull request; a rewritten branch is refused, not forced.
    writeFileSync(join(f.copy, "NOTES.md"), "more\n");
    inCopy("add", "NOTES.md"); inCopy("commit", "-qm", "Add notes");
    expect(await publish("wolf/readme", "Improve the README", ""))
      .toEqual({ url: "https://github.com/o/r/pull/1", number: 1, branch: "wolf/readme", commit: inCopy("rev-parse", "wolf/readme"), created: false });
    inCopy("commit", "-q", "--amend", "-m", "Rewritten");
    const before = git(f.upstream("o/r"), "rev-parse", "wolf/readme");
    await expect(publish("wolf/readme", "Improve the README", "")).rejects.toThrow(/rejected|fetch first/);
    expect(git(f.upstream("o/r"), "rev-parse", "wolf/readme")).toBe(before);
    await expect(publish("wolf/missing", "x", "")).rejects.toThrow("was not found in the copy");
    // The trap is armed: an ordinary Git command inside the copy runs it.
    execFileSync("git", ["-C", f.copy, "status", "--short"], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(existsSync(marker)).toBe(true);
  });

  it("refuses a copy whose folders or Git store were replaced", async () => {
    const f = fixture(), tools = f.tools(), publish = () => tools.call("github_open_pull_request", { repository: "o/r", branch: "wolf/x", title: "x", body: "", draft: false });
    await expect(publish()).rejects.toThrow("Use github_checkout first");
    await tools.call("github_checkout", { repository: "o/r", fresh: true });
    git(f.copy, "switch", "-qc", "wolf/x");
    writeFileSync(join(f.copy, ".git/objects/info/alternates"), join(f.dir, "upstream/o/s.git/objects") + "\n");
    await expect(publish()).rejects.toThrow("borrows another Git store");
    rmSync(join(f.copy, ".git/objects/info/alternates"));
    const outside = join(f.dir, "outside");
    mkdirSync(join(outside, "r"), { recursive: true });
    rmSync(join(f.root, ".data/workspace/personal/github/o"), { recursive: true });
    symlinkSync(outside, join(f.root, ".data/workspace/personal/github/o"));
    await expect(publish()).rejects.toThrow("replaced by a link");
    await expect(tools.call("github_checkout", { repository: "o/r", fresh: true })).rejects.toThrow("replaced by a link");
    expect(existsSync(join(outside, "r"))).toBe(true);
  });

  it("removes copies nobody used for a week, without following replaced folders", async () => {
    const f = fixture(), tools = f.tools();
    await tools.call("github_checkout", { repository: "o/s", fresh: true });
    const stale = join(f.root, ".data/workspace/personal/github/o/s"), outside = join(f.dir, "outside/o/s");
    mkdirSync(outside, { recursive: true }); writeFileSync(join(outside, "keep.txt"), "keep");
    mkdirSync(join(f.root, ".data/workspace/work"), { recursive: true });
    symlinkSync(join(f.dir, "outside"), join(f.root, ".data/workspace/work/github"));
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    f.store.setSetting("github.copies.v1", JSON.stringify({ "personal/o/s": old, "work/o/s": old, "../o/s": old }));
    await tools.call("github_checkout", { repository: "o/r", fresh: true });
    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(Object.keys(JSON.parse(f.store.getSetting("github.copies.v1")!))).toEqual(["personal/o/r"]);
  });
});

function readdir(path: string): string[] { return execFileSync("ls", ["-A", path], { encoding: "utf8" }).split("\n").filter(Boolean); }
