import { afterEach, expect, it, vi } from "vitest";
const wire=vi.hoisted(()=>({request:vi.fn(),notify:undefined as undefined|((message:any)=>void)}));
vi.mock("../src/rpc.js",()=>({CodexRpc:class {
  closed=false; exited=Promise.resolve(); request=wire.request;
  constructor(_home:unknown,notify:(message:any)=>void){wire.notify=notify;}
  initialize=async()=>undefined;
  close(){this.closed=true;}
}}));
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexEngineAdapter } from "../src/codex.js";
const roots:string[]=[];
afterEach(()=>{wire.request.mockReset();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"codex-projects-"))); roots.push(root);
  const workspace=join(root,"audience"),source=join(root,"source"),metadata=join(source,".git"),readable=join(root,"knowledge");
  for(const path of [workspace,metadata,readable])mkdirSync(path,{recursive:true});
  const config={default_permissions:"openstrudel",permissions:{openstrudel:{filesystem:{":minimal":"read",[workspace]:"write"},network:{enabled:false}}}};
  const engine=new CodexEngineAdapter({workingDirectory:workspace,config,scoped:true});
  wire.request.mockImplementation(async(method:string,params:any)=>{
    if(method==="configRequirements/read")return{requirements:null};
    if(method==="model/list")return{data:[]};
    if(method==="thread/start"||method==="thread/resume")return{thread:{id:"preserved-history"}};
    if(method==="thread/unsubscribe"||method==="thread/inject_items")return{};
    if(method==="turn/start"){
      queueMicrotask(()=>wire.notify?.({method:"turn/completed",params:{threadId:params.threadId,turn:{status:"completed"}}}));
      return{turn:{id:"native-turn"}};
    }
    throw Error(method);
  });
  const project={id:"trusted",name:"Source",revision:1,cwd:source,gitDirectory:metadata};
  return{root,workspace,source,metadata,readable,engine,project};
}

it("sets native cwd and only the registered checkout, Git metadata and existing audience permissions",async()=>{
  const f=fixture();
  try {
    await f.engine.run("Improve",{project:f.project,byOwner:true,access:true,readPaths:[f.readable]});
    const params=wire.request.mock.calls.find(([m])=>m==="thread/start")![1];
    expect(params.cwd).toBe(f.source); expect(params.sandbox).toBeUndefined();
    expect(params.config.permissions.openstrudel.filesystem).toEqual({":minimal":"read",[f.workspace]:"write",[f.source]:"write",[f.metadata]:"write",[f.readable]:"read"});
    expect(params.config.permissions.openstrudel.network.enabled).toBe(false);
    expect(Object.keys(params.config).some(key=>key.startsWith("permissions."))).toBe(false);
    expect(params.developerInstructions).toContain("Do not restart or replace the Home executing this active turn");
    expect(params.approvalPolicy).toBe("on-request");
  }finally{f.engine.close();}
});

it("resumes the same native history with new identity on revision, then removes checkout permissions when disconnected",async()=>{
  const f=fixture();
  try {
    const first=await f.engine.run("First",{project:f.project,byOwner:true});
    await f.engine.run("Next",{threadId:first.threadId,project:{...f.project,revision:2},byOwner:true});
    expect(wire.request.mock.calls.filter(([m])=>m==="thread/start")).toHaveLength(1);
    expect(wire.request.mock.calls.filter(([m])=>m==="thread/unsubscribe")).toHaveLength(1);
    const updated=wire.request.mock.calls.find(([m])=>m==="thread/inject_items")![1];
    expect(updated.threadId).toBe(first.threadId); expect(JSON.stringify(updated.items)).toContain('\\"revision\\":2');
    await f.engine.run("Disconnected",{threadId:first.threadId,byOwner:true});
    const resumed=wire.request.mock.calls.filter(([m])=>m==="thread/resume").at(-1)![1];
    expect(resumed.cwd).toBe(f.workspace);
    expect(resumed.config["permissions.openstrudel.filesystem"]).toEqual({":minimal":"read",[f.workspace]:"write"});
    expect(resumed.developerInstructions).not.toContain("Owner-approved source project");
  }finally{f.engine.close();}
});

it.each([{byOwner:false},{byOwner:true,groupContext:true},{byOwner:true,groupChat:true},{byOwner:true,scheduled:true},{byOwner:true,access:false}])("refuses an invalid project grant before talking to Codex: %j",async(options)=>{
  const f=fixture();
  try { await expect(f.engine.run("Improve",{project:f.project,...options})).rejects.toThrow("private interactive"); expect(wire.request).not.toHaveBeenCalled(); }
  finally{f.engine.close();}
});
