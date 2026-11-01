import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter } from "../src/telegram.js";
import { Scheduler } from "../src/scheduler.js";
import { employeeTools } from "../src/personality.js";
import type { TelegramToolContext } from "../src/telegram-tools.js";

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();vi.unstubAllGlobals();});
function setup() {
  const root=mkdtempSync(join(tmpdir(),"strudel-bot-tools-"));
  const store=new Store(join(root,"test.sqlite"));
  store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});
  store.linkTelegramChat({chatId:"-1001",title:"Core Team",allowedSenders:["42"]});
  store.linkTelegramChat({chatId:"-1002",title:"Test group",allowedSenders:["42"]});
  store.connectTelegramGroup("-1001");store.connectTelegramGroup("-1002");
  const source=store.primaryConversation();
  const run=vi.fn(async()=>({threadId:"native-thread",response:"Готово",events:[]}));
  const engine={run};
  const messages=new MessageService(store,engine,root);
  const adapter=new TelegramAdapter("1:fixture",store,messages);messages.telegram=adapter;
  const sent:Array<{method:string;body:any}>=[];
  vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{
    sent.push({method:url.split("/").at(-1)!,body:init.body instanceof FormData?init.body:JSON.parse(String(init.body))});
    return Response.json({ok:true,result:{message_id:100+sent.length}});
  }));
  const context:TelegramToolContext={conversationId:source.id,messageId:"request-1",channel:"api",byOwner:true,telegram:adapter,files:messages.files,scope:messages.contextFor(source.id)};
  const tools=(overrides:Partial<TelegramToolContext>={})=>employeeTools(store,engine,messages.interactions,{...context,...overrides,profile:null});
  cleanup.push(async()=>{adapter.stop();await messages.close();store.close();rmSync(root,{recursive:true,force:true});});
  return {root,store,messages,adapter,run,sent,source,context,tools};
}

it("exposes the already connected bot in app, web and owner DM turns without an MCP login",async()=>{
  const {run,messages,store,sent}=setup();
  run.mockImplementation(async(_input,options:any)=>{
    expect(options.tools.definitions.map((t:any)=>t.name)).toContain("send_telegram_message");
    const list=await options.tools.call("list_telegram_chats",{query:"core"});
    expect(list).toMatchObject({chats:[{chatId:"-1001",title:"Core Team",type:"group",conversationId:expect.any(String)}]});
    const result=await options.tools.call("send_telegram_message",{chatId:list.chats[0].chatId,text:"Approved delivery",paths:[]});
    expect(result).toMatchObject({sent:true,chatId:"-1001",telegramMessageIds:[expect.any(String)]});
    return {threadId:"native-thread",response:"Отправлено",events:[]};
  });
  await messages.handle({channel:"api",text:"Send from the app",byOwner:true});
  await messages.handle({channel:"telegram",externalChatId:"42",externalId:"42:7",telegramSenderId:"42",text:"Send from DM",byOwner:true});
  expect(sent.filter(s=>s.method==="sendMessage")).toHaveLength(2);
  const target=store.getTelegramChat("-1001")!.conversationId!;
  expect(store.listMessages(target).map(m=>m.text)).toEqual(["Approved delivery","Approved delivery"]);
});

it("records only the requested content in the destination and coalesces duplicate sends",async()=>{
  const {tools,sent,store,source}=setup();
  store.addMessage({conversationId:source.id,channel:"api",direction:"inbound",text:"Private context, never forward"});
  const args={chatId:"-1001",text:"Only this text",paths:[]};
  const tool=tools();
  const [first,second]=await Promise.all([tool.call("send_telegram_message",args),tool.call("send_telegram_message",args)]) as any[];
  expect(first.sent).toBe(true);expect(second.sent).toBe(false); // first was still sending
  const repeated=await tools().call("send_telegram_message",args);
  expect(repeated).toEqual(first);expect(sent).toHaveLength(1);
  const target=store.getTelegramChat("-1001")!.conversationId!;
  expect(store.listMessages(target).map(m=>m.text)).toEqual(["Only this text"]);
  const page=store.employeeMessagePage(null,new URLSearchParams({limit:"50"}));
  expect(page.messages.find(m=>m.id===first.messageId)).toMatchObject({origin:{chatId:"-1001",title:"Core Team"},delivery:{state:"delivered"}});
});

