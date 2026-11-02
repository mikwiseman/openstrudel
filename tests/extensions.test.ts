import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexExtensions, previewExtension, readToml, beginExtensionRun, inheritedIntegrations, ownerOnlyServers, shareWithAllChats, sharedWithAllChats, type ExtensionFile } from "../src/extensions.js";
import { readExtensionBundle } from "../src/extension-bundle.js";
import { CodexRpc } from "../src/rpc.js";
import { ScopedCodexEngine } from "../src/scopes.js";
import { CodexEngineAdapter } from "../src/codex.js";
import { providerInfo } from "../src/providers.js";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
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

it("uses plugin MCP identifiers rather than display descriptions in approval defaults",()=>{
  const {home,cwd}=fixture();
  writeFileSync(join(home,"config.toml"),'[plugins."office@openstrudel-local"]\nenabled = true\n[plugins."external@official"]\nenabled = true\n');
  const record=join(home,"openstrudel-packages/plugins/office");mkdirSync(record,{recursive:true});
  writeFileSync(join(record,".openstrudel-package.json"),JSON.stringify({services:["calendar · calendar.example","local-probe · программа на устройстве"]}));
  const manager=new CodexExtensions({home,cwd,client:async()=>{throw new Error("No RPC needed");},changed:async()=>{},idle:()=>true});
  expect(manager.pluginServers()).toEqual({"office@openstrudel-local":["calendar","local-probe"]});
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

it("saves custom MCP headers and disabled tools privately, with rollback on a failed reload",async()=>{
  const {home,cwd}=fixture(),changed=vi.fn(async()=>{});
  const manager=new CodexExtensions({home,cwd,client:async()=>({request:async()=>({})}) as unknown as CodexRpc,changed,idle:()=>true});
  const result=await manager.addMcp({name:"private-reader",url:"https://example.com/mcp",http_headers:{"X-API-KEY":"private-test-key"},disabled_tools:["execute_request","execute_request"]});
  expect(result).toEqual({id:"mcp:private-reader",saved:true});
  const saved=readToml(join(home,"openstrudel-extensions.toml")).mcp_servers["private-reader"];
  expect(saved.http_headers).toEqual({"X-API-KEY":"private-test-key"});
  expect(saved.disabled_tools).toEqual(["execute_request"]);
  expect(statSync(join(home,"openstrudel-extensions.toml")).mode & 0o777).toBe(0o600);
  changed.mockRejectedValueOnce(new Error("reload failed"));
  await expect(manager.addMcp({name:"second",url:"https://example.com/second",http_headers:{"X-API-KEY":"other-private-key"}})).rejects.toThrow("reload failed");
  expect(readToml(join(home,"config.toml")).mcp_servers.second).toBeUndefined();
  expect(readToml(join(home,"openstrudel-extensions.toml")).mcp_servers["private-reader"]).toEqual(saved);
});

it("rejects ambiguous, protocol, identity and malformed custom headers before changing a connector",async()=>{
  const {home,cwd}=fixture(),client=vi.fn();
  const manager=new CodexExtensions({home,cwd,client,changed:async()=>{},idle:()=>true});
  const before=readFileSync(join(home,"config.toml"),"utf8");
  for(const http_headers of [null,[],"key",{"X-Key":"a\r\nInjected: yes"},{"X-Key":"a\0b"},{"X-Key":42},{"X-Key":""},{"Bad Header":"v"},{"X-Key":"v","x-key":"other"},{Host:"other.test"},{"mcp-session-id":"v"},{"x-hermes-user-id":"123"},{"Content-Length":"999"}]) {
    await expect(manager.addMcp({name:"sample",url:"https://example.com/mcp",http_headers})).rejects.toThrow();
  }
  await expect(manager.addMcp({name:"sample",url:"https://example.com/mcp",token:"key",http_headers:{authorization:"Bearer other"}})).rejects.toThrow(/Authorization/);
  await expect(manager.addMcp({name:"sample",command:"true",http_headers:{"X-Key":"v"}})).rejects.toThrow(/адреса/);
  for(const disabled_tools of ["execute_request",["*"],["invalid tool"],[1],Array(101).fill("read")]) {
    await expect(manager.addMcp({name:"sample",url:"https://example.com/mcp",disabled_tools})).rejects.toThrow();
  }
  expect(client).not.toHaveBeenCalled();
  expect(readFileSync(join(home,"config.toml"),"utf8")).toBe(before);
});

it("never inherits owner-only connectors into employees or future groups and preserves exclusions when sharing toggles",()=>{
  const {root}=fixture();
  mkdirSync(join(root,".data/extensions/personal"),{recursive:true});
  mkdirSync(join(root,".data/connections"),{recursive:true});
  writeFileSync(join(root,".data/extensions/personal/config.toml"),'[mcp_servers.unipile]\nurl="https://developer.unipile.com/mcp"\n[mcp_servers.unipile.http_headers]\nX-API-KEY="private-test-key"\n[mcp_servers.company]\nurl="https://company.example/mcp"\n[mcp_servers.company.http_headers]\nAuthorization="Bearer company-key"\n[apps.calendar]\nenabled=true\n');
  writeFileSync(join(root,".data/connections/personal.toml"),'[mcp_servers.legacy-private]\nurl="https://private.example/mcp"\n[mcp_servers.legacy-private.http_headers]\nAuthorization="Bearer private-key"\n');
  shareWithAllChats(root,true,["unipile","legacy-private"]);
  for(const context of ["work","agent-"+"a".repeat(32),"group-"+"b".repeat(64)]) {
    const inherited=inheritedIntegrations(root,context,{servers:{}});
    expect(Object.keys(inherited.servers)).toEqual(["company"]);
    expect(inherited.apps).toEqual(["calendar"]);
  }
  shareWithAllChats(root,false);shareWithAllChats(root,true);
  expect(ownerOnlyServers(root)).toEqual(["unipile","legacy-private"]);
  expect(inheritedIntegrations(root,"work",{servers:{}}).servers.unipile).toBeUndefined();
  expect(readToml(join(root,".data/extensions/personal/config.toml")).mcp_servers.unipile.http_headers["X-API-KEY"]).toBe("private-test-key");
  expect(statSync(join(root,".data/extensions/all-chats.json")).mode & 0o777).toBe(0o600);
});

it("fails closed for corrupt owner-only sharing policy without replacing it during an ordinary toggle",()=>{
  const {root}=fixture(),path=join(root,".data/extensions/all-chats.json");
  shareWithAllChats(root,true,["private"]);
  for(const text of ['{"enabled":true,"ownerOnlyServers":"private"}','{"enabled":true,"ownerOnlyServers":["../private"]}','{broken']) {
    writeFileSync(path,text);
    expect(sharedWithAllChats(root)).toBe(false);
    expect(inheritedIntegrations(root,"work",{servers:{}})).toEqual({servers:{},apps:[]});
    expect(()=>shareWithAllChats(root,true)).toThrow(/повреждены/);
    expect(readFileSync(path,"utf8")).toBe(text);
  }
});

it("removes a service after a native thread used its per-tool approval settings",async()=>{
  const {home,cwd}=fixture();
  const config='[features]\napps = false\n[mcp_servers.probe]\ncommand = "true"\nenabled = false\n';
  writeFileSync(join(home,"config.toml"),config);
  writeFileSync(join(home,"openstrudel-extensions.toml"),'[mcp_servers.probe]\ncommand = "true"\nenabled = false\n');
  const engine=new CodexEngineAdapter({codexHome:home,workingDirectory:cwd,scoped:true});
  try {
    const rpc=await (engine as any).client() as CodexRpc;
    const result=await rpc.request("thread/start",{cwd,model:"gpt-6.1-sol",config:{"mcp_servers.probe.default_tools_approval_mode":"prompt"}});
    (engine as any).loadedConfig.set(result.thread.id,"fixture");
    (engine as any).loaded.set(result.thread.id,"Same employee identity");
    await engine.extensions().removeMcp("probe");
    expect(readToml(join(home,"config.toml")).mcp_servers?.probe).toBeUndefined();
    expect((engine as any).loaded.get(result.thread.id)).toBe("Same employee identity");
  } finally {engine.close();}
},30_000);

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

it("keeps an explicitly enabled app when the same audience switches accounts",async()=>{
  const {root}=fixture(),source=join(root,"source");mkdirSync(source);
  const first=new ScopedCodexEngine(root,source);first.forContext("personal");
  const home=join(root,".data/contexts/personal"),shared=join(root,".data/extensions/personal/config.toml");
  const extensions=new CodexExtensions({home,cwd:join(root,".data/workspace/personal"),sharedConfigPath:shared,
    client:async()=>{throw Error("Not needed to save a grant");},changed:async()=>{},idle:()=>true});
  await extensions.enableApp("connector_calendar");
  first.close();
  const second=new ScopedCodexEngine(root,source,undefined,join(root,"second-account"));
  second.forContext("personal");second.forContext("work");
  expect(readToml(join(root,"second-account/personal/config.toml")).apps.connector_calendar.enabled).toBe(true);
  expect(readToml(join(root,"second-account/work/config.toml")).apps.connector_calendar).toBeUndefined();
  expect(readToml(shared).apps).toEqual({connector_calendar:{enabled:true}});
  second.close();
});

it("keeps native initialization and pending requests busy, then releases the idle runtime",async()=>{
  const {home,cwd}=fixture();
  const engine=new CodexEngineAdapter({codexHome:home,workingDirectory:cwd,scoped:true});
  try {
    const opening=(engine as any).client() as Promise<CodexRpc>;
    expect(engine.busy).toBe(true);
    const rpc=await opening;
    expect(engine.busy).toBe(false);
    const reading=rpc.request("config/read",{includeLayers:false});
    expect(engine.busy).toBe(true);
    await reading;
    expect(engine.busy).toBe(false);
  } finally {engine.close();}
});

it("releases least-recent idle audiences without stopping active work or losing saved context",()=>{
  const {root}=fixture(),source=join(root,"source");mkdirSync(source);
  const scoped=new ScopedCodexEngine(root,source);
  const first=scoped.forContext("personal") as CodexEngineAdapter;
  const firstClose=vi.spyOn(first,"close");
  const active=scoped.forContext("work") as CodexEngineAdapter;
  vi.spyOn(active,"busy","get").mockReturnValue(true);
  const activeClose=vi.spyOn(active,"close");
  const memory=join(root,".data/contexts/personal/memories");mkdirSync(memory,{recursive:true});writeFileSync(join(memory,"MEMORY.md"),"Retained fact");
  const workspace=join(root,".data/workspace/personal/result.txt");writeFileSync(workspace,"Retained file");
  for(let i=0;i<8;i++)scoped.forContext("agent-"+i.toString(16).padStart(32,"0"));
  expect(firstClose).toHaveBeenCalledOnce();
  expect(activeClose).not.toHaveBeenCalled();
  expect(scoped.forContext("work")).toBe(active);
  expect(scoped.forContext("personal")).not.toBe(first);
  expect(readFileSync(join(memory,"MEMORY.md"),"utf8")).toBe("Retained fact");
  expect(readFileSync(workspace,"utf8")).toBe("Retained file");
  scoped.close();
});

it("keeps native memories persistent and readable only inside their audience",()=>{
  const {root}=fixture(),source=join(root,"source");mkdirSync(source);
  const scoped=new ScopedCodexEngine(root,source);
  const group="group-"+"a".repeat(64);
  for(const context of ["personal","work",group]) {
    scoped.forContext(context);
    const home=join(root,".data/contexts",context),memory=join(home,"memories");
    const config=readToml(join(home,"config.toml"));
    expect(config.features.memories).toBe(true);
    expect(config.memories).toMatchObject({generate_memories:true,use_memories:true,disable_on_external_context:false,min_rate_limit_remaining_percent:0});
    expect(config.permissions.openstrudel.filesystem[memory]).toBe("read");
    expect(config.permissions.openstrudel.filesystem[source]).toBeUndefined();
    expect(config.permissions.openstrudel.filesystem[join(root,".data/contexts")]).toBeUndefined();
    for(const other of ["personal","work",group].filter(value=>value!==context))
      expect(config.permissions.openstrudel.filesystem[join(root,".data/contexts",other,"memories")]).toBeUndefined();
    mkdirSync(memory,{recursive:true});writeFileSync(join(memory,"MEMORY.md"),context);
  }
  scoped.close();
  for(const context of ["personal","work",group]) {
    scoped.forContext(context);
    expect(readFileSync(join(root,".data/contexts",context,"memories/MEMORY.md"),"utf8")).toBe(context);
  }
  scoped.close();
});

it("keeps a key provider's Codex away from chatgpt.com and GitHub, even where a local plugin is enabled",async()=>{
  const {root}=fixture(),source=join(root,"source"),contexts=join(root,"provider");mkdirSync(source);
  mkdirSync(join(root,".data/extensions/personal"),{recursive:true});
  writeFileSync(join(root,".data/extensions/personal/config.toml"),'[plugins."recipe@openstrudel-local"]\nenabled = true\n');
  // Codex syncs OpenAI's plugin catalog from chatgpt.com and GitHub at start whenever plugins are on.
  const keyed=new ScopedCodexEngine(root,undefined,undefined,contexts,{info:providerInfo("xai")!,key:()=>"xai-key"});
  const engine=keyed.forContext("personal") as CodexEngineAdapter;
  expect(readToml(join(contexts,"personal/config.toml")).features).toEqual({apps:false,plugins:false,remote_plugin:false,memories:false});
  expect(readToml(join(contexts,"personal/config.toml")).memories).toBeUndefined();
  await expect(engine.extensions().prepare()).resolves.toBeUndefined();
  const chatgpt=new ScopedCodexEngine(root,source);chatgpt.forContext("personal");
  expect(readToml(join(root,".data/contexts/personal/config.toml")).features).toEqual({apps:true,plugins:true,remote_plugin:false,memories:true});
  keyed.close();chatgpt.close();
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

it("updates a real local plugin in one operation and restores its previous version on failure",async()=>{
  const {home,cwd}=fixture(); const rpc=new CodexRpc(home,undefined,undefined,undefined,cwd); await rpc.initialize();
  const changed=vi.fn(async()=>{await rpc.request("config/mcpServer/reload",{});});
  const manager=new CodexExtensions({home,cwd,client:async()=>rpc,changed,idle:()=>true});
  const bundle=(version:string)=>[
    file("plugin.json",JSON.stringify({name:"update-fixture",version,description:"Version "+version,skills:"./skills/"})),
    file("skills/concise-replies/SKILL.md",`---\nname: concise-replies\ndescription: Version ${version}\n---\nUse version ${version}.\n`),
  ];
  const path=join(home,"openstrudel-packages/plugins/update-fixture/plugin.json");
  const installedDescription=async()=>(await rpc.request("skills/list",{cwds:[cwd],forceReload:true})).data.flatMap((r:any)=>r.skills).find((s:any)=>s.name==="update-fixture:concise-replies")?.description;
  try {
    const first=bundle("1.0.0"); await manager.install(first,previewExtension(first).digest);
    expect(await installedDescription()).toBe("Version 1.0.0");
    const second=bundle("1.1.0"),preview=manager.preview(second);
    expect(preview.replaces).toBe(previewExtension(first).digest);
    await expect(manager.install(second,preview.digest)).rejects.toThrow(/версия изменилась/);
    await manager.install(second,preview.digest,preview.replaces);
    expect(JSON.parse(readFileSync(path,"utf8")).version).toBe("1.1.0");
    expect(await installedDescription()).toBe("Version 1.1.0");
    const third=bundle("1.2.0"),review=manager.preview(third);
    changed.mockRejectedValueOnce(new Error("injected reload failure"));
    await expect(manager.install(third,review.digest,review.replaces)).rejects.toThrow("injected reload failure");
    expect(JSON.parse(readFileSync(path,"utf8")).version).toBe("1.1.0");
    expect(await installedDescription()).toBe("Version 1.1.0");
    await manager.change("plugin:update-fixture@openstrudel-local",false);
    await manager.install(third,review.digest,review.replaces);
    expect((await manager.list()).items.find(i=>i.name==="update-fixture")?.enabled).toBe(false);
    const revised=[third[0]!,file("skills/concise-replies/SKILL.md","---\nname: concise-replies\ndescription: Same version, corrected content\n---\nCorrected.\n")];
    const revision=manager.preview(revised);
    await manager.install(revised,revision.digest,revision.replaces);
    await manager.change("plugin:update-fixture@openstrudel-local",true);
    expect(await installedDescription()).toBe("Same version, corrected content");
  } finally {rpc.close();}
},90_000);

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
