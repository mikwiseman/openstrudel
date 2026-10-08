import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { CodexAccountService } from "../src/account.js";
const engines = vi.hoisted(() => ({ run: vi.fn(), closed: [] as string[] }));
vi.mock("../src/scopes.js", () => ({ ScopedCodexEngine: class {
  constructor(_root: string, readonly account: string) {}
  forContext(context: string) { return { run: (input: string, options: any) => engines.run(this.account, context, input, options), connections: async () => [this.account] }; }
  close() { engines.closed.push(this.account); }
} }));
import { Accounts, AccountEngines } from "../src/accounts.js";
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks(); engines.run.mockReset(); engines.closed.length = 0; });
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const primary = new CodexAccountService(store, "/unused-test"); const accounts = new Accounts(store, "/unused-test", primary);
  const second = accounts.add("Other").id;
  for (const id of ["default", second]) {
    vi.spyOn(accounts.get(id), "read").mockResolvedValue({ connected: true, email: id + "@example.invalid", planType: "plus", managed: true });
    vi.spyOn(accounts.get(id), "usage").mockResolvedValue({ checkedAt: new Date().toISOString(), ordinaryUsageAllowed: true, windows: [] });
    vi.spyOn(accounts.get(id), "executionHome").mockReturnValue(id);
  }
  return { store, accounts, second, pool: new AccountEngines(accounts) };
}
describe("per-device Codex subscriptions", () => {
  it("does not wait for quota checks to open service settings", async () => {
    const { accounts, pool } = fixture();
    expect(await pool.forAgent("main", "personal").connections!()).toEqual(["default"]);
    expect(accounts.get("default").usage).not.toHaveBeenCalled();
  });
  it("uses ordered allowed accounts and backend quota permission without inferring permission from percentages", async () => {
    const { accounts, second } = fixture();
    vi.mocked(accounts.get("default").usage).mockResolvedValue({ checkedAt: "now", ordinaryUsageAllowed: false, windows: [] });
    expect((await accounts.choose("main")).id).toBe(second);
    accounts.setPolicy("main", ["default"]); await expect(accounts.choose("main")).rejects.toMatchObject({ reason: "limits" });
    vi.mocked(accounts.get("default").usage).mockResolvedValue({ checkedAt: "now", ordinaryUsageAllowed: null, windows: [{ name: "unknown", usedPercent: 100, remainingPercent: 0, windowDurationMins: 1, resetsAt: 0 }] });
    expect((await accounts.choose("main")).id).toBe("default");
  });
  it("keeps one account for a running turn and never retries tool effects through another account", async () => {
    const { accounts, second, pool } = fixture();
    let finish!: () => void; const gate = new Promise<void>(resolve => finish = resolve);
    engines.run.mockImplementation(async (account: string) => { await gate; throw new Error("connection failed after an external action"); });
    const pending = pool.forAgent("main", "personal").run("perform action");
    await vi.waitFor(() => expect(accounts.active.get("default")).toBe(1));
    expect(() => accounts.assertIdle("default")).toThrow("выполняет поручение");
    accounts.prioritize(second); finish(); await expect(pending).rejects.toThrow("external action");
    expect(engines.run).toHaveBeenCalledTimes(1); expect(engines.run.mock.calls[0]?.[0]).toBe("default");
    expect((await accounts.choose("main")).id).toBe(second);
  });
  it("separates thread IDs and restores each account's own conversation", async () => {
    const { store, accounts, second, pool } = fixture(), conversation = store.primaryConversation();
    store.addMessage({ channel: "api", conversationId: conversation.id, direction: "outbound", text: "Remember this context" });
    engines.run.mockImplementation(async (account, _context, _input, options) => ({ threadId: account + "-thread", response: "ok", events: [] }));
    await pool.run("one", { conversationId: conversation.id });
    accounts.prioritize(second); await pool.run("two", { conversationId: conversation.id, threadId: "default-thread" });
    expect(engines.run.mock.calls[1]?.[3].threadId).toBeUndefined(); expect(engines.run.mock.calls[1]?.[2]).toContain("Remember this context");
    accounts.prioritize("default"); await pool.run("three", { conversationId: conversation.id, threadId: second + "-thread" });
    expect(engines.run.mock.calls[2]?.[3].threadId).toBe("default-thread");
  });
  it("blocks account maintenance during a turn and avoids choosing an account being logged out", async () => {
    const { accounts, second } = fixture(); let done!: () => void;
    const maintenance = accounts.withIdle("default", () => new Promise<void>(resolve => done = resolve));
    expect((await accounts.choose("main")).id).toBe(second);
    await expect(accounts.withIdle("default", async () => {})).rejects.toThrow("обновляется"); done(); await maintenance;
    expect((await accounts.choose("main")).id).toBe("default");
  });
  it("does not treat an OpenAI outage as an invitation to cycle accounts", async () => {
    const { accounts, second } = fixture();
    vi.mocked(accounts.get("default").read).mockResolvedValue({ connected: false, email: null, planType: null, managed: true, issue: "unavailable" });
    await expect(accounts.choose("main")).rejects.toThrow("пока не отвечает");
    expect(accounts.get(second).read).not.toHaveBeenCalled();
  });
  it("distinguishes missing login from exhausted limits", async () => {
    const { accounts, second } = fixture();
    for (const id of ["default", second]) vi.mocked(accounts.get(id).read).mockResolvedValue({ connected: false, email: null, planType: null, managed: false });
    await expect(accounts.choose("main")).rejects.toMatchObject({ reason: "sign_in_required" });
  });
});
