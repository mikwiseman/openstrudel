import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ConversationFiles } from "../src/files.js";
import { requestSigningApproval, decideSigningRequest, requestedSigningMarks, signingRequester, requestOwnerSigning } from "../src/document-signing-approvals.js";

const { render } = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("../src/document-signing.js", async load => ({ ...await load<typeof import("../src/document-signing.js")>(), runDocumentSigning: render }));
const cleanup: Array<()=>void>=[];
afterEach(()=>{render.mockReset();for (const f of cleanup.splice(0)) f();});

function fixture() {
  const root=mkdtempSync(join(tmpdir(),"signing-request-")), dbPath=join(root,"state.sqlite"), store=new Store(dbPath);
  const files=new ConversationFiles(store,root), dir=join(root,".data/sign-document");
  mkdirSync(join(dir,"assets"),{recursive:true});mkdirSync(join(dir,"scripts"));writeFileSync(join(dir,"scripts/docsign.py"),"test");
  writeFileSync(join(dir,"config.json"),JSON.stringify({telegramUserId:"42",requesterTelegramUserIds:["77"]}));
  writeFileSync(join(dir,"assets/identity.json"),JSON.stringify({entities:{sample:{name:"Test Entity",has_stamp:true},other:{name:"Other Entity",has_stamp:false}},entity_tokens:{sample:["Test Entity","Shared Brand"],other:["Other Entity"]}}));
  store.linkTelegramChat({chatId:"42",allowedSenders:["42"],title:"Signer"});
  store.linkTelegramChat({chatId:"-100",allowedSenders:["77"],title:"Team"});store.connectTelegramGroup("-100");
  const document={name:"sample.pdf",mimeType:"application/pdf",contentBase64:Buffer.from("%PDF-fixture-only").toString("base64")};
  const input={requesterTelegramId:"77",requesterName:"Requester",originTitle:"Team",chatId:"-100",requestMessageId:5,documentMessageId:4,document,signature:true,stamp:false,telegramDirectText:"Sign this document."};
  const transport={sendSigningReview:vi.fn().mockResolvedValue(181),sendSigningResult:vi.fn().mockResolvedValue(true),sendSigningNeedsReview:vi.fn().mockResolvedValue(true),sendSigningStatus:vi.fn().mockResolvedValue(true)};
  let entity="Test Entity", direct=true;const seen:string[]=[];
  render.mockImplementation(async (_dir:string,argv:string[])=>{
    if (argv[0]==="inspect") { seen.push(readFileSync(argv[1]!,"utf8"));writeFileSync(argv[3]!,JSON.stringify({pages:1,zones:[{id:"one",ours:direct,ours_source:"direct",signable:true,context:[entity],anchors:[{line:"Sample Signer"}]}]})); }
    if(argv[0]==="plan")writeFileSync(argv[3]!,JSON.stringify({placements:[{_zone:"one",page:1,asset:"signature"},{_zone:"one",page:1,asset:"stamp"}]}));
    if(argv[0]==="apply"){const plan=JSON.parse(readFileSync(argv[2]!,"utf8"));writeFileSync(plan.output,"%PDF-synthetic "+plan.placements.map((p:{asset:string})=>p.asset).join(" "));}
    if(argv[0]==="preview"){mkdirSync(argv[3]!);const png=Buffer.alloc(24);Buffer.from("89504e470d0a1a0a","hex").copy(png);png.writeUInt32BE(200,16);png.writeUInt32BE(250,20);writeFileSync(join(argv[3]!,"signed-p01.png"),png);}
    return {stdout:"",stderr:""};
  });
  const decision=(id:string,approve=true)=>({id,approve,ownerTelegramId:"42",ownerChatId:"42",approvalMessageId:181});
  cleanup.push(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {store,files,dir,input,transport,dbPath,decision,seen,entity:(name:string)=>{entity=name;},direct:(v:boolean)=>{direct=v;}};
}

it("freezes the reviewed source, accepts one exact private decision and returns only status to its origin",async()=>{
  const f=fixture(), x=await requestSigningApproval(f.store,f.files,f.input,f.transport);
  expect(x.state).toBe("pending");expect(render).not.toHaveBeenCalled();
  expect(f.transport.sendSigningReview.mock.calls[0]![0]).toMatchObject({ownerId:"42",document:f.input.document,signature:true,stamp:false});
  expect((await requestSigningApproval(f.store,f.files,f.input,f.transport)).id).toBe(x.id);
  expect(f.transport.sendSigningReview).toHaveBeenCalledTimes(1);
  f.input.document.contentBase64=Buffer.from("changed").toString("base64");
  await expect(requestSigningApproval(f.store,f.files,f.input,f.transport)).rejects.toThrow();
  for(const change of [{ownerTelegramId:"77"},{ownerChatId:"-100"},{approvalMessageId:182},{id:"missing"}]) {
    expect((await decideSigningRequest(f.store,f.files,{...f.decision(x.id),...change},f.transport)).state).toBe("unavailable");
  }
  const results=await Promise.all([1,2].map(()=>decideSigningRequest(f.store,f.files,f.decision(x.id),f.transport)));
  expect(results.map(x=>x.state)).toEqual(["signed","signed"]);expect(f.seen).toEqual(["%PDF-fixture-only"]);
  expect(f.transport.sendSigningResult).toHaveBeenCalledTimes(1);
  const signed=f.transport.sendSigningResult.mock.calls[0]![0];expect(signed.ownerId).toBe("42");
  expect(Buffer.from(signed.document.contentBase64,"base64").toString()).toBe("%PDF-synthetic signature");
  expect(f.transport.sendSigningStatus.mock.calls[0]![0]).toEqual({id:x.id,chatId:"-100",replyToMessageId:5,state:"signed"});
  expect((await decideSigningRequest(f.store,f.files,f.decision(x.id),f.transport)).state).toBe("signed");expect(f.transport.sendSigningResult).toHaveBeenCalledTimes(1);
});

it("persists decline across restart; another paired owner, disabled origin or replaced config cannot decide",async()=>{
  const f=fixture(), x=await requestSigningApproval(f.store,f.files,{...f.input,chatId:"77"},f.transport);
  expect(signingRequester(f.store,f.files,"77","77")).toBe(true);expect(signingRequester(f.store,f.files,"78","78")).toBe(false);
  f.store.linkTelegramChat({chatId:"51",allowedSenders:["51"],title:"Other"});
  const d=f.decision(x.id,false);expect((await decideSigningRequest(f.store,f.files,{...d,ownerTelegramId:"51",ownerChatId:"51"},f.transport)).state).toBe("unavailable");
  const reopened=new Store(f.dbPath); try {
    const fs=new ConversationFiles(reopened,f.files.root);
    expect((await decideSigningRequest(reopened,fs,d,f.transport)).state).toBe("declined");
    expect((await decideSigningRequest(reopened,fs,{...d,approve:true},f.transport)).state).toBe("declined");
  } finally {reopened.close();}
  expect(render).not.toHaveBeenCalled();expect(f.transport.sendSigningResult).not.toHaveBeenCalled();
  const g=await requestSigningApproval(f.store,f.files,f.input,f.transport);f.store.setSetting("telegram.paused.-100","true");
  expect((await decideSigningRequest(f.store,f.files,f.decision(g.id),f.transport)).state).toBe("unavailable");
  writeFileSync(join(f.dir,"config.json"),JSON.stringify({telegramUserId:"42",requesterTelegramUserIds:[]}));
  expect((await decideSigningRequest(f.store,f.files,d,f.transport)).state).toBe("unavailable");
});

it("a delegate's compound spoken request for both marks waits for the owner's private decision", async () => {
  const f=fixture();
  const telegramDirectText="Можешь составить документ и подписать и поставить печать.";
  const x=await requestSigningApproval(f.store,f.files,{...f.input,stamp:true,telegramDirectText},f.transport);
  expect(x.state).toBe("pending");
  expect(f.transport.sendSigningReview.mock.calls[0]![0]).toMatchObject({ownerId:"42",signature:true,stamp:true});
  expect(render).not.toHaveBeenCalled();
});

it.each(["unknown","foreign","ambiguous","brand-only","no-zone"])("requires manual review rather than applying a seal for %s",async kind=>{
  const f=fixture(),x=await requestSigningApproval(f.store,f.files,{...f.input,stamp:true,telegramDirectText:"Please sign and stamp this."},f.transport);
  f.entity(kind==="foreign"?"Other Entity":kind==="ambiguous"?"Test Entity Other Entity":kind==="brand-only"?"Shared Brand":"Unknown");if(kind==="no-zone")f.direct(false);
  expect((await decideSigningRequest(f.store,f.files,f.decision(x.id),f.transport)).state).toBe("needs_review");
  expect(render.mock.calls.some(([,argv])=>argv[0]==="apply")).toBe(false);expect(f.transport.sendSigningResult).not.toHaveBeenCalled();expect(f.transport.sendSigningNeedsReview.mock.calls[0]![0]).toMatchObject({ownerId:"42",document:f.input.document});
});

it("retries delivery of the exact frozen signed bytes after a provider failure without signing twice",async()=>{
  const f=fixture(),x=await requestSigningApproval(f.store,f.files,{...f.input,signature:false,stamp:true,telegramDirectText:"Stamp this."},f.transport);
  f.transport.sendSigningResult.mockRejectedValueOnce(new Error("temporary delivery failure"));
  await expect(decideSigningRequest(f.store,f.files,f.decision(x.id),f.transport)).rejects.toThrow("temporary");
  expect((await decideSigningRequest(f.store,f.files,f.decision(x.id),f.transport)).state).toBe("signed");expect(f.seen).toHaveLength(1);
  const [a,b]=f.transport.sendSigningResult.mock.calls;expect(a).toEqual(b);expect(Buffer.from(a![0].document.contentBase64,"base64").toString()).toBe("%PDF-synthetic stamp");
});

it.each([
  ["Подпиши договор.",true,false],["Поставь печать на договоре.",false,true],["Please sign and stamp this.",true,true],
  ["Sign the document about a stamp.",true,false],["Sign this without a stamp.",true,false],["Подпиши этот договор без печати.",true,false],
  ["Sign this document with the title ‘Sign and stamp it’.",true,false],
  ["Please explain who signed this.",false,false],["If approved, sign this.",false,false],
])("takes only the requested marks from the sender's own instruction %s",(text,sig,seal)=>{
  expect(requestedSigningMarks(String(text))).toEqual(sig||seal?{signature:sig,stamp:seal}:null);
});

it("accepts isolated handoffs from the authorized participants of any enabled bound group",async()=>{
  const f=fixture();
  f.store.linkTelegramChat({chatId:"-200",allowedSenders:[],title:"Forum"}); f.store.connectTelegramGroup("-200");
  const input={...f.input,chatId:"-200",messageThreadId:3};
  expect(signingRequester(f.store,f.files,"77","-200")).toBe(true);
  expect(signingRequester(f.store,f.files,"51","-200")).toBe(false);
  await expect(requestOwnerSigning(f.store,f.files,input,f.transport)).rejects.toThrow();
  const owned=await requestOwnerSigning(f.store,f.files,{...input,requesterTelegramId:"42"},f.transport);
  expect(owned.state).toBe("signed");
  expect(f.transport.sendSigningReview).not.toHaveBeenCalled();
  expect(f.transport.sendSigningStatus.mock.calls[0]![0]).toMatchObject({chatId:"-200",messageThreadId:3});
  expect(f.transport.sendSigningResult.mock.calls[0]![0]).toMatchObject({ownerId:"42"});
  f.store.setSetting("telegram.paused.-200","true");
  expect(signingRequester(f.store,f.files,"77","-200")).toBe(false);
});
it.each(["Мик, подпиши этот договор.","Передай Мику на подпись."])("can request the signer's private approval in delegated mode: %s",text=>{
  expect(requestedSigningMarks(text,true)).toEqual({signature:true,stamp:false});
  expect(requestedSigningMarks(text)).toBeNull();
});
