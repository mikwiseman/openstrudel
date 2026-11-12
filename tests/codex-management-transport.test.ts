import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep the real protocol, config parser, thread persistence and MCP transport.
// Only model inference is replaced, so this test uses no account or API credits.
vi.mock("../src/rpc.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/rpc.js")>();
  return { ...actual, CodexRpc: class extends actual.CodexRpc {
    constructor(...args: ConstructorParameters<typeof actual.CodexRpc>) {
      super(...args);
      const original = this.request.bind(this), notify = args[1];
      let management = false;
      this.request = async (method: string, params?: any, timeout?: number): Promise<any> => {
        if (method === "model/list") return { data: [] };
        if (method === "thread/start" || method === "thread/resume") management = params.config?.["mcp_servers.openstrudel_runtime"]?.enabled === true;
        if (method === "turn/start") {
          const inventory = await original("mcpServerStatus/list",{threadId:params.threadId});
          const server = inventory.data.find((s: any)=>s.name === "openstrudel_runtime");
          if (management) {
            for (const name of served) expect(Object.values(server?.tools ?? {}).some((t: any)=>t.name === name), name).toBe(true);
            const result = await original("mcpServer/tool/call",{threadId:params.threadId,server:"openstrudel_runtime",tool:served[0],arguments:{}});
            expect(JSON.stringify(result)).toContain("fixture");
          } else expect(server).toMatchObject({runtimeStatus:"disabled",tools:{}});
          await original("thread/inject_items", {threadId:params.threadId,items:[{type:"message",role:"assistant",content:[{type:"output_text",text:"Fixture, no inference"}]}]});
          queueMicrotask(()=>notify?.({method:"turn/completed",params:{threadId:params.threadId,turn:{status:"completed"}}}));
          return { turn:{id:"fixture"} };
        }
        return original(method,params,timeout);
      };
    }
  } };
});

import { CodexEngineAdapter } from "../src/codex.js";

/** The Home tools the turn under test must find on its bridge; the first one is called. */
let served = ["read_model_settings"];

it("starts ordinary chats and resumes them across management grant and revocation using real Codex", async () => {
  const root = mkdtempSync(join(tmpdir(), "strudel-management-transport-"));
  const engine = new CodexEngineAdapter({codexHome:join(root,"codex"),workingDirectory:root});
  try {
    const ordinary = await engine.run("Ordinary participant",{access:false});
    expect(ordinary.threadId).toBeTruthy();
    const call = vi.fn(async()=>({fixture:true}));
    const tools = {definitions:[{type:"function" as const,name:"read_model_settings",description:"Fixture",inputSchema:{type:"object",properties:{}}}],call};
    const managed = await engine.run("Administrator",{threadId:ordinary.threadId,access:true,tools});
    expect(managed.threadId).toBe(ordinary.threadId);
    await engine.run("Next administrator request",{threadId:managed.threadId,access:true,tools});
    expect(call).toHaveBeenCalledTimes(2);
    const revoked = await engine.run("Access revoked",{threadId:managed.threadId,access:false});
    expect(revoked.threadId).toBe(ordinary.threadId);
  } finally { engine.close(); await engine.settled(); rmSync(root,{recursive:true,force:true}); }
}, 30_000);

it("gives a chat that began before cards existed the card tools on its next turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "strudel-card-transport-"));
  const engine = new CodexEngineAdapter({codexHome:join(root,"codex"),workingDirectory:root});
  served = ["raise_card", "close_card"];
  try {
    // The thread starts with no Home tools at all, as a chat from before this release did.
    const before = await engine.run("An older chat",{access:true});
    const call = vi.fn(async()=>({fixture:true}));
    const tool = (name: string) => ({type:"function" as const,name,description:"Fixture",inputSchema:{type:"object",properties:{}}});
    const after = await engine.run("The same chat today",{threadId:before.threadId,access:true,tools:{definitions:[tool("raise_card"),tool("close_card")],call}});
    expect(after.threadId).toBe(before.threadId);
    expect(call).toHaveBeenCalledWith("raise_card",{});
  } finally { served = ["read_model_settings"]; engine.close(); await engine.settled(); rmSync(root,{recursive:true,force:true}); }
}, 30_000);
