import type { CloudReceipt } from "./aigid-cloud-status.js";
import type { ProjectDelivery } from "./project-delivery.js";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export const packageTargets = ["android", "web", "macos", "desktop"] as const;
export type PackageTarget = typeof packageTargets[number];
export const isPackageTarget = (value: unknown): value is PackageTarget => packageTargets.some(target => target === value);
export interface ProposedBuild { change:boolean; repository?:string; release?:boolean|"source"; packages?:PackageTarget[]; packageOnly?:PackageTarget; revision?:string; destination?:"website"; route?:string; githubOnly?:true }
interface Proposal { id:string; goal:string; state:string; files:string; job_id:string|null; build:ProposedBuild; replaces:string|null }
export function requestId(conversation: string, message: string, repository: string | null, operation: string) {
  const bytes = createHash("sha256").update(JSON.stringify([conversation, message, repository, operation])).digest();
  bytes[6] = (bytes[6]! & 15) | 128;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20,32)].join("-");
}
export type BuildState = "queued" | "preparing" | "ready" | "tagged" | "dispatched" | "completed" | "failed";
export interface BuildRequest {
  id: string; created: string; conversation: string; channel: "api" | "telegram"; actor: string;
  goal: string; changes: number; state: BuildState; commit_sha: string | null;
  apple_build_number?:number|null;
  package_dispatched:number; source_message:string|null; package_target:PackageTarget|null; parent_request:string|null; repository:string|null; release_project:number; pull: number | null; notes: string | null; detail: string | null;
}

