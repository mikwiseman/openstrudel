import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexExtensions, previewExtension, readToml, beginExtensionRun, type ExtensionFile } from "../src/extensions.js";
import { readExtensionBundle } from "../src/extension-bundle.js";
import { CodexRpc } from "../src/rpc.js";
import { ScopedCodexEngine } from "../src/scopes.js";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const file=(path:string,text:string):ExtensionFile=>({path,contentBase64:Buffer.from(text).toString("base64")});
const skill=[file("SKILL.md","---\nname: concise-replies\ndescription: >-\n  Short, clear replies.\n  Keep facts exact.\n---\nAnswer briefly.\n")];
function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"strudel-extensions-"))); roots.push(root);
  const home=join(root,"codex"),cwd=join(root,"workspace");
  mkdirSync(home);mkdirSync(cwd);
  writeFileSync(join(home,"config.toml"),'[features]\nplugins = true\nremote_plugin = false\napps = false\n');
  return {root,home,cwd};
}

it("previews folded skill descriptions and rejects traversal, conflicting names and modified packages",()=>{
  expect(previewExtension(skill)).toMatchObject({kind:"skill",name:"concise-replies",description:"Short, clear replies. Keep facts exact."});
  for(const path of ["../auth.json","/tmp/file","a/../../b",".git/config","a\\file",".openstrudel-package.json"]) expect(()=>previewExtension([...skill,file(path,"x")])).toThrow();
  expect(()=>previewExtension([...skill,file("skill.md","different")])).toThrow(/повторяются/);
  expect(previewExtension(skill).digest).not.toBe(previewExtension([{...skill[0]!,executable:true}]).digest);
});

it("bounds package contents and refuses symlinks without reading their targets",async()=>{
  const {root}=fixture();const path=join(root,"package");mkdirSync(path);
  writeFileSync(join(path,"SKILL.md"),Buffer.from(skill[0]!.contentBase64,"base64"));
  symlinkSync(join(root,"outside-secret"),join(path,"secret"));
  await expect(readExtensionBundle(path)).rejects.toThrow(/ссылка/);
  expect(()=>previewExtension([...skill,file("large.txt","x".repeat(10*1024*1024))])).toThrow(/10 МБ/);
});

it("previews a plugin's referenced MCP file and rejects manifest paths outside the reviewed package",()=>{
  const manifest=(extra:object)=>file(".codex-plugin/plugin.json",JSON.stringify({name:"docs",...extra}));
  const mcp=file("config/services.json",JSON.stringify({mcpServers:{docs:{url:"https://docs.example/mcp"}}}));
  expect(previewExtension([manifest({mcpServers:"./config/services.json"}),mcp]).services).toEqual(["docs · docs.example"]);
  for(const path of ["/etc/config","./../../secrets","./config/../private","..\\private"]) {
    expect(()=>previewExtension([manifest({skills:path})])).toThrow(/внутри/);
  }
});

it("keeps MCP credentials private, persists explicit config, blocks built-ins and rolls back failed reloads",async()=>{
  const {home,cwd}=fixture(),rpc={request:vi.fn(async()=>({}))},changed=vi.fn(async()=>{});
  const manager=new CodexExtensions({home,cwd,client:async()=>rpc as unknown as CodexRpc,changed,idle:()=>true,reservedServers:["company"]});
  await expect(manager.addMcp({name:"company",url:"https://example.com/mcp"})).rejects.toThrow(/управляется/);
  for(const url of ["http://public.test/mcp","https://name:password@example.com/mcp","https://example.com/mcp#secret"]) await expect(manager.addMcp({name:"sample",url})).rejects.toThrow();
  const result=await manager.addMcp({name:"sample",url:"https://example.com/mcp",token:"test-key"});
  expect(JSON.stringify(result)).not.toContain("test-key");
  expect(readToml(join(home,"openstrudel-extensions.toml")).mcp_servers.sample.http_headers.Authorization).toBe("Bearer test-key");
  expect(statSync(join(home,"config.toml")).mode & 0o777).toBe(0o600);
  changed.mockRejectedValueOnce(new Error("reload failed"));
  await expect(manager.removeMcp("sample")).rejects.toThrow("reload failed");
  expect(readToml(join(home,"config.toml")).mcp_servers.sample).toBeDefined();
  await manager.removeMcp("sample");
  expect(readToml(join(home,"openstrudel-extensions.toml")).mcp_servers).toBeUndefined();
});

it("preserves employee extensions across scoped restarts and isolates another audience",()=>{
  const {root,home}=fixture(),source=join(root,"source");mkdirSync(source);
  const scoped=new ScopedCodexEngine(root,source);
  scoped.forContext("personal");
  const personal=join(root,".data/contexts/personal");
  writeFileSync(join(personal,"openstrudel-extensions.toml"),'[mcp_servers.mine]\nurl = "https://example.com/mcp"\n[plugins."recipe@openstrudel-local"]\nenabled = true\n');
  scoped.close(); scoped.forContext("personal");scoped.forContext("work");
  expect(readToml(join(personal,"config.toml")).mcp_servers.mine.url).toBe("https://example.com/mcp");
  expect(readToml(join(root,".data/contexts/work/config.toml")).mcp_servers.mine).toBeUndefined();
  expect(readToml(join(personal,"config.toml")).features.remote_plugin).toBe(false);
  const shared=join(root,".data/extensions/personal/config.toml");mkdirSync(join(shared,".."),{recursive:true});
  writeFileSync(shared,'[mcp_servers.shared]\nurl = "https://shared.example/mcp"\n');
  scoped.forContext("personal");
  expect(readToml(join(personal,"config.toml")).mcp_servers.shared).toBeDefined();
  const second=new ScopedCodexEngine(root,source,undefined,join(root,"second-account"));second.forContext("personal");
  expect(readToml(join(root,"second-account/personal/config.toml")).mcp_servers.shared).toBeDefined();
  second.close();
  scoped.close();
});

