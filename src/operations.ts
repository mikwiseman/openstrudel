import type { Store } from "./store.js";
import type { EngineEvent, Message } from "./types.js";
import { correspondenceIssueTask, correspondenceNoticeId, mayDeliverCorrespondenceNotice } from "./correspondence.js";

import { problemText, type ProblemCode } from "./tool-problems.js";
export { problemText, toolProblem, toolRecovered, failureCode, errorProblem, type ProblemCode, type FailureCode } from "./tool-problems.js";
type RuntimeIssue = { conversationId:string; messageId:string; title:string; code:ProblemCode; time:string; tools?:string[]; connections?:Record<string,string>; detail?:string; scope?:string; taskName?:string; audience?:string };
const prefix="runtime.issue.";

export type ConnectorOutcome = { tool:string; server:string; failed:boolean; connection?:boolean };

/** Native MCP receipts are emitted even for calls made inside code mode. */
export function connectorOutcome(event:EngineEvent):ConnectorOutcome|undefined {
  const item=(event.payload as any)?.item;
  if(event.type!=="item/completed" || item?.type!=="mcpToolCall" || !["failed","completed"].includes(item.status))return;
  if(![item.server,item.tool].every(v=>typeof v==="string" && /^[a-zA-Z0-9_.:-]+$/.test(v)))return;
  if(/user rejected MCP tool call/i.test(item.error?.message ?? ""))return;
  const failed=item.status==="failed" || Boolean(item.error) || item.result?.isError===true;
  // A startup failure precedes the tool itself. A later call reaching this
  // server proves recovery; it does not prove that a failed attachment or write worked.
  const connection=failed && /handshaking with MCP server failed|MCP startup failed|failed to get client/i.test(item.error?.message ?? "");
  return{tool:item.server+"."+item.tool,server:item.server,failed,...connection?{connection:true}:{}};
}

function connectorService(tool:string):string {
  if(tool.startsWith("wai-telegram."))return "Telegram";
  if(tool.startsWith("codex_apps.gmail."))return "Gmail";
  if(tool.startsWith("unipile."))return "Unipile";
  return tool.split(".")[0]!;
}

/** Keep partial answers and unresolved action failures, but close recovered connections. */
export function reportConnectorIssues(store:Store,conversationId:string,messageId:string,outcomes:ConnectorOutcome[]):Message|undefined {
  if(!outcomes.length)return;
  const task=issueTask(store,conversationId,messageId),inbox=task.scope?.startsWith("correspondence:")===true;
  const key=prefix+"connector."+conversationId+(inbox?":"+task.scope:""),previous=JSON.parse(store.getSetting(key) ?? "null") as RuntimeIssue|null;
  const tools=new Set(previous?.tools ?? []),connections=new Map(Object.entries(previous?.connections ?? {}));
  for(const outcome of outcomes){
    const {tool,server,failed,connection}=outcome;
    if(failed){tools.add(tool);if(connection)connections.set(tool,server);else connections.delete(tool);}
    else{
      tools.delete(tool);connections.delete(tool);
      for(const [name,connectionServer] of connections)if(connectionServer===server){tools.delete(name);connections.delete(name);}
    }
  }
  const names=[...tools].sort(),connectionServers=Object.fromEntries([...connections].sort());
  if(JSON.stringify(names)===JSON.stringify(previous?.tools ?? []) && JSON.stringify(connectionServers)===JSON.stringify(previous?.connections ?? {}))return;
  const title=(inbox ? task.taskName : store.getConversation(conversationId)?.title) ?? "Чат";
  if(!names.length){store.deleteSetting(key);return;}
  const added=names.filter(name=>!previous?.tools?.includes(name));
  const audience=inbox?correspondenceNoticeId(store):undefined;
  store.setSetting(key,JSON.stringify({...added.length?{conversationId,messageId,title,code:"connector",time:new Date().toISOString(),...inbox?{scope:task.scope,audience}:{}}:previous,tools:names,connections:connectionServers}));
  // Recoveries are silent. An old unresolved tool is not a new failure.
  if(!added.length)return;
  const services=[...new Set(added.map(connectorService))].join(", ");
  const text=inbox ? `${title}\nНет подтверждения от сервиса ${services}. ${task.nextAction}`
    : `Требует внимания · ${title}\nНе выполнен запрос к сервису: ${services}. Подробности — в исходном чате.`;
  return store.addMessage({conversationId:store.primaryConversation().id,channel:"api",direction:"outbound",kind:"notice",text,
    externalId:audience});
}

export function runtimeIssues(store:Store,telegramOwner?:string):RuntimeIssue[] {
  return store.db.prepare("SELECT value FROM settings WHERE key GLOB 'runtime.issue.*' ORDER BY updated_at DESC").all().flatMap(row=>{
    try {
      const issue=JSON.parse(String(row.value)) as RuntimeIssue;
      if(!(issue.code in problemText) || !store.getConversation(issue.conversationId))return [];
      if(telegramOwner!==undefined && (issue.scope ?? issueTask(store,issue.conversationId,issue.messageId).scope)?.startsWith("correspondence:")
        && (!issue.audience || !mayDeliverCorrespondenceNotice(store,issue.audience,telegramOwner)))return [];
      return [issue];
    }catch{return [];}
  });
}

/** A scheduled run that could not do its work says so in its first line; the reason goes to the owner, never to the chat. */
/** Nothing to post: the answer is NO_REPLY, or ends with it after the model explained itself. */
export const quietReply = (text:string):boolean => /(?:^|\n)[ \t]*NO_REPLY[ \t]*$/.test(text.trim());
export function failedRun(text:string):string|undefined {
  const match=text.trim().match(/^FAILED:[ \t]*(.*)/);
  return match ? match[1]!.trim().slice(0,300) || "причина не указана" : undefined;
}
/** A scheduled result opens with "OUTCOME: " and what is now true. The line stays the result's first line, without its marker,
 * and is kept apart, in at most 60 characters, for lists and notifications. A quiet or failed run has none. */
