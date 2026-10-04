import { afterEach, expect, it, vi } from "vitest";
const wire = vi.hoisted(() => ({ request: vi.fn(), onRequest: undefined as undefined | ((method: string, params: any) => Promise<any>) }));
vi.mock("../src/rpc.js", () => ({ CodexRpc: class {
  closed = false;
  constructor(_home: unknown, _notify: unknown, request: typeof wire.onRequest) { wire.onRequest = request; }
  initialize = async () => undefined;
  request = wire.request;
  close() { this.closed = true; }
} }));
import { CodexEngineAdapter } from "../src/codex.js";
afterEach(() => { wire.request.mockReset(); wire.onRequest = undefined; });

it("uses the Home's access token and delegates refresh back to that same Home", async () => {
  wire.request.mockImplementation(async (method: string) => {
    if (method === "account/login/start") return {};
    if (method === "app/installed") return { apps: [] };
    if (method === "app/list" || method === "mcpServerStatus/list") return { data: [], nextCursor: null };
    throw new Error(method);
  });
  const authTokens = vi.fn(async (refresh?: boolean) => ({ accessToken: refresh ? "renewed-access" : "initial-access", chatgptAccountId: "same-owner", chatgptPlanType: "plus" }));
  const engine = new CodexEngineAdapter({ authTokens });
  try {
    await engine.connections();
    expect(wire.request.mock.calls[0]).toEqual(["account/login/start", { type: "chatgptAuthTokens", accessToken: "initial-access", chatgptAccountId: "same-owner", chatgptPlanType: "plus" }]);
    expect(await wire.onRequest!("account/chatgptAuthTokens/refresh", { reason: "unauthorized" })).toEqual({ accessToken: "renewed-access", chatgptAccountId: "same-owner", chatgptPlanType: "plus" });
    expect(authTokens).toHaveBeenLastCalledWith(true);
    expect(JSON.stringify(wire.request.mock.calls)).not.toContain("refresh_token");
  } finally { engine.close(); }
});
