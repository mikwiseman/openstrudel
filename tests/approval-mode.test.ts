import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeApprovalConfig, nativeApprovalPolicy, readApprovalMode, approvalSetting } from "../src/approval-mode.js";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import type { CodexEngine } from "../src/types.js";

it("uses native review without widening group permissions or changing MCP access", () => {
  expect(readApprovalMode(undefined)).toBe("ask");
  expect(readApprovalMode("corrupt")).toBe("ask");
  const source = {mcp_servers:{company:{enabled:false,http_headers:{Authorization:"private-fixture"},disabled_tools:["delete"]}},"mcp_servers.telegram":{enabled:false}};
  const copy = structuredClone(source);
  const config = nativeApprovalConfig("approve_all",source,{"office@openstrudel-local":["calendar"]});
  expect(source).toEqual(copy);
  expect(config['mcp_servers.company.default_tools_approval_mode']).toBe("approve");
  expect(config['mcp_servers.telegram.default_tools_approval_mode']).toBe("approve");
  expect(config['plugins.office@openstrudel-local.mcp_servers.calendar.default_tools_approval_mode']).toBe("approve");
  expect(JSON.stringify(config)).not.toContain("private-fixture");
  expect(Object.keys(config).some(k=>k.endsWith("enabled"))).toBe(false);
  expect(nativeApprovalPolicy("auto",true)).toEqual({approvalPolicy:{granular:{sandbox_approval:false,rules:false,skill_approval:false,request_permissions:false,mcp_elicitations:true}},approvalsReviewer:"auto_review"});
  expect(nativeApprovalPolicy("approve_all",true)).toEqual({approvalPolicy:"never",approvalsReviewer:"user"});
});

it("changes only the next queued turn, including scheduled and Telegram deliveries", async () => {
  const store = new Store(":memory:");
  let finish!:()=>void;
  const seen: Array<Parameters<CodexEngine["run"]>[1]> = [];
  const engine: CodexEngine = {run:async(_input,options)=>{
    seen.push(options);
    if(seen.length===1) await new Promise<void>(r=>finish=r);
    return {threadId:"stable-thread",response:"OK",events:[]};
  }};
  const messages = new MessageService(store,engine);
  try {
    const first = await messages.submit({channel:"api",text:"First",externalChatId:"home"});
    await vi.waitFor(()=>expect(seen).toHaveLength(1));
    store.setSetting(approvalSetting,"auto");
    const next = await messages.submit({channel:"api",text:"Next",externalChatId:"home",scheduled:true});
    expect(seen[0]?.approvalMode).toBe("ask");
    finish(); await Promise.all([first.completion,next.completion]);
    expect(seen[1]?.approvalMode).toBe("auto");
    await messages.handle({channel:"telegram",text:"Group",externalChatId:"-123",telegramSenderId:"42",externalId:"-123:1"});
    expect(seen[2]).toMatchObject({approvalMode:"auto",groupContext:true,telegramActor:{userId:"42",chatId:"-123",messageId:"-123:1"}});
  } finally { store.close(); }
});

it("persists device mode and requires owner authorization and explicit approve-all confirmation", async () => {
  const root=mkdtempSync(join(tmpdir(),"strudel-approvals-"));
  const runtime=new OpenStrudelRuntime({rootDirectory:root,dbPath:join(root,"state.sqlite"),apiToken:"owner",startTelegram:false,engine:{run:async()=>({threadId:"test",response:"OK",events:[]})}});
  const address=await runtime.api.listen("127.0.0.1",0);
  const call=(route:string,method="GET",body?:unknown,headers:Record<string,string>={authorization:"Bearer owner"})=>fetch(`http://127.0.0.1:${address.port}${route}`,{method,headers:{"content-type":"application/json",...headers},body:body===undefined?undefined:JSON.stringify(body)});
  try {
    expect(await (await call("/v1/settings/approvals")).json()).toEqual({mode:"ask",canManage:true});
    expect((await call("/v1/settings/approvals","POST",{mode:"invalid"})).status).toBe(400);
    expect((await call("/v1/settings/approvals","POST",{mode:"approve_all"})).status).toBe(409);
    expect(await (await call("/v1/settings/approvals","POST",{mode:"auto"})).json()).toMatchObject({mode:"auto"});
    // Obtain a real member cookie; never trust a caller's owner header.
    const session=await call("/auth/session","POST",{key:runtime.api.web.invite(false).key});
    const {csrf}=await session.json();
    const headers={cookie:session.headers.get("set-cookie")!.split(";")[0]!,"x-openstrudel-csrf":csrf,"x-openstrudel-owner":"1"};
    expect(await (await call("/v1/settings/approvals","GET",undefined,headers)).json()).toEqual({mode:"auto",canManage:false});
    expect((await call("/v1/settings/approvals","POST",{mode:"approve_all",confirm:true},headers)).status).toBe(403);
    expect((await call("/v1/settings/approvals?deviceId=remote","POST",{mode:"approve_all",confirm:true},headers)).status).toBe(403);
    expect(await (await call("/v1/settings/approvals","POST",{mode:"approve_all",confirm:true})).json()).toMatchObject({mode:"approve_all"});
    const persisted=new Store(join(root,"state.sqlite"));
    expect(persisted.getSetting(approvalSetting)).toBe("approve_all");persisted.close();
  }finally{await runtime.stop();rmSync(root,{recursive:true,force:true});}
});
