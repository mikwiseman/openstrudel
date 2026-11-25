import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter, type TelegramUpdate } from "../src/telegram.js";
import type { SigningTransport } from "../src/document-signing-approvals.js";
const approvals = vi.hoisted(() => ({ submit:vi.fn(), decide:vi.fn() }));
vi.mock("../src/document-signing-approvals.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/document-signing-approvals.js")>(),
  signingOwner: (_store:unknown,_files:unknown,sender:string,chat:string) => sender==="42" && ["42","-100"].includes(chat),
  signingRequester: (_store:unknown,_files:unknown,sender:string,chat:string) => sender==="77" && ["77","-100"].includes(chat),
  requestSigningApproval: approvals.submit, decideSigningRequest:approvals.decide,
}));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function setup() {
  const root=mkdtempSync(join(tmpdir(),"telegram-sign-review-")), store=new Store(":memory:");
  store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});
  const run=vi.fn(async()=>({response:"NO_REPLY",events:[]})), messages=new MessageService(store,{run},root);
  const tg=new TelegramAdapter("123:test",store,messages);let id=300;
  const net=vi.fn(async (url:string,init?:RequestInit)=>{
    if(url.includes("/file/")) return new Response(Buffer.from("unsigned example"));
    if(url.endsWith("/getFile")) {const body=JSON.parse(String(init?.body));return Response.json({ok:true,result:{file_path:"documents/"+body.file_id}});}
    return Response.json({ok:true,result:{message_id:++id}});
  });
  vi.stubGlobal("fetch",net);cleanup.push(async()=>{tg.stop();await messages.close();store.close();rmSync(root,{recursive:true,force:true});});
  const update=(message:Record<string,unknown>,seq=1)=>tg.processUpdate({update_id:seq,message:{message_id:seq,chat:{id:77,type:"private"},from:{id:77,first_name:"Requester"},...message}} as TelegramUpdate);
  return {tg,store,messages,net,run,update};
}
const doc={file_id:"exact.pdf",file_name:"Notice.pdf",mime_type:"application/pdf"};
const reqid="1234567890abcdef1234567890abcdef";
it("accepts an unpaired requester's own caption and frozen file without starting a model or pairing",async()=>{
  const {update,run,store}=setup();approvals.submit.mockResolvedValue({id:reqid,state:"pending"});
  await update({caption:"Please sign and stamp this.",document:doc});
  expect(approvals.submit).toHaveBeenCalledOnce();
  expect(approvals.submit.mock.calls[0]![2]).toMatchObject({requesterTelegramId:"77",chatId:"77",requestMessageId:1,documentMessageId:1,signature:true,stamp:true,document:{name:"Notice.pdf",contentBase64:Buffer.from("unsigned example").toString("base64")}});
  expect(run).not.toHaveBeenCalled();expect(store.getTelegramChat("77")).toBeNull();
});
it("accepts an original voice replying to one selected group document; forwards cannot submit",async()=>{
  const {tg,update,run}=setup();
  approvals.submit.mockResolvedValue({id:reqid,state:"pending"});tg.transcribe=vi.fn(async()=>"Подпиши документ.");
  const base={chat:{id:-100,type:"supergroup"},is_topic_message:true,message_thread_id:51,voice:{file_id:"voice.ogg"},reply_to_message:{message_id:50,document:doc}};
  await update({...base,forward_origin:{type:"user"}},10);expect(approvals.submit).not.toHaveBeenCalled();
  await update(base,11);
  expect(approvals.submit.mock.calls[0]![2]).toMatchObject({chatId:"-100",requestMessageId:11,documentMessageId:50,messageThreadId:51,signature:true,stamp:false});
  expect(run).not.toHaveBeenCalled();
});
it("asks for exactly one file and ignores a request quoted by the sender",async()=>{
  const {update,run,net}=setup();const source={reply_to_message:{message_id:4,document:doc}};
  await update({text:"Sign this."},20);
  expect(net.mock.calls.some(([url,init])=>String(url).endsWith("/sendMessage") && String(init?.body).includes("документ"))).toBe(true);
  await update({...source,text:"Подпиши документ",entities:[{type:"blockquote",offset:0,length:16}]},21);
  await update({...source,text:"Подпиши документ",via_bot:{id:90}},22);
  await update({...source,text:"Sign this.",document:doc},23);
  expect(approvals.submit).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});
