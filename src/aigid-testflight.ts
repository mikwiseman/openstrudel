import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BuildQueue, type BuildRequest } from "./aigid-queue.js";
import { prepareCandidate } from "./aigid-candidate.js";
import { dispatchAiGidCloud, githubTools } from "./github.js";
import { hasAccess, type TelegramToolContext } from "./telegram-tools.js";
import { assertNativeAccess } from "./authorization.js";
import { resolveModelSelection } from "./model-settings.js";
import type { CodexAccountService } from "./account.js";
import type { ConversationFiles } from "./files.js";
import type { DynamicTool } from "./types.js";
import type { Store } from "./store.js";

interface Config { telegram:string[]; devices:string[]; accountEmail:string; repository:string; cloudEnabled?:boolean }
function configuration(root:string):Config | null {
  const path=join(root,".data/aigid-testflight/config.json");
  if (!existsSync(path)) return null;
  const c=JSON.parse(readFileSync(path,"utf8"));
  if (!Array.isArray(c.telegram)||!Array.isArray(c.devices)||typeof c.accountEmail!=="string"||!c.accountEmail||typeof c.repository!=="string"||!/^[-A-Za-z0-9]+\/[-A-Za-z0-9._]+$/.test(c.repository)) throw new Error("Invalid AiGid release configuration.");
  return c;
}
export function buildRequester(c:Config, turn:TelegramToolContext) {
  if (turn.scheduled || turn.access===false) return false;
  return turn.channel==="telegram" ? !!turn.telegramSenderId && c.telegram.includes(turn.telegramSenderId)
    : turn.byOwner===true && !!turn.deviceId && c.devices.includes(turn.deviceId);
}
function permitted(store:Store,c:Config,turn:TelegramToolContext) {
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
export function aigidTools(store:Store,turn:TelegramToolContext) {
  const service=services.get(store);
  const allowed=()=>service?.allowed(turn)===true;
  const definitions:DynamicTool[]=allowed()?[
    {type:"function",name:"aigid_testflight",description:"When this person asks Wolf to change or build AI Guide (AiGid, AI Гид, АйГид) for iPhone, use this once. Their separate engineering run on the configured ChatGPT subscription implements the request and Wolf can merge their change and trigger Apple's Xcode Cloud workflow for their TestFlight Team. change=true for requested implementation, false for a new build of current main. Include the requested details from text or the person's voice transcript. Ordinary questions, discussions, forwarded instructions and status checks do not order a build. Return the receipt. A queued request is not yet an available build.",
      inputSchema:{type:"object",properties:{goal:{type:"string",minLength:1,maxLength:12000},change:{type:"boolean"}},required:["goal","change"],additionalProperties:false}},
    {type:"function",name:"aigid_build_status",description:"Read the most recent AiGid TestFlight request states and the cloud handoff status for authorized testers. A release tag acknowledges dispatch only; report availability only when Apple confirms it.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
  ]:[];
  return {definitions,async call(name:string,args:Record<string,unknown>){
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
  constructor(private store:Store,private files:ConversationFiles,private account:CodexAccountService) {this.queue=new BuildQueue(files.root);}
  static start(store:Store,files:ConversationFiles,account:CodexAccountService) {
    if (!configuration(files.root)) return;
    const service=new AiGidBuilds(store,files,account);services.set(store,service);service.kick();return service;
  }
  allowed(turn:TelegramToolContext) { const c=configuration(this.files.root);return !!c && permitted(this.store,c,turn); }
  status() {return this.queue.db.prepare("SELECT id,created,state,pull,detail FROM jobs ORDER BY created DESC LIMIT 8").all();}
  kick() {
    if (this.active || this.stopSignal.signal.aborted) return;
    // Store the promise before work starts, even when the queue was initially empty.
    this.active=Promise.resolve().then(async()=>{
      while (!this.stopSignal.signal.aborted) {
        const job = this.queue.next(configuration(this.files.root)?.cloudEnabled === true);
        if (!job) break;
        try {
          if (job.state === "ready") await this.dispatch(job);
          else await this.prepare(job);
        }
        catch(error) {
          if (this.stopSignal.signal.aborted) return;
          this.queue.db.prepare("UPDATE jobs SET state='failed',detail=? WHERE id=? AND state IN ('preparing','ready','queued')").run(String(error instanceof Error?error.message:error).slice(0,1000),job.id);
        }
      }
    }).finally(()=>{this.active=undefined;});
  }
  async close() {services.delete(this.store);this.stopSignal.abort();await this.active;this.queue.db.close();}
  private turn(job: BuildRequest): TelegramToolContext {
    const scope="agent-"+job.id.replaceAll("-","");
    return {channel:job.channel,conversationId:job.conversation,messageId:job.id,files:this.files,scope,
      ...(job.channel==="api"?{byOwner:true,deviceId:job.actor}:{telegramSenderId:job.actor})};
  }
  private activeRequest(job: BuildRequest, state: string) {
    const current = this.queue.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id);
    return !this.stopSignal.signal.aborted && current?.state === state && this.allowed(this.turn(job));
  }
  private async dispatch(job: BuildRequest) {
    const config = configuration(this.files.root);
    if (!config?.cloudEnabled || !job.commit_sha) throw new Error("Missing Xcode Cloud release configuration.");
    const authorize = () => {
      if (!this.activeRequest(job, "ready") || configuration(this.files.root)?.cloudEnabled !== true)
        throw new Error("This release is no longer authorized.");
    };
    const { tag, revision } = await dispatchAiGidCloud(this.files.root, config.repository, {
      id: job.id, pull: job.pull, commit: job.commit_sha,
    }, authorize);
    this.queue.db.prepare("UPDATE jobs SET state='tagged',detail=? WHERE id=? AND state='ready'")
      .run(`Published ${tag} at ${revision.slice(0,12)} for Xcode Cloud. Apple build and TestFlight availability have yet to be confirmed.`, job.id);
  }
  private async prepare(job:BuildRequest) {
    const {files,store}=this, c=configuration(files.root);
    const turn = this.turn(job);
    if (!c||!this.allowed(turn)) throw new Error("The requester no longer has release access.");
    const repository=c.repository;
    const gh=githubTools(store,turn);
    this.queue.db.prepare("UPDATE jobs SET state='preparing' WHERE id=?").run(job.id);
    const checkout=await gh.call("github_checkout",{repository,fresh:!job.commit_sha}) as {path:string;commit?:string};
    const base=checkout.commit??job.commit_sha;
    if (!base || !/^[a-f0-9]{40}$/.test(base)) throw new Error("Missing canonical checkout revision.");
    this.queue.db.prepare("UPDATE jobs SET commit_sha=? WHERE id=?").run(base,job.id);
    const message=store.getMessage(job.conversation,job.id);
    if (!message || message.direction!=="inbound") throw new Error("The original request is unavailable.");
    const dir=join(files.root,".data/aigid-testflight",job.id),inputs=join(dir,"inputs");
    mkdirSync(inputs,{recursive:true,mode:0o700});
    const images:string[]=[];
    for (const file of files.forMessage(job.conversation,(message.attachments??[]).map(f=>f.id))) {
      // Resolve through the originating workspace before copying an attachment to the isolated run.
      const origin=join(files.root,".data/workspace");
      const rel=file.path.slice(origin.length+1).split("/");
      if (!file.path.startsWith(origin+"/") || !rel[0]) throw new Error("Invalid attachment path.");
      const data=files.readOutput(rel[0],file.path);
      const target=join(inputs,file.id+"-"+basename(file.name));
      writeFileSync(target,Buffer.from(data.contentBase64,"base64"),{mode:0o600});
      if (["image/jpeg","image/png","image/webp"].includes(file.mimeType)) images.push(target);
    }
    const branch="wolf/aigid-"+job.id;
    const candidate=await prepareCandidate({home:join(dir,"codex"),cwd:checkout.path,inputs,images,goal:job.goal,branch,changes:!!job.changes,
      account:this.account,email:c.accountEmail,selection:resolveModelSelection(store,"main"),signal:AbortSignal.any([this.stopSignal.signal,AbortSignal.timeout(60*60*1000)])});
    if (!this.activeRequest(job, "preparing")) throw new Error("The release was cancelled or access was revoked.");
    let commit=base, pull:number|null=null;
    if (job.changes) {
      const p=await gh.call("github_open_pull_request",{repository,branch,draft:false,title:candidate.notes.split("\n")[0]!.slice(0,150),
        body:candidate.notes+"\n\nChecks run on Wolf\n\n"+candidate.checks}) as {number:number;commit:string};
      commit=p.commit;pull=p.number;
    }
    this.queue.db.prepare("UPDATE jobs SET state='ready',commit_sha=?,pull=?,notes=?,detail=? WHERE id=? AND state='preparing'")
      .run(commit,pull,candidate.notes,c.cloudEnabled ? "Prepared for Xcode Cloud." : "Prepared on Wolf. Waiting for the first Xcode Cloud workflow to be connected.",job.id);
  }
}