export function splitOutcome(text:string):{text:string;outcome:string|null} {
  const marker=/^\s*OUTCOME:[ \t]*/.exec(text);
  if(!marker)return {text,outcome:null};
  const body=text.slice(marker[0].length),end=body.indexOf("\n");
  const line=(end<0?body:body.slice(0,end)).trim(),rest=end<0?"":body.slice(end+1);
  if(!line||quietReply(rest)||failedRun(rest))return {text:rest.trim()?rest:body,outcome:null};
  if(line.length<=60)return {text:body,outcome:line};
  const cut=line.slice(0,59),space=cut.lastIndexOf(" ");
  return {text:body,outcome:(space>0?cut.slice(0,space):cut).replace(/[\s,;:.—–-]+$/,"")+"…"};
}

/** Different scheduled jobs can share a conversation. Their successes do not prove each other's recovery. */
function issueTask(store:Store,conversationId:string,messageId?:string):{scope?:string;taskName?:string;nextAction?:string} {
  if(!messageId)return {};
  let message=store.db.prepare("SELECT external_id,reply_to_id FROM messages WHERE id=? AND conversation_id=?").get(messageId,conversationId);
  if(message?.reply_to_id)message=store.db.prepare("SELECT external_id FROM messages WHERE id=? AND conversation_id=?").get(message.reply_to_id,conversationId);
  const externalId=String(message?.external_id ?? "");
  if(externalId.startsWith("operations:"))return {scope:"operations"};
  if(externalId.startsWith("correspondence:"))return correspondenceIssueTask(store,conversationId,externalId.slice("correspondence:".length));
  if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schedule_runs'").get())return {};
  const runId=externalId.startsWith("schedule:")?externalId.slice("schedule:".length):messageId;
  const schedule=store.db.prepare("SELECT s.id,s.name FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id WHERE r.id=? AND r.conversation_id=?").get(runId,conversationId);
  return schedule?{scope:"schedule:"+schedule.id,taskName:String(schedule.name)}:{};
}

function issueKey(conversationId:string,code:ProblemCode,scope?:string):string {
  return prefix+conversationId+(scope?":"+scope:"")+(["voice","delivery"].includes(code)?":"+code:"");
}

/** Preserve existing incidents on upgrade, including the task receipt that originally opened one. */
function migrateIssue(store:Store,conversationId:string):void {
  const key=prefix+conversationId,value=store.getSetting(key);
  if(!value)return;
  const issue=JSON.parse(value) as RuntimeIssue;
  const task=issueTask(store,conversationId,issue.messageId),next=issueKey(conversationId,issue.code,issue.scope ?? task.scope);
  if(next===key)return;
  if(!store.getSetting(next))store.setSetting(next,JSON.stringify({...issue,...task,...task.scope?.startsWith("correspondence:")?{detail:undefined,title:task.taskName}:{}}));
  store.deleteSetting(key);
}

export function reportIssue(store:Store,conversationId:string,messageId:string,code:ProblemCode,detail?:string):Message|undefined {
  const conversation=store.getConversation(conversationId);if(!conversation)return;
  migrateIssue(store,conversationId);
  const task=issueTask(store,conversationId,messageId),key=issueKey(conversationId,code,task.scope);
  const previous=store.getSetting(key);
  const correspondence=task.scope?.startsWith("correspondence:")===true;
  // Provider errors can quote private correspondence. Only the local cause and event metadata belong in a notice.
  if(correspondence)detail=undefined;
  const title=correspondence ? task.taskName! : conversation.title ?? "Чат";
  const root=store.primaryConversation(),last=previous ? JSON.parse(previous) as RuntimeIssue : null;
  const audience=correspondence?correspondenceNoticeId(store):undefined;
  store.setSetting(key,JSON.stringify({conversationId,messageId,title,code,detail,scope:task.scope,taskName:task.taskName,audience,time:new Date().toISOString()}));
  // A failure in another chat or job must not silence this request. Repeat after its recovery or a changed cause.
  if(last && last.code===code && last.detail===detail)return;
  const reason=code==="account" ? "Аккаунт недоступен. Проверьте вход и лимит в настройках." : code==="connection" ? "Связь прервалась во время проверки." : code==="resources" ? "Серверу не хватило ресурсов для проверки." : "Проверка не завершилась.";
  const text=correspondence ? `${title}\n${reason} ${task.nextAction}`
    : `Требует внимания · ${title}\n${task.taskName?`Расписание: ${task.taskName}\n`:""}${detail ? `Задача не выполнена: ${detail}` : problemText[code]}`;
  return store.addMessage({conversationId:root.id,channel:"api",direction:"outbound",kind:"notice",text,
    externalId:audience});
}

export function resolveIssue(store:Store,conversationId:string,messageId?:string):Message|undefined {
  migrateIssue(store,conversationId);
  const key=issueKey(conversationId,"execution",issueTask(store,conversationId,messageId).scope);
  // A recovery is not news; the incident closes silently.
  // A model turn proves neither successful transcription nor confirmed delivery.
  store.deleteSetting(key);
  return;
}

/** Called only after speech recognition actually returns a transcript. */
export function resolveVoiceIssue(store:Store,conversationId:string):void {
  migrateIssue(store,conversationId);
  store.deleteSetting(issueKey(conversationId,"voice"));
}
