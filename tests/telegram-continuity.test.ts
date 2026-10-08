import { afterEach,expect,it,vi } from "vitest";
import { Store } from "../src/store.js";
import { Scheduler } from "../src/scheduler.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter } from "../src/telegram.js";
import { AccountUnavailableError } from "../src/account-errors.js";
const stores:Store[]=[];
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();for(const s of stores.splice(0))s.close();});
function setup() {
 const s=new Store(":memory:");stores.push(s);const run=vi.fn(async()=>({threadId:"one",response:"**Done**",events:[]}));
 const m=new MessageService(s,{run});const a=new TelegramAdapter("123:test",s,m);
 s.linkTelegramChat({chatId:"-100",title:"Group",allowedSenders:["7"]});
 vi.stubGlobal("fetch",vi.fn(async()=>Response.json({ok:true,result:{message_id:99}})));
 return {s,m,a,run};
}
it("keeps ordinary group chatter quiet during an account incident and sends one actionable notice until recovery", async () => {
 const {s,m,a,run}=setup();s.setSetting("telegram.bot_username","core_bot");
 s.bindTelegramChat("-100",s.createProfile({name:"Core"}).id);
 run.mockRejectedValue(new AccountUnavailableError("limits"));
 const update=(id:number,text:string)=>({update_id:id,message:{message_id:id,from:{id:7},chat:{id:-100,type:"group"},text}});
 await a.processUpdate(update(1,"ordinary conversation"));
 expect(fetch).not.toHaveBeenCalled();
 await a.processUpdate(update(2,"@core_bot check"));
 await a.processUpdate(update(3,"@core_bot second attachment"));
 expect(fetch).toHaveBeenCalledTimes(1);
 expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)).text).toContain("Лимит");
 expect(s.listMessages(s.getTelegramChat("-100")!.conversationId!).filter(m=>m.status==="failed")).toHaveLength(3);
 // Restart retains the incident; successful processing resets it.
 const restarted=new TelegramAdapter("123:test",s,m);
 await restarted.processUpdate(update(4,"@core_bot still waiting"));expect(fetch).toHaveBeenCalledTimes(1);
 run.mockResolvedValue({threadId:"one",response:"NO_REPLY",events:[]});
 await restarted.processUpdate(update(5,"ordinary conversation after recovery"));
 run.mockRejectedValue(new AccountUnavailableError("sign_in_required"));
 await restarted.processUpdate(update(6,"@core_bot hello"));expect(fetch).toHaveBeenCalledTimes(2);
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
 const body=JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body));
 expect(body.text).toContain("Полное описание");expect(body.reply_markup.inline_keyboard).toEqual([]);
 m.interactions.cancelMessage(input.id);await expect(result).rejects.toThrow();await m.close();
});
it("does not resend a delivery whose response was lost",async()=>{
 const {a}=setup();vi.stubGlobal("fetch",vi.fn(async()=>{throw new Error("connection lost");}));
 await expect(a.sendMessage(-100,"Hello","same-reply")).rejects.toThrow();
 await expect(a.sendMessage(-100,"Hello","same-reply")).rejects.toThrow();
 expect(fetch).toHaveBeenCalledTimes(1);
});
it("keeps NO_REPLY internal in groups, including replay after restart", async () => {
 const {s,m,a,run}=setup();
 s.bindTelegramChat("-100",s.createProfile({name:"Core",instructions:"In the group, stay silent unless addressed."}).id);
 run.mockResolvedValue({threadId:"one",response:"NO_REPLY",events:[]});
 const update={update_id:42,message:{message_id:42,from:{id:7,first_name:"Dasha"},chat:{id:-100,type:"group",title:"Core"},text:"See you on Monday"}};
 await a.processUpdate(update);
 expect(fetch).not.toHaveBeenCalled();
 expect(s.listMessages(s.getTelegramChat("-100")!.conversationId!).map(m=>m.text)).toEqual(["See you on Monday"]);
 await a.processUpdate(update);
 expect(run).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
 expect(run.mock.calls[0]?.[1]).toMatchObject({profile:expect.stringContaining('Telegram group "Core"')});
 await m.close();
});
it("recognizes a reply to the same bot from before the migration", async () => {
 const {s,m,a,run}=setup(); s.setSetting("telegram.bot_username","core_bot");
 s.bindTelegramChat("-100",s.createProfile({name:"Core"}).id);
 await a.processUpdate({update_id:43,message:{message_id:43,from:{id:7},chat:{id:-100,type:"group"},text:"Yes",reply_to_message:{message_id:11,from:{id:123,is_bot:true,username:"core_bot"}}}});
 expect(run.mock.calls[0]?.[0]).toContain('"replyToAssistant":true');
 expect(run.mock.calls[0]?.[1]).toMatchObject({telegramActor:{userId:"7",chatId:"-100",messageId:"-100:43"}});
 expect(fetch).toHaveBeenCalledTimes(1); await m.close();
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
it.each(["voice", "video_note"] as const)("transcribes %s before later text in the same chat",async(kind)=>{
 const {a,run,m,s}=setup();let finish!:(v:string)=>void;
 s.bindTelegramChat("-100",s.createProfile({name:"Voice"}).id);
 a.transcribe=()=>new Promise(r=>{finish=r;});
 vi.stubGlobal("fetch",vi.fn(async(url:string)=>url.includes("/file/") ? new Response(new Uint8Array([1,2])) : Response.json({ok:true,result:url.endsWith("getFile")?{file_path:"voice/file.mp4",file_size:2}:{message_id:99}})));
 const first=a.processUpdate({update_id:3,message:{message_id:3,from:{id:7},chat:{id:-100,type:"group"},[kind]:{file_id:"voice",file_size:2}}});
 await vi.waitFor(()=>expect(finish).toBeDefined());
 const second=a.processUpdate({update_id:4,message:{message_id:4,from:{id:7},chat:{id:-100,type:"group"},text:"Second"}});
 finish("First");await Promise.all([first,second]);
 expect(run.mock.calls.map(c=>c[0])).toEqual([expect.stringContaining("\n\nFirst"),expect.stringContaining("\n\nSecond")]);await m.close();
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
