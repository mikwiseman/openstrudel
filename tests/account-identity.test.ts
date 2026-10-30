import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { CodexAccountService } from "../src/account.js";
import { Accounts } from "../src/accounts.js";

const wire = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/rpc.js", () => ({ CodexRpc: class {
  initialize = async () => {};
  exited = Promise.resolve();
  request = wire.request;
  close() {}
} }));

let root: string, store: Store, accounts: Accounts;
function authorize(id: string, workspace: string, user = "user-1", token = id) {
  const home = join(root, ".data", ...(id === "default" ? [] : ["accounts", id]), "codex");
  mkdirSync(home, { recursive: true });
  const claims = Buffer.from(JSON.stringify({ sub: user, "https://api.openai.com/auth": { chatgpt_account_id: workspace } })).toString("base64url");
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { account_id: workspace, id_token: `header.${claims}.signature`, access_token: token, refresh_token: "private-refresh" } }), { mode: 0o600 });
  store.setSetting(id === "default" ? "codex.auth.mode" : `codex.account.${id}.mode`, "managed");
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "strudel-identities-")); store = new Store(":memory:");
  accounts = new Accounts(store, root, new CodexAccountService(store, join(root, ".data")));
  wire.request.mockImplementation(async method => method === "account/read" ? { account: { type: "chatgpt", email: "person@example.invalid", planType: "plus" } } : { rateLimits: {} });
});
afterEach(() => { accounts.close(); store.close(); rmSync(root, { force: true, recursive: true }); vi.restoreAllMocks(); wire.request.mockReset(); });