it("installs, disables, reloads and removes a real Codex skill and local plugin",async()=>{
  const {home,cwd}=fixture();const rpc=new CodexRpc(home,undefined,undefined,undefined,cwd);await rpc.initialize();
  const manager=new CodexExtensions({home,cwd,client:async()=>rpc,changed:async()=>{await rpc.request("config/mcpServer/reload",{});},idle:()=>true});
  try {
    const preview=previewExtension(skill);
    await expect(manager.install(skill,"wrong")).rejects.toThrow(/изменился/);
    await manager.install(skill,preview.digest);
    let item=(await manager.list()).items.find(i=>i.name===preview.name)!;
    expect(item).toMatchObject({enabled:true,removable:true,kind:"skill"});
    await manager.change(item.id,false);
    expect((await manager.list()).items.find(i=>i.id===item.id)?.enabled).toBe(false);
    await manager.change(item.id,true);
    await manager.change(item.id);
    expect((await manager.list()).items.find(i=>i.id===item.id)).toBeUndefined();

    const plugin=[file("plugin.json",JSON.stringify({name:"recipe",version:"1.0.0",description:"A harmless local test plugin.",skills:"./skills/"})),file("skills/concise-replies/SKILL.md",Buffer.from(skill[0]!.contentBase64,"base64").toString())];
    await manager.install(plugin,previewExtension(plugin).digest);
    item=(await manager.list()).items.find(i=>i.id==="plugin:recipe@openstrudel-local")!;
    expect(item).toMatchObject({enabled:true,removable:true});
    await manager.change(item.id,false);
    expect((await manager.list()).items.find(i=>i.id===item.id)?.enabled).toBe(false);
    await manager.change(item.id,true);
    await manager.change(item.id);
    expect((await manager.list()).items.some(i=>i.id===item.id)).toBe(false);
  } finally {rpc.close();}
},90_000);

it("restores installed files when an extension removal cannot reload Codex",async()=>{
  const {home,cwd}=fixture(); const path=join(cwd,".agents/skills/concise-replies/SKILL.md");
  mkdirSync(join(path,".."),{recursive:true});writeFileSync(path,Buffer.from(skill[0]!.contentBase64,"base64"));
  writeFileSync(join(path,"../.openstrudel-package.json"),"{}");
  const rpc={request:async()=>({data:[{skills:[{name:"concise-replies",description:"Short",path,enabled:true}]}]})};
  const manager=new CodexExtensions({home,cwd,client:async()=>rpc as unknown as CodexRpc,changed:async()=>{throw new Error("failed");},idle:()=>true});
  const item=(await manager.list()).items[0]!;
  await expect(manager.change(item.id)).rejects.toThrow("failed");expect(existsSync(path)).toBe(true);
});

it("keeps scope changes out of active turns, including another account",async()=>{
  const {root,home,cwd}=fixture(),shared=join(root,"shared/config.toml");
  const manager=new CodexExtensions({home,cwd,sharedConfigPath:shared,client:async()=>({request:async()=>({})}) as unknown as CodexRpc,changed:async()=>{},idle:()=>true});
  const finish=beginExtensionRun(shared);
  try {await expect(manager.addMcp({name:"shared",url:"https://example.com/mcp"})).rejects.toThrow(/завершения/);}finally{finish();}
  await manager.addMcp({name:"shared",url:"https://example.com/mcp"});
  expect(readToml(shared).mcp_servers.shared).toBeDefined();
});

it("discovers an installed local plugin after switching to another Codex account home",async()=>{
  const {root,home,cwd}=fixture(),shared=join(root,"shared/config.toml");
  const first=new CodexRpc(home,undefined,undefined,undefined,cwd);await first.initialize();
  const manager=new CodexExtensions({home,cwd,sharedConfigPath:shared,client:async()=>first,changed:async()=>{await first.request("config/mcpServer/reload",{});},idle:()=>true});
  const plugin=[file("plugin.json",JSON.stringify({name:"shared-recipe",version:"1.0.0",description:"QA",skills:"./skills/"})),file("skills/concise-replies/SKILL.md",Buffer.from(skill[0]!.contentBase64,"base64").toString())];
  let second:CodexRpc|undefined;
  try {
    await manager.install(plugin,previewExtension(plugin).digest);
    const next=join(root,"second-home");mkdirSync(next);
    writeFileSync(join(next,"config.toml"),readFileSync(join(home,"config.toml")));
    const nextManager=new CodexExtensions({home:next,cwd,sharedConfigPath:shared,client:async()=>second!,changed:async()=>{},idle:()=>true});
    await nextManager.prepare();await nextManager.prepare();
    second=new CodexRpc(next,undefined,undefined,undefined,cwd);await second.initialize();
    const result=await second.request("skills/list",{cwds:[cwd],forceReload:true});
    expect(result.data.flatMap((r:any)=>r.skills).some((s:any)=>s.name==="shared-recipe:concise-replies" && s.pluginId)).toBe(true);
  }finally{first.close();second?.close();}
},90_000);
