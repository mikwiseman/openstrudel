import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { saveModelSelection } from "../src/model-settings.js";

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
function setup(){
  const root=mkdtempSync(join(tmpdir(),"scheduled-context-")),store=new Store(":memory:");
  const employee=store.createProfile({name:"Family"});
  store.linkTelegramChat({chatId:"-100",title:"Family",allowedSenders:["7"]});
  const group=store.bindTelegramChat("-100",employee.id);
  const run=vi.fn(async(_input:string,_options:any)=>({threadId:"schedule",response:"NO_REPLY",events:[]}));
  const service=new MessageService(store,{run},root);
  cleanup.push(async()=>{await service.close();store.close();rmSync(root,{recursive:true,force:true});});
  const request={channel:"api" as const,profile:employee.id,text:"Prepare the family report",scheduled:true,scheduleTelegramChatId:"-100"};
  return{root,store,employee,group,service,run,request};
}

it("refreshes scoped working memory on resumed turns and scheduled reports without importing another audience",async()=>{
  const {root,store,group,service,run,request}=setup();
  const groupPath=service.files.workspace(service.contextFor(group.conversationId!));
  mkdirSync(groupPath,{recursive:true});
  writeFileSync(join(groupPath,"MEMORY.md"),"Alisa · 2026-10-31 · message 10791: use formula-feeding context.");
  const privatePath=service.files.workspace("personal");mkdirSync(privatePath,{recursive:true});
  writeFileSync(join(privatePath,"MEMORY.md"),"UNRELATED_PRIVATE_MEMORY");
  await service.handle(request);
  expect(run.mock.calls[0]![0]).toContain("use formula-feeding context");
  expect(run.mock.calls[0]![0]).not.toContain("UNRELATED_PRIVATE_MEMORY");
  writeFileSync(join(groupPath,"MEMORY.md"),"Alisa · later correction: father is available mornings and evenings.");
  await service.handle(request);
  expect(run.mock.calls[1]![0]).toContain("father is available mornings and evenings");
  expect(run.mock.calls[1]![0]).not.toContain("use formula-feeding context");
  rmSync(join(groupPath,"MEMORY.md"));
  symlinkSync(join(privatePath,"MEMORY.md"),join(groupPath,"MEMORY.md"));
  await service.handle(request);
  expect(run.mock.calls[2]![0]).not.toContain("UNRELATED_PRIVATE_MEMORY");
});

it("brings the delivery group's current feedback into every scheduled run, with full paginated history",async()=>{
  const {store,group,service,run,request}=setup();
  const home=store.profileConversation(group.profileId!);
  store.addMessage({conversationId:home.id,channel:"api",direction:"inbound",text:"PRIVATE_OWNER_NOTE"});
  for(let i=0;i<60;i++)store.addMessage({conversationId:group.conversationId!,channel:"telegram",direction:"inbound",author:"Alisa",text:i===0?"OLD_FAMILY_FEEDBACK":`Older comment ${i}`});
  store.addMessage({conversationId:group.conversationId!,channel:"telegram",direction:"inbound",author:"Alisa",text:"Please use the corrected name Elli."});
  await service.handle(request);
  expect(run.mock.calls[0]![0]).toContain("Please use the corrected name Elli.");
  expect(run.mock.calls[0]![0]).toContain('"author":"Alisa"');
  const tools=run.mock.calls[0]![1].tools;
  const latest=await tools.call("read_chat_history",{before:null});
  expect(JSON.stringify(latest)).not.toContain("PRIVATE_OWNER_NOTE");
  expect(latest.olderCursor).toBeTruthy();
  const older=await tools.call("read_chat_history",{before:latest.olderCursor});
  expect(JSON.stringify(older)).toContain("OLD_FAMILY_FEEDBACK");
  store.addMessage({conversationId:group.conversationId!,channel:"telegram",direction:"inbound",author:"Alisa",text:"Include a small game tomorrow."});
  await service.handle(request);
  expect(run.mock.calls[1]![0]).toContain("Include a small game tomorrow.");
  expect(run.mock.calls[1]![0]).toContain("Please use the corrected name Elli.");
});

it("does not read another employee's group or retain the grant after reassignment, and still prepares the report",async()=>{
  const {store,group,service,run,request}=setup();
  store.addMessage({conversationId:group.conversationId!,channel:"telegram",direction:"inbound",author:"Alisa",text:"GROUP_ONLY_TALK"});
  await service.handle(request);
  expect(run.mock.calls[0]![0]).toContain("GROUP_ONLY_TALK");
  const other=store.createProfile({name:"Other"});
  store.bindTelegramChat("-100",other.id);
  const tools=run.mock.calls[0]![1].tools;
  expect(JSON.stringify(await tools.call("read_chat_history",{before:null}))).not.toContain("GROUP_ONLY_TALK");
  await service.handle(request);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]![0]).not.toContain("GROUP_ONLY_TALK");
  expect(run.mock.calls[1]![0]).not.toContain("Delivery group history");
});

