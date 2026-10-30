import { afterEach, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../src/rpc.js", () => ({ CodexRpc: class {
  closed = false;
  exited = Promise.resolve();
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
    expect(await engine.connections()).toEqual([{id:"calendar",name:"Google Calendar",kind:"app",connected:false,url:null,status:"available"}]);
    expect(await engine.connect("calendar")).toEqual({url:null});
    expect(await engine.isConnected("calendar")).toBe(true);
  } finally {engine.close();}
});
it("does not mistake a failed installed-app check for a missing connection or grant access",async()=>{
  let failed=false;
  request.mockImplementation(async(method:string)=>{
    if(method==="app/installed"){if(failed)throw new Error("timeout");return {apps:[{id:"calendar",runtimeName:"Google Calendar",enabled:true,callable:true}]};}
    if(method==="app/list")return {data:[{id:"calendar",name:"Google Calendar",installUrl:"https://example.test/oauth"}]};
    if(method==="mcpServerStatus/list")return {data:[]};
    throw new Error(method);
  });
  const engine=new CodexEngineAdapter();
  try {
    expect((await engine.connections())[0]).toMatchObject({connected:true,status:"ready"});
    failed=true;
    expect((await engine.connections(true))[0]).toMatchObject({connected:false,status:"unknown"});
    await expect(engine.connect("calendar")).rejects.toThrow("Не удалось проверить подключение");
    expect(request.mock.calls.some(([method])=>method==="config/value/write")).toBe(false);
  }finally{engine.close();}
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
it("never waits for a slow app directory and reuses the Home's copy once it arrives", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "strudel-catalog-")), catalogPath = join(root, "app-catalog.json");
  let deliver!: (value: unknown) => void;
  request.mockImplementation(async (method: string) => {
    if (method === "app/installed") return { apps: [{ id: "calendar", runtimeName: "Google Calendar", enabled: true, callable: true }] };
    if (method === "app/list") return new Promise(resolve => deliver = resolve);
    if (method === "mcpServerStatus/list") return { data: [] };
    throw new Error(method);
  });
  const engine = new CodexEngineAdapter({ catalogPath }), later = new CodexEngineAdapter({ catalogPath });
  try {
    const started = Date.now();
    expect((await engine.connections()).map(c => c.id)).toEqual(["calendar"]);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(engine.connectionNotice).toBeUndefined();
    deliver({ data: [{ id: "gmail", name: "Gmail", installUrl: "https://example.test/gmail" }], nextCursor: null });
    await vi.waitFor(() => expect(request.mock.calls.filter(([m]) => m === "app/list")).toHaveLength(1));
    await vi.waitFor(async () => expect((await later.connections(true)).find(c => c.id === "gmail")).toMatchObject({ status: "sign_in", url: "https://example.test/gmail" }));
    // The second runtime used the saved copy instead of downloading the directory again.
    expect(request.mock.calls.filter(([m]) => m === "app/list")).toHaveLength(1);
  } finally { engine.close(); later.close(); rmSync(root, { recursive: true, force: true }); }
});
