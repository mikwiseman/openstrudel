import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "smol-toml";
import { shareWithAllChats } from "../src/extensions.js";
import { UnipileAdapter, UNIPILE_ACCOUNTS_SETTING, type UnipileReadInput } from "../src/unipile.js";

const roots: string[] = [];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const identity = {accountId:"acc_linkedin",provider:"linkedin",providerUserId:"owner-li"} as const;
const whatsapp = {accountId:"acc_whatsapp",provider:"whatsapp",providerUserId:"owner-wa"} as const;
const key="synthetic-unipile-private-key";
const now=()=>new Date("2026-11-02T12:00:00Z");
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});
const account=(who=identity as typeof identity|typeof whatsapp)=>({object:"Account",id:who.accountId,user_id:who.providerUserId,provider:who.provider,status:"running",is_locked:false,name:"Synthetic owner"});
const chat={object:"Chat",id:"chat-1",name:"Synthetic conversation",provider:"linkedin",type:"1to1",unread_count:1,is_readonly:false,is_archived:false,last_message_timestamp:"2026-11-02T11:00:00Z"};
const message={object:"Message",id:"message-1",chat_id:"chat-1",sender_id:"other-person",provider:"linkedin",timestamp:"2026-11-02T11:00:00Z",is_sender:false,is_deleted:false,is_hidden:false,is_edited:false,is_event:false,text:"Would Tuesday work?",attachments:[]};
function fixture() {
  const root=mkdtempSync(join(tmpdir(),"strudel-unipile-"));roots.push(root);
  const path=join(root,".data/extensions/personal/config.toml");mkdirSync(join(path,".."),{recursive:true});
  const config={mcp_servers:{unipile:{enabled:true,url:"https://developer.unipile.com/mcp",http_headers:{"X-API-KEY":key},disabled_tools:["execute_request"]}}};
  const saveConfig=()=>writeFileSync(path,stringify(config));saveConfig();shareWithAllChats(root,true,["unipile"]);
  const settings=new Map([[UNIPILE_ACCOUNTS_SETTING,JSON.stringify([identity])]]),store={getSetting:(name:string)=>settings.get(name)??null};
  const calls:Array<{url:URL;init:RequestInit}>=[];
  const state:{account:unknown;page:unknown;status:number;before?: (url:URL)=>void}={account:account(),page:{data:[chat],next_cursor:"page-two"},status:200};
  const fetcher=vi.fn(async(input:URL|RequestInfo,init?:RequestInit)=>{
    const url=new URL(String(input));calls.push({url,init:init!});state.before?.(url);
    return json(url.pathname.startsWith("/v2/accounts/")?state.account:state.page,state.status);
  }) as unknown as typeof fetch;
  const adapter=new UnipileAdapter(root,store,{owner:true,fetch:fetcher,now});
  const request=async(extra:Partial<UnipileReadInput>={}):Promise<UnipileReadInput>=>({accountId:identity.accountId,sourceFingerprint:(await adapter.accounts()).accounts[0]!.source.sourceFingerprint,resource:"chats",inboxId:"CLASSIC_PRIMARY",...extra});
  return {root,path,config,saveConfig,settings,store,calls,state,fetcher,adapter,request};
}

