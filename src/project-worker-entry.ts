// Trusted container entry point. GitHub write access and the OAuth refresh token stay outside.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareCandidate } from "./aigid-candidate.js";
import { validateWorkerJob, snapshotBranch } from "./project-worker-protocol.js";
import type { CodexAuthTokens } from "./account.js";

async function run() {
  const chunks:Buffer[]=[];
  let size=0;
  for await (const chunk of process.stdin) {
    size+=chunk.length;
    if(size>40*1024*1024) throw new Error("The request attachments exceed the worker limit.");
    chunks.push(chunk);
  }
  const {job:request, account:identity}=JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const job=validateWorkerJob(request);
  const {email,tokens}=identity as {email:string;tokens:CodexAuthTokens};
  if (!email || !tokens?.accessToken || !tokens.chatgptAccountId) throw new Error("Worker subscription unavailable.");
  const work="/work", cwd=join(work,"repo"), inputs=join(work,"inputs");
  mkdirSync(cwd,{recursive:true});
  mkdirSync(inputs,{recursive:true});
  const git=(args:string[],extra:NodeJS.ProcessEnv={})=>execFileSync("git",["-c","core.hooksPath=/dev/null","-C",cwd,...args],
    {env:{PATH:process.env.PATH,HOME:work,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_TERMINAL_PROMPT:"0",...extra},
     maxBuffer:32*1024*1024,timeout:600_000,stdio:["ignore","pipe","pipe"]}).toString("utf8");
  git(["init","--quiet","--template="]);
  const local = process.argv[2] === "--mounted-source";
  const url = local ? "/wolf-source" : "https://github.com/"+job.repository+".git";
  const auth:NodeJS.ProcessEnv=local ? {} : {
    GIT_CONFIG_COUNT:"1",GIT_CONFIG_KEY_0:"http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0:"AUTHORIZATION: basic "+Buffer.from("x-access-token:"+job.gitToken).toString("base64"),
  };
  let defaultBranch:string|undefined;
  try {
    defaultBranch=local ? job.defaultBranch : snapshotBranch(git(["ls-remote","--symref",url,"HEAD"],auth),job.base);
    git(["fetch",...(local ? ["--upload-pack=git -c safe.directory=/wolf-source upload-pack"] : []),"--quiet","--depth=1","--update-shallow","--no-tags","--no-recurse-submodules",url,job.base],auth);
  } catch { throw new Error("The worker could not fetch the requested Git revision."); }
  if(git(["rev-parse","FETCH_HEAD"]).trim()!==job.base) throw new Error("The fetched revision has changed.");
  if(defaultBranch){
    git(["check-ref-format","refs/heads/"+defaultBranch]);
    git(["update-ref","refs/heads/"+defaultBranch,job.base]);
    git(["update-ref","refs/remotes/origin/"+defaultBranch,job.base]);
  }
  git(["checkout","--quiet","-b",job.branch,job.base]);
  git(["config","user.name","Wolf"]);git(["config","user.email","wolf@localhost"]);
  const images:string[]=[];
  for(const [i,file] of job.files.entries()){
    const path=join(inputs,i+"-"+file.name);
    writeFileSync(path,Buffer.from(file.data,"base64"),{mode:0o600});
    if(file.image) images.push(path);
  }
  const outcome=await prepareCandidate({home:join(work,"codex"),cwd,inputs,images,goal:job.goal,branch:job.branch,
    changes:job.change,email,account:{read:async()=>({connected:true,email}),authTokens:async()=>tokens},
    selection:{model:job.selection.model??null,reasoningEffort:job.selection.reasoningEffort},
    source:{revision:job.base,defaultBranch},buildWorkspace:true,project:job.release==="project"?job.repository:undefined,signal:AbortSignal.timeout(55*60_000)});
  if(git(["status","--porcelain"]).trim()) throw new Error("Uncommitted edits remain in the worker checkout.");
  const patch=job.change?git(["diff","--no-ext-diff","--no-textconv","--binary","--full-index",job.base,"HEAD","--"]):"";
  process.stdout.write(JSON.stringify({base:job.base,...outcome,patch}));
}
run().catch(error=>{process.stderr.write((error instanceof Error?error.message:"Project worker failed").slice(0,800)+"\n");process.exitCode=1;});
