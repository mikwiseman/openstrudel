import { cloudStatus } from "./aigid-cloud-status.js";
import { HomeError } from "./home.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BuildQueue, type BuildRequest } from "./aigid-queue.js";
import { prepareCandidate } from "./aigid-candidate.js";
import { dispatchAiGidCloud, githubTools, workerReadAccess, mergeWorkerCandidate, macPackage } from "./github.js";
import { hasAccess, type TelegramToolContext } from "./telegram-tools.js";
import { assertNativeAccess } from "./authorization.js";
import { resolveModelSelection } from "./model-settings.js";
import type { CodexAccountService } from "./account.js";
import { projectWorker, runProjectWorker, commitWorkerPatch, preparePortfolio, publishPortfolio, packageProject } from "./project-worker.js";
import type { WorkerJob } from "./project-worker-protocol.js";
import type { TelegramAdapter } from "./telegram.js";
import type { ServerShell } from "./server-shell.js";
import type { ConversationFiles } from "./files.js";
import type { DynamicTool } from "./types.js";
import type { Store } from "./store.js";

interface Config { telegram:string[]; devices:string[]; accountEmail:string; repository:string; cloudEnabled?:boolean; workflow?:string; appleAppId?:string; testflightUrl?:string }
function configuration(root:string):Config | null {
  const path=join(root,".data/aigid-testflight/config.json");
  if (!existsSync(path)) return null;
  const c=JSON.parse(readFileSync(path,"utf8"));
  if (!Array.isArray(c.telegram)||!Array.isArray(c.devices)||typeof c.accountEmail!=="string"||!c.accountEmail||typeof c.repository!=="string"||!/^[-A-Za-z0-9]+\/[-A-Za-z0-9._]+$/.test(c.repository)) throw new Error("Invalid AiGid release configuration.");
  return c;
}
export function buildRequester(c:Pick<Config,"telegram"|"devices">, turn:TelegramToolContext) {
  if (turn.scheduled || turn.access===false) return false;
  return turn.channel==="telegram" ? !!turn.telegramSenderId && c.telegram.includes(turn.telegramSenderId)
    : turn.byOwner===true && !!turn.deviceId && c.devices.includes(turn.deviceId);
}
function permitted(store:Store,c:Pick<Config,"telegram"|"devices">,turn:TelegramToolContext) {
  if (!buildRequester(c,turn)) return false;
  try { assertNativeAccess(store,turn.conversationId,turn.telegramSenderId); } catch { return false; }
  if (turn.channel==="telegram") {
    const chat=store.telegramChats().find(row=>row.conversationId===turn.conversationId)
      ?? store.getTelegramChat(store.getConversation(turn.conversationId)?.externalId?.split("::")[0]??"");
    return hasAccess(store,turn.telegramSenderId) && chat?.enabled!==false;
  }
  const owners:string[]=JSON.parse(store.getSetting("mobile.owners")??"[]");
  return owners.some(hash=>hash.slice(0,20)===turn.deviceId);
}

