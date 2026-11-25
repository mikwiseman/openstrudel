import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { packageTargets } from "./aigid-queue.js";
import { validateWorkerResult, type WorkerJob } from "./project-worker-protocol.js";

const config = z.object({
  host:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/), user:z.string().regex(/^[a-z_][a-z0-9_-]{0,30}$/),
  telegram:z.array(z.string()), devices:z.array(z.string()),
  // A default-branch push starts the repository's own delivery. Self-updates use the Home's existing updater.
  releases:z.record(z.string(),z.enum(["push","home","vercel","pages"])).default({}),
  sourceRepositories:z.array(z.string()).default([]),
  packages:z.record(z.string(),z.array(z.enum(packageTargets))).default({}),
  portfolio:z.record(z.string(),z.object({ branch:z.string(), delivery:z.literal("branch").optional() })).default({}),
});
export function projectWorker(root:string) {
  const dir=join(root,".data/project-worker"), path=join(dir,"config.json");
  if(!existsSync(path)) return null;
  return {dir,...config.parse(JSON.parse(readFileSync(path,"utf8")))};
}
type Worker=NonNullable<ReturnType<typeof projectWorker>>;
const execute=promisify(execFile);
export async function runProjectWorker(worker:Worker,job:WorkerJob,signal:AbortSignal) {
  const raw=await requestWorker(worker,job,signal,job.gitToken);
  return validateWorkerResult(raw,job.base,job.change);
}

const hash=z.string().regex(/^[a-f0-9]{40}$/);
const portfolioResult=z.object({base:hash,revision:hash,branch:z.string(),notes:z.string().min(1),checks:z.string(),changed:z.boolean()});
type Preparation=Pick<WorkerJob,"repository"|"goal"|"change"|"selection"|"files">&{id:string};
export async function preparePortfolio(worker:Worker,job:Preparation,signal:AbortSignal) {
  const r=portfolioResult.parse(await requestWorker(worker,{portfolio:"prepare",...job},signal));
  if(r.branch!=="wolf/project-"+job.id || r.changed!==job.change || !r.changed && r.base!==r.revision)
    throw new Error("Invalid project candidate receipt.");
  return r;
}
export async function publishPortfolio(worker:Worker,repository:string,id:string,revision:string,signal:AbortSignal,sourceOnly=false) {
  const operation=sourceOnly?"merge-source":"publish";
  const r=z.object({revision:hash,branch:z.string()}).parse(await requestWorker(worker,{portfolio:operation,repository,id,revision},signal));
  const expected=sourceOnly?worker.portfolio[repository]?.branch:"wolf/project-"+id;
  if(r.revision!==revision || r.branch!==expected) throw new Error("Invalid project delivery receipt.");
  return r;
}
export async function packageProject(worker:Worker,repository:string,id:string,target:"android"|"web",revision:string|null,signal:AbortSignal) {
  const output=z.object({repository:z.string(),target:z.enum(["android","web"]),revision:hash,name:z.string(),size:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/),url:z.url({protocol:/^https$/})});
  const result=output.parse(await requestWorker(worker,{portfolio:"package",repository,id,target,revision},signal));
  if(result.repository!==repository || result.target!==target || revision && result.revision!==revision) throw new Error("Invalid package receipt.");
  return result;
}
async function requestWorker(worker:Worker,request:unknown,signal:AbortSignal,secret?:string) {
  const data=JSON.stringify(request);
  if(Buffer.byteLength(data)>40*1024*1024) throw new Error("The request attachments exceed the worker limit.");
  const task=execute("ssh",["-T","-F","/dev/null","-o","BatchMode=yes","-o","IdentitiesOnly=yes","-o","StrictHostKeyChecking=yes",
    "-o","GlobalKnownHostsFile=/dev/null","-o","UserKnownHostsFile="+join(worker.dir,"known_hosts"),"-o","ClearAllForwardings=yes",
    "-o","ForwardAgent=no","-o","ConnectTimeout=15","-o","ServerAliveInterval=20","-o","ServerAliveCountMax=3",
    "-i",join(worker.dir,"identity"),worker.user+"@"+worker.host],{timeout:60*60_000,maxBuffer:40*1024*1024,signal});
  task.child.stdin?.on("error",()=>{}).end(data);
  try { return JSON.parse((await task).stdout) as unknown; }
  catch(error) {
    const message=(error as {stderr?:string}).stderr?.trim() || (error as Error).message;
    throw new Error("Project worker: "+(secret ? message.replaceAll(secret,"[credential]") : message).slice(-750));
  }
}
/** Used only on a fresh job-owned checkout, before any local model can modify it. No repository scripts or hooks run on Home. */
export async function commitWorkerPatch(cwd:string,base:string,branch:string,patch:string,title:string) {
  if(!patch) throw new Error("The worker returned no source change to publish.");
  const args=["-C",cwd,"-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false"];
  const opts={env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"},timeout:90_000};
  await execute("git",[...args,"checkout","--quiet","-B",branch,base],opts);
  const apply=execute("git",[...args,"apply","--binary","--index","--whitespace=nowarn","-"],opts);
  apply.child.stdin?.on("error",()=>{}).end(patch);
  await apply;
  await execute("git",[...args,"commit","--quiet","-m",title],opts);
}
