import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter } from "../src/telegram.js";
import { Scheduler } from "../src/scheduler.js";
import { reportIssue, resolveIssue, resolveVoiceIssue, runtimeIssues, toolProblem, toolRecovered } from "../src/operations.js";

const stores:Store[]=[];
afterEach(()=>{vi.unstubAllGlobals();stores.splice(0).forEach(s=>s.close());});

it("reports an unresolved native connector failure to root and Telegram while preserving a partial answer",async()=>{
 const store=new Store(":memory:");stores.push(store);const root=store.primaryConversation();
 store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});
 const profile=store.createProfile({name:"Daily",instructions:"brief"});
 let failed=true,tool="list_events";
 const messages=new MessageService(store,{async run(_text,options){
  options!.onEvent!({type:"item/completed",payload:{item:{type:"mcpToolCall",server:"calendar",tool,status:failed?"failed":"completed",error:null,result:{content:[{type:"text",text:failed?'PRIVATE_SECRET upstream_failure':'ok'}]}}}});
  return{threadId:"t",response:"CRM available; calendar unavailable",events:[]};
 }});
 const sent:any[]=[];vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{sent.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:sent.length}});}));
 const telegram=new TelegramAdapter("123:test",store,messages);messages.telegram=telegram;
 try {
  for(let i=0;i<2;i++)expect((await messages.handle({channel:"api",profile:profile.id,text:"check"})).text).toContain("CRM available");
  expect(sent).toHaveLength(1);expect(sent[0].text).toContain("calendar.list_events");expect(sent[0].text).not.toContain("PRIVATE_SECRET");
  expect(store.listMessages(root.id)).toHaveLength(1);expect(runtimeIssues(store)[0]?.code).toBe("connector");
  failed=false;tool="read_crm";await messages.handle({channel:"api",profile:profile.id,text:"unrelated success"});
  expect(runtimeIssues(store)).toHaveLength(1);expect(sent).toHaveLength(1);
  tool="list_events";await messages.handle({channel:"api",profile:profile.id,text:"retry read"});
  // A recovery is not news: the incident closes silently.
  expect(runtimeIssues(store)).toEqual([]);expect(sent).toHaveLength(1);
 }finally{telegram.stop();await messages.close();}
});

it("lets Codex recover a connector in the same turn and ignores declined actions",async()=>{
 const store=new Store(":memory:");stores.push(store);
 const messages=new MessageService(store,{async run(_text,options){
  for(const item of [
   {server:"calendar",tool:"list_events",status:"failed",error:null},
   {server:"calendar",tool:"list_events",status:"completed",error:null},
   {server:"calendar",tool:"delete_event",status:"failed",error:{message:"user rejected MCP tool call"}},
  ])options!.onEvent!({type:"item/completed",payload:{item:{type:"mcpToolCall",...item}}});
  return{threadId:"t",response:"ok",events:[]};
 }});
 try{await messages.handle({channel:"api",text:"check"});expect(runtimeIssues(store)).toEqual([]);}finally{await messages.close();}
});

it("opens a connector incident only where no owner read the answer",async()=>{
 const store=new Store(":memory:");stores.push(store);
 store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});
 let status="failed",response="done";
 const messages=new MessageService(store,{async run(_text,options){
  options!.onEvent!({type:"item/completed",payload:{item:{type:"mcpToolCall",server:"calendar",tool:"list_events",status,error:null}}});
  return{threadId:"t",response,events:[]};
 }});
 try{
  // The owner asked in the app, in his private chat or in a group: he reads the answer.
  await messages.handle({channel:"api",text:"app",byOwner:true});
  await messages.handle({channel:"telegram",externalChatId:"42",externalId:"42:1",telegramSenderId:"42",byOwner:true,text:"private"});
  await messages.handle({channel:"telegram",externalChatId:"-100",externalId:"-100:1",telegramSenderId:"42",text:"group"});
  expect(runtimeIssues(store)).toEqual([]);
  // A quiet answer in the group is hidden, and his unattended pipeline is not his reading.
  response="NO_REPLY";await messages.handle({channel:"telegram",externalChatId:"-100",externalId:"-100:2",telegramSenderId:"42",text:"quiet"});
  response="done";await messages.handle({channel:"api",text:"batch",byOwner:true,externalId:"operations:news"});
  expect(runtimeIssues(store)).toHaveLength(2);
  status="completed";await messages.handle({channel:"api",text:"retry",byOwner:true});
  expect(runtimeIssues(store)).toHaveLength(1);
 }finally{await messages.close();}
});

