import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type BuildState = "queued" | "preparing" | "ready" | "building" | "team" | "external" | "failed";
export interface BuildRequest {
  id: string; created: string; conversation: string; channel: "api" | "telegram"; actor: string;
  goal: string; changes: number; state: BuildState; commit_sha: string | null;
  pull: number | null; notes: string | null; detail: string | null;
}

export class BuildQueue {
  readonly db: DatabaseSync;
  constructor(root: string) {
    const directory = resolve(root, ".data/aigid-testflight");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(directory, "jobs.sqlite"));
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created TEXT NOT NULL, conversation TEXT NOT NULL, channel TEXT NOT NULL, actor TEXT NOT NULL, goal TEXT NOT NULL, changes INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued', commit_sha TEXT, pull INTEGER, notes TEXT, detail TEXT)");
  }
  add(id: string, conversation: string, channel: string, actor: string, goal: string, changes: boolean) {
    this.db.prepare("INSERT OR IGNORE INTO jobs (id,created,conversation,channel,actor,goal,changes) VALUES(?,?,?,?,?,?,?)")
      .run(id,new Date().toISOString(),conversation,channel,actor,goal,Number(changes));
    return this.db.prepare("SELECT id,state,detail,pull FROM jobs WHERE id=?").get(id);
  }
  next() {
    return this.db.prepare("SELECT * FROM jobs WHERE state IN ('queued','preparing') ORDER BY created LIMIT 1").get() as unknown as BuildRequest | undefined;
  }
  worker(input: Record<string,unknown>) {
    if (input.action === "list") return this.db.prepare("SELECT id,created,state,commit_sha,pull,notes,detail FROM jobs WHERE state IN ('ready','building','team') ORDER BY created").all();
    const { id, state, detail } = input;
    if (input.action !== "report" || typeof id !== "string" || typeof state !== "string" || typeof detail !== "string" || detail.length > 1500)
      throw new Error("Invalid worker report");
    const sources: Record<string,string[]> = { building:["ready","building"], team:["building","team"], external:["building","team","external"], failed:["ready","building","team","failed"] };
    const from = sources[state];
    if (!from || !this.db.prepare("UPDATE jobs SET state=?,detail=? WHERE id=? AND state IN ("+from.map(()=>"?").join(",")+")").run(state,detail,id,...from).changes)
      throw new Error("Unknown request or stale transition");
    return { ok:true };
  }
}

// The signing Mac has a forced SSH command with only this JSON protocol.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const queue = new BuildQueue(process.cwd());
  try {
    let input = "";
    for await (const part of process.stdin) { input += part; if (input.length > 4096) throw new Error("Too large"); }
    console.log(JSON.stringify(queue.worker(JSON.parse(input))));
  } finally { queue.db.close(); }
}
