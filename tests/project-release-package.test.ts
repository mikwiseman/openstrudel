import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AiGidBuilds } from "../src/aigid-testflight.js";
import type { BuildRequest } from "../src/aigid-queue.js";
import * as worker from "../src/project-worker.js";
import * as github from "../src/github.js";
it("builds the Vercel candidate with project dependencies before allowing a production merge",async()=>{
  const root=mkdtempSync(join(tmpdir(),"wolf-release-gate-")),repo="team/site",sha="a".repeat(40);
  const dir=join(root,".data/project-worker");mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,"config.json"),JSON.stringify({host:"localhost",user:"build",devices:[],telegram:[],packages:{[repo]:["web"]},releases:{[repo]:"vercel"}}));
  const service=new AiGidBuilds({} as any,{root} as any,{} as any);
  const subject=service as unknown as {activeRequest:()=>boolean;dispatchProject:(job:BuildRequest)=>Promise<void>};
  vi.spyOn(subject,"activeRequest").mockReturnValue(true);
  const build=vi.spyOn(worker,"packageProject").mockRejectedValue(new Error("Web compile failed"));
  const merge=vi.spyOn(github,"mergeWorkerCandidate").mockResolvedValue("b".repeat(40));
  try {
    const id=service.queue.add("msg","chat","telegram","owner","Ship",true,repo,true).id;
    service.queue.db.prepare("UPDATE jobs SET state='ready',commit_sha=?,pull=2 WHERE id=?").run(sha,id);
    const job=service.queue.next(true)!;
    await expect(subject.dispatchProject(job)).rejects.toThrow("Web compile failed");
    expect(merge).not.toHaveBeenCalled();
    const candidate=build.mock.calls[0]!;
    expect(candidate.slice(1,5)).toEqual([repo,expect.any(String),"web",sha]);
    build.mockResolvedValue({repository:repo,target:"web",revision:sha,url:"https://example.com/build.zip",name:"site.zip",size:12,sha256:"1".repeat(64)});
    await subject.dispatchProject(job);
    expect(build.mock.calls[1]![2]).toBe(candidate[2]);expect(merge).toHaveBeenCalledOnce();
  } finally {vi.restoreAllMocks();await service.close();rmSync(root,{recursive:true,force:true});}
});