it("sends a real GIF as an animation and preserves a downloadable copy in its destination",async()=>{
  const {tools,messages,context,sent,store}=setup();
  const workspace=messages.files.workspace(context.scope!);mkdirSync(workspace,{recursive:true});
  const path=join(workspace,"wave.gif"),bytes=Buffer.from("GIF89a-fixture");writeFileSync(path,bytes);
  const args={chatId:"-1001",text:"",paths:[path]};
  const result=await tools().call("send_telegram_message",args) as any;
  expect(result.sent).toBe(true);expect(sent).toHaveLength(1);expect(sent[0]!.method).toBe("sendAnimation");
  expect(Buffer.from(await (sent[0]!.body.get("animation") as Blob).arrayBuffer())).toEqual(bytes);
  const target=store.getTelegramChat("-1001")!.conversationId!;
  const file=store.listMessages(target)[0]!.attachments![0]!;
  expect(file).toMatchObject({conversationId:target,name:"wave.gif",mimeType:"image/gif"});
  expect(messages.files.forMessage(target,[file.id])).toHaveLength(1);
  await tools().call("send_telegram_message",args);expect(sent).toHaveLength(1);
  expect(store.db.prepare("SELECT COUNT(*) n FROM conversation_files").get()?.n).toBe(1);
});

/** Telegram's reply to each file in turn, the last one repeating: an animation also carries a document field for older clients. */
function telegramReplies(sent:Array<{method:string;body:any}>, ...media:Array<Record<string,unknown>>) {
  vi.mocked(fetch).mockImplementation(async(url,init)=>{
    sent.push({method:String(url).split("/").at(-1)!,body:init!.body});
    return Response.json({ok:true,result:{message_id:100+sent.length,...media[Math.min(sent.length,media.length)-1]}});
  });
}
const largeGif=()=>Buffer.concat([Buffer.from("GIF89a"),Buffer.alloc(8*1024*1024)]);

it("sends a GIF above 8 MB as a silent MP4 and reports what Telegram made of it",async()=>{
  const {tools,messages,context,adapter,sent}=setup();
  const workspace=messages.files.workspace(context.scope!);mkdirSync(workspace,{recursive:true});
  const small=join(workspace,"small.gif"),large=join(workspace,"large.gif");
  writeFileSync(small,"GIF89a-fixture");writeFileSync(large,largeGif());
  const convert=vi.fn(async(_path:string)=>Buffer.from("mp4-fixture"));adapter.convertGif=convert;
  telegramReplies(sent,{animation:{file_id:"a"},document:{file_id:"a"}});
  expect(await tools().call("send_telegram_message",{chatId:"-1001",text:"",paths:[small]})).toMatchObject({sent:true,files:[{name:"small.gif",kind:"animation"}]});
  expect(convert).not.toHaveBeenCalled();expect(await (sent[0]!.body.get("animation") as File).text()).toBe("GIF89a-fixture");
  expect(await tools().call("send_telegram_message",{chatId:"-1001",text:"",paths:[large]})).toMatchObject({sent:true,files:[{name:"large.gif",kind:"animation"}]});
  expect(convert).toHaveBeenCalledTimes(1);expect(convert.mock.calls[0]![0]).toMatch(/-large\.gif$/);
  const video=sent[1]!.body.get("animation") as File;
  expect(sent[1]!.method).toBe("sendAnimation");expect(video).toMatchObject({name:"large.mp4",type:"video/mp4"});expect(await video.text()).toBe("mp4-fixture");
});