it("binds a press to the private original approval message and ignores presses from a group or bot",async()=>{
  const {tg}=setup();approvals.decide.mockResolvedValue({id:reqid,state:"declined"});
  const press=(seq:number,chat:number,sender:number,bot=false)=>tg.processUpdate({update_id:seq,callback_query:{id:String(seq),data:"signreq:"+reqid+":decline",from:{id:sender,is_bot:bot},message:{message_id:60,chat:{id:chat,type:chat<0?"group":"private"}}}} as TelegramUpdate);
  await press(1,-100,42);await press(2,77,77);await press(3,42,42,true);expect(approvals.decide).not.toHaveBeenCalled();
  await press(4,42,42);expect(approvals.decide.mock.calls[0]![2]).toMatchObject({id:reqid,approve:false,ownerTelegramId:"42",ownerChatId:"42",approvalMessageId:60});
});
it("tells the verified owner when an older card no longer authorizes a decision",async()=>{
  const {tg,net}=setup();approvals.decide.mockResolvedValue({id:reqid,state:"unavailable"});
  await tg.processUpdate({update_id:77,callback_query:{id:"cb",data:"signreq:"+reqid+":approve",from:{id:42},message:{message_id:699,chat:{id:42,type:"private"}}}});
  const texts=net.mock.calls.filter(([url])=>String(url).endsWith("/sendMessage")).map(([,r])=>JSON.parse(String(r?.body)));
  expect(texts).toHaveLength(1);expect(texts[0]).toMatchObject({chat_id:"42",reply_parameters:{message_id:699}});
  expect(texts[0].text).toContain("Новое решение по нему не принято");
  expect(net.mock.calls.some(([url])=>String(url).endsWith("/sendDocument"))).toBe(false);
});
it("delivers exact unsigned bytes with owner-only action buttons and keeps group updates file-free",async()=>{
  const {tg,net}=setup(), tr:SigningTransport=tg;
  const packet={id:reqid,ownerId:"42",signature:true,stamp:false,requesterName:"Гриша",originTitle:"Review",document:{name:"Notice.pdf",mimeType:"application/pdf",contentBase64:Buffer.from("unsigned contents").toString("base64")}};
  const mid=await tr.sendSigningReview(packet);expect(mid).toBe(await tr.sendSigningReview(packet));
  const forms=net.mock.calls.filter(([url])=>String(url).endsWith("/sendDocument")).map(([,req])=>req!.body as FormData);
  expect(forms).toHaveLength(1);expect(forms[0]!.get("chat_id")).toBe("42");expect(await (forms[0]!.get("document") as Blob).text()).toBe("unsigned contents");
  expect(forms[0]!.get("caption")).toContain("Гриша");expect(forms[0]!.get("reply_markup")).toContain("signreq:"+reqid+":approve");
  expect(forms[0]!.get("caption")).not.toMatch(/AI-помощником/);
  await tr.sendSigningStatus({id:reqid,chatId:"-100",replyToMessageId:7,messageThreadId:5,state:"declined"});
  expect(net.mock.calls.filter(([url])=>String(url).endsWith("/sendDocument"))).toHaveLength(1);
  const outgoing=net.mock.calls.find(([url])=>String(url).endsWith("/sendMessage"));
  expect(JSON.parse(String(outgoing?.[1]?.body))).toMatchObject({chat_id:"-100",message_thread_id:5,reply_parameters:{message_id:7}});
});
it("retries a definitively refused review and never blindly repeats an ambiguous document send",async()=>{
  const {tg,net}=setup();
  const packet={id:reqid,ownerId:"42",signature:true,stamp:false,requesterName:"Гриша",originTitle:"Личное сообщение",document:{name:"Notice.pdf",contentBase64:"JVBERg==",mimeType:"application/pdf"}};
  net.mockResolvedValueOnce(Response.json({ok:false,error_code:400,description:"invalid file"}));
  await expect(tg.sendSigningReview(packet)).rejects.toThrow();
  await expect(tg.sendSigningReview(packet)).resolves.toBeGreaterThan(0);
  net.mockRejectedValueOnce(new Error("connection lost"));
  await expect(tg.sendSigningReview({...packet,id:"a".repeat(32)})).rejects.toThrow();
  await expect(tg.sendSigningReview({...packet,id:"a".repeat(32)})).rejects.toThrow("проверить");
  expect(net).toHaveBeenCalledTimes(3);
});
