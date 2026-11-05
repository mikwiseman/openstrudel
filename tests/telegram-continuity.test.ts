import { afterEach,expect,it,vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Scheduler } from "../src/scheduler.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter } from "../src/telegram.js";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { MockCodexEngine } from "../src/codex.js";
import { AccountUnavailableError } from "../src/account-errors.js";
import { ProviderKeyError, providerFailure, providerInfo, providerNotConnected } from "../src/providers.js";
import { runtimeIssues } from "../src/operations.js";
const stores:Store[]=[];
const deliveryCalls=()=>vi.mocked(fetch).mock.calls.filter(([url])=>!String(url).endsWith("/sendChatAction"));
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();for(const s of stores.splice(0))s.close();});
function setup() {
 const s=new Store(":memory:");stores.push(s);const run=vi.fn(async()=>({threadId:"one",response:"**Done**",events:[]}));
 const m=new MessageService(s,{run});const a=new TelegramAdapter("123:test",s,m);
 s.linkTelegramChat({chatId:"-100",title:"Group",allowedSenders:["7"]});
 vi.stubGlobal("fetch",vi.fn(async()=>Response.json({ok:true,result:{message_id:99}})));
 return {s,m,a,run};
}
it("keeps a scheduled clarification reply with its employee after a runtime restart", async () => {
 const s=new Store(":memory:");stores.push(s);
 s.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});
 const profile=s.createProfile({name:"Юрист",instructions:"Review the owner's agreements"}),chat=s.profileConversation(profile.id);
 const question="Не нашёл BBF в каталоге клиентов. Где искать договор: под другим названием или по ссылке? Можно прислать файл сюда.";
 const m=new MessageService(s,{async run(_text,options){
  options!.onEvent!({type:"item/completed",payload:{item:{type:"mcpToolCall",server:"company",tool:"company_client_files_list",status:"completed",result:{structuredContent:{found:false,clientQuery:"BBF",ambiguous:false,matches:[]}}}}});
  return {threadId:"legal-thread",response:question,events:[]};
 }});
 vi.stubGlobal("fetch",vi.fn(async()=>Response.json({ok:true,result:{message_id:99}})));
 const a=new TelegramAdapter("123:test",s,m);m.telegram=a;
 const scheduler=new Scheduler(s,m);scheduler.deliver=(chatId,text,key)=>a.sendMessage(chatId,text,key);
 scheduler.save({conversationId:chat.id,name:"Review",prompt:"Check BBF agreements",cron:"@once 2030-01-15T09:00:00Z",timezone:"UTC",delivery:"telegram",telegramChatId:"42"},new Date("2030-01-15T08:00:00Z"));
 await scheduler.tick(new Date("2030-01-15T09:00:00Z"));await scheduler.idle();
 expect(scheduler.runs(chat.id)[0]?.status).toBe("completed");
 expect(runtimeIssues(s)).toEqual([]);
 expect(deliveryCalls()).toHaveLength(1);
 expect(JSON.parse(String(deliveryCalls()[0]![1]!.body)).text).toContain(question);
 a.stop();await m.close();

 const run=vi.fn(async()=>({threadId:"legal-thread",response:"Проверю договор по этой ссылке.",events:[]}));
 const resumed=new MessageService(s,{run}),telegram=new TelegramAdapter("123:test",s,resumed);
 try {
  await telegram.processUpdate({update_id:200,message:{message_id:200,from:{id:42},chat:{id:42,type:"private"},reply_to_message:{message_id:99,from:{id:123,is_bot:true}},text:"Договор здесь: https://example.test/bbf.pdf"}});
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[1]).toMatchObject({conversationId:chat.id,threadId:"legal-thread",profile:expect.stringContaining("Юрист")});
  expect(run.mock.calls[0]?.[0]).toContain("https://example.test/bbf.pdf");
  expect(s.listMessages(chat.id).map(message=>message.text)).toContain("Договор здесь: https://example.test/bbf.pdf");
  expect(runtimeIssues(s)).toEqual([]);
  expect(s.getTelegramChat("42")?.profileId).toBeNull();
  await telegram.processUpdate({update_id:201,message:{message_id:201,from:{id:42},chat:{id:42,type:"private"},reply_to_message:{message_id:999,from:{id:123,is_bot:true}},text:"Unrelated reply"}});
  expect(run.mock.calls[1]?.[1]?.conversationId).not.toBe(chat.id);
 } finally {telegram.stop();await resumed.close();}
});
it("never shows a group an account incident and tells the owner privately once until recovery", async () => {
 const {s,m,a,run}=setup();s.setSetting("telegram.bot_username","core_bot");m.telegram=a;
 s.linkTelegramChat({chatId:"42",title:"Mik",allowedSenders:["42"]});
 s.bindTelegramChat("-100",s.createProfile({name:"Core"}).id);
 run.mockRejectedValue(new AccountUnavailableError("limits"));
 const update=(id:number,text:string,chat=-100,from=7)=>({update_id:id,message:{message_id:id,from:{id:from},chat:{id:chat,type:chat<0?"group":"private"},text}});
 const sent=()=>deliveryCalls().map(c=>JSON.parse(String(c[1]!.body))).map(b=>({chat:String(b.chat_id),text:String(b.text)}));
 await a.processUpdate(update(1,"ordinary conversation"));
 await a.processUpdate(update(2,"@core_bot check"));
 await a.processUpdate(update(3,"@core_bot second attachment"));
 expect(sent().filter(x=>x.chat==="-100")).toEqual([]);
 expect(sent()).toHaveLength(1);
 expect(sent()[0]).toMatchObject({chat:"42",text:expect.stringContaining("Требует внимания")});
 expect(s.listMessages(s.getTelegramChat("-100")!.conversationId!).filter(m=>m.status==="failed")).toHaveLength(3);
 // The owner's own chat still shows its failure directly, without a duplicate notice.
 await a.processUpdate(update(4,"hello",42,42));
 expect(sent().filter(x=>x.chat==="42").map(x=>x.text)).toEqual([expect.stringContaining("Требует внимания"),expect.stringContaining("Лимит")]);
 run.mockResolvedValue({threadId:"one",response:"NO_REPLY",events:[]});
 await a.processUpdate(update(5,"ordinary conversation after recovery"));
 run.mockRejectedValue(new AccountUnavailableError("sign_in_required"));
 await a.processUpdate(update(6,"@core_bot hello"));
 expect(sent().filter(x=>x.chat==="-100").map(x=>x.text)).toEqual([]);
 await m.close();
});
it("keeps a key provider incident out of the group and out of other people's private chats",async()=>{
 const {s,m,a,run}=setup();s.setSetting("telegram.bot_username","core_bot");m.telegram=a;
 s.linkTelegramChat({chatId:"42",title:"Mik",allowedSenders:["42"]});
 s.bindTelegramChat("-100",s.createProfile({name:"Core"}).id);
 const update=(id:number,text:string)=>({update_id:id,message:{message_id:id,from:{id:7},chat:{id:-100,type:"group"},text}});
 const sent=()=>deliveryCalls().map(c=>JSON.parse(String(c[1]!.body))).map(b=>({chat:String(b.chat_id),text:String(b.text)}));
 run.mockRejectedValue(new ProviderKeyError(providerInfo("anthropic")!));
 await a.processUpdate(update(1,"ordinary conversation"));
 await a.processUpdate(update(2,"@core_bot check"));
 run.mockRejectedValue(providerFailure(providerInfo("anthropic")!,new Error("429 rate_limit_error")));
 await a.processUpdate(update(3,"@core_bot limits"));
 run.mockRejectedValue(providerNotConnected("anthropic"));
 await a.processUpdate(update(4,"@core_bot moved"));
 expect(sent().filter(x=>x.chat!=="42")).toEqual([]);
 expect(sent().length).toBeGreaterThan(0);
 await m.close();
});
it("restricts a linked group to its approved senders",async()=>{
 const {s,m,a,run}=setup();const p=s.createProfile({name:"News"});s.bindTelegramChat("-100",p.id);
 await a.processUpdate({update_id:1,message:{message_id:1,from:{id:8},chat:{id:-100,type:"group"},text:"change everything"}});
 expect(run).not.toHaveBeenCalled();
 await a.processUpdate({update_id:2,message:{message_id:2,from:{id:7},chat:{id:-100,type:"group"},text:"Hello"}});
 expect(s.listMessages(s.getTelegramChat("-100")!.conversationId!)).toHaveLength(2);await m.close();
});
it.each(["Разрешить", "Отказать"])("routes MCP approval to its group and original sender: %s", async decision => {
 const s=new Store(":memory:");stores.push(s);
 s.linkTelegramChat({chatId:"-100",title:"Core",allowedSenders:["7","8"]});
 s.bindTelegramChat("-100",s.createProfile({name:"Core"}).id);
 const executed=vi.fn();
 const m=new MessageService(s,{async run(_text,options){
  const answer=await options!.onRequest!("mcpServer/elicitation/request",{
   mode:"form",serverName:"service",message:"Run the test action?",_meta:{codex_approval_kind:"mcp_tool_call",tool_params:{target:"Test record"}},requestedSchema:{type:"object",properties:{}}
  }) as {action:string};
  if(answer.action==="accept")executed();
  return {threadId:"core",response:answer.action,events:[]};
 }});
 const sent:Array<any>=[];
 vi.stubGlobal("fetch",vi.fn(async(_url:string,init:RequestInit)=>{sent.push(JSON.parse(String(init.body)));return Response.json({ok:true,result:{message_id:99}});}));
 const a=new TelegramAdapter("123:test",s,m);
 const turn=a.processUpdate({update_id:200,message:{message_id:200,from:{id:7},chat:{id:-100,type:"group"},text:"Test action"}});
 await vi.waitFor(()=>expect(sent.some(s=>s.reply_markup?.inline_keyboard)).toBe(true));
 const card=sent.find(s=>s.reply_markup?.inline_keyboard);
 expect(card.chat_id).toBe("-100");expect(card.text).toContain("Test record");expect(executed).not.toHaveBeenCalled();
 const data=card.reply_markup.inline_keyboard.flat().find((button:any)=>button.text===decision).callback_data;
 const callback=(id:number,who:number,chat=-100)=>({update_id:id,callback_query:{id:String(id),from:{id:who},data,message:{message_id:99,chat:{id:chat}}}});
 await a.processUpdate(callback(201,7,-101));await a.processUpdate(callback(202,8));
 expect(m.interactions.list(s.getTelegramChat("-100")!.conversationId!)).toHaveLength(1);
 expect(sent.some(s=>s.text==="Подтвердить может тот, кто дал поручение")).toBe(true);
 await a.processUpdate(callback(203,7));await turn;
 expect(executed).toHaveBeenCalledTimes(decision==="Разрешить"?1:0);
 await a.processUpdate(callback(204,7));
 expect(sent.at(-2).text).toBe("Этот запрос уже завершён");
 expect(executed).toHaveBeenCalledTimes(decision==="Разрешить"?1:0);
 await m.close();
});
it("does not offer confirmation for truncated action details in Telegram", async () => {
 const {s,m}=setup();s.bindTelegramChat("-100",s.createProfile({name:"Core"}).id);
 const c=s.getTelegramChat("-100")!.conversationId!;
 const input=s.addMessage({conversationId:c,channel:"telegram",direction:"inbound",text:"test",externalId:"-100:20"});
 const result=m.interactions.ask({conversationId:c,messageId:input.id,title:"Approve?",detail:"A".repeat(5000),questions:[{id:"decision",question:"",options:["Разрешить","Отказать"]}]});
 await vi.waitFor(()=>expect(fetch).toHaveBeenCalled());
 const body=JSON.parse(String(deliveryCalls()[0]![1]!.body));
 expect(body.text).toContain("Полное описание");expect(body.reply_markup.inline_keyboard).toEqual([]);
 m.interactions.cancelMessage(input.id);await expect(result).rejects.toThrow();await m.close();
});
it("does not resend a delivery whose response was lost",async()=>{
 const {a}=setup();vi.stubGlobal("fetch",vi.fn(async()=>{throw new Error("connection lost");}));
 await expect(a.sendMessage(-100,"Hello","same-reply")).rejects.toThrow();
 await expect(a.sendMessage(-100,"Hello","same-reply")).rejects.toThrow();
 expect(deliveryCalls()).toHaveLength(1);
});
it("keeps NO_REPLY internal in groups, including replay after restart", async () => {
 const {s,m,a,run}=setup();
 s.bindTelegramChat("-100",s.createProfile({name:"Core",instructions:"In the group, stay silent unless addressed."}).id);
 run.mockResolvedValue({threadId:"one",response:"NO_REPLY",events:[]});
 const update={update_id:42,message:{message_id:42,from:{id:7,first_name:"Dasha"},chat:{id:-100,type:"group",title:"Core"},text:"See you on Monday"}};
 await a.processUpdate(update);
 expect(deliveryCalls()).toHaveLength(0);
 expect(s.listMessages(s.getTelegramChat("-100")!.conversationId!).map(m=>m.text)).toEqual(["See you on Monday"]);
 await a.processUpdate(update);
 expect(run).toHaveBeenCalledTimes(1); expect(deliveryCalls()).toHaveLength(0);
 expect(run.mock.calls[0]?.[1]).toMatchObject({profile:expect.stringContaining('Telegram group "Core"')});
 await m.close();
});
it("recognizes a reply to the same bot from before the migration", async () => {
 const {s,m,a,run}=setup(); s.setSetting("telegram.bot_username","core_bot");
 s.bindTelegramChat("-100",s.createProfile({name:"Core"}).id);
 await a.processUpdate({update_id:43,message:{message_id:43,from:{id:7},chat:{id:-100,type:"group"},text:"Yes",reply_to_message:{message_id:11,from:{id:123,is_bot:true,username:"core_bot"}}}});
 expect(run.mock.calls[0]?.[0]).toContain('"replyToAssistant":true');
 expect(run.mock.calls[0]?.[1]).toMatchObject({telegramActor:{userId:"7",chatId:"-100",messageId:"-100:43"}});
 expect(deliveryCalls()).toHaveLength(1); await m.close();
});
it("retries a confirmed Telegram rate rejection after retry_after",async()=>{
 const {a,s}=setup();vi.useFakeTimers();
 const send=vi.fn()
  .mockResolvedValueOnce(Response.json({ok:false,error_code:429,parameters:{retry_after:2},description:"Too Many Requests"},{status:429}))
  .mockResolvedValueOnce(Response.json({ok:true,result:{message_id:99}}));
 vi.stubGlobal("fetch",send);
 const delivery=a.sendMessage(-100,"Hello","throttled");
 await vi.advanceTimersByTimeAsync(1999);expect(send).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(1);await delivery;
 expect(send).toHaveBeenCalledTimes(2);
 expect(s.db.prepare("SELECT status FROM telegram_outbox").get()?.status).toBe("delivered");
});
it("keeps group replies with its bound employee even when an old digest came from another",async()=>{
 const {s,m,a,run}=setup();const scheduler=new Scheduler(s,m);
 const baby=s.createProfile({name:"Baby"});const news=s.createProfile({name:"News"});
 s.bindTelegramChat("-100",news.id);
 const babyChat=s.profileConversation(baby.id);
 const schedule=scheduler.save({conversationId:babyChat.id,name:"Baby edition",prompt:"Digest",cron:"0 6 * * *",timezone:"Europe/Moscow",telegramChatId:"-100"},new Date("2026-09-26T10:00:00Z"));
 s.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at) VALUES(?,?,?,?,?,?)").run("baby-run",schedule.id,babyChat.id,"2026-09-27T03:00:00.000Z","completed","2026-09-27T03:00:00.000Z");
 await a.sendMessage(-100,"Baby edition","schedule:baby-run");
 await a.processUpdate({update_id:5,message:{message_id:5,from:{id:7},chat:{id:-100,type:"group"},reply_to_message:{message_id:99},text:"Continue that edition"}});
 expect(run.mock.calls[0]?.[1]).toMatchObject({profile:expect.stringContaining("News")});
 expect(s.listMessages(babyChat.id)).toHaveLength(0);
 expect(s.listConversations().filter(c=>c.externalId===`-100::employee::${baby.id}`)).toHaveLength(0);
 expect(s.getTelegramChat("-100")?.profileId).toBe(news.id);await m.close();
});
it.each(["voice", "audio", "video_note", "video", "document"] as const)("transcribes %s before later text in the same chat",async(kind)=>{
 const {a,run,m,s}=setup();let finish!:(v:string)=>void;
 s.bindTelegramChat("-100",s.createProfile({name:"Voice"}).id);
 a.transcribe=()=>new Promise(r=>{finish=r;});
 vi.stubGlobal("fetch",vi.fn(async(url:string)=>url.includes("/file/") ? new Response(new Uint8Array([1,2])) : Response.json({ok:true,result:url.endsWith("getFile")?{file_path:"voice/file.mp4",file_size:2}:{message_id:99}})));
 const first=a.processUpdate({update_id:3,message:{message_id:3,from:{id:7},chat:{id:-100,type:"group"},[kind]:{file_id:"voice",file_size:2,...(kind==="document"?{file_name:"recording.m4a",mime_type:"audio/mp4"}:{})}}});
 await vi.waitFor(()=>expect(finish).toBeDefined());
 const second=a.processUpdate({update_id:4,message:{message_id:4,from:{id:7},chat:{id:-100,type:"group"},text:"Second"}});
 finish("First");await Promise.all([first,second]);
 expect(run.mock.calls.map(c=>c[0])).toEqual([expect.stringContaining("\n\nFirst"),expect.stringContaining("\n\nSecond")]);await m.close();
});