it("reports a GIF that Telegram kept as a plain file instead of promising an animation",async()=>{
  const {tools,messages,context,adapter,sent}=setup();
  const workspace=messages.files.workspace(context.scope!);mkdirSync(workspace,{recursive:true});
  const path=join(workspace,"large.gif"),bytes=largeGif();writeFileSync(path,bytes);
  adapter.convertGif=async()=>null; // a Home without ffmpeg sends the original
  telegramReplies(sent,{document:{file_id:"d",mime_type:"image/gif"}});
  const args={chatId:"-1001",text:"",paths:[path]};
  const result=await tools().call("send_telegram_message",args);
  expect(result).toMatchObject({sent:true,status:"delivered",files:[{name:"large.gif",kind:"document"}]});
  expect(sent[0]!.method).toBe("sendAnimation");
  expect(Buffer.from(await (sent[0]!.body.get("animation") as Blob).arrayBuffer()).equals(bytes)).toBe(true);
  expect(await tools().call("send_telegram_message",args)).toEqual(result);expect(sent).toHaveLength(1);
});

it("lists what Telegram made of each file in the requested order, each with its own message",async()=>{
  const {tools,messages,context,sent}=setup();
  const workspace=messages.files.workspace(context.scope!);
  const paths=[join(workspace,"b","clip.gif"),join(workspace,"a","clip.gif"),join(workspace,"notes.txt")];
  for (const [index,path] of paths.entries()) {mkdirSync(dirname(path),{recursive:true});writeFileSync(path,index<2?"GIF89a-"+index:"notes");}
  // File ids are random and order the outbox; here the first file gets the last one.
  const put=messages.files.put.bind(messages.files),ids=["f","8","0"].map(digit=>digit.repeat(8)+"-0000-4000-8000-000000000000");
  vi.spyOn(messages.files,"put").mockImplementation((conversationId,scope,input)=>put(conversationId,scope,{...input,id:ids.shift()}));
  telegramReplies(sent,{animation:{file_id:"a"},document:{file_id:"a"}},{document:{file_id:"d",mime_type:"image/gif"}},{document:{file_id:"t"}});
  expect(await tools().call("send_telegram_message",{chatId:"-1001",text:"",paths})).toMatchObject({sent:true,files:[
    {name:"clip.gif",kind:"animation",telegramMessageId:"101"},{name:"clip.gif",kind:"document",telegramMessageId:"102"},
    {name:"notes.txt",kind:"document",telegramMessageId:"103"}]});
});

const ffmpeg=(process.env.PATH ?? "").split(":").map(directory=>join(directory,"ffmpeg")).find(path=>existsSync(path));
/** A GIF whose width×height canvas is drawn by 1×1 frames; with none it holds no image at all. */
function canvasGif(width:number, height:number, frames:number) {
  const screen=Buffer.alloc(7);screen.writeUInt16LE(width,0);screen.writeUInt16LE(height,2);screen[4]=0x80;
  const frame=[0x21,0xf9,4,4,10,0,0,0, 0x2c,0,0,0,0,1,0,1,0,0, 2,2,0x44,1,0];
  return Buffer.concat([Buffer.from("GIF89a"),screen,Buffer.from([0,0,0,255,255,255,...Array(frames).fill(frame).flat(),0x3b])]);
}

it.skipIf(!ffmpeg)("converts a GIF to an even H.264 MP4 at most 1280 px on its longer side, keeping its shape",async()=>{
  const {adapter,root}=setup(),gif=join(root,"canvas.gif"),mp4=join(root,"canvas.mp4"),streams:string[]=[];
  for (const [width,height] of [[2001,1001],[601,1999],[301,201]]) {
    writeFileSync(gif,canvasGif(width!,height!,3));writeFileSync(mp4,(await adapter.convertGif(gif,ffmpeg))!);
    streams.push(execFileSync(join(dirname(ffmpeg!),"ffprobe"),["-v","error","-show_entries","stream=codec_name,width,height,pix_fmt","-of","csv=p=0",mp4],{encoding:"utf8"}).trim());
  }
  expect(streams).toEqual(["h264,1280,640,yuv420p","h264,384,1280,yuv420p","h264,300,200,yuv420p"]);
});

