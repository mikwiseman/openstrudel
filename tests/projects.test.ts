import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { Projects, type ProjectReceipt } from "../src/projects.js";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter } from "../src/telegram.js";
import type { TelegramToolContext } from "../src/telegram-tools.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], { encoding:"utf8", stdio:["ignore","pipe","pipe"] }).trim();
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "strudel-projects-"))), home = join(dir,"home");
  mkdirSync(home); cleanups.push(() => rmSync(dir,{recursive:true,force:true}));
  const store = new Store(":memory:"); cleanups.push(() => store.close());
  const projects = new Projects(store,home);
  function repo(name = "source") {
    const path=join(dir,name); mkdirSync(path,{recursive:true});
    git(path,"init","-b","codex/test"); git(path,"config","user.name","Fixture"); git(path,"config","user.email","fixture@example.invalid");
    writeFileSync(join(path,"tracked.txt"),"before\n"); git(path,"add","tracked.txt"); git(path,"commit","-qm","Fixture");
    return path;
  }
  const conversation=store.getOrCreateConversation({channel:"api",externalId:"fixture"});
  const context: TelegramToolContext={conversationId:conversation.id,messageId:"request",channel:"api",byOwner:true,scope:"personal",access:true};
  const register = (path: string) => projects.save({revision:projects.read(true).revision,id:null,name:"Source",path,enabled:true},true);
  const bind = (id: string, employeeId="main") => projects.bind({revision:projects.read(true).revision,employeeId,projectId:id},true);
  const receipts = async (messageId: string|null="request") => (await projects.tools(context).call("read_project_result",{messageId}) as {receipts:ProjectReceipt[]}).receipts;
  return {dir,home,store,projects,repo,context,register,bind,receipts};
}

