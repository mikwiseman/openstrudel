import { expect,it } from "vitest";
import { existsSync,mkdtempSync,readFileSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";

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
