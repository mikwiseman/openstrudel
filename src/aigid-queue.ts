import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export type BuildState = "queued" | "preparing" | "ready" | "tagged" | "dispatched" | "completed" | "failed";
export interface BuildRequest {
  id: string; created: string; conversation: string; channel: "api" | "telegram"; actor: string;
  goal: string; changes: number; state: BuildState; commit_sha: string | null;
  package_dispatched:number; source_message:string|null; package_target:"android"|"web"|"macos"|null; repository:string|null; release_project:number; pull: number | null; notes: string | null; detail: string | null;
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
  }
  add(id: string, conversation: string, channel: string, actor: string, goal: string, changes: boolean, repository:string|null=null, releaseProject=false) {
    this.db.prepare("INSERT OR IGNORE INTO jobs (id,created,conversation,channel,actor,goal,changes,repository,release_project) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id,new Date().toISOString(),conversation,channel,actor,goal,Number(changes),repository,Number(releaseProject));
    return this.db.prepare("SELECT id,state,detail,pull FROM jobs WHERE id=?").get(id);
  }
  addPackage(message:string,conversation:string,channel:string,actor:string,repository:string,target:"android"|"web"|"macos",revision?:string) {
    const bytes=createHash("sha256").update(JSON.stringify([conversation,message,repository,target])).digest();
    bytes[6]=(bytes[6]!&15)|128;bytes[8]=(bytes[8]!&63)|128;
    const hex=bytes.toString("hex");
    const id=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20,32)].join("-");
    this.db.prepare("INSERT OR IGNORE INTO jobs (id,created,conversation,channel,actor,goal,changes,repository,source_message,package_target,commit_sha) VALUES(?,?,?,?,?,?,0,?,?,?,?)")
      .run(id,new Date().toISOString(),conversation,channel,actor,"Build the "+target+" package",repository,message,target,revision??null);
    return this.db.prepare("SELECT id,state,detail FROM jobs WHERE id=?").get(id)!;
  }
  next(cloudEnabled: boolean) {
    return this.db.prepare("SELECT * FROM jobs WHERE state IN ('queued','preparing') OR (state='ready' AND (repository IS NOT NULL OR ?)) ORDER BY created LIMIT 1")
      .get(Number(cloudEnabled)) as unknown as BuildRequest | undefined;
  }
}
