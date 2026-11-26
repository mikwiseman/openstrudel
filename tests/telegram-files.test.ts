import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {afterEach,expect,it,vi} from "vitest";
import {OpenStrudelRuntime} from "../src/runtime.js";
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();vi.unstubAllGlobals();vi.unstubAllEnvs();});
it("keeps Telegram documents and generated replies in the same employee chat",async()=>{
  const root=mkdtempSync(resolve(tmpdir(),"strudel-telegram-files-"));
  const received:{path?:string;bytes?:string}={};
  const runtime=new OpenStrudelRuntime({rootDirectory:root,dbPath:":memory:",startTelegram:false,engine:{async run(input,options){
    const file=runtime.store.listMessages(runtime.store.profileConversation(employee.id).id)[0]!.attachments![0]!;
    received.bytes=readFileSync(runtime.messages.files.get(file.id)!.path,"utf8");
    received.path=input;
    const directory=runtime.messages.files.workspace(runtime.messages.contextFor(runtime.store.profileConversation(employee.id).id));mkdirSync(directory,{recursive:true});
    const output=resolve(directory,"answer.txt");writeFileSync(output,"Verified reply file");
    await options!.tools!.call("attach_file",{path:output});
    return {threadId:"document-chat",response:"Файл готов.",events:[]};
  }}});
  const employee=runtime.store.createProfile({name:"Documents",domain:"work"});
  runtime.store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});runtime.store.bindTelegramChat("42",employee.id);
  const sent: Array<{method:string;data:any}>=[];
  vi.stubGlobal("fetch",vi.fn(async(url:string,init?:RequestInit)=>{
    if(url.includes("/file/"))return new Response("Private source document");
    const method=url.split("/").at(-1)!;
    if(init?.body instanceof FormData){sent.push({method,data:init.body});return Response.json({ok:true,result:{message_id:102}});}
    sent.push({method,data:JSON.parse(String(init?.body))});
    return Response.json({ok:true,result:method==="getFile"?{file_path:"documents/note.txt",file_size:23}:{message_id:101}});
  }));
  const {TelegramAdapter}=await import("../src/telegram.js");
  const adapter=new TelegramAdapter("123:test",runtime.store,runtime.messages);
  try {
    const update={update_id:7,message:{message_id:8,from:{id:42},chat:{id:42},document:{file_id:"doc",file_name:"note.txt",mime_type:"text/plain",file_size:23},caption:"Прочитай и подготовь файл"}};
    await adapter.processUpdate(update);
    expect(received.bytes).toBe("Private source document");expect(received.path).toContain("note.txt");
    const chat=runtime.store.profileConversation(employee.id);
    expect(runtime.store.listMessages(chat.id)[0]!.attachments?.[0]?.name).toBe("note.txt");
    const outgoing=sent.find(s=>s.method==="sendDocument")?.data as FormData;
    expect(outgoing).toBeInstanceOf(FormData);expect(await (outgoing.get("document") as Blob).text()).toBe("Verified reply file");
    await adapter.processUpdate(update);
    expect(sent.filter(s=>s.method==="sendDocument")).toHaveLength(1);
  } finally {adapter.stop();await runtime.stop();rmSync(root,{recursive:true,force:true});}
});
it("keeps a file Telegram could not hand over as one failed request, without replaying it into a conflict",async()=>{
  const root=mkdtempSync(resolve(tmpdir(),"strudel-telegram-file-failure-"));
  const prompts:string[]=[];
  const runtime=new OpenStrudelRuntime({rootDirectory:root,dbPath:":memory:",startTelegram:false,engine:{async run(input){prompts.push(input);return {threadId:"document-chat",response:"Готово.",events:[]};}}});
  const employee=runtime.store.createProfile({name:"Documents",domain:"work"});
  runtime.store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});runtime.store.bindTelegramChat("42",employee.id);
  let online=false;
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>{
    if(!online) throw new TypeError("fetch failed");
    if(url.includes("/file/"))return new Response("Private source document");
    return Response.json({ok:true,result:url.endsWith("/getFile")?{file_path:"documents/note.txt",file_size:23}:{message_id:101}});
  }));
  const {TelegramAdapter}=await import("../src/telegram.js");
  const adapter=new TelegramAdapter("123:test",runtime.store,runtime.messages);
  try {
    const update={update_id:7,message:{message_id:8,from:{id:42},chat:{id:42},document:{file_id:"doc",file_name:"note.txt",mime_type:"text/plain",file_size:23},caption:"Прочитай"}};
    // Neither the file nor the notice about it got through. The failure is recorded, so the update is done.
    await adapter.processUpdate(update);
    expect(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM telegram_inbox").get()).toEqual({count:0});
    expect(runtime.store.findMessageByExternal("telegram","42:8")).toMatchObject({direction:"inbound",status:"failed",error:"fetch failed"});
    online=true;
    await adapter.processUpdate(update);
    expect(prompts).toEqual([]);
    expect(runtime.store.findMessageByExternal("telegram","42:8")).toMatchObject({status:"failed"});
  } finally {adapter.stop();await runtime.stop();rmSync(root,{recursive:true,force:true});}
});
it("does not replay a failed file request into a conflict when Home stops before finishing the update",async()=>{
  const root=mkdtempSync(resolve(tmpdir(),"strudel-telegram-file-stop-")),dbPath=resolve(root,"home.sqlite");
  const prompts:string[]=[];
  const engine={async run(input:string){prompts.push(input);return {threadId:"document-chat",response:"Готово.",events:[]};}};
  const {TelegramAdapter}=await import("../src/telegram.js");
  let runtime=new OpenStrudelRuntime({rootDirectory:root,dbPath,startTelegram:false,engine});
  const employee=runtime.store.createProfile({name:"Documents",domain:"work"});
  runtime.store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});runtime.store.bindTelegramChat("42",employee.id);
  let stopping=true;
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>{
    // Home stops: the download is aborted and the database closes while the notice is on its way.
    if(stopping){if(url.endsWith("/sendMessage"))runtime.store.close();throw new TypeError("fetch failed");}
    if(url.includes("/file/"))return new Response("Private source document");
    return Response.json({ok:true,result:url.endsWith("/getFile")?{file_path:"documents/note.txt",file_size:23}:{message_id:101}});
  }));
  const update={update_id:7,message:{message_id:8,from:{id:42},chat:{id:42},document:{file_id:"doc",file_name:"note.txt",mime_type:"text/plain",file_size:23},caption:"Прочитай"}};
  await new TelegramAdapter("123:test",runtime.store,runtime.messages).processUpdate(update).catch(()=>undefined);
  await runtime.stop().catch(()=>undefined);
  stopping=false;runtime=new OpenStrudelRuntime({rootDirectory:root,dbPath,startTelegram:false,engine});
  const adapter=new TelegramAdapter("123:test",runtime.store,runtime.messages);
  try {
    const saved=runtime.store.db.prepare("SELECT payload FROM telegram_inbox").all();
    expect(saved).toHaveLength(1);
    await adapter.processUpdate(JSON.parse(String(saved[0]!.payload)));
    expect(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM telegram_inbox").get()).toEqual({count:0});
    expect(prompts).toEqual([]);
    expect(runtime.store.findMessageByExternal("telegram","42:8")).toMatchObject({direction:"inbound",status:"failed"});
  } finally {adapter.stop();await runtime.stop();rmSync(root,{recursive:true,force:true});}
});