describe("owner-scoped Unipile reads",()=>{
  it("uses only fixed GET routes and returns bounded source metadata without the connector key",async()=>{
    const f=fixture(),input=await f.request({limit:1}),result=await f.adapter.read(input);
    expect(result.items).toEqual([{id:"chat-1",name:"Synthetic conversation",provider:"linkedin",type:"1to1",unreadCount:1,readOnly:false,archived:false,lastMessageAt:"2026-11-02T11:00:00Z"}]);
    expect(result.source).toMatchObject({...identity,connector:"unipile",endpoint:"https://api.unipile.com/v2",checkedAt:"2026-11-02T12:00:00.000Z",sourceFingerprint:input.sourceFingerprint});
    expect(result.coverage).toMatchObject({returned:1,total:null,nextCursor:"page-two",hasMore:true,complete:false});
    expect(JSON.stringify(result)).not.toContain(key);
    expect(f.calls.map(c=>c.url.pathname)).toEqual(["/v2/accounts/acc_linkedin","/v2/accounts/acc_linkedin","/v2/acc_linkedin/inboxes/CLASSIC_PRIMARY/chats"]);
    for(const call of f.calls){expect(call.url.origin).toBe("https://api.unipile.com");expect(call.init.method).toBe("GET");expect(call.init.redirect).toBe("error");expect(new Headers(call.init.headers).get("x-api-key")).toBe(key);}
    expect(f.calls.at(-1)!.url.searchParams.get("limit")).toBe("1");
  });

  it("checks owner access before reading configuration or reaching the provider",async()=>{
    const f=fixture(),adapter=new UnipileAdapter(f.root,f.store,{fetch:f.fetcher});
    await expect(adapter.accounts()).rejects.toMatchObject({code:"owner_only"});
    await expect(adapter.read({} as UnipileReadInput)).rejects.toMatchObject({code:"owner_only"});
    expect(f.calls).toHaveLength(0);
  });

  it("denies any account not exactly allowlisted before networking, even when the provider key could read it",async()=>{
    const f=fixture(),input=await f.request();f.calls.length=0;
    await expect(f.adapter.read({...input,accountId:"acc_another_person"})).rejects.toMatchObject({code:"account_denied"});
    expect(f.calls).toHaveLength(0);
    f.settings.set(UNIPILE_ACCOUNTS_SETTING,JSON.stringify([{...identity,provider:"google"}]));
    await expect(f.adapter.accounts()).rejects.toMatchObject({code:"not_configured"});
    expect(f.calls).toHaveLength(0);
  });

  it.each([undefined,"null","{}","[]","{invalid"])("refuses absent or malformed account policy (%s)",async(value)=>{
    const f=fixture();if(value===undefined)f.settings.delete(UNIPILE_ACCOUNTS_SETTING);else f.settings.set(UNIPILE_ACCOUNTS_SETTING,value);
    await expect(f.adapter.accounts()).rejects.toMatchObject({code:"not_configured"});expect(f.calls).toHaveLength(0);
  });

  it("requires owner-only inheritance and disabled generic execution before using the saved credential",async()=>{
    const f=fixture();shareWithAllChats(f.root,true,[]);
    await expect(f.adapter.accounts()).rejects.toMatchObject({code:"not_configured"});
    shareWithAllChats(f.root,true,["unipile"]);f.config.mcp_servers.unipile.disabled_tools=[];f.saveConfig();
    await expect(f.adapter.accounts()).rejects.toMatchObject({code:"not_configured"});
    f.config.mcp_servers.unipile.disabled_tools=["execute_request"];f.config.mcp_servers.unipile.url="https://other.example/mcp";f.saveConfig();
    await expect(f.adapter.accounts()).rejects.toMatchObject({code:"not_configured"});expect(f.calls).toHaveLength(0);
  });

  it.each([{id:"acc_other"},{user_id:"another-owner"},{provider:"whatsapp"}])("refuses a changed upstream account identity %j",async(change)=>{
    const f=fixture();f.state.account={...account(),...change};
    await expect(f.adapter.accounts()).rejects.toMatchObject({code:"account_denied"});expect(f.calls).toHaveLength(1);
  });

  it.each([{status:"disconnected"},{is_locked:true},{metadata:{products_connection_status:{classic:"errored"}}}])("does not treat a configured account as a live connection %j",async(change)=>{
    const f=fixture();f.state.account={...account(),...change};await expect(f.adapter.accounts()).rejects.toMatchObject({code:"account_unavailable"});
  });

  it("refuses stale source references before reading and rechecks permission after the provider returns",async()=>{
    const f=fixture(),input=await f.request();f.calls.length=0;
    f.config.mcp_servers.unipile.http_headers["X-API-KEY"]="replacement-synthetic-key";f.saveConfig();
    await expect(f.adapter.read(input)).rejects.toMatchObject({code:"source_changed"});expect(f.calls).toHaveLength(0);
    f.config.mcp_servers.unipile.http_headers["X-API-KEY"]=key;f.saveConfig();
    f.state.before=url=>{if(!url.pathname.startsWith("/v2/accounts/"))f.settings.set(UNIPILE_ACCOUNTS_SETTING,JSON.stringify([whatsapp]));};
    await expect(f.adapter.read(input)).rejects.toMatchObject({code:"account_denied"});
  });

  it("rechecks all earlier accounts if the allowlist changes during a multi-account read",async()=>{
    const f=fixture();f.settings.set(UNIPILE_ACCOUNTS_SETTING,JSON.stringify([identity,whatsapp]));
    f.state.before=url=>{if(url.pathname.endsWith(whatsapp.accountId)){f.state.account=account(whatsapp);f.settings.set(UNIPILE_ACCOUNTS_SETTING,JSON.stringify([whatsapp]));}};
    await expect(f.adapter.accounts()).rejects.toMatchObject({code:"account_denied"});
  });

  it.each([
    {chatId:"../accounts",resource:"messages",inboxId:undefined},{inboxId:"x/../../accounts"},{inboxId:"x%2faccounts"},
    {url:"https://other.example"},{method:"POST"},{resource:"send"},{resource:"messages",inboxId:undefined},
    {limit:51},{offset:-1},{cursor:"c",offset:1},{before:"2026-11-03T09:00:00"},{after:"2026-11-04T00:00:00Z",before:"2026-11-03T00:00:00Z"},
  ])("rejects URL escape, writes and invalid page arguments before networking %j",async(change)=>{
    const f=fixture(),input=await f.request();f.calls.length=0;
    await expect(f.adapter.read({...input,...change} as UnipileReadInput)).rejects.toMatchObject({code:"invalid_arguments"});expect(f.calls).toHaveLength(0);
  });

  it("uses LinkedIn inbox discovery and never substitutes an unsupported generic chat route",async()=>{
    const f=fixture(),input=await f.request();f.calls.length=0;
    await expect(f.adapter.read({...input,inboxId:undefined})).rejects.toMatchObject({code:"unsupported_resource"});expect(f.calls).toHaveLength(0);
    f.state.page={data:[{object:"Inbox",id:"CLASSIC_PRIMARY",disabled:false,description:"Primary"}]};
    const result=await f.adapter.read({...input,resource:"inboxes",inboxId:undefined});
    expect(result.items).toEqual([{id:"CLASSIC_PRIMARY",disabled:false,description:"Primary"}]);
    expect(f.calls.at(-1)!.url.pathname).toBe("/v2/acc_linkedin/inboxes");expect(f.calls.at(-1)!.url.search).toBe("");
  });

  it("reads WhatsApp only after its exact provider identity is allowlisted",async()=>{
    const f=fixture();f.settings.set(UNIPILE_ACCOUNTS_SETTING,JSON.stringify([whatsapp]));f.state.account=account(whatsapp);f.state.page={data:[{...chat,provider:"whatsapp"}],total_count:1};
    const source=(await f.adapter.accounts()).accounts[0]!.source;
    const result=await f.adapter.read({accountId:whatsapp.accountId,sourceFingerprint:source.sourceFingerprint,resource:"chats",limit:1});
    expect(result.source.provider).toBe("whatsapp");expect(f.calls.at(-1)!.url.pathname).toBe("/v2/acc_whatsapp/chats");
    expect(result.coverage).toMatchObject({hasMore:false,complete:true});
  });

  it("preserves message provenance and direction while excluding hidden/deleted bodies and attachment URLs",async()=>{
    const f=fixture(),input=await f.request({resource:"messages",inboxId:undefined,chatId:"chat-1"});
    f.state.page={data:[{...message,attachments:[{id:"file-1",type:"file",filename:"brief.pdf",url:"https://private.example/signed",file_size:100}]},{...message,id:"message-2",is_sender:true,is_deleted:true,text:"Deleted private body"},{...message,id:"message-3",is_hidden:true,text:"Hidden body"}],total_count:3};
    const result=await f.adapter.read(input);
    expect(result.items[0]).toMatchObject({id:"message-1",chatId:"chat-1",senderId:"other-person",timestamp:message.timestamp,fromMe:false,text:message.text,attachments:[{id:"file-1",type:"file",fileName:"brief.pdf",sizeBytes:100}]});
    expect(result.items[1]).toMatchObject({fromMe:true,deleted:true,text:null});expect(result.items[2]).toMatchObject({hidden:true,text:null});
    expect(JSON.stringify(result)).not.toMatch(/private\.example|Deleted private body|Hidden body/);
    expect(f.calls.at(-1)!.url.pathname).toBe("/v2/acc_linkedin/chats/chat-1/messages");
  });

  it.each([{provider:"whatsapp"},{chat_id:"other-chat"}])("rejects messages from another source %j",async(change)=>{
    const f=fixture(),input=await f.request({resource:"messages",inboxId:undefined,chatId:"chat-1"});f.state.page={data:[{...message,...change}]};
    await expect(f.adapter.read(input)).rejects.toMatchObject({code:"account_denied"});
  });

  it("does not claim completeness from a short page without totals and preserves cursor/date filters",async()=>{
    const f=fixture(),input=await f.request({cursor:"opaque+/=cursor",after:"2026-11-01T09:00:00+03:00",before:"2026-11-03T09:00:00+03:00"});f.state.page={data:[chat]};
    const result=await f.adapter.read(input);expect(result.coverage).toMatchObject({returned:1,total:null,offset:null,hasMore:null,complete:null,nextOffset:null});
    const query=f.calls.at(-1)!.url.searchParams;expect(query.get("cursor")).toBe(input.cursor);expect(query.get("after")).toBe(input.after);expect(query.get("before")).toBe(input.before);
    expect((await f.adapter.read({...input,cursor:undefined})).coverage).toMatchObject({nextOffset:1,hasMore:null,complete:null});
    f.state.page={data:[chat],total_count:3};
    expect((await f.adapter.read({...input,cursor:undefined,offset:1})).coverage).toMatchObject({nextOffset:2,hasMore:true,complete:false});
    f.state.page={data:[],total_count:3};
    expect((await f.adapter.read({...input,cursor:undefined,offset:3})).coverage).toMatchObject({hasMore:false,complete:false});
  });

  it.each([[401,"service_auth"],[403,"service_denied"],[429,"service_unavailable"],[501,"service_unavailable"]] as const)("returns a fixed refusal for HTTP %s without copying the upstream body",async(status,code)=>{
    const f=fixture();f.state.status=status;f.state.account={detail:key};
    await expect(f.adapter.accounts()).rejects.toMatchObject({code});await expect(f.adapter.accounts()).rejects.not.toThrow(key);
  });

  it("refuses secret echoes and oversized responses without returning partial content",async()=>{
    const f=fixture(),input=await f.request();f.state.page={data:[{...chat,name:key}]};
    await expect(f.adapter.read(input)).rejects.toMatchObject({code:"service_unavailable"});
    f.state.page={data:[{...chat,name:"x".repeat(1024*1024)}]};
    await expect(f.adapter.read(input)).rejects.toMatchObject({code:"response_too_large"});
    expect(readFileSync(f.path,"utf8")).toContain(key);
  });

  it("bounds a stalled response body and never retries an unknown provider result",async()=>{
    const f=fixture(),fetcher=vi.fn(async()=>new Response(new ReadableStream({start(){}}))) as unknown as typeof fetch;
    const adapter=new UnipileAdapter(f.root,f.store,{owner:true,fetch:fetcher,timeoutMs:10});
    await expect(adapter.accounts()).rejects.toMatchObject({code:"service_unavailable"});expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
