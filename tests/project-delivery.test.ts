import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { BuildQueue } from "../src/aigid-queue.js";
import { projectDeliveryEvent } from "../src/project-delivery.js";
const head="a".repeat(40), merged="b".repeat(40), secret="test-secret";
const actions={id:41898282,login:"github-actions[bot]"},vercel={id:35613825,login:"vercel[bot]"};
function event(repo:string,route:string,name:string,input:object) {
  const body=Buffer.from(JSON.stringify({repository:{full_name:repo},...input}));
  return projectDeliveryEvent(repo,route,secret,name,body,"sha256="+createHmac("sha256",secret).update(body).digest("hex"));
}
it("binds BBF's delivery to the worker branch, exact revision, repository and pull, including out-of-order receipts",()=>{
 const root=mkdtempSync(join(tmpdir(),"wolf-delivery-")),q=new BuildQueue(root),repo="waiwai-is/hello";
 try{
  const one=q.add("message","chat","telegram","owner","Change it",true,repo,true);
  q.db.prepare("UPDATE jobs SET state='ready',commit_sha=? WHERE id=?").run(head,one.id);
  const note={action:"created",sender:actions,issue:{number:32,pull_request:{}},comment:{user:actions,body:"**Your change is online.** Open https://hello.bbf.waiwai.is (version of today)."}};
  const record=event(repo,"branch","issue_comment",note)!;
  expect(q.recordDelivery(repo,record)).toBeUndefined();
  const pr={number:32,head:{repo:{full_name:repo},sha:head,ref:"wolf/project-"+one.id},base:{repo:{full_name:repo},ref:"main"}};
  expect(q.recordDelivery(repo,event(repo,"branch","pull_request",{action:"opened",pull_request:pr})!)).toBeUndefined();
  q.db.prepare("UPDATE jobs SET state='dispatched' WHERE id=?").run(one.id);
  expect(q.finishDelivery(one.id as string)?.state).toBe("completed");
  expect(q.recordDelivery(repo,record)).toBeUndefined();
  expect(event(repo,"branch","issue_comment",{...note,comment:{...note.comment,user:{...actions,id:123}}})).toBeNull();
  expect(event(repo,"branch","issue_comment",{...note,comment:{...note.comment,body:"**Your change is online.** Open https://elsewhere.example/"}})).toBeNull();
  expect(event(repo,"branch","pull_request",{action:"opened",pull_request:{...pr,head:{...pr.head,ref:"someone-else"}}})).toBeNull();
 }finally{q.db.close();rmSync(root,{recursive:true,force:true});}
});
it("credits only the Vercel production deploy of the merged source for this release",()=>{
 const root=mkdtempSync(join(tmpdir(),"wolf-vercel-")),q=new BuildQueue(root),repo="owner/site";
 try{
  const one=q.add("msg","chat","telegram","owner","Ship",true,repo,true);
  q.db.prepare("UPDATE jobs SET state='dispatched',commit_sha=? WHERE id=?").run(merged,one.id);
  const value={sender:vercel,deployment:{sha:merged,environment:"Production",creator:vercel},
   deployment_status:{state:"success",environment:"Production",environment_url:"https://sample-hello.vercel.app",creator:vercel}};
  expect(event(repo,"vercel","deployment_status",{...value,deployment:{...value.deployment,environment:"Preview"}})).toBeNull();
  expect(q.recordDelivery(repo,event(repo,"vercel","deployment_status",{...value,deployment:{...value.deployment,sha:head}})!)).toBeUndefined();
  expect(q.recordDelivery(repo,event(repo,"vercel","deployment_status",value)!)?.id).toBe(one.id);
  expect(q.db.prepare("SELECT state,detail FROM jobs WHERE id=?").get(one.id)).toMatchObject({state:"completed",detail:expect.stringContaining("https://sample-hello.vercel.app")});
  expect(()=>projectDeliveryEvent(repo,"vercel",secret,"deployment_status",Buffer.from("{}"),"bad")).toThrow(/signature/);
 }finally{q.db.close();rmSync(root,{recursive:true,force:true});}
});

it("reports only a completed default-branch push of the registered deployment workflow",()=>{
 const repo="owner/service",repository={full_name:repo,default_branch:"main"};
 const run={id:42,event:"push",status:"completed",conclusion:"success",head_branch:"main",head_sha:merged,head_repository:repository,path:".github/workflows/deploy.yml"};
 const send=(overrides:Record<string,unknown>={})=>event(repo,"push","workflow_run",{action:"completed",repository,workflow_run:{...run,...overrides}});
 expect(send()).toMatchObject({source:"commit",key:merged,state:"completed",detail:expect.stringContaining("https://github.com/owner/service/actions/runs/42")});
 expect(send({conclusion:"failure"})).toMatchObject({state:"failed"});
 for(const other of [{event:"pull_request"},{head_branch:"preview"},{path:".github/workflows/test.yml"},{head_repository:{full_name:"someone/fork"}},{status:"in_progress"},{head_sha:"bad"}])expect(send(other)).toBeNull();
});

it("confirms the actual GitHub Pages release of the checked default-branch commit",()=>{
 const repo="owner/site",repository={full_name:repo,default_branch:"main"};
 const deployment={sha:merged,ref:"main",environment:"github-pages",performed_via_github_app:{id:34598,slug:"github-pages"}};
 const status={state:"success",environment:"github-pages",environment_url:"https://owner.github.io/site/"};
 const send=(d:object,s:object)=>event(repo,"pages","deployment_status",{repository,deployment:d,deployment_status:s});
 expect(send(deployment,status)).toMatchObject({state:"completed",key:merged,detail:expect.stringContaining(status.environment_url)});
 expect(send(deployment,{...status,state:"error"})).toMatchObject({state:"failed"});
 for(const d of [{...deployment,ref:"other"},{...deployment,performed_via_github_app:{id:2}},{...deployment,environment:"Preview"}])expect(send(d,status)).toBeNull();
 expect(send(deployment,{...status,environment_url:"https://owner.github.io/another/"})).toBeNull();
});
