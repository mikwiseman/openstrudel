import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { validateWorkerResult, type WorkerJob } from "./project-worker-protocol.js";

const config = z.object({
  host:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/), user:z.string().regex(/^[a-z_][a-z0-9_-]{0,30}$/),
  telegram:z.array(z.string()), devices:z.array(z.string()),
  // A default-branch push starts the repository's own delivery. Self-updates use the Home's existing updater.
  releases:z.record(z.string(),z.enum(["push","home"])).default({}),
});
export function projectWorker(root:string) {
  const dir=join(root,".data/project-worker"), path=join(dir,"config.json");
  if(!existsSync(path)) return null;
  return {dir,...config.parse(JSON.parse(readFileSync(path,"utf8")))};
}
type Worker=NonNullable<ReturnType<typeof projectWorker>>;
const execute=promisify(execFile);
export async function runProjectWorker(worker:Worker,job:WorkerJob,signal:AbortSignal) {
  const data=JSON.stringify(job);
  if(Buffer.byteLength(data)>40*1024*1024) throw new Error("The request attachments exceed the worker limit.");
  const task=execute("ssh",["-T","-F","/dev/null","-o","BatchMode=yes","-o","IdentitiesOnly=yes","-o","StrictHostKeyChecking=yes",
    "-o","GlobalKnownHostsFile=/dev/null","-o","UserKnownHostsFile="+join(worker.dir,"known_hosts"),"-o","ClearAllForwardings=yes",
    "-o","ForwardAgent=no","-o","ConnectTimeout=15","-o","ServerAliveInterval=20","-o","ServerAliveCountMax=3",
    "-i",join(worker.dir,"identity"),worker.user+"@"+worker.host],{timeout:60*60_000,maxBuffer:40*1024*1024,signal});
  task.child.stdin?.on("error",()=>{}).end(data);
  try { return validateWorkerResult(JSON.parse((await task).stdout),job.base,job.change); }
  catch(error) {
    const message=(error as {stderr?:string}).stderr?.trim() || (error as Error).message;
    throw new Error("Project worker: "+message.replaceAll(job.gitToken,"[credential]").slice(-750));
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