it("narrows a connector incident silently when one of its tools recovers",async()=>{
 const store=new Store(":memory:");stores.push(store);const root=store.primaryConversation();
 let turn:string[][]=[];
 const messages=new MessageService(store,{async run(_text,options){
  for(const [tool,status] of turn)options!.onEvent!({type:"item/completed",payload:{item:{type:"mcpToolCall",server:"calendar",tool,status,error:null}}});
  return{threadId:"t",response:"done",events:[]};
 }});
 const notices=()=>store.listMessages(root.id).filter(m=>m.kind==="notice").length;
 try{
  turn=[["list_events","failed"],["create_event","failed"]];await messages.handle({channel:"api",text:"a"});expect(notices()).toBe(1);
  turn=[["list_events","completed"]];await messages.handle({channel:"api",text:"b"});
  expect(notices()).toBe(1);expect(runtimeIssues(store)[0]?.tools).toEqual(["calendar.create_event"]);
  turn=[["delete_event","failed"]];await messages.handle({channel:"api",text:"c"});expect(notices()).toBe(2);
 }finally{await messages.close();}
});

it("retries an operational notice after Telegram recovers without replaying ordinary messages",async()=>{
 const store=new Store(":memory:");stores.push(store);
 store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});
 const messages=new MessageService(store,{async run(){throw Error("quota exceeded");}});
 const telegram=new TelegramAdapter("123:test",store,messages);messages.telegram=telegram;
 let offline=true;const sent:any[]=[];
 vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{if(offline)throw Error("network timeout");sent.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:sent.length}});}));
 try{
  await expect(messages.handle({channel:"api",text:"check"})).rejects.toThrow();
  await expect(telegram.sendMessage("42","Business message","ordinary")).rejects.toThrow();
  offline=false;await telegram.flushOwnerNotices();await telegram.flushOwnerNotices();
  expect(sent).toHaveLength(1);expect(sent[0].text).toContain("Аккаунт");
  expect(store.db.prepare("SELECT status FROM telegram_outbox WHERE key='42:ordinary:0'").get()?.status).toBe("unknown");
  expect(store.listMessages(store.primaryConversation().id).filter(m=>m.kind==="notice")).toHaveLength(1);
 }finally{telegram.stop();await messages.close();}
});

it.each([true,false])("delivers one failure to the paired owner and closes it silently, including root failures (%s)",async(rootFailure)=>{
 const store=new Store(":memory:");stores.push(store);
 store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});
 store.linkTelegramChat({chatId:"-100",title:"Team",allowedSenders:["42"]});
 store.linkTelegramChat({chatId:"55",title:"Unpaired",allowedSenders:[]});
 const conversation=rootFailure ? store.primaryConversation() : store.profileConversation(store.createProfile({name:"News",instructions:"news"}).id);
 let fail=true;
 const messages=new MessageService(store,{async run(){if(fail)throw Error("quota exceeded PRIVATE_SECRET");return{threadId:"t",response:"done",events:[]};}});
 const sent:any[]=[];
 vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{sent.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:sent.length}});}));
 const telegram=new TelegramAdapter("123:test",store,messages);messages.telegram=telegram;
 try {
  for(let i=0;i<2;i++)await expect(messages.handle({channel:"api",conversationId:conversation.id,text:"check",externalId:"fail-"+i})).rejects.toThrow();
  expect(sent).toHaveLength(1);expect(sent[0].chat_id).toBe("42");expect(sent[0].text).toContain("Аккаунт");expect(sent[0].text).not.toContain("PRIVATE_SECRET");
  fail=false;await messages.handle({channel:"api",conversationId:conversation.id,text:"check again"});
  expect(sent).toHaveLength(1);
  expect(runtimeIssues(store)).toEqual([]);
 }finally{telegram.stop();await messages.close();}
});