describe("account identity and consistency", () => {
  it("coalesces duplicate connections, retains the existing name/order and employee choice, and never revokes the OpenAI session", async () => {
    authorize("default", "workspace-a");
    accounts.rename("default", "Studio");
    const duplicate = accounts.add("OpenAI"); authorize(duplicate.id, "workspace-a", "user-1", "new-login");
    accounts.setPolicy("main", [duplicate.id]);
    const conversation = store.primaryConversation();
    store.addMessage({ channel: "api", conversationId: conversation.id, direction: "outbound", text: "Keep this history" });
    store.setConversationThread(conversation.id, "duplicate-thread");
    store.setSetting("codex.threadOwner." + conversation.id, duplicate.id);
    const [one, two] = await Promise.all([accounts.list(), accounts.list()]);
    expect(one).toHaveLength(1); expect(two).toHaveLength(1);
    expect(one[0]).toMatchObject({ id: "default", name: "Studio", displayName: "Studio" });
    expect(accounts.policy("main")).toEqual(["default"]);
    expect(store.listMessages(conversation.id).some(m => m.text === "Keep this history")).toBe(true);
    expect(store.getConversation(conversation.id)?.codexThreadId).toBeNull();
    expect(store.getSetting("codex.threadOwner." + conversation.id)).toBeNull();
    expect(JSON.parse(readFileSync(join(root, ".data/codex/auth.json"), "utf8")).tokens.access_token).toBe("new-login");
    expect(wire.request.mock.calls.some(([method]) => method === "account/logout")).toBe(false);
    expect(JSON.stringify(one)).not.toMatch(/private-refresh|new-login|workspace-a|user-1/);
  });
  it("keeps same-email workspaces and different users within a workspace separate", async () => {
    authorize("default", "workspace-a");
    const work = accounts.add("OpenAI"); authorize(work.id, "workspace-b");
    const colleague = accounts.add("OpenAI"); authorize(colleague.id, "workspace-b", "user-2");
    expect(await accounts.list()).toHaveLength(3);
  });
  it("does not guess duplicates from missing identity claims", async () => {
    for (const id of ["default", accounts.add("OpenAI").id]) {
      authorize(id, "workspace-a");
      const path = join(accounts.get(id).executionHome()!, "auth.json");
      const auth = JSON.parse(readFileSync(path, "utf8")); delete auth.tokens.id_token; writeFileSync(path, JSON.stringify(auth));
    }
    expect(await accounts.list()).toHaveLength(2);
  });
  it("waits until running work finishes before consolidating credentials", async () => {
    authorize("default", "workspace-a");
    const duplicate = accounts.add("OpenAI"); authorize(duplicate.id, "workspace-a");
    accounts.active.set("default", 1);
    expect(await accounts.list()).toHaveLength(2);
    accounts.active.set("default", 0);
    expect(await accounts.list()).toHaveLength(1);
  });
  it("waits for an in-flight token renewal before handing credentials to the retained account", async () => {
    authorize("default", "workspace-a");
    const duplicate = accounts.add("OpenAI"); authorize(duplicate.id, "workspace-a");
    const source = accounts.get(duplicate.id), path = join(source.executionHome()!, "auth.json");
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    wire.request.mockImplementationOnce(async () => {
      await gate;
      const auth = JSON.parse(readFileSync(path, "utf8")); auth.tokens.access_token = "renewed-in-flight";
      writeFileSync(path, JSON.stringify(auth));
      return { account: { type: "chatgpt", email: "person@example.invalid", planType: "plus" } };
    });
    const refreshing = source.authTokens(true);
    await vi.waitFor(() => expect(wire.request).toHaveBeenCalledOnce());
    const listing = accounts.list();
    finish(); await refreshing; await listing;
    expect(JSON.parse(readFileSync(join(root, ".data/codex/auth.json"), "utf8")).tokens.access_token).toBe("renewed-in-flight");
    expect(source.executionHome()).toBeUndefined();
  });
  it("keeps a completed login poll valid after another client merged its temporary slot", async () => {
    authorize("default", "workspace-a");
    const duplicate = accounts.add("OpenAI"); authorize(duplicate.id, "workspace-a");
    vi.spyOn(accounts.get(duplicate.id), "status").mockResolvedValue({ loginId: "same-login", status: "completed" });
    await accounts.list();
    expect(await accounts.loginStatus(duplicate.id, "same-login")).toMatchObject({ status: "completed", accountId: "default", alreadyConnected: true, account: { connected: true } });
    expect(await accounts.loginStatus(duplicate.id, "same-login")).toMatchObject({ status: "completed", alreadyConnected: true });
  });
  it("returns the current catalogue if an account is renamed while balances load", async () => {
    authorize("default", "workspace-a");
    let finish!: (value: any) => void;
    vi.spyOn(accounts.get("default"), "usage").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const listing = accounts.list();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    accounts.rename("default", "New name");
    finish({ checkedAt: "now", windows: [], ordinaryUsageAllowed: null });
    expect((await listing)[0]?.displayName).toBe("New name");
  });
  it("preserves all five identities through a provider outage and recovers without another sign-in", async () => {
    const ids = ["default", ...Array.from({ length: 4 }, () => accounts.add("OpenAI").id)];
    ids.forEach((id, index) => authorize(id, `workspace-${index}`));
    await accounts.list();
    wire.request.mockRejectedValue(new Error("connection timed out"));
    const unavailable = await accounts.list(true);
    expect(unavailable).toHaveLength(5);
    expect(unavailable.every(entry => entry.account.email === "person@example.invalid" && entry.account.issue === "unavailable")).toBe(true);
    wire.request.mockResolvedValue({ account: { type: "chatgpt", email: "person@example.invalid", planType: "plus" }, rateLimits: {} });
    expect((await accounts.list(true)).every(entry => entry.account.connected)).toBe(true);
  });
  it("renames an account without changing identity, credentials or priority", async () => {
    authorize("default", "workspace-a");
    const before = readFileSync(join(root, ".data/codex/auth.json"));
    accounts.rename("default", "  My studio  ");
    expect((await accounts.list())[0]).toMatchObject({ id: "default", displayName: "My studio" });
    expect(readFileSync(join(root, ".data/codex/auth.json"))).toEqual(before);
    expect(() => accounts.rename("default", "   ")).toThrow();
    expect(() => accounts.rename("default", "x".repeat(81))).toThrow();
  });
});
