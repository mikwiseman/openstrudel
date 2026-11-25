import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { requestsDocumentSigning, runDocumentSigning } from "./document-signing.js";
import { telegramAuthorization } from "./authorization.js";
import { MAX_FILE_BYTES, type ConversationFiles } from "./files.js";
import type { Store } from "./store.js";

type Marks = {signature:boolean; stamp:boolean};
export type SigningDocument = {name:string; mimeType?:string; contentBase64:string};
type FinalState = "signed" | "declined" | "needs_review";
type PublicState = "pending" | FinalState | "unavailable";
type Result = {id:string;state:PublicState};
export type SigningRequestInput = Marks & {
  requesterTelegramId:string; chatId:string; requestMessageId:number; documentMessageId:number; messageThreadId?:number;
  document:SigningDocument; telegramDirectText:string; requesterName:string; originTitle:string;
};
export interface SigningTransport {
  sendSigningReview(input:Marks & {id:string;ownerId:string;document:SigningDocument;requesterName:string;originTitle:string}):Promise<number>;
  sendSigningResult(input:{id:string;ownerId:string;document:SigningDocument}):Promise<unknown>;
  sendSigningNeedsReview(input:{id:string;ownerId:string;document:SigningDocument}):Promise<unknown>;
  sendSigningStatus(input:{id:string;chatId:string;replyToMessageId:number;messageThreadId?:number;state:FinalState}):Promise<unknown>;
}
type Decision = {id:string;approve:boolean;ownerTelegramId:string;ownerChatId:string;approvalMessageId:number};
type Row = {
  id:string; signer:string; requester:string; origin:string; binding:string; request_msg:number; document_msg:number; topic:number|null;
  name:string; mime:string; digest:string; signature:number; stamp:number; source:Uint8Array|null; output:Uint8Array|null;
  state:"pending"|"approved"|FinalState; review_msg:number|null; result_sent:number; status_sent:number;
};
const sha = (data:Uint8Array) => createHash("sha256").update(data).digest("hex");
const digitId = (v:unknown):v is string => typeof v==="string" && /^[1-9]\d{0,19}$/.test(v);
const positive = (n:unknown):n is number => typeof n==="number" && Number.isSafeInteger(n) && n>0;
const directory = (files:ConversationFiles) => join(files.root,".data/sign-document");
const unavailable = (id:string): Result => ({id,state:"unavailable"});

export function requestedSigningMarks(words?:string,delegated=false): Marks|null {
  if (!words) return null;
  const unquoted=words.toLowerCase().replace(/^[ \t]*>.*$/gm,"").replace(/"[^"]*"|«[^»]*»|“[^”]*”|„[^“]*“|`[^`]*`/gu," ").trim();
  const text=delegated ? unquoted.replace(/^(?:мик|mik)[,\s]+/u,"") : unquoted;
  const forSigner=delegated && /^(?:передай|отправь)(?:те)?\s+(?:(?:это[т]?|договор|документ|файл)\s+)*мику\s+на\s+подпись(?:[.!?\s]|$)/u.test(text);
  if (!forSigner&&!requestsDocumentSigning(text)) return null;
  if (/(?:^|\s)(?:или|or|maybe|возможно)(?=\s)/u.test(text)) return null;
  const signature=(forSigner||/(?:\bsign\b|подпи(?:ш|с)|(?:apply|add|affix|put)\s+(?:(?:my|our|the|a|company)\s+)+(?:signature)\b)/u.test(text)) &&
    !/(?:\b(?:without|no)\s+(?:(?:a|the|my|company)\s+)*signature|без\s+подписи)/u.test(text);
  const stamp=/(?:\bstamp\s+(?:this|that|it|both|these|the|my|our|attached|here|and)\b|\b(?:and|with|add|apply|affix|put)\s+(?:(?:a|the|my|our|company)\s+)*(?:stamp|seal)\b|(?:постав\p{L}*|простав\p{L}*|добав\p{L}*|налож\p{L}*)\s+(?:(?:мою|свою|нашу)\s+)?печать|(?:и\s+|с\s+)печать(?:ю)?(?!\p{L}))/u.test(text) &&
    !/(?:\b(?:without|no)\s+(?:(?:a|the|my|company)\s+)*(?:stamp|seal)|без\s+печати)/u.test(text);
  return signature||stamp?{signature,stamp}:null;
}

