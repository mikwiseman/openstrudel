import { expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { stringify } from "smol-toml";
const transport=vi.hoisted(()=>({check:undefined as undefined|((params:any)=>void)}));

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
          transport.check?.(params);
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

// Fresh processes exercise app-server configuration independently; ancestor/dotted key overlap was nondeterministic.
it.each([1, 2, 3])("accepts project permissions, revision and revocation in fresh pinned Codex process %i",async()=>{
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

// Exercise the same emitted profile with the pinned CLI's real OS sandbox too:
// the legacy app-server response reports write roots, but omits readable roots.
const inlineToml=(value:unknown):string=>value && typeof value==="object"
  ? Array.isArray(value) ? `[${value.map(inlineToml).join(",")}]`
    : `{${Object.entries(value).map(([key,item])=>`${JSON.stringify(key)}=${inlineToml(item)}`).join(",")}}`
  : JSON.stringify(value);

it.each([1,2,3])("enforces read-only owner and approved scheduled sources, revoking source and guest-memory access with pinned Codex %i",async()=>{
  // Keep CODEX_HOME out of the OS temp root (native helper aliases), and the
  // fixture outside this repository so its ancestor AGENTS.md is not imported.
  const root=realpathSync(mkdtempSync(join(homedir(),".openstrudel-source-protocol-"))),workspace=join(root,"audience"),source=join(root,"knowledge"),home=join(root,"codex"),memories=join(home,"memories");
  for(const path of [workspace,source,memories])mkdirSync(path,{recursive:true});
  const sourceFile=join(source,"source.txt"),memoryFile=join(memories,"memory.txt"),written=join(workspace,"written.txt");
  writeFileSync(sourceFile,"owner-source-marker");writeFileSync(memoryFile,"owner-memory-marker");
  const config={default_permissions:"openstrudel",permissions:{openstrudel:{filesystem:{":minimal":"read",[workspace]:"write",[memories]:"read"},network:{enabled:false}},other:{filesystem:{":minimal":"read"}}}};
  writeFileSync(join(home,"config.toml"),stringify(config));
  const cli=join(dirname(createRequire(import.meta.url).resolve("@openai/codex/package.json")),"bin/codex.js");
  let sourceAllowed=true,memoryAllowed=true,checks=0;
  transport.check=params=>{
    const run=(command:string[])=>spawnSync(process.execPath,[cli,"-c",`permissions=${inlineToml(params.config.permissions)}`,"sandbox","-P","openstrudel","-C",workspace,"--",...command],{
      env:{HOME:workspace,CODEX_HOME:home,PATH:process.env.PATH},encoding:"utf8",timeout:20_000,
    });
    for(const [file,marker,allowed] of [[sourceFile,"owner-source-marker",sourceAllowed],[memoryFile,"owner-memory-marker",memoryAllowed]] as const){
      const read=run(["/bin/cat",file]);
      if(allowed){expect(read.status,read.stderr).toBe(0);expect(read.stdout).toBe(marker);}
      else{expect(read.status,read.stderr).not.toBe(0);expect(read.stdout).not.toContain(marker);expect(read.stderr).toMatch(/Operation not permitted|Permission denied/i);}
    }
    if(sourceAllowed){
      const denied=run(["/bin/sh","-c",'printf changed > "$1"',"fixture",sourceFile]);
      expect(denied.status,denied.stderr).not.toBe(0);expect(readFileSync(sourceFile,"utf8")).toBe("owner-source-marker");
    }
    const write=run(["/bin/sh","-c",'printf workspace-write > "$1"',"fixture",written]);
    expect(write.status,write.stderr).toBe(0);expect(readFileSync(written,"utf8")).toBe("workspace-write");
    checks++;
  };
  const engine=new CodexEngineAdapter({codexHome:home,workingDirectory:workspace,scoped:true,config});
  try{
    const first=await engine.run("Read source",{byOwner:true,access:true,readPaths:[source]});
    sourceAllowed=false;
    const revoked=await engine.run("Unapproved schedule",{threadId:first.threadId,byOwner:true,scheduled:true,access:true,readPaths:[source]});
    expect(revoked.threadId).toBe(first.threadId);
    sourceAllowed=true;
    const approved=await engine.run("Approved private brief",{threadId:first.threadId,byOwner:false,scheduled:true,privateSourceAccess:true,access:true,readPaths:[source]});
    expect(approved.threadId).toBe(first.threadId);
    sourceAllowed=false;
    memoryAllowed=false;
    const guest=await engine.run("Guest",{threadId:first.threadId,byOwner:true,scheduled:true,privateSourceAccess:true,access:false,readPaths:[source,memories]});
    expect(guest.threadId).toBe(first.threadId);expect(checks).toBe(4);
  }finally{transport.check=undefined;engine.close();await engine.settled();rmSync(root,{recursive:true,force:true});}
},45_000);