it.skipIf(!ffmpeg)("sends the original of a large GIF without frames or with a canvas beyond 4K",async()=>{
  const {tools,messages,context,adapter,sent}=setup();
  const workspace=messages.files.workspace(context.scope!);mkdirSync(workspace,{recursive:true});
  const convert=adapter.convertGif;adapter.convertGif=path=>convert(path,ffmpeg);
  telegramReplies(sent,{document:{file_id:"d",mime_type:"image/gif"}});
  // An 8 MB comment carries each GIF past the conversion threshold.
  const comment=Buffer.alloc(2+32_768*256+1);comment.set([0x21,0xfe]);for (let block=0;block<32_768;block++) comment[2+block*256]=255;
  for (const [index,[name,gif]] of ([["empty.gif",canvasGif(2,2,0)],["huge.gif",canvasGif(4000,2200,3)]] as const).entries()) {
    const path=join(workspace,name),bytes=Buffer.concat([gif.subarray(0,-1),comment,gif.subarray(-1)]);writeFileSync(path,bytes);
    expect(await tools().call("send_telegram_message",{chatId:"-1001",text:"",paths:[path]})).toMatchObject({sent:true});
    const upload=sent[index]!.body.get("animation") as File;
    expect(upload).toMatchObject({name,type:"image/gif"});expect(Buffer.from(await upload.arrayBuffer()).equals(bytes)).toBe(true);
  }
});

function albumFiles(messages:MessageService, context:TelegramToolContext) {
  const workspace=messages.files.workspace(context.scope!);mkdirSync(workspace,{recursive:true});
  return ["house.jpg","map.png"].map(name=>{const path=join(workspace,name);writeFileSync(path,"photo-fixture-"+name);return path;});
}

it("delivers requested photo albums once with one caption and a durable receipt for every photo",async()=>{
  const {tools,messages,context,store}=setup(),paths=albumFiles(messages,context);
  let form:FormData;
  vi.mocked(fetch).mockImplementation(async(url,init)=>{
    expect(String(url)).toMatch(/\/sendMediaGroup$/);
    form=init!.body as FormData;
    return Response.json({ok:true,result:[{message_id:201,media_group_id:"album-1"},{message_id:202,media_group_id:"album-1"}]});
  });
  const args={chatId:"-1001",text:"**Дом** · [источник](https://example.com/house)",paths,album:true,silent:true};
  const first=await tools().call("send_telegram_message",args) as any;
  expect(first).toMatchObject({sent:true,telegramMessageIds:["201","202"],telegramMediaGroupIds:["album-1"]});
  expect(form!.get("chat_id")).toBe("-1001");expect(form!.get("disable_notification")).toBe("true");
  const media=JSON.parse(String(form!.get("media")));
  expect(media).toHaveLength(2);expect(media[0]).toMatchObject({type:"photo",media:"attach://photo0",caption:"Дом · источник"});
  expect(media[0].caption_entities).toContainEqual({type:"text_link",offset:6,length:8,url:"https://example.com/house"});
  expect(media[1]).toEqual({type:"photo",media:"attach://photo1"});
  expect(await (form!.get("photo0") as Blob).text()).toBe("photo-fixture-house.jpg");
  const replacement=new TelegramAdapter("1:fixture",store,messages);
  expect(await tools({telegram:replacement}).call("send_telegram_message",args)).toEqual(first);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(store.db.prepare("SELECT status,message_id,media_group_id FROM telegram_outbox ORDER BY message_id").all()).toEqual([
    {status:"delivered",message_id:"201",media_group_id:"album-1"},{status:"delivered",message_id:"202",media_group_id:"album-1"},
  ]);
  replacement.stop();
});

it.each(["network", "incomplete response"])("keeps an uncertain photo album from being resent after %s",async(failure)=>{
  const {tools,messages,context,store}=setup(),paths=albumFiles(messages,context);
  vi.mocked(fetch).mockImplementation(async()=>{
    if(failure==="network")throw new TypeError("connection lost after upload");
    return Response.json({ok:true,result:[{message_id:201,media_group_id:"album-1"}]});
  });
  const args={chatId:"-1001",text:"Дом",paths,album:true};
  expect(await tools().call("send_telegram_message",args)).toMatchObject({sent:false,status:"unknown"});
  const replacement=new TelegramAdapter("1:fixture",store,messages);
  expect(await tools({telegram:replacement}).call("send_telegram_message",args)).toMatchObject({sent:false,status:"unknown"});
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(store.db.prepare("SELECT status FROM telegram_outbox").all()).toEqual([{status:"unknown"},{status:"unknown"}]);
  replacement.stop();
});

