// Ask the official personal app-server to refresh, then delegate only its current access token.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const child=spawn("/opt/wolf-tools/codex",["app-server"],{stdio:["pipe","pipe","ignore"]});
const pending=new Map();
createInterface({input:child.stdout}).on("line",line=>{
  const message=JSON.parse(line);
  if(message.method || !pending.has(message.id)) return;
  const {ok,bad}=pending.get(message.id);pending.delete(message.id);
  if(message.error) bad(Error("Codex account check failed")); else ok(message.result);
});
let sequence=0;
function request(method,params){
  const id=++sequence;
  return new Promise((ok,bad)=>{pending.set(id,{ok,bad});child.stdin.write(JSON.stringify({id,method,params})+"\n");});
}
const timer=setTimeout(()=>child.kill(),30000);
child.on("exit",()=>{ for(const p of pending.values()) p.bad(Error("Codex sign-in service stopped")); });
try {
  await request("initialize",{clientInfo:{name:"wolf_worker",title:"Wolf project worker",version:"1"}});
  child.stdin.write('{"method":"initialized"}\n');
  const {account}=await request("account/read",{refreshToken:true});
  if(account?.type!=="chatgpt" || !account.email) throw Error("Sign in with ChatGPT on the build server.");
  const {tokens}=JSON.parse(readFileSync(join(process.env.HOME,".codex/auth.json"),"utf8"));
  if(!tokens?.access_token || !tokens.account_id) throw Error("The build account has no access token.");
  process.stdout.write(JSON.stringify({email:account.email,tokens:{accessToken:tokens.access_token,chatgptAccountId:tokens.account_id,chatgptPlanType:account.planType}}));
}finally {clearTimeout(timer);child.stdin.end();child.kill();}
