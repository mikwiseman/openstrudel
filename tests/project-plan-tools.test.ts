import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiGidBuilds, aigidTools } from "../src/aigid-testflight.js";
import { ConversationFiles } from "../src/files.js";
import { Store } from "../src/store.js";
import type { BuildRequest } from "../src/aigid-queue.js";
import type { TelegramToolContext } from "../src/telegram-tools.js";
import * as github from "../src/github.js";

let store:Store,root:string,service:AiGidBuilds;
const owner="a".repeat(20), repository="team/site";
function worker(targets:string[]=["web"],releases:Record<string,string>={[repository]:"pages"}) {
  writeFileSync(join(root,".data/project-worker/config.json"),JSON.stringify({
    host:"localhost",user:"worker",devices:[owner],telegram:[],packages:{[repository]:targets},releases,
    sourceRepositories:["team/lib"],portfolio:{"team/other":{branch:"main"}},
  }));
}
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),"project-plans-"));mkdirSync(join(root,".data/project-worker"),{recursive:true});worker();
  store=new Store(":memory:");store.setSetting("mobile.owners",JSON.stringify([owner]));
  service=AiGidBuilds.start(store,new ConversationFiles(store,root),{} as never)!;
  vi.spyOn(service,"kick").mockImplementation(()=>{});
});
afterEach(async()=>{await service.close();store.close();rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});
function turn(words:string){
  const conversationId=store.primaryConversation().id, message=store.addMessage({conversationId,channel:"api",direction:"inbound",text:words});
  return {channel:"api" as const,deviceId:owner,conversationId,messageId:message.id,byOwner:true,scope:"personal"};
}
const build={repository,goal:"Improve the homepage heading",change:true,release:true,destination:"website",packages:["web"]};
it("keeps registered website, source and package actions pending until their exact route has been approved",async()=>{
  for(const [name,args] of [
    ["project_build",build],["project_publish_source",{repository:"team/lib",goal:"Fix spelling"}],
    ["project_package",{repository,target:"web",revision:"b".repeat(40)}],
  ] as const){
    const t=turn(name); const tools=aigidTools(store,t);
    expect(tools.definitions.map(x=>x.name)).toContain("project_propose");
    expect(await tools.call(name,args)).toMatchObject({state:"pending"});
    expect(service.queue.next(true)).toBeUndefined();
    const plan=service.queue.proposal(t.messageId,t.conversationId)!;
    expect(service.canRunPlan(t,plan.build)).toBe(true);
    if(name==="project_package")expect(plan.build).toMatchObject({packageOnly:"web",revision:"b".repeat(40)});
  }
});
it("requires the exact approved destination and current package and project grants",async()=>{
  const t=turn("Plan website edits");const tools=aigidTools(store,t);
  await expect(tools.call("project_propose",{...build,repository:"other/unregistered",release:false,packages:[]})).rejects.toThrow();
  await expect(tools.call("project_propose",{...build,destination:null})).rejects.toThrow();
  await tools.call("project_propose",{...build,feedbackMessages:null,replaces:null});
  const plan=service.queue.proposal(t.messageId,t.conversationId)!;
  expect(service.canRunPlan(t,plan.build)).toBe(true);
  service.queue.approve(t.messageId,"approve",t.conversationId,"api",owner);
  const job=service.queue.next(true)!;
  const check=service as unknown as {jobAllowed(job:BuildRequest,t:TelegramToolContext):boolean};
  expect(check.jobAllowed(job,t)).toBe(true);
  worker([]);expect(service.canRunPlan(t,plan.build)).toBe(false);
  worker(["web"],{});expect(service.canRunPlan(t,plan.build)).toBe(false);
  worker(["web"],{[repository]:"vercel"});expect(service.canRunPlan(t,plan.build)).toBe(false);
  expect(check.jobAllowed(job,t)).toBe(false);
  worker();store.setSetting("mobile.owners","[]");expect(service.canRunPlan(t,plan.build)).toBe(false);
});

it("requires a tester's own words for a Telegram inspection, while allowing a direct source question",async()=>{
  const t=turn("forwarded reporter's voice");
  const tg={...t,channel:"telegram" as const,telegramSenderId:"42"};
  vi.spyOn(service,"projectAllowed").mockReturnValue(true);
  const args={...build,change:false,release:false,destination:null,packages:[]};
  await expect(aigidTools(store,tg).call("project_build",args)).rejects.toThrow(/plan|question/i);
  expect(service.queue.next(true)).toBeUndefined();
  const genuine={...tg,telegramDirectText:"Which source handles the webpage?"};
  await expect(aigidTools(store,genuine).call("project_build",args)).resolves.toMatchObject({state:"queued"});
});
it("keeps GitHub App repositories outside the release catalog available for candidate changes only",async()=>{
  const t=turn("Fix the typo in this repository"),tools=aigidTools(store,t),repo="team/another";
  const check=vi.spyOn(github,"installedWorkerRepository").mockResolvedValue(repo);
  await tools.call("project_propose",{repository:repo,goal:"Fix the typo",change:true,release:false,packages:[]});
  const plan=service.queue.proposal(t.messageId,t.conversationId)!;
  expect(check).toHaveBeenCalledWith(root,repo);
  expect(service.canRunPlan(t,plan.build)).toBe(true);
  expect(service.canRunPlan(t,{...plan.build,release:"source"})).toBe(false);
  expect(service.canRunPlan(t,{...plan.build,packages:["web"]})).toBe(false);
});