it("rejects invalid photo albums before creating or sending a delivery",async()=>{
  const {tools,messages,context,store}=setup(),paths=albumFiles(messages,context);
  const args={chatId:"-1001",text:"Дом",paths,album:true};
  await expect(tools().call("send_telegram_message",{...args,paths:paths.slice(0,1)})).rejects.toThrow("2–10");
  await expect(tools().call("send_telegram_message",{...args,text:"x".repeat(1025)})).rejects.toThrow("1024");
  const gif=join(messages.files.workspace(context.scope!),"animation.gif");writeFileSync(gif,"GIF89a");
  await expect(tools().call("send_telegram_message",{...args,paths:[paths[0],gif]})).rejects.toThrow("JPEG");
  expect(fetch).not.toHaveBeenCalled();
  expect(store.db.prepare("SELECT COUNT(*) n FROM telegram_outbox").get()?.n).toBe(0);
});

it("keeps requested quiet delivery and link previews in the durable text and file outbox",async()=>{
  const {tools,messages,context,sent,store}=setup();
  const workspace=messages.files.workspace(context.scope!);mkdirSync(workspace,{recursive:true});
  const path=join(workspace,"night.gif");writeFileSync(path,"GIF89a-fixture");
  const args={chatId:"-1001",text:"Verified source https://example.com/news",paths:[path],silent:true,linkPreview:true};
  expect(await tools().call("send_telegram_message",args)).toMatchObject({sent:true});
  expect(sent[0]!.body).toMatchObject({disable_notification:true,link_preview_options:{is_disabled:false}});
  expect(sent[1]!.body.get("disable_notification")).toBe("true");
  const rows=store.db.prepare("SELECT payload,status FROM telegram_outbox").all();
  expect(rows).toHaveLength(2);
  expect(rows.every(row=>JSON.parse(String(row.payload)).disable_notification === true && row.status === "delivered")).toBe(true);
  // Presentation changes cannot turn a repeated request into a second send.
  expect(await tools().call("send_telegram_message",{...args,silent:false,linkPreview:false})).toMatchObject({sent:true});
  expect(sent).toHaveLength(2);
});

it("preserves ordinary delivery defaults and rejects invalid presentation options before sending",async()=>{
  const {tools,sent}=setup();
  const args={chatId:"-1001",text:"Ordinary message",paths:[]};
  await expect(tools().call("send_telegram_message",{...args,silent:"true"})).rejects.toThrow("уведомления");
  await expect(tools().call("send_telegram_message",{...args,linkPreview:1})).rejects.toThrow("предпросмотр");
  expect(sent).toEqual([]);
  expect(await tools().call("send_telegram_message",{...args,silent:null,linkPreview:null})).toMatchObject({sent:true});
  expect(sent[0]!.body.disable_notification).toBeUndefined();
  expect(sent[0]!.body.link_preview_options).toEqual({is_disabled:true});
});

it("sends documents and text through the existing outbox and reports partial failures honestly",async()=>{
  const {tools,messages,context,store}=setup();
  const workspace=messages.files.workspace(context.scope!);mkdirSync(workspace,{recursive:true});
  const path=join(workspace,"report.txt");writeFileSync(path,"Verified report");
  vi.mocked(fetch).mockImplementation(async(_url,init)=>init!.body instanceof FormData
    ? Response.json({ok:false,error_code:403,description:"Forbidden"})
    : Response.json({ok:true,result:{message_id:101}}));
  const args={chatId:"-1001",text:"Report",paths:[path]};
  const result=await tools().call("send_telegram_message",args) as any;
  expect(result).toMatchObject({sent:false,status:"partial",telegramMessageIds:["101"],error:expect.any(String)});
  await tools().call("send_telegram_message",args);expect(fetch).toHaveBeenCalledTimes(2);
  expect(store.db.prepare("SELECT status FROM telegram_outbox ORDER BY key").all().map(r=>r.status)).toEqual(["delivered","not_sent"]);
});

