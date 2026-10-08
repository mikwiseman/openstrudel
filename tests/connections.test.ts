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
it("keeps installed apps available when the public app catalog fails", async () => {
  let granted = false;
  request.mockImplementation(async (method: string) => {
    if (method === "app/installed") return { apps: [{id: "calendar", runtimeName: "Google Calendar", enabled: granted, callable: granted}] };
    if (method === "app/list") throw new Error("403 catalog unavailable");
    if (method === "mcpServerStatus/list") return {data: []};
    if (method === "config/value/write") { granted = true; return {}; }
    throw new Error(method);
  });
  const engine = new CodexEngineAdapter({scoped:true});
  try {
    expect(await engine.connections()).toEqual([{id:"calendar",name:"Google Calendar",kind:"app",connected:false,url:null}]);
    expect(await engine.connect("calendar")).toEqual({url:null});
    expect(await engine.isConnected("calendar")).toBe(true);
  } finally {engine.close();}
});
it("bounds directory checks and discovers native connections concurrently", async () => {
  let finish!: (value: unknown) => void;
  request.mockImplementation(async (method: string) => {
    if (method === "app/installed") return new Promise(resolve => finish = resolve);
    if (method === "app/list") return { data: [] };
    if (method === "mcpServerStatus/list") return { data: [] };
    throw new Error(method);
  });
  const engine = new CodexEngineAdapter();
  const pending = engine.connections();
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("mcpServerStatus/list", expect.anything(), 12_000));
  } finally { finish({ apps: [] }); await pending; engine.close(); }
});
it("keeps working native integrations visible when the OpenAI app directory is unavailable", async () => {
  request.mockImplementation(async (method: string) => {
    if (method === "app/installed") return {apps: []};
    if (method === "app/list") throw new Error("403 Forbidden: <html>provider challenge</html>");
    if (method === "mcpServerStatus/list") return {data:[{name:"wai_personal",tools:{find:{name:"find"}},authStatus:"unsupported"}]};
    throw new Error(method);
  });
  const engine = new CodexEngineAdapter();
  try { expect(await engine.connections(true)).toEqual([{id:"mcp:wai_personal",name:"WAI",detail:"Личные документы",kind:"mcp",connected:true,url:null,status:"ready",toolCount:1,removable:false}]); }
  finally { engine.close(); }
});