it("reports an uncertain scheduled delivery without replaying it or losing the saved answer",async()=>{
 const store=new Store(":memory:");stores.push(store);
 const messages=new MessageService(store,{async run(){return{threadId:"t",response:"Ready edition",events:[]};}});
 const root=store.primaryConversation(),scheduler=new Scheduler(store,messages);
 store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});
 scheduler.deliver=vi.fn(async()=>{throw Error("Lost acknowledgement");});
 scheduler.save({conversationId:root.id,name:"Daily",prompt:"Read sources",cron:"0 9 * * *",timezone:"Europe/Moscow",delivery:"telegram",telegramChatId:"42"},new Date("2026-10-20T05:00:00Z"));
 try {
  await scheduler.tick(new Date("2026-10-20T06:00:00Z"));await scheduler.idle();
  expect(scheduler.runs(root.id)[0]?.status).toBe("uncertain");expect(runtimeIssues(store)[0]?.code).toBe("delivery");
  expect(store.listMessages(root.id).some(m=>m.text==="Ready edition")).toBe(true);
  await scheduler.tick(new Date("2026-10-20T06:01:00Z"));await scheduler.idle();expect(scheduler.deliver).toHaveBeenCalledTimes(1);
 }finally{await messages.close();}
});

it("does not report an owner-cancelled schedule as an outage",async()=>{
 const store=new Store(":memory:");stores.push(store);const root=store.primaryConversation();
 let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);
 const messages=new MessageService(store,{run:async(_text,options)=>new Promise((_resolve,reject)=>{options!.signal!.addEventListener("abort",()=>reject(Error("cancelled")),{once:true});started();})});
 const scheduler=new Scheduler(store,messages);
 scheduler.save({conversationId:root.id,name:"Daily",prompt:"Read sources",cron:"0 9 * * *",timezone:"Europe/Moscow"},new Date("2026-10-20T05:00:00Z"));
 try {
  await scheduler.tick(new Date("2026-10-20T06:00:00Z"));await ready;
  const inbound=store.db.prepare("SELECT id FROM messages WHERE direction='inbound' ORDER BY rowid DESC LIMIT 1").get()!;
  messages.cancel(root.id,String(inbound.id));await scheduler.idle();
  expect(scheduler.runs(root.id)[0]?.status).toBe("failed");expect(runtimeIssues(store)).toEqual([]);
 }finally{await messages.close();}
});

it("recognizes sandbox exhaustion inside native code-mode outputs without treating ordinary grep misses as outages",()=>{
  expect(toolProblem({type:"item/completed",payload:{item:{type:"functionCallOutput",name:"exec",output:[{type:"input_text",text:JSON.stringify({exit_code:1,output:"bwrap: Creating new namespace failed: Resource temporarily unavailable"})}]}}})).toBe("resources");
  expect(toolProblem({type:"item/completed",payload:{item:{type:"commandExecution",exitCode:1,aggregatedOutput:""}}})).toBeUndefined();
  expect(toolProblem({type:"item/completed",payload:{item:{type:"agentMessage",text:"Resource temporarily unavailable"}}})).toBeUndefined();
});

it("shows a failed employee at the owner's root without leaking raw tool output, then resolves on a successful turn",async()=>{
  const store=new Store(":memory:");stores.push(store);
  const root=store.primaryConversation();const profile=store.createProfile({name:"Dates",instructions:"Dates"});
  let fail=true;
  const messages=new MessageService(store,{async run(_text,options){
    if(fail)options!.onEvent!({type:"item/completed",payload:{item:{type:"commandExecution",exitCode:1,aggregatedOutput:"bwrap: Creating new namespace failed: Resource temporarily unavailable PRIVATE_SECRET"}}});
    return{threadId:"thread",response:fail?"Cannot read rules":"done",events:[]};
  }});
  try {
    await expect(messages.handle({channel:"api",profile:profile.id,text:"check",externalId:"one"})).rejects.toThrow("ресурсов");
    expect(runtimeIssues(store)).toHaveLength(1);
    const notices=store.listMessages(root.id);
    expect(notices).toHaveLength(1);expect(notices[0]!.text).toContain("Dates");expect(notices[0]!.text).not.toContain("PRIVATE_SECRET");
    fail=false;await messages.handle({channel:"api",profile:profile.id,text:"check again",externalId:"two"});
    expect(runtimeIssues(store)).toHaveLength(0);
    expect(store.listMessages(root.id)).toHaveLength(1);
  }finally{await messages.close();}
});

it("reports infrastructure errors thrown before the model can reply",async()=>{
  const store=new Store(":memory:");stores.push(store);
  const profile=store.createProfile({name:"Worker",instructions:"work"});
  const messages=new MessageService(store,{async run(){throw Error("Codex не смог установить этот плагин");}});
  try{await expect(messages.handle({channel:"api",profile:profile.id,text:"go"})).rejects.toThrow();expect(runtimeIssues(store)[0]?.code).toBe("tools");}
  finally{await messages.close();}
});


