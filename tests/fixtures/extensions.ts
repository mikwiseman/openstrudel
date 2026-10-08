/** Native UI + real Codex extension acceptance. No Telegram poller or production data. */
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { OpenStrudelRuntime } from "../../src/runtime.js";
import { ScopedCodexEngine } from "../../src/scopes.js";

const output=resolve(process.argv[2]!),root=resolve(process.argv[3]!);mkdirSync(root,{recursive:true,mode:0o700});
delete process.env.TELEGRAM_BOT_TOKEN;
const auth=process.env.OPENSTRUDEL_QA_REAL_CODEX === "1" ? async()=>{
  const source=JSON.parse(readFileSync(resolve(homedir(),"Library/Application Support/OpenStrudel/runtime/.data/codex/auth.json"),"utf8"));
  return {accessToken:source.tokens.access_token,chatgptAccountId:source.tokens.account_id};
} : undefined;
const engine=new ScopedCodexEngine(root,root,auth);
const runtime=new OpenStrudelRuntime({rootDirectory:root,dbPath:resolve(root,"state.sqlite"),engine,startTelegram:false,apiToken:"extensions-local-qa",mobilePort:Number(process.env.OPENSTRUDEL_QA_MOBILE_PORT ?? 0)});
runtime.account.read=async()=>({connected:true,email:"extensions-test@example.com",planType:"plus",managed:true});
Object.assign((runtime.api.mobile as any).options,{host:"127.0.0.1",hostname:"127.0.0.1"});
const employee=runtime.store.listProfiles().find(p=>p.name==="Редактор теста") ?? runtime.store.createProfile({name:"Редактор теста",instructions:"Ты тестовый редактор. Следуй навыкам и используй только явно запрошенные инструменты."});
const chat=runtime.store.profileConversation(employee.id);
const other=runtime.store.listProfiles().find(p=>p.name==="Другой сотрудник") ?? runtime.store.createProfile({name:"Другой сотрудник",instructions:"Тест изоляции."});
const group=runtime.store.linkTelegramChat({chatId:"-500",title:"Тестовая группа",allowedSenders:["42"]});
runtime.store.bindTelegramChat("-500",employee.id);
let calls=0;
const mcp=createServer(async(req,res)=>{
  if(req.method!=="POST"){res.writeHead(405).end();return;}
  let raw="";for await(const chunk of req)raw+=chunk;
  const message=JSON.parse(raw);
  if(message.id===undefined){res.writeHead(202).end();return;}
  let result:unknown;
  if(message.method==="initialize")result={protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"extensions-qa",title:"Проверка подключения",version:"1"}};
  else if(message.method==="tools/list")result={tools:[{name:"check_ready",description:"Harmless test. Returns EXTENSIONS_READY only. Does not change any data.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}]};
  else if(message.method==="tools/call"){calls++;result={content:[{type:"text",text:"EXTENSIONS_READY"}]};}
  else result={};
  res.setHeader("content-type","application/json");res.end(JSON.stringify({jsonrpc:"2.0",id:message.id,result}));
});
await new Promise<void>(r=>mcp.listen(Number(process.env.OPENSTRUDEL_QA_MCP_PORT ?? 0),"127.0.0.1",r));
const control=createServer(async(req,res)=>{
  if(req.url==="/invite"){res.end(JSON.stringify(await runtime.api.mobile.invite(true)));return;}
  if(req.url==="/restart-codex"){engine.close();res.end('{}');return;}
  res.end(JSON.stringify({calls,employee:employee.id,chat:chat.id,other:runtime.store.profileConversation(other.id).id,group:runtime.store.getTelegramChat("-500")?.conversationId,mcpURL:`http://127.0.0.1:${(mcp.address() as any).port}/mcp`}));
});
await new Promise<void>(r=>control.listen(Number(process.env.OPENSTRUDEL_QA_CONTROL_PORT ?? 0),"127.0.0.1",r));
const address=await runtime.api.listen("127.0.0.1",Number(process.env.OPENSTRUDEL_QA_API_PORT ?? 0));
writeFileSync(output,JSON.stringify({url:`http://127.0.0.1:${(control.address() as any).port}`,localURL:`http://127.0.0.1:${address.port}`,mcpURL:`http://127.0.0.1:${(mcp.address() as any).port}/mcp`,root,employee:employee.id,chat:chat.id,pid:process.pid}),{mode:0o600});
console.log("Isolated real-Codex extensions fixture ready.");
const stop=async()=>{control.close();mcp.close();engine.close();await runtime.stop();process.exit(0);};
process.once("SIGTERM",stop);process.once("SIGINT",stop);