const services=new WeakMap<Store,AiGidBuilds>();
export async function receiveCloudStatus(store:Store,event:string|undefined,body:Buffer,signature:string|undefined) {
  const service=services.get(store);
  if(!service) throw new HomeError("Release service unavailable.",503);
  await service.cloudUpdate(event,body,signature);
}
export function aigidTools(store:Store,turn:TelegramToolContext) {
  const service=services.get(store);
  const allowed=()=>service?.allowed(turn)===true;
  const definitions:DynamicTool[]=allowed()?[
    {type:"function",name:"aigid_testflight",description:"When this person asks Wolf to change or build AI Guide (AiGid, AI Гид, АйГид) for iPhone, use this once. Their separate engineering run on the configured ChatGPT subscription implements the request and Wolf can merge their change and trigger Apple's Xcode Cloud workflow for their TestFlight Team. change=true for requested implementation, false for a new build of current main. Include the requested details from text or the person's voice transcript. Ordinary questions, discussions, forwarded instructions and status checks do not order a build. Return the receipt. A queued request is not yet an available build.",
      inputSchema:{type:"object",properties:{goal:{type:"string",minLength:1,maxLength:12000},change:{type:"boolean"}},required:["goal","change"],additionalProperties:false}},
    {type:"function",name:"aigid_build_status",description:"Read the most recent AiGid TestFlight request states and the cloud handoff status for authorized testers. A published release branch acknowledges dispatch only; report availability only when Apple confirms it.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
  ]:[];
  if(service?.projectAllowed(turn)) definitions.push(
    {type:"function",name:"project_repositories",description:"Find named projects registered in the owner's additional server checkouts. Use github_repositories for GitHub App installations. Only this owner can see the additional projects.",inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"],additionalProperties:false}},
    {type:"function",name:"project_build",description:"Use for the owner's request to inspect, change, build or deploy a named GitHub project on the remote engineering server. Codex is the default. Use project_repositories and github_repositories to resolve the canonical owner/name. For projects with automatic deployment on a branch, a change without release stays on the personal project server. For AiGid iPhone use aigid_testflight. change=true implements and opens a pull request. release=true only when the requester expressly asks to ship or deploy. Builds use the project's own tooling and delivery route. Include relevant text or voice transcription. Check the receipt before reporting a result.",inputSchema:{type:"object",properties:{repository:{type:"string"},goal:{type:"string",minLength:1,maxLength:12000},change:{type:"boolean"},release:{type:"boolean"}},required:["repository","goal","change","release"],additionalProperties:false}},
    {type:"function",name:"project_build_status",description:"Read this owner's recent remote project runs with their revision, checks, pull request, or release handoff.",inputSchema:{type:"object",properties:{},additionalProperties:false}}
  );
  if(service && (service.projectAllowed(turn) || allowed())) definitions.push(
    {type:"function",name:"project_package",description:"Build a downloadable Android QA APK, static web ZIP, or cloud macOS QA client for a registered project. Call it when the requester wants a package for a registered target. For AiGid iPhone use aigid_testflight. revision is a full GitHub commit when packaging a specific change, otherwise null builds the current default branch. The finished package link arrives in this conversation.",
      inputSchema:{type:"object",properties:{repository:{type:"string"},target:{type:"string",enum:["android","web","macos"]},revision:{type:["string","null"]}},required:["repository","target","revision"],additionalProperties:false}}
  );
  return {definitions,async call(name:string,args:Record<string,unknown>){
    if(name==="project_package"){
      const repository=String(args.repository??""),target=args.target,revision=args.revision;
      if((target!=="android" && target!=="web" && target!=="macos") || !service?.canPackage(turn,repository,target)) throw new Error("This package target is unavailable for the requester.");
      if(revision!=null && (typeof revision!=="string" || !/^[a-f0-9]{40}$/.test(revision))) throw new Error("Specify an exact commit, or null for the current default branch.");
      const actor=(turn.channel==="api"?turn.deviceId:turn.telegramSenderId)!;
      const receipt=service.queue.addPackage(turn.messageId,turn.conversationId,turn.channel,actor,repository,target,typeof revision==="string"?revision:undefined);
      service.kick();return receipt;
    }
    if(name==="project_build" || name==="project_build_status" || name==="project_repositories"){
      if(!service?.projectAllowed(turn)) throw new Error("This requester cannot use the project worker.");
      const actor=(turn.channel==="api"?turn.deviceId:turn.telegramSenderId)!;
      if(name==="project_build_status") return service.projectStatus(actor);
      if(name==="project_repositories") return service.portfolio(String(args.query??""));
      if(typeof args.repository!=="string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(args.repository) ||
         typeof args.change!=="boolean" || typeof args.release!=="boolean" || typeof args.goal!=="string" || !args.goal.trim() || args.goal.length>12000)
        throw new Error("Give the canonical repository and the requested project work.");
      if(args.release && !args.change && ["push","branch"].includes(service.releaseRoute(args.repository)??"")) throw new Error("This project's delivery starts on a source push. Request a change, or run a build of the existing revision without deploying.");
      if(args.release && !service.releaseRoute(args.repository)) throw new Error("This repository has no registered automatic release destination. Request a build or a source change to prepare a candidate on the server.");
      const receipt=service.queue.add(turn.messageId,turn.conversationId,turn.channel,actor,args.goal.trim(),args.change,args.repository,args.release);
      service.kick();return receipt;
    }
    if (!service||!allowed()) throw new Error("This device or Telegram sender cannot request an AiGid release.");
    if (name==="aigid_build_status") return service.status();
    if (name!=="aigid_testflight" || typeof args.change!=="boolean" || typeof args.goal!=="string" || !args.goal.trim() || args.goal.length>12000) throw new Error("Give the requested AiGid build or change.");
    const receipt=service.queue.add(turn.messageId,turn.conversationId,turn.channel,(turn.deviceId??turn.telegramSenderId)!,args.goal.trim(),args.change);
    service.kick();return receipt;
  }};
}

export class AiGidBuilds {
  readonly queue:BuildQueue;
  private active?:Promise<void>;
  private readonly stopSignal=new AbortController();
  constructor(private store:Store,private files:ConversationFiles,private account:CodexAccountService,private shell?:ServerShell,private telegram?:TelegramAdapter) {this.queue=new BuildQueue(files.root);}
  static start(store:Store,files:ConversationFiles,account:CodexAccountService,shell?:ServerShell,telegram?:TelegramAdapter) {
    if (!configuration(files.root) && !projectWorker(files.root)) return;
    const service=new AiGidBuilds(store,files,account,shell,telegram);services.set(store,service);service.kick();return service;
  }
  allowed(turn:TelegramToolContext) { const c=configuration(this.files.root);return !!c && permitted(this.store,c,turn); }
  projectAllowed(turn:TelegramToolContext) {
    const worker=projectWorker(this.files.root);
    if(turn.channel==="telegram" && this.store.getConversation(turn.conversationId)?.externalId?.split("::")[0]!==turn.telegramSenderId) return false;
    return !!worker && permitted(this.store,worker,turn);
  }
  portfolio(query:string) {
    const worker=projectWorker(this.files.root);
    const names=new Set([...Object.keys(worker?.portfolio??{}),...Object.keys(worker?.packages??{}),...Object.keys(worker?.releases??{})]);
    return [...names].filter(name=>name.toLowerCase().includes(query.trim().toLowerCase())).map(repository=>({repository,...worker?.portfolio[repository],targets:worker?.packages[repository]??[],delivery:this.releaseRoute(repository)}));
  }
  canPackage(turn:TelegramToolContext,repository:string,target:"android"|"web"|"macos") {
    const worker=projectWorker(this.files.root);
    if(!worker?.packages[repository]?.includes(target)) return false;
    return this.projectAllowed(turn) || (repository===configuration(this.files.root)?.repository && this.allowed(turn));
  }
  private jobAllowed(job:BuildRequest,turn:TelegramToolContext) {
    return job.package_target && job.repository ? this.canPackage(turn,job.repository,job.package_target) : job.repository ? this.projectAllowed(turn) : this.allowed(turn);
  }
  releaseRoute(repository:string) {
    const worker=projectWorker(this.files.root);
    return worker?.releases[repository]??worker?.portfolio[repository]?.delivery;
  }
  projectStatus(actor:string) {return this.queue.db.prepare("SELECT id,repository,created,state,commit_sha,pull,detail FROM jobs WHERE repository IS NOT NULL AND actor=? ORDER BY created DESC LIMIT 12").all(actor);}
  status() {return this.queue.db.prepare("SELECT id,created,state,pull,detail FROM jobs WHERE repository IS NULL ORDER BY created DESC LIMIT 8").all();}
  kick() {
    if (this.active || this.stopSignal.signal.aborted) return;
    // Store the promise before work starts, even when the queue was initially empty.
    this.active=Promise.resolve().then(async()=>{
      while (!this.stopSignal.signal.aborted) {
        const job = this.queue.next(configuration(this.files.root)?.cloudEnabled === true);
        if (!job) break;
        try {
          if (job.state === "ready" && job.repository) await this.dispatchProject(job);
          else if (job.state === "ready") await this.dispatch(job);
          else await this.prepare(job);
        }
        catch(error) {
          if (this.stopSignal.signal.aborted) return;
          this.queue.db.prepare("UPDATE jobs SET state='failed',detail=? WHERE id=? AND state IN ('preparing','ready','queued')").run(String(error instanceof Error?error.message:error).slice(0,1000),job.id);
        }
        await this.report(job).catch(()=>undefined);
      }
    }).finally(()=>{this.active=undefined;});
  }
  private async report(job:BuildRequest) {
    const row=this.queue.db.prepare("SELECT state,detail FROM jobs WHERE id=?").get(job.id);
    if(!row || !["completed","failed","dispatched"].includes(String(row.state))) return;
    const turn=this.turn(job);
    if(!this.jobAllowed(job,turn)) return;
    const key="project-run:"+job.id+":"+row.state;
    const text=(job.repository??"AiGid TestFlight")+" · "+row.state+"\n"+String(row.detail??"");
    this.store.addMessage({conversationId:job.conversation,replyToId:job.source_message??job.id,channel:job.channel,direction:"outbound",kind:"notice",externalId:key,text});
    if(job.channel==="telegram") {
      const footer="Sent by an AI assistant.";
      await this.telegram?.sendMessage(job.actor,{text:text+"\n\n"+footer,entities:[{type:"italic",offset:text.length+2,length:footer.length}]},key);
    }
  }
  async cloudUpdate(event:string|undefined,body:Buffer,signature:string|undefined) {
    const config=configuration(this.files.root),key=join(this.files.root,".data/aigid-testflight/github-webhook-secret");
    if(!config?.workflow || !config.appleAppId || !existsSync(key)) throw new HomeError("Webhook is not configured.",404);
    const status=cloudStatus({repository:config.repository,workflow:config.workflow,appleAppId:config.appleAppId},readFileSync(key,"utf8").trim(),event,body,signature);
    if(!status) return;
    const job=this.queue.db.prepare("SELECT * FROM jobs WHERE release_commit=? AND repository IS NULL").get(status.sha) as unknown as BuildRequest|undefined;
    if(!job || !["dispatched","completed","failed"].includes(job.state)) return;
    const state=status.success?"completed":"failed";
    const install=config.testflightUrl?.startsWith("https://testflight.apple.com/") ? "\n"+config.testflightUrl : "";
    const detail=(status.success?"Apple completed the AiGid TestFlight workflow."+install:"Apple reported a TestFlight workflow failure.")+"\n"+status.url;
    this.queue.db.prepare("UPDATE jobs SET state=?,detail=? WHERE id=? AND state='dispatched'").run(state,detail,job.id);
    await this.report(job);
  }
  async close() {services.delete(this.store);this.stopSignal.abort();await this.active;this.queue.db.close();}
  private turn(job: BuildRequest): TelegramToolContext {
    const scope="agent-"+job.id.replaceAll("-","");
    return {channel:job.channel,conversationId:job.conversation,messageId:job.source_message??job.id,files:this.files,scope,
      ...(job.channel==="api"?{byOwner:true,deviceId:job.actor}:{telegramSenderId:job.actor})};
  }
  private activeRequest(job: BuildRequest, state: string) {
    const current = this.queue.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id);
    return !this.stopSignal.signal.aborted && current?.state === state && this.jobAllowed(job,this.turn(job));
  }
  private async dispatchProject(job:BuildRequest) {
    const repository=job.repository!;
    const route=this.releaseRoute(repository);
    const authorize=()=>{if(!route || this.releaseRoute(repository)!==route || !this.activeRequest(job,"ready")) throw new Error("Project delivery is no longer authorized.");};
    authorize();
    if(!job.commit_sha) throw new Error("Missing project revision.");
    if(route==="branch"){
      const worker=projectWorker(this.files.root)!;
      const sent=await publishPortfolio(worker,repository,job.id,job.commit_sha,this.stopSignal.signal);
      const detail="Pushed "+sent.revision+" to https://github.com/"+repository+"/tree/"+sent.branch+". The repository's workflow builds the candidate and merges it after its checks.";
      this.queue.db.prepare("UPDATE jobs SET state='dispatched',detail=? WHERE id=? AND state='ready'").run(detail,job.id);
      return;
    }
    const revision=job.pull ? await mergeWorkerCandidate(this.files.root,repository,{id:job.id,pull:job.pull,commit:job.commit_sha},authorize) : job.commit_sha;
    authorize();
    let detail:string;
    if(route==="home"){
      const tool=this.shell?.tools(this.turn(job));
      if(!tool?.definitions.length) throw new Error("The Home updater is unavailable to this requester.");
      const receipt=await tool.call({command:"openstrudel-update",background:true,timeoutSeconds:3600});
      detail="Home updater started for "+revision+". Its verified outcome follows in this chat. "+JSON.stringify(receipt).slice(0,250);
    }else{
      if(!job.pull) throw new Error("This release runs on a push. The request did not create a new revision.");
      detail="Merged "+revision+". The repository's push workflow owns deployment. Check the provider for the outcome.";
    }
    this.queue.db.prepare("UPDATE jobs SET state='dispatched',commit_sha=?,detail=? WHERE id=? AND state='ready'").run(revision,detail,job.id);
  }
  private async dispatch(job: BuildRequest) {
    const config = configuration(this.files.root);
    if (!config?.cloudEnabled || !job.commit_sha) throw new Error("Missing Xcode Cloud release configuration.");
    const authorize = () => {
      if (!this.activeRequest(job, "ready") || configuration(this.files.root)?.cloudEnabled !== true)
        throw new Error("This release is no longer authorized.");
    };
    const { branch, revision, releaseCommit } = await dispatchAiGidCloud(this.files.root, config.repository, {
      id: job.id, pull: job.pull, commit: job.commit_sha,
    }, authorize);
    this.queue.db.prepare("UPDATE jobs SET state='dispatched',release_commit=?,detail=? WHERE id=? AND state='ready'")
      .run(releaseCommit,`Published ${branch} at ${releaseCommit.slice(0,12)} for Xcode Cloud, with the exact source of main at ${revision.slice(0,12)}. Apple build and TestFlight availability have yet to be confirmed.`, job.id);
  }
  private async prepare(job:BuildRequest) {
    const {files,store}=this, c=configuration(files.root);
    const turn = this.turn(job);
    if (!this.jobAllowed(job,turn)) throw new Error("The requester no longer has release access.");
    const repository=job.repository??c!.repository;
    this.queue.db.prepare("UPDATE jobs SET state='preparing' WHERE id=?").run(job.id);
    const worker=projectWorker(files.root);
    const message=store.getMessage(job.conversation,job.source_message??job.id);
    if (!message || message.direction!=="inbound") throw new Error("The original request is unavailable.");
    if(job.package_target && worker){
      const r=job.package_target==="macos"
        ? await macPackage(files.root,repository,job.id,job.commit_sha,!!job.package_dispatched,revision=>this.queue.db.prepare("UPDATE jobs SET package_dispatched=1,commit_sha=? WHERE id=?").run(revision,job.id),this.stopSignal.signal)
        : await packageProject(worker,repository,job.id,job.package_target,job.commit_sha,this.stopSignal.signal);
      if(!this.activeRequest(job,"preparing")) throw new Error("Package access was revoked.");
      const detail=r.name+" · "+(r.size/1024/1024).toFixed(1)+" MiB\n"+r.url+"\nRevision "+r.revision+"\nSHA-256 "+r.sha256;
      this.queue.db.prepare("UPDATE jobs SET state='completed',commit_sha=?,detail=? WHERE id=? AND state='preparing'").run(r.revision,detail,job.id);
      return;
    }
    const dir=join(files.root,".data/aigid-testflight",job.id),inputs=join(dir,"inputs");
    mkdirSync(inputs,{recursive:true,mode:0o700});
    const images:string[]=[],remoteFiles:WorkerJob["files"]=[];
    for (const file of files.forMessage(job.conversation,(message.attachments??[]).map(f=>f.id))) {
      // Resolve through the originating workspace before copying an attachment to the isolated run.
      const origin=join(files.root,".data/workspace");
      const rel=file.path.slice(origin.length+1).split("/");
      if (!file.path.startsWith(origin+"/") || !rel[0]) throw new Error("Invalid attachment path.");
      const data=files.readOutput(rel[0],file.path);
      const target=join(inputs,file.id+"-"+basename(file.name));
      writeFileSync(target,Buffer.from(data.contentBase64,"base64"),{mode:0o600});
      remoteFiles.push({name:basename(target),data:data.contentBase64,image:["image/jpeg","image/png","image/webp"].includes(file.mimeType)});
      if (["image/jpeg","image/png","image/webp"].includes(file.mimeType)) images.push(target);
    }
    const branch=(job.repository?"wolf/project-":"wolf/aigid-")+job.id;
    const signal=AbortSignal.any([this.stopSignal.signal,AbortSignal.timeout(60*60*1000)]);
    const selection=resolveModelSelection(store,"main");
    const model={model:selection.provider && selection.provider!=="openai" ? null : selection.model,reasoningEffort:selection.reasoningEffort};
    if(job.repository && worker?.portfolio[job.repository]){
      const r=await preparePortfolio(worker,{id:job.id,repository,goal:job.goal,change:!!job.changes,files:remoteFiles,selection:model},signal);
      if(!this.activeRequest(job,"preparing")) throw new Error("Project access was revoked.");
      const detail=[r.notes,r.checks,r.changed ? "Saved "+r.branch+" at "+r.revision+" in the server checkout ~/projects/"+repository+"." : "Checked revision "+r.revision+"."].join("\n").slice(0,4800);
      this.queue.db.prepare("UPDATE jobs SET state=?,commit_sha=?,notes=?,detail=? WHERE id=? AND state='preparing'")
        .run(job.release_project?"ready":"completed",r.revision,r.notes,detail,job.id);
      return;
    }
    const gh=githubTools(store,turn);
    const checkout=await gh.call("github_checkout",{repository,fresh:!!worker || !job.commit_sha}) as {path:string;commit?:string};
    const base=job.commit_sha??checkout.commit;
    if (!base || !/^[a-f0-9]{40}$/.test(base)) throw new Error("Missing canonical checkout revision.");
    this.queue.db.prepare("UPDATE jobs SET commit_sha=? WHERE id=?").run(base,job.id);
    let candidate:{notes:string;checks:string};
    if(worker){
      const access=await workerReadAccess(files.root,repository);
      const result=await runProjectWorker(worker,{...access,base,branch,goal:job.goal,release:job.repository?"project":"aigid",
        change:!!job.changes,files:remoteFiles,selection:model},signal);
      if(!this.activeRequest(job,"preparing")) throw new Error("Project access was revoked.");
      if(job.changes) await commitWorkerPatch(checkout.path,base,branch,result.patch,result.notes.split("\n")[0]!.slice(0,150));
      candidate=result;
    }else{
      if(job.repository || !c) throw new Error("The project worker is unavailable.");
      candidate=await prepareCandidate({home:join(dir,"codex"),cwd:checkout.path,inputs,images,goal:job.goal,branch,changes:!!job.changes,
        account:this.account,email:c.accountEmail,selection,signal});
    }
    if (!this.activeRequest(job, "preparing")) throw new Error("The release was cancelled or access was revoked.");
    let commit=base, pull:number|null=null;
    if (job.changes) {
      const p=await gh.call("github_open_pull_request",{repository,branch,draft:false,title:candidate.notes.split("\n")[0]!.slice(0,150),
        body:candidate.notes+"\n\nChecks run on Wolf\n\n"+candidate.checks}) as {number:number;commit:string};
      commit=p.commit;pull=p.number;
    }
    if(job.repository){
      const detail=[candidate.notes,candidate.checks,pull?"https://github.com/"+repository+"/pull/"+pull:""].filter(Boolean).join("\n").slice(0,4800);
      this.queue.db.prepare("UPDATE jobs SET state=?,commit_sha=?,pull=?,notes=?,detail=? WHERE id=? AND state='preparing'")
        .run(job.release_project?"ready":"completed",commit,pull,candidate.notes,detail,job.id);
      return;
    }
    this.queue.db.prepare("UPDATE jobs SET state='ready',commit_sha=?,pull=?,notes=?,detail=? WHERE id=? AND state='preparing'")
      .run(commit,pull,candidate.notes,c!.cloudEnabled ? "Prepared for Xcode Cloud." : "Prepared on Wolf. Waiting for the first Xcode Cloud workflow to be connected.",job.id);
  }
}