it("accepts an actual successful native command after recovery and does not fail the whole task",async()=>{
 const store=new Store(":memory:");stores.push(store);
 const profile=store.createProfile({name:"Recover",instructions:"work"});
 const service=new MessageService(store,{async run(_text,options){
  options!.onEvent!({type:"item/completed",payload:{item:{type:"commandExecution",exitCode:1,aggregatedOutput:"Resource temporarily unavailable"}}});
  const recovered={type:"item/completed",payload:{item:{type:"functionCallOutput",name:"exec",output:[{text:JSON.stringify({exit_code:0,output:"file read"})}]}}};
  expect(toolRecovered(recovered)).toBe(true);options!.onEvent!(recovered);
  return{threadId:"t",response:"Read successfully",events:[]};
 }});
 try{expect((await service.handle({channel:"api",profile:profile.id,text:"read"})).text).toBe("Read successfully");expect(runtimeIssues(store)).toEqual([]);}
 finally{await service.close();}
});

it("can cancel a hidden scheduled turn without reporting an intentional cancellation as an incident",async()=>{
 const store=new Store(":memory:");stores.push(store);
 const c=store.primaryConversation();let started!:()=>void;const ready=new Promise<void>(r=>started=r);
 const service=new MessageService(store,{run:async(_text,options)=>new Promise((_resolve,reject)=>{options!.signal!.addEventListener("abort",()=>reject(Error("cancelled")),{once:true});started();})});
 try{
  const job=await service.submit({channel:"api",conversationId:c.id,text:"Scheduled work",scheduled:true});
  const completion=expect(job.completion).rejects.toThrow("cancelled");await ready;
  const row=store.db.prepare("SELECT id FROM messages WHERE direction='inbound' ORDER BY rowid DESC LIMIT 1").get()!;
  store.db.prepare("UPDATE messages SET hidden=1 WHERE id=?").run(row.id);
  service.cancel(c.id,String(row.id));await completion;
  expect(runtimeIssues(store)).toEqual([]);
 }finally{await service.close();}
});


it("does not mistake an ordinary network error for exhausted resources",()=>{
 const failed=(text:string)=>toolProblem({type:"item/completed",payload:{item:{type:"commandExecution",exitCode:1,aggregatedOutput:text}}});
 // Linux: 110 ETIMEDOUT, 111 ECONNREFUSED, 113 EHOSTUNREACH. Only 11 is EAGAIN.
 for(const text of ["Connection timed out (os error 110)","Connection refused (os error 111)","No route to host (os error 113)"])expect(failed(text)).toBeUndefined();
 expect(failed("Resource temporarily unavailable (os error 11)")).toBe("resources");
 expect(failed("spawn failed (os error 11)")).toBe("resources");
});

it("does not mistake a successfully read diagnostic log for a new infrastructure failure",()=>{
 expect(toolProblem({type:"item/completed",payload:{item:{type:"commandExecution",exitCode:0,aggregatedOutput:"Yesterday: Resource temporarily unavailable"}}})).toBeUndefined();
 expect(toolProblem({type:"item/completed",payload:{item:{type:"functionCallOutput",name:"exec",output:[{text:JSON.stringify({exit_code:0,output:"Yesterday: failed to fork"})}]}}})).toBeUndefined();
});

it("tells the owner once for each affected chat and again for a different cause",async()=>{
 const store=new Store(":memory:");stores.push(store);
 store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});
 const chats=["Familia","Wish","News"].map(name=>store.profileConversation(store.createProfile({name,instructions:name}).id));
 let error=Error("Лимит подключённых аккаунтов OpenAI закончился");
 const messages=new MessageService(store,{async run(){throw error;}});
 const sent:any[]=[];
 vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{sent.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:sent.length}});}));
 const telegram=new TelegramAdapter("123:test",store,messages);messages.telegram=telegram;
 try {
  for(const chat of chats)await expect(messages.handle({channel:"api",conversationId:chat.id,text:"go"})).rejects.toThrow();
  expect(sent).toHaveLength(3);expect(runtimeIssues(store)).toHaveLength(3);
  // A different cause is news again.
  error=Error("Не удалось запустить необходимый инструмент: failed to spawn code-mode");
  await expect(messages.handle({channel:"api",conversationId:chats[0]!.id,text:"go"})).rejects.toThrow();
  expect(sent).toHaveLength(4);
 }finally{telegram.stop();await messages.close();}
});

