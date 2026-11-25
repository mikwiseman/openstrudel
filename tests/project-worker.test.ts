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

it("deduplicates a project request and keeps its release separate from the Apple queue", () => {
  const root=mkdtempSync(join(tmpdir(),"wolf-queue-")),queue=new BuildQueue(root);
  try {
    queue.add("request","one","telegram","owner","Web change",true,"owner/web",true);
    queue.add("request","one","telegram","owner","other",false,"owner/other",false);
    queue.db.prepare("UPDATE jobs SET state='ready' WHERE id='request'").run();
    expect(queue.next(false)).toMatchObject({repository:"owner/web",release_project:1,goal:"Web change"});
    queue.db.prepare("UPDATE jobs SET state='completed' WHERE id='request'").run();
    expect(queue.next(true)).toBeUndefined();
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
