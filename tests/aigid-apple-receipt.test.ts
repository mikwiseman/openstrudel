import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { appleBuildReceipt } from "../src/aigid-cloud-status.js";
import { BuildQueue } from "../src/aigid-queue.js";

const sha="a".repeat(40), run="7de9b8d6-5cc2-4d0a-85f4-670e30d5d042", workflow="acb21680-aa90-46b2-afec-a380b18e4049";
const config={appleAppId:"1234",appleWorkflowId:workflow};
const apple={metadata:{attributes:{eventType:"BUILD_STARTED"}},app:{type:"apps",id:"1234"},ciWorkflow:{type:"ciWorkflows",id:workflow.toUpperCase()},ciBuildRun:{type:"ciBuildRuns",id:run.toUpperCase(),attributes:{number:185,sourceCommit:{commitSha:sha},isPullRequestBuild:false}}};
const token="b".repeat(64);
it("reads Apple's number only from the configured product hook and workflow",()=>{
  const read=(event:unknown, supplied=token)=>appleBuildReceipt(config,token,supplied,Buffer.from(JSON.stringify(event)));
  expect(read(apple)).toEqual({sha,run,number:185});
  expect(()=>read(apple,"d".repeat(64))).toThrow();
  for(const altered of [{app:{id:"4321",type:"apps"}},{ciWorkflow:{type:"ciWorkflows",id:run}},{ciBuildRun:{...apple.ciBuildRun,attributes:{...apple.ciBuildRun.attributes,number:0}}},{ciBuildRun:{...apple.ciBuildRun,attributes:{...apple.ciBuildRun.attributes,isPullRequestBuild:true}}}])
    expect(read({...apple,...altered})).toBeNull();
});
it.each(["apple","github"])("binds the exact run in either order, survives restart, delivers once (%s first)", first=>{
  const root=mkdtempSync(join(tmpdir(),"wolf-apple-receipt-"));let q=new BuildQueue(root);
  const github={sha,run,state:"completed" as const,detail:"Apple completed the AiGid TestFlight workflow."},number={sha,run,number:185};
  try{
    q.add("one","chat","telegram","10","QA",false);
    q.db.prepare("UPDATE jobs SET state='dispatched',release_commit=?,apple_number_required=1 WHERE id='one'").run(sha);
    q.recordCloudReceipt({...number,run:workflow,number:19});q.recordCloudReceipt({...number,sha:"c".repeat(40),number:99});
    q.recordCloudReceipt(first==="apple"?number:github);
    expect(q.cloudReports()).toHaveLength(0);
    q.db.close();q=new BuildQueue(root);
    q.recordCloudReceipt(first==="apple"?github:number);
    expect(q.cloudReports()).toMatchObject([{id:"one",state:"completed",apple_build_number:185}]);
    // A crash after the durable job update and before notifying is recovered on startup.
    q.db.close();q=new BuildQueue(root);
    expect(q.cloudReports()).toHaveLength(1);
    q.markCloudReported("one");
    q.recordCloudReceipt(github);q.recordCloudReceipt({...number,number:888});
    expect(q.cloudReports()).toHaveLength(0);
    expect(q.db.prepare("SELECT apple_build_number n FROM jobs WHERE id='one'").get()?.n).toBe(185);
  }finally{q.db.close();rmSync(root,{recursive:true,force:true});}
});
it("keeps existing dispatches deliverable during rollout and matches receipts arriving before dispatch",()=>{
  const root=mkdtempSync(join(tmpdir(),"wolf-apple-rollout-")),q=new BuildQueue(root);
  try {
    q.recordCloudReceipt({sha,run,state:"failed",detail:"Apple reported a TestFlight workflow failure."});
    expect(q.cloudReports()).toEqual([]);
    q.add("prior","chat","telegram","10","Release",false);
    q.db.prepare("UPDATE jobs SET release_commit=?,state='dispatched' WHERE id='prior'").run(sha);
    expect(q.cloudReports()).toMatchObject([{id:"prior",state:"failed",apple_build_number:null}]);
    q.markCloudReported("prior");
    q.recordCloudReceipt({sha,run,number:185});
    expect(q.cloudReports()).toEqual([]);
  } finally {q.db.close();rmSync(root,{recursive:true,force:true});}
});
