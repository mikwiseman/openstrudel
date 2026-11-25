import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export type BuildState = "queued" | "preparing" | "ready" | "tagged" | "dispatched" | "completed" | "failed";
export interface BuildRequest {
  id: string; created: string; conversation: string; channel: "api" | "telegram"; actor: string;
  goal: string; changes: number; state: BuildState; commit_sha: string | null;
  repository:string|null; release_project:number; pull: number | null; notes: string | null; detail: string | null;
}

export class BuildQueue {
  readonly db: DatabaseSync;
  constructor(root: string) {
    const directory = resolve(root, ".data/aigid-testflight");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(directory, "jobs.sqlite"));
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created TEXT NOT NULL, conversation TEXT NOT NULL, channel TEXT NOT NULL, actor TEXT NOT NULL, goal TEXT NOT NULL, changes INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued', commit_sha TEXT, pull INTEGER, notes TEXT, detail TEXT)");
    const columns=this.db.prepare("PRAGMA table_info(jobs)").all().map(row=>row.name);
    if (!columns.includes("repository")) this.db.exec("ALTER TABLE jobs ADD COLUMN repository TEXT");
    if (!columns.includes("release_project")) this.db.exec("ALTER TABLE jobs ADD COLUMN release_project INTEGER NOT NULL DEFAULT 0");
  }
  add(id: string, conversation: string, channel: string, actor: string, goal: string, changes: boolean, repository:string|null=null, releaseProject=false) {
    this.db.prepare("INSERT OR IGNORE INTO jobs (id,created,conversation,channel,actor,goal,changes,repository,release_project) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id,new Date().toISOString(),conversation,channel,actor,goal,Number(changes),repository,Number(releaseProject));
    return this.db.prepare("SELECT id,state,detail,pull FROM jobs WHERE id=?").get(id);
  }
  next(cloudEnabled: boolean) {
    return this.db.prepare("SELECT * FROM jobs WHERE state IN ('queued','preparing') OR (state='ready' AND (repository IS NOT NULL OR ?)) ORDER BY created LIMIT 1")
      .get(Number(cloudEnabled)) as unknown as BuildRequest | undefined;
  }
}
