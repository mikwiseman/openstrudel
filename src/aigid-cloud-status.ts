import { createHmac, timingSafeEqual } from "node:crypto";
import { HomeError } from "./home.js";

export function verifyGitHubSignature(secret:string,body:Buffer,signature:string|undefined) {
  const digest=createHmac("sha256",secret).update(body).digest();
  if(!signature || !/^sha256=[0-9a-f]{64}$/.test(signature) || !timingSafeEqual(digest,Buffer.from(signature.slice(7),"hex")))
    throw new HomeError("Invalid GitHub webhook signature.",401);
}

export interface CloudStatusConfig { repository:string; workflow:string; appleAppId:string }
export function cloudStatus(config:CloudStatusConfig, secret:string, event:string|undefined, body:Buffer, signature:string|undefined) {
  verifyGitHubSignature(secret,body,signature);
  if(event!=="status") return null;
  const value=JSON.parse(body.toString("utf8"));
  if(value.repository?.full_name!==config.repository || value.sender?.id!==84813463 || value.sender?.login!=="xcode-cloud[bot]" ||
     value.context!==config.workflow || !["success","failure","error"].includes(value.state) || !/^[a-f0-9]{40}$/.test(value.sha)) return null;
  let url:URL;
  try {url=new URL(value.target_url);} catch {return null;}
  const path=url.pathname.match(/^\/teams\/[a-f0-9-]{36}\/apps\/(\d+)\/ci\/builds\/([a-f0-9-]{36})$/i);
  if(url.origin!=="https://appstoreconnect.apple.com" || path?.[1]!==config.appleAppId || !uuid.test(path[2]!) || url.search || url.hash) return null;
  return {sha:String(value.sha),success:value.state==="success",url:url.href,run:path[2]!.toLowerCase()};
}

export interface AppleReceiptConfig { appleAppId:string; appleWorkflowId:string }
export type CloudReceipt = {sha:string;run:string} & ({number:number} | {state:"completed"|"failed";detail:string});
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Xcode Cloud authenticates its product webhook by its unique HTTPS URL. Its
 * metadata supplies a number; only GitHub's separately signed status can finish a job. */
export function appleBuildReceipt(config:AppleReceiptConfig,secret:string,provided:string,body:Buffer) {
  if(!/^[0-9a-f]{64}$/.test(secret) || !/^[0-9a-f]{64}$/.test(provided) || !timingSafeEqual(Buffer.from(provided),Buffer.from(secret)))
    throw new HomeError("Unknown Xcode Cloud webhook.",404);
  let value;
  try {value=JSON.parse(body.toString("utf8"));} catch {throw new HomeError("Invalid Xcode Cloud payload.",400);}
  const run=value?.ciBuildRun, attrs=run?.attributes, sha=attrs?.sourceCommit?.commitSha;
  if(value?.app?.type!=="apps" || value.app.id!==config.appleAppId || value.ciWorkflow?.type!=="ciWorkflows" ||
     typeof value.ciWorkflow.id!=="string" || value.ciWorkflow.id.toLowerCase()!==config.appleWorkflowId.toLowerCase() ||
     run?.type!=="ciBuildRuns" || typeof run.id!=="string" || !uuid.test(run.id) || attrs?.isPullRequestBuild===true ||
     typeof sha!=="string" || !/^[0-9a-f]{40}$/i.test(sha) || !Number.isSafeInteger(attrs.number) || attrs.number<1) return null;
  return {sha:sha.toLowerCase(),run:run.id.toLowerCase() as string,number:attrs.number as number};
}