it("publishes the transcript before model work and still answers if its preview delivery is uncertain", async () => {
 const {a,run,m,s}=setup();s.bindTelegramChat("-100",s.createProfile({name:"Voice"}).id);
 a.transcribe=vi.fn(async()=>"Расшифровка записи");const events:string[]=[];
 vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{
   if(url.includes("/file/"))return new Response(new Uint8Array([1]));
   if(url.endsWith("getFile"))return Response.json({ok:true,result:{file_path:"voice.ogg",file_size:1}});
   if(url.endsWith("sendChatAction"))return Response.json({ok:true,result:true});
   const body=JSON.parse(String(init.body));events.push(body.text);
   if(body.text.startsWith("📝"))throw new Error("Response lost after send");
   return Response.json({ok:true,result:{message_id:99}});
 }));
 run.mockImplementation(async()=>{events.push("model started");return {threadId:"one",response:"Ответ",events:[]};});
 const update={update_id:12,message:{message_id:12,from:{id:7},chat:{id:-100,type:"group"},voice:{file_id:"v",file_size:1}}};
 await a.processUpdate(update);await a.processUpdate(update);
 expect(events).toEqual(["📝 Расшифровка записи","model started","Ответ"]);
 expect(a.transcribe).toHaveBeenCalledTimes(1);expect(run).toHaveBeenCalledTimes(1);
 expect(s.listMessages(s.getTelegramChat("-100")!.conversationId!)[0]!.text).toBe("Расшифровка записи");
 expect(s.getSetting("telegram.transcript.12")).toBeNull();await m.close();
});