describe("owner registered development projects", () => {
  it("registers only a canonical committed checkout through the owner API, with optimistic revision checks", async () => {
    const f=fixture(), path=f.repo();
    expect(()=>f.projects.read(false)).toThrow("owner");
    await expect(f.projects.save({revision:0,id:null,name:"Source",path,enabled:true},false)).rejects.toThrow("owner");
    const saved=await f.register(path);
    expect(saved).toMatchObject({saved:true,revision:1,project:{path,revision:1,gitDirectory:join(path,".git"),enabled:true}});
    expect(()=>f.projects.bind({revision:1,employeeId:"main",projectId:saved.project.id},false)).toThrow("owner");
    f.bind(saved.project.id);
    expect(f.projects.read(true).bindings).toEqual({main:saved.project.id});
    await expect(f.projects.save({revision:1,id:saved.project.id,name:"stale",path,enabled:true},true)).rejects.toThrow("settings changed");
    await expect(f.register(path)).rejects.toThrow("already connected");
    expect(f.projects.tools(f.context).definitions.map(t=>t.name)).toEqual(["list_projects","bind_employee_project","read_project_result"]);
    await expect(f.projects.tools(f.context).call("register_project",{path})).rejects.toThrow("Unknown");
  });

  it("rejects aliases, subdirectories, missing paths, Home data and installed applications", async () => {
    const f=fixture(), path=f.repo();
    symlinkSync(path,join(f.dir,"alias")); mkdirSync(join(path,"nested"));
    for(const unsafe of [join(f.dir,"alias"),join(path,"nested"),join(f.dir,"missing"),f.repo("home/.data/source"),f.repo("Installed.app/source")]) {
      await expect(f.register(unsafe)).rejects.toThrow();
    }
    await expect(f.register(parse(path).root)).rejects.toThrow("not Home data");
    expect(f.projects.read(true).projects).toHaveLength(0);
  });

  it("refuses a replaced checkout or changed Git metadata before granting a turn", async () => {
    const f=fixture(), path=f.repo(), saved=await f.register(path); f.bind(saved.project.id);
    renameSync(path,path+"-original"); f.repo();
    await expect(f.projects.begin("main",f.context,true)).rejects.toThrow("checkout changed");
    rmSync(path,{recursive:true}); renameSync(path+"-original",path);
    const other=f.repo("other"); renameSync(join(path,".git"),join(path,"saved-git"));
    writeFileSync(join(path,".git"),`gitdir: ${join(other,".git")}\n`);
    await expect(f.projects.begin("main",f.context,true)).rejects.toThrow("repository changed");
  });

  it("blocks shared, scheduled, nonowner and non-Codex turns, including an owner in an API-bound group", async () => {
    const f=fixture(), saved=await f.register(f.repo()); f.bind(saved.project.id);
    for(const patch of [{byOwner:false},{scheduled:true},{scope:"group-private"},{access:false},{channel:"telegram" as const,byOwner:true,telegramSenderId:"77"}]) {
      const context={...f.context,...patch};
      expect(f.projects.tools(context).definitions).toEqual([]);
      await expect(f.projects.begin("main",context,true)).rejects.toThrow();
    }
    await expect(f.projects.begin("main",f.context,false)).rejects.toThrow("native Codex");
    f.store.linkTelegramChat({chatId:"-100",title:"Group",allowedSenders:["77"]});
    f.store.db.prepare("UPDATE telegram_chats SET conversation_id=? WHERE chat_id='-100'").run(f.context.conversationId);
    await expect(f.projects.begin("main",f.context,true)).rejects.toThrow("private chat");
  });

  it("rechecks the actual Telegram pairing and a paused private chat, ignoring an old owner snapshot", async () => {
    const f=fixture(), saved=await f.register(f.repo()); f.bind(saved.project.id);
    f.store.linkTelegramChat({chatId:"77",title:"Owner",allowedSenders:["77"]});
    const context={...f.context,channel:"telegram" as const,telegramSenderId:"77"};
    const run=await f.projects.begin("main",context,true); expect(run).toBeDefined(); await run!.finish("completed");
    const tools=f.projects.tools(context);
    f.store.setSetting("telegram.paused.77","true");
    await expect(f.projects.begin("main",context,true)).rejects.toThrow("private chat");
    f.store.setSetting("telegram.paused.77",""); f.store.linkTelegramChat({chatId:"77",title:"Owner",allowedSenders:[]});
    await expect(tools.call("list_projects",{})).rejects.toThrow("private chat");
    await expect(f.projects.begin("main",context,true)).rejects.toThrow("private chat");
  });

  it("fails closed if pairing is revoked while Git is read, then releases the checkout for an authorized retry", async () => {
    const f=fixture(), saved=await f.register(f.repo()); f.bind(saved.project.id);
    f.store.linkTelegramChat({chatId:"77",title:"Owner",allowedSenders:["77"]});
    const context={...f.context,channel:"telegram" as const,telegramSenderId:"77"};
    const pending=f.projects.begin("main",context,true);
    f.store.linkTelegramChat({chatId:"77",title:"Owner",allowedSenders:[]});
    await expect(pending).rejects.toThrow("private chat");
    expect(await f.receipts()).toEqual([]);
    const retry=await f.projects.begin("main",f.context,true); await retry!.finish("completed");
  });

  // These multi-step cases run real Git processes; keep their deadline bounded
  // at 10s without increasing the default for the rest of the suite.
  it("blocks disabled registrations and advances project revision before another native request", async () => {
    const f=fixture(), saved=await f.register(f.repo()); f.bind(saved.project.id);
    const disabled=await f.projects.save({revision:f.projects.read(true).revision,id:saved.project.id,name:"Source",path:saved.project.path,enabled:false},true);
    expect(disabled.project.revision).toBe(2);
    await expect(f.projects.begin("main",f.context,true)).rejects.toThrow("disabled");
    const enabled=await f.projects.save({revision:f.projects.read(true).revision,id:saved.project.id,name:"Source",path:saved.project.path,enabled:true},true);
    const run=await f.projects.begin("main",f.context,true);
    expect(run?.context.revision).toBe(enabled.project.revision); await run!.finish("completed");
  }, 10_000);

  it("serializes writers across employees sharing a checkout and releases the lease after failure", async () => {
    const f=fixture(), saved=await f.register(f.repo()); f.bind(saved.project.id);
    const employee=f.store.createProfile({name:"Developer"}); f.bind(saved.project.id,employee.id);
    const first=await f.projects.begin("main",f.context,true);
    await expect(f.projects.begin(employee.id,{...f.context,messageId:"second"},true)).rejects.toThrow("Another request");
    await expect(f.projects.save({revision:f.projects.read(true).revision,id:saved.project.id,name:"Changed",path:saved.project.path,enabled:false},true)).rejects.toThrow("checkout is working");
    await first!.finish("failed");
    const second=await f.projects.begin(employee.id,{...f.context,messageId:"second"},true); await second!.finish("completed");
    expect((await f.receipts("request"))[0]?.outcome).toBe("failed");
    expect((await f.receipts("second"))[0]?.outcome).toBe("completed");
  }, 10_000);

  it("permits independent checkouts and refuses binding changes while an employee is queued", async () => {
    const f=fixture(), a=await f.register(f.repo()), b=await f.register(f.repo("other")); f.bind(a.project.id);
    const employee=f.store.createProfile({name:"Other"}); f.bind(b.project.id,employee.id);
    const one=await f.projects.begin("main",f.context,true), two=await f.projects.begin(employee.id,{...f.context,messageId:"other"},true);
    await Promise.all([one!.finish("completed"),two!.finish("completed")]);
    const queued=f.store.addMessage({conversationId:f.context.conversationId,channel:"api",direction:"inbound",text:"queued"}); f.store.setMessageStatus(queued.id,"queued");
    expect(()=>f.projects.bind({revision:f.projects.read(true).revision,employeeId:"main",projectId:null},true)).toThrow("employee is working");
    f.store.setMessageStatus(queued.id,"completed");
    f.projects.bind({revision:f.projects.read(true).revision,employeeId:"main",projectId:null},true);
    expect(await f.projects.begin("main",f.context,true)).toBeUndefined();
  }, 10_000);

  it("records actual Git changes and native command failures without treating a successful response as passing tests", async () => {
    const f=fixture(), path=f.repo(), saved=await f.register(path); f.bind(saved.project.id);
    const run=await f.projects.begin("main",f.context,true);
    writeFileSync(join(path,"tracked.txt"),"after\n"); git(path,"commit","-qam","Change");
    run!.observe({type:"thread.started",payload:{threadId:"native-thread"}});
    run!.observe({type:"item/completed",payload:{turnId:"native-turn",item:{id:"test",type:"commandExecution",command:"npm test",status:"completed",exitCode:1}}});
    run!.observe({type:"item/completed",payload:{item:{id:"prose",type:"agentMessage",text:"All tests passed. https://github.com/example/repo/pull/1"}}});
    run!.observe({type:"item/completed",payload:{item:{id:"failed-pr",type:"mcpToolCall",tool:"create_pull_request",status:"completed",result:{isError:true,url:"https://github.com/example/repo/pull/2"}}}});
    run!.observe({type:"item/completed",payload:{item:{id:"real-pr",type:"mcpToolCall",tool:"mcp__github__create_pull_request",status:"completed",result:{url:"https://github.com/example/repo/pull/3"}}}});
    await run!.finish("completed");
    const receipt=(await f.receipts())[0]!;
    expect(receipt).toMatchObject({outcome:"completed",threadId:"native-thread",commands:[{itemId:"test",turnId:"native-turn",exitCode:1,status:"completed"}],pullRequests:[{itemId:"real-pr",url:"https://github.com/example/repo/pull/3"}],before:{dirty:false},after:{head:git(path,"rev-parse","HEAD"),dirty:false}});
    expect(receipt.before.head).not.toBe(receipt.after?.head);
    expect(receipt.commands[0]?.commandSHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain("npm test");
    expect(receipt).not.toHaveProperty("testsPassed");
  });

  it("marks interrupted and unverifiable work accurately and bounds command receipts", async () => {
    const f=fixture(), path=f.repo(), saved=await f.register(path); f.bind(saved.project.id);
    const inbound=f.store.addMessage({conversationId:f.context.conversationId,channel:"api",direction:"inbound",text:"work"});
    const run=await f.projects.begin("main",{...f.context,messageId:inbound.id},true);
    for(let i=0;i<101;i++) run!.observe({type:"item/completed",payload:{item:{id:String(i),type:"commandExecution",command:"false",status:"completed",exitCode:1}}});
    f.store.setMessageStatus(inbound.id,"failed");
    expect((await f.receipts(inbound.id))[0]).toMatchObject({outcome:"failed",commandsTruncated:true,verificationError:expect.stringContaining("interrupted")});
    renameSync(path,path+"-gone"); await run!.finish("failed");
    const receipt=(await f.receipts(inbound.id))[0]!;
    expect(receipt.commands).toHaveLength(100); expect(receipt.after).toBeUndefined(); expect(receipt.verificationError).toContain("unavailable");
  });

  it("records only structured created-PR identities, not quoted links or failed payloads", async () => {
    const f=fixture(), saved=await f.register(f.repo()); f.bind(saved.project.id);
    const run=await f.projects.begin("main",f.context,true);
    const url=(id:number)=>`https://github.com/example/repo/pull/${id}`;
    const results=[
      {html_url:url(1),body:`Related work: ${url(90)}`,base:{url:url(91)}},
      {structuredContent:{pull_request:{html_url:url(2),body:url(92)}}},
      {content:[{type:"text",text:JSON.stringify({html_url:url(3),body:url(93)})}]},
      {content:[{type:"text",text:`A previous PR is ${url(94)}`}]},
      {content:[{type:"text",text:JSON.stringify({error:"Creation failed",url:url(95)})}]},
      {url:url(96)+"/files"},
      {structuredContent:{pull_request:{success:false,url:url(97)}}},
    ];
    results.forEach((result,index)=>run!.observe({type:"item/completed",payload:{item:{id:`pr-${index}`,type:"mcpToolCall",tool:"create_pull_request",status:"completed",result}}}));
    await run!.finish("completed");
    expect((await f.receipts())[0]?.pullRequests.map(p=>p.url)).toEqual([url(1),url(2),url(3)]);
  });
});

describe("project message routing", () => {
  it("uses the registered project in the normal owner DM queue and does not replay an external message", async () => {
    const f=fixture(), run=vi.fn(async (_text,options) => ({threadId:options.threadId??"native",response:"Done",events:[]}));
    const messages=new MessageService(f.store,{run},f.home); cleanups.push(()=>messages.close());
    const employee=f.store.createProfile({name:"Developer"}), saved=await f.register(f.repo()); f.bind(saved.project.id,employee.id);
    f.store.linkTelegramChat({chatId:"77",title:"Owner",allowedSenders:["77"]}); f.store.bindTelegramChat("77",employee.id);
    const input={channel:"telegram" as const,externalChatId:"77",externalId:"77:1",telegramSenderId:"77",byOwner:true,text:"Improve the project"};
    await messages.handle(input); await messages.handle(input);
    expect(run).toHaveBeenCalledOnce(); expect(run.mock.calls[0]?.[1]).toMatchObject({project:{id:saved.project.id,cwd:saved.project.path},byOwner:true,scheduled:false});
    expect((await f.receipts(null))[0]).toMatchObject({outcome:"completed",threadId:"native"});
  });

  it.each(["revoked", "paused", "missing sender"])("rejects a %s queued Telegram request before the engine", async reason => {
    const f=fixture(); let release!:()=>void;
    const run=vi.fn(async()=>{ if(run.mock.calls.length===1) await new Promise<void>(r=>release=r); return {threadId:"native",response:"NO_REPLY",events:[]}; });
    const messages=new MessageService(f.store,{run},f.home); cleanups.push(()=>messages.close());
    messages.telegram=new TelegramAdapter(undefined,f.store,messages);
    f.store.linkTelegramChat({chatId:"77",title:"Owner",allowedSenders:["77"]});
    const base={channel:"telegram" as const,externalChatId:"77",telegramSenderId:"77",text:"work"};
    const first=await messages.submit({...base,externalId:"77:1"}); await vi.waitFor(()=>expect(run).toHaveBeenCalledOnce());
    const queued=await messages.submit({...base,externalId:"77:2",telegramSenderId:reason==="missing sender"?undefined:"77"});
    const rejected=expect(queued.completion).rejects.toMatchObject({status:403,message:expect.stringContaining("Доступ к этому чату изменился")});
    if(reason==="paused") f.store.setSetting("telegram.paused.77","true");
    if(reason==="revoked") f.store.linkTelegramChat({chatId:"77",title:"Owner",allowedSenders:[]});
    release(); await first.completion; await rejected;
    expect(run).toHaveBeenCalledOnce(); expect(f.store.getMessage(queued.receipt.conversationId,queued.receipt.messageId)?.status).toBe("failed");
  });
});