export class BuildQueue {
  readonly db: DatabaseSync;
  constructor(root: string) {
    const directory = resolve(root, ".data/aigid-testflight");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(directory, "jobs.sqlite"));
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created TEXT NOT NULL, conversation TEXT NOT NULL, channel TEXT NOT NULL, actor TEXT NOT NULL, goal TEXT NOT NULL, changes INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued', commit_sha TEXT, pull INTEGER, notes TEXT, detail TEXT)");
    const columns=this.db.prepare("PRAGMA table_info(jobs)").all().map(row=>row.name);
    if (!columns.includes("package_dispatched")) this.db.exec("ALTER TABLE jobs ADD COLUMN package_dispatched INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("release_commit")) this.db.exec("ALTER TABLE jobs ADD COLUMN release_commit TEXT");
    if (!columns.includes("source_message")) this.db.exec("ALTER TABLE jobs ADD COLUMN source_message TEXT");
    if (!columns.includes("package_target")) this.db.exec("ALTER TABLE jobs ADD COLUMN package_target TEXT");
    if (!columns.includes("repository")) this.db.exec("ALTER TABLE jobs ADD COLUMN repository TEXT");
    if (!columns.includes("release_project")) this.db.exec("ALTER TABLE jobs ADD COLUMN release_project INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("parent_request")) this.db.exec("ALTER TABLE jobs ADD COLUMN parent_request TEXT");
    if (!columns.includes("apple_build_number")) this.db.exec("ALTER TABLE jobs ADD COLUMN apple_build_number INTEGER");
    if (!columns.includes("apple_number_required")) this.db.exec("ALTER TABLE jobs ADD COLUMN apple_number_required INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("apple_run_id")) this.db.exec("ALTER TABLE jobs ADD COLUMN apple_run_id TEXT");
    this.db.exec(`CREATE TABLE IF NOT EXISTS aigid_cloud_receipts (
      sha TEXT NOT NULL, run TEXT NOT NULL, number INTEGER, state TEXT, detail TEXT, reported INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(sha,run))`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS project_deliveries
      (repository TEXT NOT NULL,source TEXT NOT NULL,identity TEXT NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL,at INTEGER NOT NULL,
       PRIMARY KEY(repository,source,identity))`);
    this.db.exec("CREATE INDEX IF NOT EXISTS jobs_source ON jobs(conversation,source_message,repository)");
    this.db.exec(`CREATE TABLE IF NOT EXISTS aigid_proposals (
      id TEXT PRIMARY KEY, conversation TEXT NOT NULL, goal TEXT NOT NULL, files TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', job_id TEXT UNIQUE)`);
    const proposalColumns=this.db.prepare("PRAGMA table_info(aigid_proposals)").all().map(row=>row.name);
    if (!proposalColumns.includes("build_json")) this.db.exec("ALTER TABLE aigid_proposals ADD COLUMN build_json TEXT");
    if (!proposalColumns.includes("replaces")) this.db.exec("ALTER TABLE aigid_proposals ADD COLUMN replaces TEXT");
  }
  pending(conversation:string) {
    return this.db.prepare("SELECT id,goal,build_json FROM aigid_proposals WHERE conversation=? AND state='pending' ORDER BY rowid")
      .all(conversation).map(row=>({id:String(row.id),goal:String(row.goal),build:(row.build_json ? JSON.parse(String(row.build_json)) : {change:true}) as ProposedBuild}));
  }
  proposal(id:string,conversation:string):Proposal|undefined {
    const row=this.db.prepare("SELECT * FROM aigid_proposals WHERE id=? AND conversation=?").get(id,conversation);
    return row ? {id:String(row.id),goal:String(row.goal),state:String(row.state),files:String(row.files),
      job_id:row.job_id == null ? null : String(row.job_id), replaces:row.replaces == null ? null : String(row.replaces),
      build:row.build_json ? JSON.parse(String(row.build_json)) : {change:true}} : undefined;
  }
  cancel(id:string,conversation:string) {
    const row=this.db.prepare("UPDATE aigid_proposals SET state='cancelled' WHERE id=? AND conversation=? AND state IN ('pending','cancelled') RETURNING id,state").get(id,conversation);
    if(!row) throw new Error("Only a pending proposal in this chat can be cancelled.");
    return row;
  }
  propose(id:string,conversation:string,goal:string,files:string[],replaces?:string,build?:ProposedBuild) {
    if (!goal.trim() || goal.length>2400) throw new Error("Write a concise, complete plan (up to 2400 characters) for the tester to approve.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let proposal=this.proposal(id,conversation);
      if (!proposal) {
        if (!replaces) {
          const normalized=goal.trim().replace(/\s+/g," "), action=JSON.stringify(build??{change:true});
          replaces=this.pending(conversation).find(p=>p.goal.trim().replace(/\s+/g," ")===normalized && JSON.stringify(p.build)===action)?.id;
        }
        if (replaces) {
          const prior=this.proposal(replaces,conversation);
          if (prior?.state!=="pending") throw new Error("That proposal is no longer open in this chat.");
          build ??= prior.build;
          if (prior.build.repository !== build.repository) throw new Error("Revise the plan for the same repository.");
          files=[...new Set([...JSON.parse(prior.files) as string[],...files])];
          this.db.prepare("UPDATE aigid_proposals SET state='replaced' WHERE id=?").run(replaces);
        }
        if(files.length>24) throw new Error("Use up to 24 attachments for one change.");
        if (this.db.prepare("SELECT 1 FROM jobs WHERE conversation=? AND source_message=? AND repository IS ?").get(conversation,id,build?.repository??null))
          throw new Error("This request is already queued. Do not open a second plan for it.");
        this.db.prepare("INSERT INTO aigid_proposals (id,conversation,goal,files,build_json,replaces) VALUES(?,?,?,?,?,?)")
          .run(id,conversation,goal,JSON.stringify(files),JSON.stringify(build ?? {change:true}),replaces ?? null);
        proposal=this.proposal(id,conversation)!;
      }
      this.db.exec("COMMIT");return {id:proposal.id,goal:proposal.goal,state:proposal.state};
    } catch(error) {this.db.exec("ROLLBACK");throw error;}
  }
  approve(id:string,message:string,conversation:string,channel:string,actor:string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const proposal=this.proposal(id,conversation);
      if (!proposal || !["pending","approved"].includes(proposal.state)) throw new Error("That proposal is no longer open in this chat.");
      if (id===message) throw new Error("Wait for a separate approval from a tester.");
      let job=proposal.job_id;
      if (!job) {
        if(this.db.prepare("SELECT 1 FROM jobs WHERE conversation=? AND source_message=? AND repository IS ?").get(conversation,message,proposal.build.repository??null))
          throw new Error("A different change is already being released for this approval.");
        const build=proposal.build;
        const receipt=build.packageOnly && build.repository
          ? this.addPackage(message,conversation,channel,actor,build.repository,build.packageOnly,build.revision)
          : this.add(message,conversation,channel,actor,proposal.goal,build.change,build.repository,build.release,build.packages);
        job=String(receipt.id);
        this.db.prepare("UPDATE aigid_proposals SET state='approved',job_id=? WHERE id=?").run(job,id);
      }
      const receipt=this.db.prepare("SELECT id,state,detail,pull FROM jobs WHERE id=?").get(job)!;
      this.db.exec("COMMIT");return receipt;
    } catch(error) {this.db.exec("ROLLBACK");throw error;}
  }
  feedbackFor(job:string):string[] {
    const row=this.db.prepare("SELECT files FROM aigid_proposals WHERE job_id=?").get(job);
    return row ? JSON.parse(String(row.files)) : [];
  }
  approvedBuild(job:string):ProposedBuild|undefined {
    const row=this.db.prepare("SELECT build_json FROM aigid_proposals WHERE job_id=? AND state='approved'").get(job);
    return row?.build_json ? JSON.parse(String(row.build_json)) : undefined;
  }
  add(message: string, conversation: string, channel: string, actor: string, goal: string, changes: boolean,
      repository: string | null = null, releaseProject:boolean|"source" = false, targets: PackageTarget[] = []) {
    this.db.exec("SAVEPOINT add_build");
    try {
      // Earlier Home versions used the message ID for project jobs. Keep their receipts valid on replay.
      const legacy = this.db.prepare("SELECT repository,actor,conversation FROM jobs WHERE id=?").get(message);
      const reuse = legacy && legacy.repository === repository && legacy.actor === actor && legacy.conversation === conversation;
      const id = reuse || (!legacy && !repository) ? message : requestId(conversation,message,repository,"project");
      const releaseMode=releaseProject==="source" ? 2 : Number(releaseProject);
      this.db.prepare(`INSERT OR IGNORE INTO jobs
        (id,created,conversation,channel,actor,goal,changes,repository,release_project,source_message) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(id,new Date().toISOString(),conversation,channel,actor,goal,Number(changes),repository,releaseMode,message);
      if (repository) for (const target of targets) this.addPackage(message,conversation,channel,actor,repository,target,undefined,id);
      const receipt = this.db.prepare("SELECT id,state,detail,pull FROM jobs WHERE id=? AND conversation=? AND actor=? AND release_project=?").get(id,conversation,actor,releaseMode);
      if (!receipt) throw new Error("Project request identity changed.");
      this.db.exec("RELEASE add_build");
      return receipt;
    } catch (error) { this.db.exec("ROLLBACK TO add_build; RELEASE add_build"); throw error; }
  }
  addPackage(message:string,conversation:string,channel:string,actor:string,repository:string,target:PackageTarget,revision?:string,parent?:string) {
    const id = requestId(conversation,message,repository,target);
    const source = parent ?? (!revision ? this.db.prepare(`SELECT id FROM jobs
      WHERE conversation=? AND actor=? AND repository=? AND (source_message=? OR id=?) AND changes=1 AND package_target IS NULL`)
      .get(conversation,actor,repository,message,message)?.id : null) ?? null;
    this.db.prepare(`INSERT OR IGNORE INTO jobs
      (id,created,conversation,channel,actor,goal,changes,repository,source_message,package_target,commit_sha,parent_request)
      VALUES(?,?,?,?,?,?,0,?,?,?,?,?)`).run(id,new Date().toISOString(),conversation,channel,actor,"Build the "+target+" package",repository,message,target,revision??null,source);
    const result = this.db.prepare("SELECT id,state,detail,parent_request,commit_sha FROM jobs WHERE id=? AND actor=? AND conversation=?").get(id,actor,conversation);
    if (!result || (source && result.parent_request !== source) || (revision && result.commit_sha !== revision))
      throw new Error("An existing package request has a different source. Send a new request for this revision.");
    return {id:result.id,state:result.state,detail:result.detail};
  }
  packageRevision(job: BuildRequest): string | null {
    if (!job.parent_request) return job.commit_sha;
    const parent = this.db.prepare("SELECT state,commit_sha FROM jobs WHERE id=? AND repository=? AND conversation=? AND actor=?")
      .get(job.parent_request,job.repository,job.conversation,job.actor);
    if (!parent || !["completed","dispatched"].includes(String(parent.state)) || typeof parent.commit_sha !== "string" || !/^[a-f0-9]{40}$/.test(parent.commit_sha))
      throw new Error("The source change did not complete. There is no changed revision to package.");
    return parent.commit_sha;
  }
  recordDelivery(repository:string,event:ProjectDelivery):BuildRequest|undefined {
    if (event.kind==="pull") {
      const row=this.db.prepare(`UPDATE jobs SET pull=? WHERE id=? AND repository=? AND commit_sha=? AND release_project=1
        AND package_target IS NULL AND (pull IS NULL OR pull=?) RETURNING id`).get(event.pull,event.job,repository,event.sha,event.pull);
      return row ? this.finishDelivery(String(row.id)) : undefined;
    }
    // GitHub may send the deployment comment before its pull-request event or before the dispatch transaction finishes.
    this.db.prepare("DELETE FROM project_deliveries WHERE at < unixepoch()-604800").run();
    this.db.prepare(`INSERT INTO project_deliveries(repository,source,identity,state,detail,at) VALUES(?,?,?,?,?,unixepoch())
      ON CONFLICT(repository,source,identity) DO UPDATE SET state=excluded.state,detail=excluded.detail,at=excluded.at`)
      .run(repository,event.source,event.key,event.state,event.detail);
    const column=event.source==="pull"?"pull":"commit_sha";
    const job=this.db.prepare("SELECT id FROM jobs WHERE repository=? AND release_project=1 AND package_target IS NULL AND state='dispatched' AND "+column+"=?")
      .get(repository,event.key);
    return job ? this.finishDelivery(String(job.id)) : undefined;
  }
  finishDelivery(id:string):BuildRequest|undefined {
    const provider=this.db.prepare(`SELECT d.state,d.detail FROM jobs j JOIN project_deliveries d ON d.repository=j.repository
      AND ((d.source='pull' AND d.identity=CAST(j.pull AS TEXT)) OR (d.source='commit' AND d.identity=j.commit_sha))
      WHERE j.id=? AND j.release_project=1 AND j.package_target IS NULL AND j.state='dispatched' ORDER BY d.at DESC LIMIT 1`).get(id);
    if (!provider) return undefined;
    return this.db.prepare("UPDATE jobs SET state=?,detail=? WHERE id=? AND state='dispatched' RETURNING *")
      .get(String(provider.state),String(provider.detail),id) as unknown as BuildRequest|undefined;
  }
  recordCloudReceipt(receipt:CloudReceipt) {
    if ("number" in receipt) {
      this.db.prepare(`INSERT INTO aigid_cloud_receipts(sha,run,number) VALUES(?,?,?)
        ON CONFLICT(sha,run) DO UPDATE SET number=excluded.number WHERE number IS NULL`).run(receipt.sha,receipt.run,receipt.number);
    } else {
      this.db.prepare(`INSERT INTO aigid_cloud_receipts(sha,run,state,detail) VALUES(?,?,?,?)
        ON CONFLICT(sha,run) DO UPDATE SET state=excluded.state,detail=excluded.detail WHERE state IS NULL`)
        .run(receipt.sha,receipt.run,receipt.state,receipt.detail);
    }
  }
  cloudReports():BuildRequest[] {
    const receipts=this.db.prepare(`SELECT j.id,r.run,r.number,r.state,r.detail FROM aigid_cloud_receipts r
      JOIN jobs j ON j.repository IS NULL AND j.release_commit=r.sha
      WHERE r.reported=0 AND r.state IS NOT NULL AND (j.apple_number_required=0 OR r.number IS NOT NULL)
        AND (j.state='dispatched' OR (j.apple_run_id=r.run AND j.state=r.state)) ORDER BY r.rowid`).all();
    const jobs:BuildRequest[]=[];
    for(const r of receipts) {
      this.db.prepare("UPDATE jobs SET state=?,detail=?,apple_run_id=?,apple_build_number=? WHERE id=? AND state='dispatched'")
        .run(r.state!,r.detail!,r.run!,r.number??null,r.id!);
      const job=this.db.prepare("SELECT * FROM jobs WHERE id=? AND apple_run_id=?").get(r.id!,r.run!);
      if(job) jobs.push(job as unknown as BuildRequest);
    }
    return jobs;
  }
  markCloudReported(id:string) {
    this.db.prepare(`UPDATE aigid_cloud_receipts SET reported=1 WHERE (sha,run)=
      (SELECT release_commit,apple_run_id FROM jobs WHERE id=?)`).run(id);
  }
  next(cloudEnabled: boolean) {
    return this.db.prepare(`SELECT job.* FROM jobs job LEFT JOIN jobs parent ON parent.id=job.parent_request
      WHERE (job.state IN ('queued','preparing') OR (job.state='ready' AND (job.repository IS NOT NULL OR ?)))
        AND (parent.id IS NULL OR parent.state IN ('completed','dispatched','failed'))
      ORDER BY job.created,job.rowid LIMIT 1`).get(Number(cloudEnabled)) as unknown as BuildRequest | undefined;
  }
}
