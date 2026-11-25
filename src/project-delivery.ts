import { verifyGitHubSignature } from "./aigid-cloud-status.js";

export type ProjectDelivery =
  | { kind:"pull"; pull:number; job:string; sha:string }
  | { kind:"result"; source:"pull"|"commit"; key:string; state:"completed"|"failed"; detail:string };

const sha=/^[a-f0-9]{40}$/;
const request=/^wolf\/project-([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/;
const fromBot=(user:any,id:number,login:string)=>user?.id===id && user.login===login;

export function projectDeliveryEvent(repository:string,route:string,secret:string,event:string|undefined,body:Buffer,signature:string|undefined):ProjectDelivery|null {
  verifyGitHubSignature(secret,body,signature);
  if (!["pull_request","issue_comment","deployment_status"].includes(event??"")) return null;
  const value=JSON.parse(body.toString("utf8"));
  if (value.repository?.full_name!==repository) return null;
  if (route==="branch" && event==="pull_request") {
    const pr=value.pull_request,job=request.exec(pr?.head?.ref??"")?.[1];
    if (!job || !sha.test(pr.head.sha) || pr.head.repo?.full_name!==repository || pr.base?.repo?.full_name!==repository ||
        pr.base.ref!=="main" || !Number.isSafeInteger(pr.number) || pr.number<1) return null;
    return {kind:"pull",pull:pr.number,job,sha:pr.head.sha};
  }
  if (route==="branch" && event==="issue_comment") {
    const {comment,issue}=value;
    if (value.action!=="created" || !issue?.pull_request || !Number.isSafeInteger(issue.number) || issue.number<1 ||
        !fromBot(value.sender,41898282,"github-actions[bot]") || !fromBot(comment?.user,41898282,"github-actions[bot]")) return null;
    const text=String(comment.body??""), match=text.match(/^\*\*Your change is online\.\*\* Open (https:\/\/[^\s)]+)/);
    let detail:string, state:"completed"|"failed";
    if (match) {
      let url:URL;try {url=new URL(match[1]!);} catch {return null;}
      if(url.origin!=="https://"+repository.split("/")[1]+".bbf.waiwai.is" || url.username || url.password) return null;
      state="completed";detail="The project’s deployment workflow confirmed it is online.\n"+url.href;
    } else {
      if (!text.includes("The deploy failed. Read the last comment on the pull request and fix it.")) return null;
      state="failed";detail="The project’s deployment workflow reported a failure.";
    }
    return {kind:"result",source:"pull",key:String(issue.number),state,detail:detail+"\nhttps://github.com/"+repository+"/pull/"+issue.number};
  }
  if (route==="vercel" && event==="deployment_status") {
    const d=value.deployment,s=value.deployment_status;
    if (!fromBot(value.sender,35613825,"vercel[bot]") || !fromBot(s?.creator,35613825,"vercel[bot]") || !fromBot(d?.creator,35613825,"vercel[bot]") ||
        d.environment!=="Production" || s.environment!=="Production" || !sha.test(d.sha) || !["success","failure","error"].includes(s.state)) return null;
    let detail="Vercel reported a production deployment failure.\nhttps://github.com/"+repository+"/commit/"+d.sha;
    if (s.state==="success") {
      let url:URL;try {url=new URL(s.environment_url);} catch {return null;}
      if (url.protocol!=="https:" || !url.hostname.endsWith(".vercel.app") || url.username || url.password || url.port) return null;
      detail="Vercel deployed this revision to Production.\n"+url.href+"\nRevision "+d.sha;
    }
    return {kind:"result",source:"commit",key:d.sha,state:s.state==="success"?"completed":"failed",detail};
  }
  return null;
}