it('does not hide a real chat failure behind an earlier quota notice from another chat',async()=>{
 const {ProviderIncident}=await import('../src/providers.js');
 const store=new Store(':memory:');stores.push(store);store.linkTelegramChat({chatId:'42',title:'Owner',allowedSenders:['42']});
 const messages=new MessageService(store,{async run(){throw new ProviderIncident('У ключа Anthropic закончился лимит или баланс.',429,'limits:anthropic');}});
 const sent:any[]=[];vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{sent.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:sent.length}});}));
 const telegram=new TelegramAdapter('123:test',store,messages);messages.telegram=telegram;
 try {
  for(const title of ['Earlier test','Wai Reflections']){
   const chat=store.getOrCreateConversation({channel:'telegram',externalId:title,title});
   for(let i=0;i<2;i++)await expect(messages.handle({channel:'api',conversationId:chat.id,text:'check'})).rejects.toThrow();
  }
  expect(sent).toHaveLength(2);expect(sent[1].text).toContain('Wai Reflections');expect(sent[1].text).toContain('Anthropic');
  expect(store.listMessages(store.primaryConversation().id).filter(m=>m.kind==='notice')).toHaveLength(2);
 } finally {telegram.stop();await messages.close();}
});

it("keeps a failed daily edition open through unrelated quiet radar runs and owner replies",async()=>{
 const store=new Store(":memory:");stores.push(store);
 const conversation=store.profileConversation(store.createProfile({name:"News",instructions:"news"}).id);
 let failDaily=true;
 const messages=new MessageService(store,{async run(text){
  if(text.includes("Scheduled request: Daily edition") && failDaily)throw Error("upstream failed");
  return {threadId:"t",response:"NO_REPLY",events:[]};
 }});
 const scheduler=new Scheduler(store,messages);
 const before=new Date("2026-11-02T03:00:00Z");
 const daily=scheduler.save({conversationId:conversation.id,name:"Daily edition",prompt:"DAILY",cron:"0 7 * * *",timezone:"Europe/Moscow"},before);
 scheduler.save({conversationId:conversation.id,name:"Radar",prompt:"RADAR",cron:"*/15 8-22 * * *",timezone:"Europe/Moscow"},before);
 const notices=()=>store.listMessages(store.primaryConversation().id).filter(m=>m.kind==="notice");
 try {
  await scheduler.tick(new Date("2026-11-02T04:00:00Z"));await scheduler.idle();
  expect(notices()).toHaveLength(1);expect(notices()[0]!.text).toContain("Daily edition");
  await scheduler.tick(new Date("2026-11-02T05:00:00Z"));await scheduler.idle();
  await messages.handle({channel:"api",conversationId:conversation.id,text:"unrelated question",byOwner:true});
  expect(runtimeIssues(store)).toHaveLength(1);
  await scheduler.tick(new Date("2026-11-03T04:00:00Z"));await scheduler.idle();
  expect(notices()).toHaveLength(1);expect(runtimeIssues(store)).toHaveLength(1);
  failDaily=false;
  await scheduler.tick(new Date("2026-11-04T04:00:00Z"));await scheduler.idle();
  expect(scheduler.runs(conversation.id).find(r=>r.scheduleId===daily.id)?.status).toBe("quiet");
  expect(runtimeIssues(store)).toEqual([]);expect(notices()).toHaveLength(1);
  failDaily=true;
  await scheduler.tick(new Date("2026-11-05T04:00:00Z"));await scheduler.idle();
  expect(notices()).toHaveLength(2);
 } finally {await messages.close();}
});

it("does not treat a quiet conversational reply as recovery of a failed request",async()=>{
 const store=new Store(":memory:");stores.push(store);const conversation=store.primaryConversation();
 let response="fail";
 const messages=new MessageService(store,{async run(){if(response==="fail")throw Error("task failed");return {threadId:"t",response,events:[]};}});
 try {
  await expect(messages.handle({channel:"api",text:"do work"})).rejects.toThrow();
  response="NO_REPLY";await messages.handle({channel:"api",text:"unrelated context"});
  expect(runtimeIssues(store)).toHaveLength(1);
  response="done";await messages.handle({channel:"api",text:"try again"});
  expect(runtimeIssues(store)).toEqual([]);
  expect(store.listMessages(conversation.id).filter(m=>m.kind==="notice")).toHaveLength(1);
 } finally {await messages.close();}
});

