import { afterEach, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../src/rpc.js", () => ({ CodexRpc: class {
  closed = false;
  initialize = async () => undefined;
  request = request;
  close() { this.closed = true; }
} }));
import { CodexEngineAdapter } from "../src/codex.js";
afterEach(() => request.mockReset());
it("keeps working native integrations visible when the OpenAI app directory is unavailable", async () => {
  request.mockImplementation(async (method: string) => {
    if (method === "app/installed") return {apps: []};
    if (method === "app/list") throw new Error("403 Forbidden: <html>provider challenge</html>");
    if (method === "mcpServerStatus/list") return {data:[{name:"wai_personal",tools:{find:{name:"find"}},authStatus:"unsupported"}]};
    throw new Error(method);
  });
  const engine = new CodexEngineAdapter();
  try { expect(await engine.connections(true)).toEqual([{id:"mcp:wai_personal",name:"WAI",detail:"Личные документы",kind:"mcp",connected:true,url:null}]); }
  finally { engine.close(); }
});