// Real image headers: Telegram's photo limits are checked against the image, not its name.
const png=(width=1280,height=720)=>{const bytes=Buffer.alloc(64);Buffer.from("89504e470d0a1a0a0000000d49484452","hex").copy(bytes);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);return bytes;};
const jpeg=(width:number,height:number)=>Buffer.concat([Buffer.from("ffd8ffe1000a4578696600000000ffc0001108","hex"),Buffer.from([height>>8,height&255,width>>8,width&255,3]),Buffer.alloc(32)]);
const webp=(width:number,height:number,animated=false)=>{const bytes=Buffer.alloc(40);bytes.write("RIFF",0);bytes.write("WEBPVP8X",8);bytes.writeUInt32LE(10,16);bytes[20]=animated?0x02:0;bytes.writeUIntLE(width-1,24,3);bytes.writeUIntLE(height-1,27,3);return bytes;};
/** A Home whose assistant attaches these images to its answer. Telegram's side is recorded; `lost` drops a reply after sending. */
function photoHome(images:Array<[string,Buffer]>=[],answer="",lost=(_method:string)=>false){
  vi.stubEnv("TELEGRAM_BOT_TOKEN","123:test");
  const root=mkdtempSync(resolve(tmpdir(),"strudel-telegram-photos-"));
  const runtime:OpenStrudelRuntime=new OpenStrudelRuntime({rootDirectory:root,dbPath:resolve(root,"home.sqlite"),startTelegram:false,engine:{async run(_input,options){
    const directory=runtime.messages.files.workspace(runtime.messages.contextFor(options!.conversationId!));mkdirSync(directory,{recursive:true});
    for(const [name,bytes] of images){writeFileSync(resolve(directory,name),bytes);await options!.tools!.call("attach_file",{path:resolve(directory,name)});}
    return {threadId:"photos",response:answer,events:[]};
  }}});
  cleanup.push(async()=>{await runtime.stop();rmSync(root,{recursive:true,force:true});});
  runtime.store.linkTelegramChat({chatId:"-1001",title:"Team",allowedSenders:["42"]});runtime.store.connectTelegramGroup("-1001");
  const sent:Array<{method:string;body:any}>=[];
  vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{
    const method=url.split("/").at(-1)!,body=init.body instanceof FormData?init.body:JSON.parse(String(init.body));
    if(method==="sendChatAction")return Response.json({ok:true,result:true});
    sent.push({method,body});
    if(lost(method))throw new TypeError("connection lost after upload");
    return Response.json({ok:true,result:method==="sendMediaGroup"?JSON.parse(String(body.get("media"))).map((_:unknown,i:number)=>({message_id:sent.length*100+i,media_group_id:"album-"+sent.length})):{message_id:sent.length*100}});
  }));
  const edition=async()=>{
    const chat=runtime.store.primaryConversation();
    runtime.scheduler.save({conversationId:chat.id,name:"Morning",prompt:"Digest",cron:"0 7 * * *",timezone:"Europe/Moscow",delivery:"telegram",telegramChatId:"-1001"},new Date("2026-10-15T10:00:00Z"));
    await runtime.scheduler.tick(new Date("2026-10-16T04:00:01Z"));await runtime.scheduler.idle();
    return runtime.scheduler.runs(chat.id)[0]!;
  };
  return {runtime,sent,edition};
}
const charts=(count:number)=>Array.from({length:count},(_,i)=>[`chart-${i}.png`,png()] as [string,Buffer]);
it("publishes a scheduled answer and its six images as one captioned album",async()=>{
  // Telegram counts a caption after formatting, so a long link address does not use it up.
  const url="https://example.com/"+"a".repeat(1100),images=charts(6);
  const {runtime,sent,edition}=photoHome(images,`**Утро** · [источник](${url})`);
  expect(await edition()).toMatchObject({status:"completed"});
  expect(sent.map(s=>s.method)).toEqual(["sendMediaGroup"]);
  const media=JSON.parse(String(sent[0]!.body.get("media")));
  expect(media.map((m:any)=>m.media)).toEqual(images.map((_,i)=>"attach://photo"+i));
  expect(media[0]).toEqual({type:"photo",media:"attach://photo0",caption:"Утро · источник",caption_entities:[{type:"bold",offset:0,length:4},{type:"text_link",offset:7,length:8,url}]});
  expect(media.slice(1).some((m:any)=>"caption" in m)).toBe(false);
  expect(Buffer.from(await (sent[0]!.body.get("photo5") as Blob).arrayBuffer())).toEqual(images[5]![1]);
  expect(runtime.store.db.prepare("SELECT status,media_group_id FROM telegram_outbox").all()).toEqual(Array(6).fill({status:"delivered",media_group_id:"album-1"}));
});
it("sends a long scheduled answer first, then its photos in albums of up to ten",async()=>{
  const text="Новости. ".repeat(130).trim();
  const {sent,edition}=photoHome(charts(12),text);
  expect(await edition()).toMatchObject({status:"completed"});
  expect(sent.map(s=>s.method)).toEqual(["sendMessage","sendMediaGroup","sendMediaGroup"]);
  expect(sent[0]!.body.text).toBe(text);
  const albums=sent.slice(1).map(s=>JSON.parse(String(s.body.get("media"))));
  expect(albums.map(album=>album.length)).toEqual([10,2]);
  expect(albums[1].map((m:any)=>m.media)).toEqual(["attach://photo10","attach://photo11"]);
  expect(albums.flat().some((m:any)=>"caption" in m)).toBe(false);
});
it("answers group and private requests with one image as a captioned photo",async()=>{
  const {runtime,sent}=photoHome([["chart.png",png()]],"График за неделю");
  runtime.store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});
  await runtime.telegram.processUpdate({update_id:1,message:{message_id:8,from:{id:42,first_name:"Owner"},chat:{id:-1001,type:"group",title:"Team"},text:"Покажи график"}});
  await runtime.telegram.processUpdate({update_id:2,message:{message_id:9,from:{id:42,first_name:"Owner"},chat:{id:42,type:"private"},text:"Покажи график"}});
  expect(sent.map(s=>[s.method,s.body.get("chat_id"),s.body.get("caption")])).toEqual([["sendPhoto","-1001","График за неделю"],["sendPhoto","42","График за неделю"]]);
  expect(Buffer.from(await (sent[0]!.body.get("photo") as Blob).arrayBuffer())).toEqual(png());
  // In a group the photo replies to its request.
  expect(JSON.parse(String(sent[0]!.body.get("reply_parameters")))).toEqual({message_id:8,allow_sending_without_reply:true});
  expect(sent[1]!.body.get("reply_parameters")).toBeNull();
  // A photo is its reply's receipt in the app: delivered, not still sending.
  const replies=runtime.store.employeeMessagePage(null,new URLSearchParams({limit:"50"})).messages.filter(m=>m.text==="График за неделю");
  expect(replies.map(m=>m.delivery?.state)).toEqual(["delivered","delivered"]);
});
it("keeps images Telegram would not take as photos as documents",async()=>{
  const {sent,edition}=photoHome([["photo.jpg",jpeg(1600,1200)],["sticker.webp",webp(512,512)],["chart.png",png()],
    ["panorama.png",png(4200,200)],["poster.png",png(6000,4001)],["scan.png",Buffer.concat([png(),Buffer.alloc(10*1024*1024)])],["renamed.png",Buffer.from("not an image")],["motion.webp",webp(480,270,true)]],"Подборка");
  expect(await edition()).toMatchObject({status:"completed"});
  expect(sent.map(s=>s.method)).toEqual(["sendMediaGroup",...Array(5).fill("sendDocument")]);
  expect(JSON.parse(String(sent[0]!.body.get("media"))).map((m:any)=>m.caption)).toEqual(["Подборка",undefined,undefined]);
  expect(sent.slice(1).map(s=>(s.body.get("document") as File).name)).toEqual(["panorama.png","poster.png","scan.png","renamed.png","motion.webp"]);
});
it("never resends photos Telegram did not confirm, even from a restarted Home",async()=>{
  const {runtime,sent,edition}=photoHome(charts(6),"Утренний выпуск",method=>method==="sendMediaGroup");
  const run=await edition();
  expect(run).toMatchObject({status:"uncertain"});
  const reply=runtime.store.listMessages(runtime.store.primaryConversation().id).find(m=>m.direction==="outbound" && m.attachments?.length)!;
  const {TelegramAdapter}=await import("../src/telegram.js");
  const restarted=new TelegramAdapter("123:test",runtime.store,runtime.messages);
  await expect(restarted.sendAnswer("-1001",reply.text,reply.attachments,"schedule:"+run.id)).rejects.toThrow("Проверьте доставку");
  restarted.stop();
  expect(sent.map(s=>s.method)).toEqual(["sendMediaGroup"]);
  expect(runtime.store.db.prepare("SELECT DISTINCT status FROM telegram_outbox").all()).toEqual([{status:"unknown"}]);
});
it("still delivers the answer and its images when Telegram refuses them as photos",async()=>{
  const {sent,edition}=photoHome([["chart.png",png()]],"График за неделю");
  const delivered=vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async(url,init)=>String(url).endsWith("/sendPhoto")
    ? (sent.push({method:"sendPhoto",body:init!.body}),Response.json({ok:false,error_code:400,description:"Bad Request: IMAGE_PROCESS_FAILED"},{status:400}))
    : delivered(url,init));
  expect(await edition()).toMatchObject({status:"completed"});
  expect(sent.map(s=>s.method)).toEqual(["sendPhoto","sendMessage","sendDocument"]);
  expect(sent[1]!.body.text).toBe("График за неделю");
});
it("finishes a delivery begun as text and documents without repeating either",async()=>{
  // A Home updated in the middle of a delivery: its text and first image already went out as before.
  const {runtime,sent}=photoHome();
  const chat=runtime.store.primaryConversation(),scope=runtime.messages.contextFor(chat.id);
  const files=[0,1,2].map(i=>runtime.messages.files.put(chat.id,scope,{name:`chart-${i}.png`,mimeType:"image/png",contentBase64:png().toString("base64")}));
  await runtime.telegram.sendMessage("-1001","Выпуск","schedule:run");await runtime.telegram.sendFiles("-1001",files.slice(0,1),"schedule:run");
  await runtime.telegram.sendAnswer("-1001","Выпуск",files,"schedule:run");
  expect(sent.map(s=>s.method)).toEqual(["sendMessage","sendDocument","sendMediaGroup"]);
  expect(JSON.parse(String(sent[2]!.body.get("media")))).toEqual([{type:"photo",media:"attach://photo0"},{type:"photo",media:"attach://photo1"}]);
});

