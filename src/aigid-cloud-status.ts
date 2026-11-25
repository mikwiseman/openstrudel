import { createHmac, timingSafeEqual } from "node:crypto";
import { HomeError } from "./home.js";

export interface CloudStatusConfig { repository:string; workflow:string; appleAppId:string }
export function cloudStatus(config:CloudStatusConfig, secret:string, event:string|undefined, body:Buffer, signature:string|undefined) {
  const digest=createHmac("sha256",secret).update(body).digest();
  if(!signature || !/^sha256=[0-9a-f]{64}$/.test(signature) || !timingSafeEqual(digest,Buffer.from(signature.slice(7),"hex")))
    throw new HomeError("Invalid GitHub webhook signature.",401);
  if(event!=="status") return null;
  const value=JSON.parse(body.toString("utf8"));
  if(value.repository?.full_name!==config.repository || value.sender?.id!==84813463 || value.sender?.login!=="xcode-cloud[bot]" ||
     value.context!==config.workflow || !["success","failure","error"].includes(value.state) || !/^[a-f0-9]{40}$/.test(value.sha)) return null;
  let url:URL;
  try {url=new URL(value.target_url);} catch {return null;}
  const path=url.pathname.match(/^\/teams\/[a-f0-9-]{36}\/apps\/(\d+)\/ci\/builds\/[a-f0-9-]{36}$/i);
  if(url.origin!=="https://appstoreconnect.apple.com" || path?.[1]!==config.appleAppId || url.search || url.hash) return null;
  return {sha:String(value.sha),success:value.state==="success",url:url.href};
}