it("never repeats an unacknowledged send, even after a new adapter loads the persisted state",async()=>{
  const {tools,store,messages}=setup();
  vi.mocked(fetch).mockRejectedValue(new TypeError("connection lost"));
  const args={chatId:"-1001",text:"Once",paths:[]};
  expect(await tools().call("send_telegram_message",args)).toMatchObject({sent:false,status:"unknown",error:expect.stringContaining("не подтверждена")});
  const replacement=new TelegramAdapter("1:fixture",store,messages);
  expect(await tools({telegram:replacement}).call("send_telegram_message",args)).toMatchObject({sent:false});
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not leave an unreadable file forever pending in the outbox",async()=>{
  const {messages,adapter,store,source,context,sent}=setup();
  const file=messages.files.put(source.id,context.scope!,{name:"gone.txt",contentBase64:Buffer.from("temporary").toString("base64")});
  rmSync(messages.files.get(file.id)!.path);
  await expect(adapter.sendFiles("-1001",[file],"missing-file")).rejects.toThrow();
  expect(store.db.prepare("SELECT status FROM telegram_outbox").get()?.status).toBe("not_sent");
  expect(sent).toEqual([]);
});

it("keeps an ordinary participant and an unattended schedule inside their own audience",async()=>{
  const {tools,store,sent}=setup();
  const conversationId=store.getTelegramChat("-1001")!.conversationId!;
  for (const scope of [{channel:"telegram" as const,byOwner:false,telegramSenderId:"7"},{channel:"api" as const,byOwner:false},{channel:"api" as const,byOwner:true,scheduled:true,scheduleTelegramChatId:"-1001"}]) {
    const tool=tools({...scope,conversationId});
    expect(await tool.call("list_telegram_chats",{query:null})).toEqual({chats:[{chatId:"-1001",title:"Core Team",type:"group"}]});
    await expect(tool.call("send_telegram_message",{chatId:"42",text:"Do not leak",paths:[],byOwner:true,telegramSenderId:"42"})).rejects.toThrow("недоступен");
  }
  expect(sent).toEqual([]);
});

it("delivers separate scheduled cards to the saved destination without an extra automatic post",async()=>{
  const {store,messages,run,source,sent}=setup();
  const scheduler=new Scheduler(store,messages);messages.scheduler=scheduler;
  const automatic=vi.fn(async()=>{});scheduler.deliver=automatic;
  run.mockImplementation(async(_input,options:any)=>{
    expect(await options.tools.call("list_telegram_chats",{query:null})).toEqual({chats:[{chatId:"-1002",title:"Test group",type:"group"}]});
    await expect(options.tools.call("send_telegram_message",{chatId:"-1001",text:"Another audience",paths:[]})).rejects.toThrow("недоступен");
    for (const text of ["First verified card","Second verified card"]) {
      const args={chatId:"-1002",text,paths:[]};
      expect(await options.tools.call("send_telegram_message",args)).toMatchObject({sent:true});
      expect(await options.tools.call("send_telegram_message",args)).toMatchObject({sent:true});
    }
    return {threadId:"scheduled-cards",response:"NO_REPLY",events:[]};
  });
  scheduler.save({conversationId:source.id,name:"Cards",prompt:"Send each card separately",cron:"0 7 * * *",timezone:"Europe/Moscow",delivery:"telegram",telegramChatId:"-1002"},new Date("2026-10-15T10:00:00Z"));
  await scheduler.tick(new Date("2026-10-16T04:00:01Z"));await scheduler.idle();
  expect(scheduler.runs(source.id)[0]).toMatchObject({status:"quiet"});
  expect(automatic).not.toHaveBeenCalled();
  expect(sent).toHaveLength(2);
  expect(sent.map(s=>s.body.chat_id)).toEqual(["-1002","-1002"]);
  const target=store.getTelegramChat("-1002")!.conversationId!;
  expect(store.listMessages(target).map(m=>m.text)).toEqual(["First verified card","Second verified card"]);
});