it("replies to the confirmed PDF when overlapping private requests produce the same file",async()=>{
  let loseReceipt=false;
  const {runtime,sent}=photoHome([],"",method=>loseReceipt && method==="sendDocument");
  runtime.store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});
  const chat=runtime.store.getOrCreateConversation({channel:"telegram",externalId:"42"});
  const scope=runtime.messages.contextFor(chat.id);
  const ask=(id:number)=>runtime.store.addMessage({conversationId:chat.id,channel:"telegram",direction:"inbound",externalId:"42:"+id,text:"Send the notice"});
  async function answer(input:string,bytes:string,text:string) {
    const file=runtime.messages.files.put(chat.id,scope,{name:"notice.pdf",mimeType:"application/pdf",contentBase64:Buffer.from(bytes).toString("base64")});
    const result=runtime.store.addMessage({conversationId:chat.id,channel:"telegram",direction:"outbound",replyToId:input,text,attachments:[file]});
    const deliver=()=>runtime.telegram.sendAnswer("42",text,[file],"reply:"+result.id);
    await deliver();
    return {deliver,result};
  }
  const initial=ask(1),clarification=ask(2),correction=ask(3);
  await answer(initial.id,"PDF A","Original notice");
  const duplicate=await answer(clarification.id,"PDF A","Please review the date on the notice.");
  await duplicate.deliver();
  expect(sent.map(s=>s.method)).toEqual(["sendMessage","sendDocument","sendMessage"]);
  expect(sent[2]!.body).toMatchObject({text:"Please review the date on the notice.",reply_parameters:{message_id:200}});
  expect(runtime.store.employeeMessagePage(null,new URLSearchParams({limit:"50"})).messages.find(m=>m.id===duplicate.result.id)?.delivery?.state).toBe("delivered");
  await answer(correction.id,"PDF B","Updated notice");
  await answer(ask(4).id,"PDF B","Here is the requested resend.");
  expect(sent.filter(s=>s.method==="sendDocument")).toHaveLength(3);
  const unconfirmed=ask(5),followUp=ask(6);
  loseReceipt=true;
  await expect(answer(unconfirmed.id,"PDF C","New notice")).rejects.toThrow();
  loseReceipt=false;
  await answer(followUp.id,"PDF C","Please review the new notice.");
  expect(sent.slice(-2).map(s=>s.method)).toEqual(["sendMessage","sendDocument"]);
  expect(sent.at(-2)!.body.reply_parameters).toBeUndefined();
});
