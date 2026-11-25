import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildQueue } from "../src/aigid-queue.js";
import { AiGidBuilds, releaseChat, feedbackFiles } from "../src/aigid-testflight.js";
import { Store } from "../src/store.js";
import { ConversationFiles } from "../src/files.js";

let root:string,queue:BuildQueue,store:Store,files:ConversationFiles;
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),"wolf-feedback-"));queue=new BuildQueue(root);store=new Store(":memory:");files=new ConversationFiles(store,root);
});
afterEach(()=>{queue.db.close();store.db.close();rmSync(root,{recursive:true,force:true});});

it("keeps discussions separate from jobs and runs only the approved version once across both testers",()=>{
  const first=queue.propose("p1","group","Original wording",["photo"]);
  expect(queue.next(true)).toBeUndefined();
  const fresh=queue.propose("p2","group","Revised wording",["annotation"],first.id);
  expect(queue.pending("group").map(p=>p.id)).toEqual(["p2"]);
  expect(()=>queue.approve("p2","wrong","dm","telegram","10")).toThrow();
  expect(()=>queue.approve("p1","stale","group","telegram","10")).toThrow();
  expect(()=>queue.propose("foreign","dm","Edit",[],"p2")).toThrow();
  const receipt=queue.approve(fresh.id,"go","group","telegram","20");
  expect(queue.approve(fresh.id,"again","group","telegram","10")).toEqual(receipt);
  expect(queue.next(true)).toMatchObject({id:"go",goal:"Revised wording",actor:"20",conversation:"group",changes:1});
  expect(queue.feedbackFor("go")).toEqual(["photo","annotation"]);
  expect(queue.pending("group")).toEqual([]);
  expect(queue.db.prepare("select count(*) as n from jobs").get()?.n).toBe(1);
});
it("keeps independent tasks and retries separate and rejects a revision of an approved proposal",()=>{
  queue.propose("one","g","First",[]);queue.propose("two","g","Second",[]);
  queue.approve("one","approve-1","g","telegram","20");
  expect(queue.propose("one","g","First",[]).id).toBe("one");
  expect(()=>queue.propose("new","g","Too late",[],"one")).toThrow();
  expect(queue.pending("g").map(p=>p.id)).toEqual(["two"]);
  expect(()=>queue.cancel("two","different chat")).toThrow();
  expect(queue.cancel("two","g")).toEqual({id:"two",state:"cancelled"});
  expect(queue.cancel("two","g").state).toBe("cancelled");
  expect(()=>queue.approve("two","late","g","telegram","20")).toThrow();
  expect(()=>queue.cancel("one","g")).toThrow();
});
it("carries only actual attachments from this conversation into the approved run",()=>{
  const a=store.getOrCreateConversation({channel:"telegram",externalId:"-10"}),b=store.getOrCreateConversation({channel:"telegram",externalId:"-20"});
  const photo=files.put(a.id,"group", {name:"story.png",mimeType:"image/png",contentBase64:"aW1hZ2U="});
  const before=store.addMessage({channel:"telegram",conversationId:a.id,direction:"inbound",text:"Screen",attachments:[photo]});
  const now=store.addMessage({channel:"telegram",conversationId:a.id,direction:"inbound",text:"Plan this"});
  expect(feedbackFiles(store,a.id,now.id,[before.id,before.id])).toEqual([photo.id]);
  expect(()=>feedbackFiles(store,b.id,now.id,[before.id])).toThrow();
});
it("returns a release reply to the bound group, scopes builds and status, and respects revocation",()=>{
  mkdirSync(join(root,".data/aigid-testflight"),{recursive:true});
  writeFileSync(join(root,".data/aigid-testflight/config.json"),JSON.stringify({telegram:["10","20"],devices:[],groups:["-10"],accountEmail:"test@example.org",repository:"example/app"}));
  store.setSetting("access.people",JSON.stringify(["10","20"]));
  const make=(id:string)=>{store.linkTelegramChat({chatId:id,title:id,allowedSenders:["10","20"]});return store.connectTelegramGroup(id);};
  const a=make("-10"),b=make("-20");
  const src=store.addMessage({channel:"telegram",conversationId:a.conversationId!,direction:"inbound",externalId:"-10:42",text:"Go"});
  const base={channel:"telegram" as const,conversationId:a.conversationId!,messageId:src.id,telegramSenderId:"20"};
  const service=new AiGidBuilds(store,files,{} as never);
  try{
    expect(service.allowed(base)).toBe(true);
    expect(releaseChat(store,base)).toEqual({chatId:"-10",replyTo:42});
    expect(service.allowed({...base,conversationId:b.conversationId!})).toBe(false);
    expect(service.allowed({...base,telegramSenderId:"30"})).toBe(false);
    expect(service.projectAllowed(base)).toBe(false);
    store.setSetting("telegram.paused.-10","true");expect(service.allowed(base)).toBe(false);
  }finally{service.queue.db.close();}
});