it("keeps a context-only recording quiet and never previews into a changed audience", async()=>{
 const {a,run,m,s}=setup();s.bindTelegramChat("-100",s.createProfile({name:"Voice"}).id);
 s.setSetting("telegram.bot_username","core_bot");s.db.prepare("UPDATE telegram_chats SET replies='mentions'").run();
 a.transcribe=vi.fn(async()=>"Слова для контекста");const sent:string[]=[];
 vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{
   if(url.includes("/file/"))return new Response(new Uint8Array([1]));
   if(url.endsWith("getFile"))return Response.json({ok:true,result:{file_path:"voice.ogg",file_size:1}});
   if(url.endsWith("sendChatAction"))return Response.json({ok:true,result:true});
   sent.push(JSON.parse(String(init.body)).text);return Response.json({ok:true,result:{message_id:99}});
 }));
 await a.processUpdate({update_id:13,message:{message_id:13,from:{id:7},chat:{id:-100,type:"group"},voice:{file_id:"v",file_size:1}}});
 expect(sent).toEqual([]);expect(run).not.toHaveBeenCalled();
 s.db.prepare("UPDATE telegram_chats SET replies='instructions'").run();
 a.transcribe=async()=>{s.bindTelegramChat("-100",s.createProfile({name:"Changed"}).id);return "Private audio";};
 await a.processUpdate({update_id:14,message:{message_id:14,from:{id:7},chat:{id:-100,type:"group"},voice:{file_id:"v2",file_size:1}}});
 expect(sent).toEqual([]);expect(run).not.toHaveBeenCalled();await m.close();
});