it("reports to a shared group that belongs to the main assistant from the employee's own thread",async()=>{
  const {store,employee,service,run}=setup();
  const shared=store.linkTelegramChat({chatId:"-200",title:"Team",allowedSenders:["7"]});
  const team=store.getOrCreateConversation({channel:"telegram",externalId:"-200",title:"Team"});
  store.addMessage({conversationId:team.id,channel:"telegram",direction:"inbound",author:"Boris",text:"TEAM_ONLY_TALK"});
  const own=store.profileConversation(employee.id);
  store.addMessage({conversationId:own.id,channel:"telegram",direction:"inbound",author:"Boris",text:"Shorter next time, please."});
  await service.handle({channel:"api",profile:employee.id,text:"Prepare the team report",scheduled:true,scheduleTelegramChatId:shared.chatId});
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]![0]).not.toContain("TEAM_ONLY_TALK");
  const history=JSON.stringify(await run.mock.calls[0]![1].tools.call("read_chat_history",{before:null}));
  expect(history).toContain("Shorter next time, please.");
  expect(history).not.toContain("TEAM_ONLY_TALK");
});

it("refuses a report to a group the owner paused",async()=>{
  const {store,service,run,request}=setup();
  store.setSetting("telegram.paused.-100","true");
  await expect(service.handle(request)).rejects.toThrow("Чат доставки изменился");
  expect(run).not.toHaveBeenCalled();
});

it("gives a scheduled Grok run in its new session the group's comments, while its own posts stay with read_news",async()=>{
  // A news employee's delivery group holds mostly its own long posts; about fifty of them would seed every hourly run again.
  const fill=({store,group}:ReturnType<typeof setup>)=>{
    for(let i=0;i<3;i++)store.addMessage({conversationId:group.conversationId!,channel:"telegram",direction:"outbound",text:`OWN_POST_${i} `+"карточка радара ".repeat(120)});
    store.addMessage({conversationId:group.conversationId!,channel:"telegram",direction:"inbound",author:"Alisa",text:"This one was a repeat."});
  };
  const grok=setup();fill(grok);
  saveModelSelection(grok.store,{provider:"grok",model:"grok-4.7",serviceTier:"default"},grok.employee.id);
  await grok.service.handle(grok.request);
  expect(grok.run.mock.calls[0]![0]).toContain("This one was a repeat.");
  expect(grok.run.mock.calls[0]![0]).not.toContain("OWN_POST_");
  // A run on another engine resumes its chat's thread and still reads the whole group.
  const other=setup();fill(other);
  await other.service.handle(other.request);
  expect(other.run.mock.calls[0]![0]).toContain("This one was a repeat.");
  expect(other.run.mock.calls[0]![0]).toContain("OWN_POST_2");
});

it("runs a News desk's schedule in a new session on any engine, and resumes the chat for its owner",async()=>{
  const desk=setup();
  const chat=desk.store.profileConversation(desk.employee.id);
  desk.store.setConversationThread(chat.id,"owner-thread");
  desk.store.addMessage({conversationId:chat.id,channel:"api",direction:"outbound",text:"EARLIER_RUN "+"карточка радара ".repeat(120)});
  // Without a reader this employee's schedule resumes its chat, like every other schedule on this engine.
  await desk.service.handle(desk.request);
  expect(desk.run.mock.calls[0]![1]).toMatchObject({threadId:"owner-thread"});
  expect(desk.run.mock.calls[0]![1].ephemeral).toBeUndefined();
  desk.store.setConversationThread(chat.id,"owner-thread");
  desk.store.addMessage({conversationId:chat.id,channel:"api",direction:"outbound",text:"A story",story:{id:"first-story",edition:null,rank:null,section:"Tools",status:"Out",title:"A story",summary:"What happened.",body:"What happened.",
    view:null,check:null,verification:"Read the announcement.",eventAt:null,change:null,sources:[{title:"announcement",url:"https://example.com/a",role:"Primary",publishedAt:null}]}});
  await desk.service.handle(desk.request);
  expect(desk.run.mock.calls[1]![1]).toMatchObject({ephemeral:true});
  expect(desk.run.mock.calls[1]![1].threadId).toBeUndefined();
  expect(desk.run.mock.calls[1]![0]).not.toContain("EARLIER_RUN");
  expect(desk.store.getConversation(chat.id)!.codexThreadId).toBe("owner-thread");
  await desk.service.handle({channel:"api",profile:desk.employee.id,text:"What did you publish today?",byOwner:true});
  expect(desk.run.mock.calls[2]![1]).toMatchObject({threadId:"owner-thread"});
  expect(desk.run.mock.calls[2]![1].ephemeral).toBeUndefined();
});
