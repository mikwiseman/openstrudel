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
            expect(Object.values(server?.tools ?? {}).some((t: any)=>t.name === "read_model_settings")).toBe(true);
            const result = await original("mcpServer/tool/call",{threadId:params.threadId,server:"openstrudel_runtime",tool:"read_model_settings",arguments:{}});
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