it("tells the owner a group recording was not recognized without blaming a speech provider",async()=>{
 vi.stubEnv("OPENSTRUDEL_STT_URL","https://stt.example.test");vi.stubEnv("OPENSTRUDEL_STT_KEY","server-test-key");
 const {a,run,m,s}=setup();m.telegram=a;s.bindTelegramChat("-100",s.createProfile({name:"Voice"}).id);
 s.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});const sent:Array<{chat:string;text:string}>=[];
 vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{
   // The Home's own speech server hears music, not words.
   if(url==="https://stt.example.test/v1/speech-to-text")return Response.json({text:""});
   if(url.includes("/file/"))return new Response(new Uint8Array([1]));
   if(url.endsWith("getFile"))return Response.json({ok:true,result:{file_path:"voice/file.oga",file_size:1}});
   if(url.endsWith("sendMessage")){const body=JSON.parse(String(init.body));sent.push({chat:String(body.chat_id),text:String(body.text)});}
   return Response.json({ok:true,result:{message_id:99}});
 }));
 await a.processUpdate({update_id:15,message:{message_id:15,from:{id:7},chat:{id:-100,type:"group"},voice:{file_id:"v",file_size:1}}});
 expect(run).not.toHaveBeenCalled();
 expect(s.listMessages(s.getTelegramChat("-100")!.conversationId!)).toMatchObject([{status:"failed",error:"Речь не распознана. Попробуйте записать сообщение ещё раз."}]);
 expect(sent).toEqual([{chat:"42",text:"Требует внимания · Group\nЗапись не распознана. Подробности сохранены в исходном чате."}]);await m.close();
});