function configuration(files:ConversationFiles):{telegramUserId:string;requesterTelegramUserIds:string[]}|undefined {
  try {
    const dir=directory(files), v=JSON.parse(readFileSync(join(dir,"config.json"),"utf8"));
    if (!digitId(v.telegramUserId)||!existsSync(join(dir,"scripts/docsign.py"))) return;
    const requesters=v.requesterTelegramUserIds??[];
    if (Array.isArray(requesters)&&requesters.every(digitId)) return {telegramUserId:v.telegramUserId,requesterTelegramUserIds:requesters};
  }catch { /* A disabled or incomplete installation cannot authorize anyone. */ }
}
function audience(store:Store,sender:string,chatId:string):string|undefined {
  if (!digitId(sender)) return;
  const access=telegramAuthorization(store), chat=store.getTelegramChat(chatId);
  if (access.subjects[sender]?.enabled===false||access.chats[chatId]?.enabled===false||chat?.enabled===false) return;
  if (chatId===sender) return "private:"+sender;
  if (!/^-[1-9]\d{0,19}$/.test(chatId)||!chat?.conversationId) return;
  // The transport verified that the named requester sent the message in this group.
  // This grant permits only a private handoff of the attached document to its signer.
  return JSON.stringify([chat.conversationId, chat.profileId, access.chats[chatId]?.policyId ?? null]);
}
function signingParties(store:Store,files:ConversationFiles,sender:string,chat:string,owner:boolean) {
  const conf=configuration(files);if(!conf) return;
  const signer=store.getTelegramChat(conf.telegramUserId);
  const eligible=owner ? sender===conf.telegramUserId : sender!==conf.telegramUserId&&conf.requesterTelegramUserIds.includes(sender);
  if(!eligible||!signer||signer.enabled===false||!signer.allowedSenders.includes(conf.telegramUserId)) return;
  if(telegramAuthorization(store).subjects[conf.telegramUserId])return;
  const binding=audience(store,sender,chat);
  if(binding)return {signer:conf.telegramUserId,binding};
}
export function signingOwner(store:Store,files:ConversationFiles,senderId:string,chatId:string):boolean {
  try { return Boolean(signingParties(store,files,senderId,chatId,true)); } catch { return false; }
}
export function signingRequester(store:Store,files:ConversationFiles,senderId:string,chatId:string):boolean {
  try { return Boolean(signingParties(store,files,senderId,chatId,false)); } catch { return false; }
}
function ensure(store:Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS document_signing_requests (
    id TEXT PRIMARY KEY, signer TEXT NOT NULL, requester TEXT NOT NULL, origin TEXT NOT NULL, binding TEXT NOT NULL,
    request_msg INTEGER NOT NULL, document_msg INTEGER NOT NULL, topic INTEGER, name TEXT NOT NULL, mime TEXT NOT NULL,
    digest TEXT NOT NULL, signature INTEGER NOT NULL, stamp INTEGER NOT NULL, source BLOB, output BLOB, state TEXT NOT NULL,
    review_msg INTEGER, result_sent INTEGER NOT NULL DEFAULT 0, status_sent INTEGER NOT NULL DEFAULT 0,
    UNIQUE(origin,request_msg))`);
}
const read=(store:Store,id:string)=>store.db.prepare("SELECT * FROM document_signing_requests WHERE id=?").get(id) as Row|undefined;
function current(store:Store,files:ConversationFiles,row:Row):boolean {
  try {
    const who=signingParties(store,files,row.requester,row.origin,row.signer===row.requester);
    return who?.signer===row.signer&&who.binding===row.binding;
  } catch { return false; }
}
function freeze(store:Store,files:ConversationFiles,input:SigningRequestInput,owner:boolean):Row {
  const parties=signingParties(store,files,input.requesterTelegramId,input.chatId,owner);
  const marks=requestedSigningMarks(input.telegramDirectText,!owner);
  if(!parties||!marks||marks.signature!==input.signature||marks.stamp!==input.stamp)throw new Error("Нет подтверждённого запроса на эти отметки.");
  if(!positive(input.requestMessageId)||!positive(input.documentMessageId)||input.documentMessageId>input.requestMessageId||
     input.messageThreadId!==undefined&&!positive(input.messageThreadId))throw new Error("Неизвестное сообщение Telegram.");
  const document=input.document,name=document.name;
  if(!name||name.length>180||name!==basename(name)||/[\\\x00-\x1f]/.test(name)||!/^\.(?:pdf|docx?|odt|rtf)$/i.test(extname(name)))throw new Error("Нужен один PDF, DOCX, DOC, ODT или RTF.");
  if(document.contentBase64.length>Math.ceil(MAX_FILE_BYTES/3)*4)throw new Error("Слишком большой документ.");
  const bytes=Buffer.from(document.contentBase64,"base64");if(!bytes.length||bytes.length>MAX_FILE_BYTES)throw new Error("Пустой или слишком большой документ.");
  const digest=sha(bytes), id=randomUUID().replaceAll("-","");
  ensure(store);
  store.db.prepare(`INSERT OR IGNORE INTO document_signing_requests
    (id,signer,requester,origin,binding,request_msg,document_msg,topic,name,mime,digest,signature,stamp,source,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,parties.signer,input.requesterTelegramId,input.chatId,parties.binding,input.requestMessageId,input.documentMessageId,input.messageThreadId??null,name,
      document.mimeType??"application/octet-stream",digest,Number(input.signature),Number(input.stamp),bytes,owner?"approved":"pending");
  const row=store.db.prepare("SELECT * FROM document_signing_requests WHERE origin=? AND request_msg=?").get(input.chatId,input.requestMessageId) as Row;
  if(row.signer!==parties.signer||row.requester!==input.requesterTelegramId||row.binding!==parties.binding||row.digest!==digest||row.name!==name||
     row.document_msg!==input.documentMessageId||row.topic!==(input.messageThreadId??null)||Boolean(row.signature)!==input.signature||Boolean(row.stamp)!==input.stamp)
    throw new Error("Документ или поручение изменились. Отправьте новый запрос.");
  return row;
}
// Concurrent redeliveries share one request's work. The transport also deduplicates every effect after restart.
const jobs=new WeakMap<Store,Map<string,Promise<Result>>>();
function serialized(store:Store,id:string,work:()=>Promise<Result>):Promise<Result> {
  let map=jobs.get(store);if(!map){map=new Map();jobs.set(store,map);}
  const previous=map.get(id)??Promise.resolve();
  const result=previous.catch(()=>{}).then(work);map.set(id,result);
  void result.finally(()=>{if(map.get(id)===result)map.delete(id);}).catch(()=>{});
  return result;
}
export async function requestSigningApproval(store:Store,files:ConversationFiles,input:SigningRequestInput,telegram:SigningTransport):Promise<Result> {
  const {id}=freeze(store,files,input,false);
  return serialized(store,id,async()=>{
    const row=read(store,id)!;if(!current(store,files,row))return unavailable(id);
    if(row.state!=="pending")return {id,state:row.state==="approved"?"pending":row.state};
    if(!row.review_msg){
      if(!row.source||sha(row.source)!==row.digest)throw new Error("Не удалось подтвердить документ.");
      const review=await telegram.sendSigningReview({id,ownerId:row.signer,document:{name:row.name,mimeType:row.mime,contentBase64:Buffer.from(row.source).toString("base64")},
        signature:Boolean(row.signature),stamp:Boolean(row.stamp),requesterName:input.requesterName,originTitle:input.originTitle});
      if(!positive(review))throw new Error("Доставка запроса не подтверждена.");
      store.db.prepare("UPDATE document_signing_requests SET review_msg=? WHERE id=? AND review_msg IS NULL").run(review,id);
    }
    return {id,state:"pending"};
  });
}
type Zone = {id:string;ours:boolean;ours_source:string;signable:boolean;context:string[];anchors:{line:string}[]};
type PlannedMark = {asset?:string;_zone?:string;page:number};
function stampBelongs(dir:string,zone:Zone):boolean {
  type Entity = { name?:string; full_name?:string; name_en?:string; inn?:string; ogrn?:string; has_stamp?:boolean };
  const identity=JSON.parse(readFileSync(join(dir,"assets/identity.json"),"utf8")) as {entities?:Record<string,Entity>};
  const normalize=(value:string)=>value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
  const text=" "+normalize([...zone.context,...zone.anchors.map(a=>a.line)].join(" "))+" ";
  // Shared brand aliases do not identify which legal entity owns a seal.
  const matches=Object.values(identity.entities??{}).filter(entity=>
    [entity.name,entity.name_en,entity.full_name,entity.inn,entity.ogrn].some(name=>
      typeof name==="string" && normalize(name).length>=3 && text.includes(" "+normalize(name)+" ")));
  return matches.length===1 && matches[0]?.has_stamp===true;
}
/** The plan comes solely from the installed renderer. There is no caller-supplied path, asset, placement or command. */
async function renderFrozen(store:Store,files:ConversationFiles,row:Row):Promise<Buffer|undefined> {
  const dir=directory(files), jobsDir=join(dir,"jobs");mkdirSync(jobsDir,{recursive:true,mode:0o700});
  const job=mkdtempSync(join(jobsDir,"approved-"));
  try {
    const source=join(job,"source"+extname(row.name).toLowerCase()), output=join(job,"signed.pdf"), report=join(job,"report.json"), planPath=join(job,"plan.json");
    if(!row.source||sha(row.source)!==row.digest)throw new Error("Не удалось подтвердить документ.");
    writeFileSync(source,row.source,{mode:0o600,flag:"wx"});
    await runDocumentSigning(dir,["inspect",source,"--json",report]);
    const inspected=JSON.parse(readFileSync(report,"utf8")) as {pages:number;zones:Zone[]};
    const zones=inspected.zones.filter(z=>z.ours&&z.signable);
    if(!zones.length||zones.some(z=>z.ours_source!=="direct"||row.stamp&&!stampBelongs(dir,z)))return;
    await runDocumentSigning(dir,["plan",source,"--out",planPath,"--output",output,...row.stamp?[]:["--no-stamp"]]);
    const proposed=JSON.parse(readFileSync(planPath,"utf8")).placements as PlannedMark[];
    const placements=proposed.filter(p=>row.stamp&&p.asset==="stamp"||row.signature&&(p.asset==="signature"||p.asset==="signature_full"));
    if(!placements.length||placements.some(p=>!zones.some(z=>z.id===p._zone))||zones.some(z=>
      row.stamp&&!placements.some(p=>p._zone===z.id&&p.asset==="stamp")||row.signature&&!placements.some(p=>p._zone===z.id&&p.asset==="signature")))return;
    writeFileSync(planPath,JSON.stringify({source,output,placements}),{mode:0o600});
    if(!current(store,files,row))return;
    await runDocumentSigning(dir,["apply","--plan",planPath]);
    const pdf=readFileSync(output);if(pdf.length>MAX_FILE_BYTES||pdf.subarray(0,5).toString()!=="%PDF-")return;
    const preview=join(job,"preview");
    await runDocumentSigning(dir,["preview",output,"--out",preview,"--dpi","100"]);
    if(!positive(inspected.pages))return;
    const previews=readdirSync(preview).filter(name=>name.endsWith(".png"));
    if(previews.length!==inspected.pages)return;
    for(let page=1;page<=inspected.pages;page++){
      const file="signed-p"+String(page).padStart(2,"0")+".png";
      if(!previews.includes(file))return;
      const png=readFileSync(join(preview,file));
      if(png.length<24||!png.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex"))||!png.readUInt32BE(16)||!png.readUInt32BE(20))return;
    }
    return pdf;
  }finally{rmSync(job,{recursive:true,force:true});}
}
async function finish(store:Store,files:ConversationFiles,row:Row,telegram:SigningTransport):Promise<Result>{
  const id=row.id;
  if(!current(store,files,row))return unavailable(id);
  if(row.state==="approved"){
    // An unplaceable, encrypted or malformed document requires the signer to review the original.
    const pdf=await renderFrozen(store,files,row).catch(()=>undefined);
    if(!current(store,files,row))return unavailable(id);
    store.db.prepare("UPDATE document_signing_requests SET output=?,state=? WHERE id=? AND state='approved'").run(pdf??null,pdf?"signed":"needs_review",id);
    row=read(store,id)!;
  }
  const state=row.state;if(state!=="signed"&&state!=="declined"&&state!=="needs_review")return {id,state:"pending"};
  if(state==="needs_review"&&!row.result_sent){
    if(!row.source||sha(row.source)!==row.digest)throw new Error("Не удалось подтвердить документ.");
    await telegram.sendSigningNeedsReview({id,ownerId:row.signer,document:{name:row.name,mimeType:row.mime,contentBase64:Buffer.from(row.source).toString("base64")}});
    store.db.prepare("UPDATE document_signing_requests SET result_sent=1 WHERE id=?").run(id);
  }
  if(state==="signed"&&!row.result_sent){
    if(!row.output)throw new Error("Не удалось открыть подписанный PDF.");
    await telegram.sendSigningResult({id,ownerId:row.signer,document:{name:basename(row.name,extname(row.name))+"_signed.pdf",mimeType:"application/pdf",contentBase64:Buffer.from(row.output).toString("base64")}});
    store.db.prepare("UPDATE document_signing_requests SET result_sent=1 WHERE id=?").run(id);
  }
  if(!row.status_sent){
    if(!current(store,files,row))return unavailable(id);
    await telegram.sendSigningStatus({id,chatId:row.origin,replyToMessageId:row.request_msg,...row.topic?{messageThreadId:row.topic}:{},state});
    // Keep the digest/decision so a retry cannot sign again. The bot no longer needs either private copy.
    store.db.prepare("UPDATE document_signing_requests SET status_sent=1,source=NULL,output=NULL WHERE id=?").run(id);
  }
  return {id,state};
}
export async function decideSigningRequest(store:Store,files:ConversationFiles,decision:Decision,telegram:SigningTransport):Promise<Result>{
  const id=decision.id;
  if(!/^[a-f0-9]{32}$/.test(id)||!positive(decision.approvalMessageId)||decision.ownerChatId!==decision.ownerTelegramId||typeof decision.approve!=="boolean")return unavailable(id);
  ensure(store);
  return serialized(store,id,async()=>{
    const row=read(store,id);
    if(!row||row.signer===row.requester||row.signer!==decision.ownerTelegramId||row.review_msg!==decision.approvalMessageId||!current(store,files,row))return unavailable(id);
    store.db.prepare("UPDATE document_signing_requests SET state=? WHERE id=? AND state='pending'").run(decision.approve?"approved":"declined",id);
    return finish(store,files,read(store,id)!,telegram);
  });
}
export async function requestOwnerSigning(store:Store,files:ConversationFiles,input:SigningRequestInput,telegram:SigningTransport):Promise<Result>{
  const {id}=freeze(store,files,input,true);
  return serialized(store,id,()=>finish(store,files,read(store,id)!,telegram));
}