it("preserves voice and uncertain delivery incidents independently of ordinary task recovery",()=>{
 const store=new Store(":memory:");stores.push(store);const conversation=store.primaryConversation();
 reportIssue(store,conversation.id,"voice-update","voice");
 reportIssue(store,conversation.id,"delivery-run","delivery");
 reportIssue(store,conversation.id,"failed-turn","execution");
 resolveIssue(store,conversation.id);
 expect(runtimeIssues(store).map(i=>i.code).sort()).toEqual(["delivery","voice"]);
 resolveVoiceIssue(store,conversation.id);
 expect(runtimeIssues(store).map(i=>i.code)).toEqual(["delivery"]);
 expect(reportIssue(store,conversation.id,"delivery-run-again","delivery")).toBeUndefined();
 expect(reportIssue(store,conversation.id,"voice-update-again","voice")).toBeDefined();
});

it("closes the Telegram voice incident only after recognition succeeds, even if the following task fails",async()=>{
 const store=new Store(":memory:");stores.push(store);
 store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});
 store.linkTelegramChat({chatId:"-100",title:"Reflections",allowedSenders:["42"]});store.connectTelegramGroup("-100");
 let executionFails=false,recognitionFails=true;
 const messages=new MessageService(store,{async run(){if(executionFails)throw Error("task failed");return {threadId:"t",response:"done",events:[]};}});
 const telegram=new TelegramAdapter("123:test",store,messages);messages.telegram=telegram;
 telegram.transcribe=async()=>{if(recognitionFails)throw Error("Речь не распознана");return "recognized words";};
 vi.stubGlobal("fetch",vi.fn(async(url)=>{
  if(String(url).includes("/file/"))return new Response(new Uint8Array([1,2,3]));
  return Response.json({ok:true,result:String(url).endsWith("/getFile")?{file_path:"voices/note.ogg"}:{message_id:99}});
 }));
 const send=(id:number,media:object)=>telegram.processUpdate({update_id:id,message:{message_id:id,from:{id:42},chat:{id:-100,type:"group"},...media}});
 try {
  await send(1,{voice:{file_id:"one",file_size:3}});
  expect(runtimeIssues(store).map(i=>i.code)).toEqual(["voice"]);
  await send(2,{text:"unrelated text"});
  expect(runtimeIssues(store).map(i=>i.code)).toEqual(["voice"]);
  recognitionFails=false;executionFails=true;
  await send(3,{voice:{file_id:"two",file_size:3}});
  expect(runtimeIssues(store).map(i=>i.code)).toEqual(["execution"]);
 } finally {telegram.stop();await messages.close();}
});

it("retains a legacy scheduled incident through an unrelated successful turn without alerting again",async()=>{
 const store=new Store(":memory:");stores.push(store);
 const conversation=store.primaryConversation(),messages=new MessageService(store,{async run(){return {threadId:"t",response:"done",events:[]};}});
 const scheduler=new Scheduler(store,messages);
 const schedule=scheduler.save({conversationId:conversation.id,name:"Daily",prompt:"Read sources",cron:"0 9 * * *",timezone:"Europe/Moscow"});
 const original=store.addMessage({conversationId:conversation.id,channel:"api",direction:"inbound",text:"scheduled",externalId:"schedule:old-run"});
 store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at) VALUES(?,?,?,?,?,?)")
  .run("old-run",schedule.id,conversation.id,"2026-11-01T06:00:00Z","failed","2026-11-01T06:00:00Z");
 store.setSetting("runtime.issue."+conversation.id,JSON.stringify({conversationId:conversation.id,messageId:original.id,title:"News",code:"execution",time:"2026-11-01T06:05:00Z"}));
 try {
  await messages.handle({channel:"api",conversationId:conversation.id,text:"unrelated"});
  expect(runtimeIssues(store)).toHaveLength(1);
  expect(reportIssue(store,conversation.id,original.id,"execution")).toBeUndefined();
  resolveIssue(store,conversation.id,original.id);
  expect(runtimeIssues(store)).toEqual([]);
 } finally {await messages.close();}
});