it("delivers the bound employee's approval to its originating private chat", async () => {
 const s=new Store(":memory:");stores.push(s);
 const news=s.createProfile({name:"News"});const editor=s.createProfile({name:"Editor"});
 s.linkTelegramChat({chatId:"42",title:"Personal",allowedSenders:["42"]});s.bindTelegramChat("42",news.id);
 const m=new MessageService(s,{async run(_text,options){
  const answer=await options!.onRequest!("item/commandExecution/requestApproval",{command:"test-only action"}) as {decision:string};
  return {threadId:"editor",response:answer.decision,events:[]};
 }});
 const sent:Array<any>=[];
 vi.stubGlobal("fetch",vi.fn(async(_url:string,init:RequestInit)=>{
  sent.push(JSON.parse(String(init.body)));return Response.json({ok:true,result:{message_id:99}});
 }));
 const a=new TelegramAdapter("123:test",s,m);
 const turn=a.processUpdate({update_id:80,message:{message_id:80,from:{id:42},chat:{id:42,type:"private"},text:"@Editor Ask approval"}});
 await vi.waitFor(()=>expect(sent.some(s=>s.reply_markup?.inline_keyboard)).toBe(true));
 const card=sent.find(s=>s.reply_markup?.inline_keyboard);
 expect(card.chat_id).toBe("42");
 expect(m.interactions.list(s.profileConversation(news.id).id)).toHaveLength(1);
 await a.processUpdate({update_id:81,callback_query:{id:"decline",from:{id:42},data:card.reply_markup.inline_keyboard[1][0].callback_data,message:{message_id:99,chat:{id:42}}}});
 await turn;
 expect(sent.some(s=>s.text==="decline")).toBe(true);
 expect(s.getTelegramChat("42")?.profileId).toBe(news.id);
 await m.close();
});

