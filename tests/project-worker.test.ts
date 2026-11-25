import { describe, expect, it } from "vitest";
import { validateWorkerJob, validateWorkerResult } from "../src/project-worker-protocol.js";

const sha = "a".repeat(40);
const job = { repository:"example/app", base:sha, branch:"wolf/project-b0f028d1-4ca8-4022-81b5-4d35289086bf",
  goal:"Test the web application", change:false, release:"project", files:[], gitToken:"read-only", selection:{} };
describe("isolated project worker", () => {
  it("accepts a repository and immutable revision, never a clone URL or shell options", () => {
    expect(validateWorkerJob(job).base).toBe(sha);
    for (const repository of ["../app","example/..","https://elsewhere/repo","-o/command"])
      expect(() => validateWorkerJob({...job,repository})).toThrow();
    expect(() => validateWorkerJob({...job,base:"main"})).toThrow();
    expect(() => validateWorkerJob({...job,branch:"main"})).toThrow();
  });
  it("rejects attachment paths and refuses patch output from an inspection", () => {
    expect(() => validateWorkerJob({...job,files:[{name:"../outside",data:"YQ=="}]})).toThrow();
    expect(() => validateWorkerResult({base:sha,notes:"ok",checks:"ok",patch:"data"},sha,false)).toThrow();
    expect(() => validateWorkerResult({base:"b".repeat(40),notes:"ok",checks:"ok",patch:""},sha,false)).toThrow();
  });
});

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { commitWorkerPatch } from "../src/project-worker.js";
import { BuildQueue } from "../src/aigid-queue.js";

it("publishes only the worker diff on the pinned revision, ignoring repository hooks", async () => {
  const root=mkdtempSync(join(tmpdir(),"wolf-patch-"));
  const git=(...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8"});
  try {
    git("init","-q");git("config","user.name","test");git("config","user.email","test@example.com");
    writeFileSync(join(root,"release.txt"),"before\n");git("add",".");git("commit","-qm","base");
    const base=git("rev-parse","HEAD").trim();
    writeFileSync(join(root,"release.txt"),"after\n");
    const patch=git("diff","--binary","--full-index");git("restore",".");
    writeFileSync(join(root,".git/hooks/pre-commit"),"#!/bin/sh\nexit 1\n",{mode:0o755});
    await commitWorkerPatch(root,base,job.branch,patch,"Change release note");
    expect(git("show","HEAD:release.txt")).toBe("after\n");
    expect(git("rev-parse","HEAD^").trim()).toBe(base);
    await expect(commitWorkerPatch(root,base,job.branch,"","empty")).rejects.toThrow("no source change");
  } finally {rmSync(root,{recursive:true,force:true});}
});

it("keeps two project requests from one message independent and deduplicates retries", () => {
  const root=mkdtempSync(join(tmpdir(),"wolf-queue-")),queue=new BuildQueue(root);
  try {
    const a=queue.add("request","one","telegram","owner","Web change",true,"owner/web",true)!;
    const other=queue.add("request","one","telegram","owner","Question",false,"owner/other")!;
    expect(a.id).not.toBe(other.id);
    expect(queue.add("request","one","telegram","owner","Web change",true,"owner/web",true)?.id).toBe(a.id);
    queue.db.prepare("UPDATE jobs SET state='ready' WHERE id=?").run(a.id);
    expect(queue.next(false)).toMatchObject({id:a.id,source_message:"request",repository:"owner/web",release_project:1});
    queue.db.prepare("UPDATE jobs SET state='completed' WHERE id=?").run(a.id);
    expect(queue.next(true)).toMatchObject({id:other.id,changes:0,source_message:"request"});
  }finally{queue.db.close();rmSync(root,{recursive:true,force:true});}
});

it("packages the changed revision and never substitutes main when a change fails", () => {
  const root=mkdtempSync(join(tmpdir(),"wolf-linked-package-")),queue=new BuildQueue(root);
  try {
    const a=queue.add("msg","one","telegram","owner","Change the site",true,"owner/web",false,["web"])!;
    expect(queue.next(false)?.id).toBe(a.id);
    queue.db.prepare("UPDATE jobs SET state='completed',commit_sha=? WHERE id=?").run(sha,a.id);
    const pkg=queue.next(true)!;
    expect(pkg).toMatchObject({source_message:"msg",package_target:"web",parent_request:a.id});
    expect(queue.packageRevision(pkg)).toBe(sha);
    expect(queue.addPackage("msg","one","telegram","owner","owner/web","web").id).toBe(pkg.id);
    queue.db.prepare("UPDATE jobs SET state='failed',commit_sha=NULL WHERE id=?").run(a.id);
    expect(()=>queue.packageRevision(pkg)).toThrow(/source change/i);
  }finally{queue.db.close();rmSync(root,{recursive:true,force:true});}
});

it("queues independent packages and preserves their original conversation message on retry", () => {
  const root=mkdtempSync(join(tmpdir(),"wolf-package-")),queue=new BuildQueue(root);
  try {
    const receipt=queue.addPackage("original","chat","telegram","owner","example/app","android");
    expect(queue.addPackage("original","chat","telegram","owner","example/app","android").id).toBe(receipt.id);
    expect(queue.addPackage("original","chat","telegram","owner","example/app","web").id).not.toBe(receipt.id);
    expect(queue.next(false)).toMatchObject({source_message:"original",package_target:"android",repository:"example/app"});
  } finally {queue.db.close();rmSync(root,{recursive:true,force:true});}
});

it("reuses historical project receipts while allowing a second repository from that message", () => {
  const root=mkdtempSync(join(tmpdir(),"wolf-history-")),queue=new BuildQueue(root);
  try {
    queue.db.prepare("INSERT INTO jobs(id,created,conversation,channel,actor,goal,changes,repository,state) VALUES('old','then','chat','telegram','owner','Change',1,'owner/web','dispatched')").run();
    expect(queue.add("old","chat","telegram","owner","Change",true,"owner/web").id).toBe("old");
    expect(queue.add("old","chat","telegram","owner","Question",false,"owner/app").id).not.toBe("old");
    expect(queue.next(true)?.repository).toBe("owner/app");
  } finally {queue.db.close();rmSync(root,{recursive:true,force:true});}
});

it("records a named branch only when the upstream HEAD matches the exact fetched commit",async()=>{
  const {snapshotBranch}=await import("../src/project-worker-protocol.js");
  const head="ref: refs/heads/release/trunk\tHEAD\n"+sha+"\tHEAD";
  expect(snapshotBranch(head,sha)).toBe("release/trunk");
  expect(snapshotBranch(head,"b".repeat(40))).toBeUndefined();
  expect(snapshotBranch(sha+"\tHEAD",sha)).toBeUndefined();
  expect(validateWorkerJob({...job,defaultBranch:"release/trunk"}).defaultBranch).toBe("release/trunk");
  expect(()=>validateWorkerJob({...job,defaultBranch:"../main"})).toThrow();
});


it("persists explicit source publication separately from a build or a provider deployment", () => {
  const root=mkdtempSync(join(tmpdir(),"wolf-source-")),queue=new BuildQueue(root);
  try {
    const receipt=queue.add("msg","chat","telegram","owner","Publish source",true,"owner/app","source");
    expect(queue.next(true)).toMatchObject({id:receipt.id,release_project:2,changes:1});
    expect(()=>queue.add("msg","chat","telegram","owner","Ordinary deployment",true,"owner/app",true)).toThrow();
  } finally {queue.db.close();rmSync(root,{recursive:true,force:true});}
});
