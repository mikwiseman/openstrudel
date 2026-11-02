import { expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real pinned Codex config parsing, permission grants and persisted threads.
// Replace only inference: no account, network request to a model or API credits.
vi.mock("../src/rpc.js",async importOriginal=>{
  const actual=await importOriginal<typeof import("../src/rpc.js")>();
  return{...actual,CodexRpc:class extends actual.CodexRpc {
    constructor(...args:ConstructorParameters<typeof actual.CodexRpc>){
      super(...args); const original=this.request.bind(this),notify=args[1];
      this.request=async(method:string,params?:any,timeout?:number):Promise<any>=>{
        if(method==="model/list")return{data:[]};
        if(method==="thread/start"||method==="thread/resume"){
          const result=await original(method,params,timeout);
          expect(result.thread.cwd).toBe(params.cwd);
          expect(result.sandbox).toMatchObject({type:"workspaceWrite",networkAccess:false});
          // Codex grants cwd implicitly; these are its actual additional write roots.
          if(params.cwd.endsWith("/source")) expect(result.sandbox.writableRoots).toEqual(expect.arrayContaining([join(params.cwd,".git"),join(params.cwd,"../audience")]));
          else expect(result.sandbox.writableRoots).toEqual([]);
          return result;
        }
        if(method==="turn/start"){
          await original("thread/inject_items",{threadId:params.threadId,items:[{type:"message",role:"assistant",content:[{type:"output_text",text:"Protocol fixture"}]}]});
          queueMicrotask(()=>notify?.({method:"turn/completed",params:{threadId:params.threadId,turn:{status:"completed"}}}));
          return{turn:{id:"fixture"}};
        }
        return original(method,params,timeout);
      };
    }
  }};
});
import { CodexEngineAdapter } from "../src/codex.js";

it("accepts project permissions and cwd with the actual pinned Codex app-server, including revision and revocation",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"project-protocol-"))),workspace=join(root,"audience"),source=join(root,"source"),metadata=join(source,".git");
  mkdirSync(workspace);mkdirSync(metadata,{recursive:true});
  const engine=new CodexEngineAdapter({codexHome:join(root,"codex"),workingDirectory:workspace,scoped:true,
    config:{default_permissions:"openstrudel",permissions:{openstrudel:{filesystem:{":minimal":"read",[workspace]:"write"},network:{enabled:false}}}}});
  const project={id:"fixture",name:"Fixture",revision:1,cwd:source,gitDirectory:metadata};
  try {
    const first=await engine.run("Project",{project,byOwner:true});
    expect(first.threadId).toBeTruthy();
    const revised=await engine.run("Revision",{threadId:first.threadId,project:{...project,revision:2},byOwner:true});
    expect(revised.threadId).toBe(first.threadId);
    const revoked=await engine.run("Normal workspace",{threadId:first.threadId,byOwner:true});
    expect(revoked.threadId).toBe(first.threadId);
  }finally{engine.close();await engine.settled();rmSync(root,{recursive:true,force:true});}
},30_000);
