import { z } from "zod";

const revision = z.string().regex(/^[0-9a-f]{40}$/);
const repository = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/);
const sourceBranch = z.string().min(1).max(240).refine(name =>
  !name.startsWith("-") && !name.includes("..") && !name.includes("@{") &&
  !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(name) && name.split("/").every(part=>part && !part.startsWith(".") && !part.endsWith(".lock") && !part.endsWith(".")));
export function snapshotBranch(remoteHead:string,base:string) {
  const lines=remoteHead.trim().split("\n");
  if(!lines.includes(base+"\tHEAD")) return undefined;
  const name=lines.map(line=>/^ref: refs\/heads\/([^\t]+)\tHEAD$/.exec(line)?.[1]).find(Boolean);
  const parsed=sourceBranch.safeParse(name);
  return parsed.success ? parsed.data : undefined;
}
const attachment = z.object({
  name: z.string().min(1).max(220).refine(name => name !== "." && name !== ".." && !/[\/\\\x00-\x1f]/.test(name)),
  data: z.base64().max(24 * 1024 * 1024),
  image: z.boolean().default(false),
});
const job = z.object({
  repository, base:revision, defaultBranch:sourceBranch.optional(),
  branch:z.string().regex(/^wolf\/(?:project|aigid)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
  goal:z.string().trim().min(1).max(12000), change:z.boolean(), release:z.enum(["project","aigid"]),
  gitToken:z.string().min(1), files:z.array(attachment).max(24),
  selection:z.object({model:z.string().nullable().optional(),reasoningEffort:z.string().nullable().optional()}),
});
export type WorkerJob = z.infer<typeof job>;
export const validateWorkerJob = (value:unknown) => job.parse(value);
const result = z.object({base:revision,notes:z.string().trim().min(1).max(1800),checks:z.string().max(4000),patch:z.string().max(32 * 1024 * 1024)});
export function validateWorkerResult(value:unknown,base:string,change:boolean) {
  const output=result.parse(value);
  if (output.base!==base || (!change && output.patch)) throw new Error("Worker returned changes outside the requested revision or mode.");
  return output;
}