it("does not let an app-only schedule send to a bound Telegram chat",async()=>{
  const {store,messages,run,sent}=setup();
  const conversationId=store.getTelegramChat("-1001")!.conversationId!;
  const scheduler=new Scheduler(store,messages);messages.scheduler=scheduler;
  run.mockImplementation(async(_input,options:any)=>{
    expect(await options.tools.call("list_telegram_chats",{query:null})).toEqual({chats:[]});
    await expect(options.tools.call("send_telegram_message",{chatId:"-1001",text:"Keep in app",paths:[]})).rejects.toThrow("недоступен");
    return {threadId:"app-edition",response:"App only",events:[]};
  });
  scheduler.save({conversationId,name:"Private review",prompt:"Review only",cron:"0 7 * * *",timezone:"Europe/Moscow",delivery:"app"},new Date("2026-10-15T10:00:00Z"));
  await scheduler.tick(new Date("2026-10-16T04:00:01Z"));await scheduler.idle();
  expect(scheduler.runs(conversationId)[0]).toMatchObject({status:"completed"});
  expect(sent).toEqual([]);
});

it("rechecks a scheduled destination's availability and cannot grant itself another audience",async()=>{
  const {tools,store,sent}=setup();
  const tool=tools({scheduled:true,scheduleTelegramChatId:"-1002"});
  store.setSetting("telegram.paused.-1002","true");
  expect(await tool.call("list_telegram_chats",{query:null})).toEqual({chats:[]});
  await expect(tool.call("send_telegram_message",{chatId:"-1001",text:"No",paths:[],scheduleTelegramChatId:"-1001"})).rejects.toThrow("недоступен");
  await expect(tool.call("send_telegram_message",{chatId:"-1002",text:"No",paths:[]})).rejects.toThrow("недоступен");
  expect(sent).toEqual([]);
});

it("lets a verified owner explicitly dispatch from a group while retaining group-scoped tools",async()=>{
  const {tools,store}=setup();
  const conversationId=store.getTelegramChat("-1001")!.conversationId!;
  const tool=tools({conversationId,byOwner:false,channel:"telegram",telegramSenderId:"42",scope:"group-test"});
  expect(await tool.call("send_telegram_message",{chatId:"-1002",text:"Requested by owner",paths:[]})).toMatchObject({sent:true});
  await expect(tool.call("update_employee",{name:"Other",instructions:"Change globally"})).rejects.toThrow("личном чате");
});

it("rechecks membership, pause and owner access at tool time",async()=>{
  const {tools,store,sent}=setup();
  const tool=tools({byOwner:false,channel:"telegram",telegramSenderId:"42"});
  store.setSetting("telegram.paused.-1001","true");
  await expect(tool.call("send_telegram_message",{chatId:"-1001",text:"No",paths:[]})).rejects.toThrow("недоступен");
  store.db.prepare("DELETE FROM telegram_chats WHERE chat_id='-1002'").run();
  await expect(tool.call("send_telegram_message",{chatId:"-1002",text:"No",paths:[]})).rejects.toThrow("недоступен");
  store.db.prepare("DELETE FROM telegram_chats WHERE chat_id='42'").run();
  expect(await tool.call("list_telegram_chats",{query:null})).toEqual({chats:[]});
  expect(sent).toEqual([]);
});

it("rejects outside files, symlinks and empty sends before contacting Telegram",async()=>{
  const {tools,messages,context,root,sent}=setup();
  const workspace=messages.files.workspace(context.scope!);mkdirSync(workspace,{recursive:true});
  const secret=join(root,"secret.txt");writeFileSync(secret,"private");symlinkSync(secret,join(workspace,"link.txt"));
  for (const paths of [[secret],[join(workspace,"link.txt")]]) await expect(tools().call("send_telegram_message",{chatId:"-1001",text:"",paths})).rejects.toThrow("рабочей области");
  await expect(tools().call("send_telegram_message",{chatId:"-1001",text:" ",paths:[]})).rejects.toThrow("текст или файл");
  expect(sent).toEqual([]);
});

it("identifies a disconnected device bot without asking for a duplicate MCP integration",async()=>{
  const {tools,adapter}=setup();adapter.disconnect();
  await expect(tools().call("list_telegram_chats",{query:null})).rejects.toThrow("Дополнительный сервис Telegram сотруднику не нужен");
});
