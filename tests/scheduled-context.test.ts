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

it("does not read another employee's group or retain the grant after reassignment",async()=>{
  const {store,group,service,run,request}=setup();
  await service.handle(request);
  const other=store.createProfile({name:"Other"});
  store.bindTelegramChat("-100",other.id);
  const tools=run.mock.calls[0]![1].tools;
  await expect(tools.call("read_chat_history",{before:null})).rejects.toThrow();
  await expect(service.handle(request)).rejects.toThrow();
  expect(run).toHaveBeenCalledTimes(1);
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
