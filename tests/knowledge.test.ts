import { expect,it } from "vitest";
import { existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { ownerKnowledge } from "../src/knowledge.js";

it("exports full owner and imported histories larger than the available JavaScript heap", async () => {
  const root=mkdtempSync(join(tmpdir(),"knowledge-memory-"));
  try {
    const result=await promisify(execFile)(process.execPath,["--max-old-space-size=64","--import","tsx",fileURLToPath(new URL("./fixtures/knowledge-memory.ts",import.meta.url)),root],{timeout:60_000,maxBuffer:1024*1024});
    const proof=JSON.parse(result.stdout);
    expect(proof.messages).toBe(8_000);
    expect(proof.bytes).toBeGreaterThan(64*1024*1024);
    expect(proof.archiveBytes).toBeGreaterThan(64*1024*1024);
    expect(proof.promptHasRange).toBe(true);
  } finally { rmSync(root,{recursive:true,force:true}); }
},65_000);

it("does not expose retained native memories belonging only to deleted employees", () => {
  const root=mkdtempSync(join(tmpdir(),"knowledge-contexts-")),store=new Store(":memory:");
  try {
    const active=store.createProfile({name:"Active",instructions:"files"});
    const removed=store.createProfile({name:"Removed",instructions:"files"});
    const activeChat=store.profileConversation(active.id),removedChat=store.profileConversation(removed.id);
    const activeContext="agent-"+active.id.replaceAll("-",""),removedContext="agent-"+removed.id.replaceAll("-","");
    const paths=[join(root,".data/contexts",activeContext,"memories"),join(root,".data/accounts/account-a/contexts",removedContext,"memories")];
    for(const path of paths){mkdirSync(path,{recursive:true});writeFileSync(join(path,"memory.md"),"Native memory, preserve on disk.");}
    store.setSetting("employee.deleted."+removed.id,"2026-11-02T00:00:00Z");
    const result=ownerKnowledge(store,root,id=>id===activeChat.id?activeContext:id===removedChat.id?removedContext:"personal");
    expect(result.readPaths).toContain(paths[0]);expect(result.readPaths).not.toContain(paths[1]);
    expect(existsSync(join(paths[1]!,"memory.md"))).toBe(true);
  } finally { store.close();rmSync(root,{recursive:true,force:true}); }
});

it("removes an obsolete imported source copy when its final visible message is hidden", async () => {
  const root=mkdtempSync(join(tmpdir(),"knowledge-hidden-")),store=new Store(":memory:");
  const employee=store.createProfile({name:"Imported",instructions:"files"}),chat=store.profileConversation(employee.id);
  store.importHistory(chat.id,[{sourceId:"imported",date:"2026-10-01T00:00:00Z",direction:"inbound",author:"Source author",text:"HIDDEN_SOURCE_SENTINEL"}]);
  const calls:string[]=[];
  const service=new MessageService(store,{async run(input){calls.push(input);return{threadId:"t",response:"ok",events:[]};}},root);
  try {
    await service.handle({channel:"api",profile:employee.id,text:"Use history",byOwner:true});
    const path=join(root,".data/workspace",service.contextFor(chat.id),"history",chat.id,"telegram.jsonl");
    expect(readFileSync(path,"utf8")).toContain("HIDDEN_SOURCE_SENTINEL");
    store.db.prepare("UPDATE messages SET hidden=1 WHERE conversation_id=? AND imported=1").run(chat.id);
    await service.handle({channel:"api",profile:employee.id,text:"Check again",byOwner:true});
    expect(existsSync(path)).toBe(false);
    expect(calls.at(-1)).not.toContain("Imported conversation archive:");
  } finally { await service.close();store.close();rmSync(root,{recursive:true,force:true}); }
});

it("gives only the owner's root a source catalogue, keeping source text out of the prompt",async()=>{
  const root=mkdtempSync(join(tmpdir(),"knowledge-")),store=new Store(":memory:");
  const employee=store.createProfile({name:"Archive",instructions:"files"});
  const chat=store.profileConversation(employee.id);
  store.addMessage({conversationId:chat.id,channel:"api",direction:"inbound",text:"PRIVATE_SOURCE_SENTINEL"});
  const calls:any[]=[];
  const service=new MessageService(store,{async run(input,options){calls.push({input,options});return{threadId:"t",response:"ok",events:[]};}},root);
  try{
    await service.handle({channel:"api",text:"Find a source",byOwner:true});
    expect(calls[0].input).toContain("catalog.json");expect(calls[0].input).not.toContain("PRIVATE_SOURCE_SENTINEL");
    const directory=join(root,".data/owner-knowledge");
    expect(calls[0].options.readPaths).toContain(directory);
    const catalog=JSON.parse(readFileSync(join(directory,"catalog.json"),"utf8"));
    const source=catalog.sources.find((s:any)=>s.conversationId===chat.id);
    expect(readFileSync(source.history,"utf8")).toContain("PRIVATE_SOURCE_SENTINEL");
    await service.handle({channel:"api",profile:employee.id,text:"Own files",byOwner:true});
    expect(calls[1].options.readPaths).toBeUndefined();
    await service.handle({channel:"telegram",externalChatId:"42",text:"Guest",byOwner:false});
    expect(calls[2].options.readPaths).toBeUndefined();expect(calls[2].input).not.toContain("catalog.json");
  }finally{await service.close();store.close();rmSync(root,{recursive:true,force:true});}
});

it("removes a deleted employee's chat copy from the owner's sources",async()=>{
  const root=mkdtempSync(join(tmpdir(),"knowledge-")),store=new Store(":memory:");
  const employee=store.createProfile({name:"Gone",instructions:"files"});
  const chat=store.profileConversation(employee.id);
  store.addMessage({conversationId:chat.id,channel:"api",direction:"inbound",text:"DELETED_EMPLOYEE_SENTINEL"});
  const service=new MessageService(store,{async run(){return{threadId:"t",response:"ok",events:[]};}},root);
  const copy=join(root,".data/owner-knowledge",chat.id+".jsonl");
  try{
    await service.handle({channel:"api",text:"Find a source",byOwner:true});
    expect(existsSync(copy)).toBe(true);
    store.setSetting("employee.deleted."+employee.id,new Date().toISOString());
    await service.handle({channel:"api",text:"Find again",byOwner:true});
    expect(existsSync(copy)).toBe(false);
  }finally{await service.close();store.close();rmSync(root,{recursive:true,force:true});}
});

it("keeps the client a question was asked about in the owner's source copy, without the source's credential",async()=>{
  const root=mkdtempSync(join(tmpdir(),"knowledge-")),store=new Store(":memory:");
  const calls:any[]=[];
  const service=new MessageService(store,{async run(input,options){calls.push({input,options});return{threadId:"t",response:"ok",events:[]};}},root);
  try{
    const context={type:"client" as const,source:{connector:"company",endpoint:"https://example.invalid/mcp",fingerprint:"0123456789abcdef"},clientId:"c-acme",slug:"acme",name:"Acme",company:"Acme Robotics",stage:"active",brand:"TRINITY",archived:false};
    const asked=await service.handle({channel:"api",text:"Что по договору?",byOwner:true,context});
    await service.handle({channel:"api",text:"Find a source",byOwner:true});
    const catalog=JSON.parse(readFileSync(join(root,".data/owner-knowledge/catalog.json"),"utf8"));
    const source=catalog.sources.find((s:any)=>s.conversationId===asked.conversationId);
    const rows=readFileSync(source.history,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(rows.find(r=>r.text==="Что по договору?").context).toEqual({type:"client",connector:"company",clientId:"c-acme",slug:"acme",name:"Acme",company:"Acme Robotics"});
    expect(rows.find(r=>r.text==="Find a source").context).toBeUndefined();
    expect(readFileSync(source.history,"utf8")).not.toContain("fingerprint");
  }finally{await service.close();store.close();rmSync(root,{recursive:true,force:true});}
});