it("keeps a private chat answering after it returns to the main assistant", async () => {
 const {s,m,a,run}=setup();const editor=s.createProfile({name:"Editor"});
 s.linkTelegramChat({chatId:"42",title:"Personal",allowedSenders:["42"]});
 const update=(id:number)=>({update_id:id,message:{message_id:id,from:{id:42},chat:{id:42,type:"private"},text:"Hello "+id}});
 await a.processUpdate(update(1));
 const direct=s.getTelegramChat("42")!.conversationId;
 a.bindChat("42",editor.id);a.bindChat("42",null);
 await a.processUpdate(update(2));
 expect(run.mock.calls.at(-1)?.[0]).toContain("Hello 2");
 expect(s.getTelegramChat("42")).toMatchObject({enabled:true,profileId:null,conversationId:direct});
 // An «Отвязать» from an older app left the chat paused; choosing the main assistant clears it.
 s.setSetting("telegram.paused.42","true");a.bindChat("42",null);
 expect(s.getTelegramChat("42")?.enabled).toBe(true);
 await m.close();
});

it("tells the app it may offer the private-chat choice, and the owner's switch back keeps the chat answering", async () => {
 const runtime=new OpenStrudelRuntime({dbPath:":memory:",engine:new MockCodexEngine(),startTelegram:false});
 const {port}=await runtime.api.listen("127.0.0.1",0);
 const call=async(path:string,body?:unknown)=>(await fetch(`http://127.0.0.1:${port}${path}`,{method:body===undefined?"GET":"PATCH",headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)})).json();
 try {
  // Older Homes pause the chat on the switch back, so the app shows the choice only with this flag.
  expect(await call("/health")).toMatchObject({telegramPrivateChoiceVersion:1});
  runtime.store.linkTelegramChat({chatId:"42",title:"Personal",allowedSenders:["42"]});
  const editor=runtime.store.createProfile({name:"Editor"});
  expect((await call("/v1/integrations/telegram/chats/42",{profileId:editor.id})).telegram.chats[0]).toMatchObject({profileId:editor.id,enabled:true});
  expect((await call("/v1/integrations/telegram/chats/42",{profileId:null})).telegram.chats[0]).toMatchObject({profileId:null,enabled:true});
 } finally { await runtime.stop(); }
});

it("answers again in a private chat that an older app paused, and keeps a paused group quiet", () => {
 const dir=mkdtempSync(join(tmpdir(),"strudel-paused-")),file=join(dir,"db.sqlite");
 const old=new Store(file);
 old.linkTelegramChat({chatId:"42",title:"Personal",allowedSenders:["42"]});old.linkTelegramChat({chatId:"-100",title:"Group",allowedSenders:["42"]});
 old.setSetting("telegram.paused.42","true");old.setSetting("telegram.paused.-100","true");old.close();
 const s=new Store(file);
 expect(s.getTelegramChat("42")?.enabled).toBe(true);
 expect(s.getTelegramChat("-100")?.enabled).toBe(false);
 s.close();rmSync(dir,{recursive:true,force:true});
});
