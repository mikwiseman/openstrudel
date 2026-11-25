import { projectUsesRussian } from "./project-language.js";
import type { AiGidBuilds } from "./aigid-testflight.js";
import type { BuildQueue, ProposedBuild } from "./aigid-queue.js";
import type { Store } from "./store.js";
import type { TelegramAdapter } from "./telegram.js";
import type { TelegramToolContext } from "./telegram-tools.js";

type Plan = NonNullable<ReturnType<BuildQueue["proposal"]>>;
export function planPresentation(plan:Plan) {
  const ru=projectUsesRussian(plan.goal), project=plan.build.repository?.split("/").at(-1) ?? "AiGid";
  const headline = (ru ? "План · " : "Plan · ") + project;
  const build=plan.build;
  const delivery=build.repository ? [build.release==="source" ? (ru?"Публикация исходников":"Publish source") : build.release ? (ru?"Публикация":"Deploy") : "",
    build.destination==="website" ? (ru?"сайт":"website") : "", ...build.packageOnly ? [build.packageOnly] : build.packages ?? [],
    build.revision ? build.revision.slice(0,10) : ""].filter(Boolean).join(" · ") : "TestFlight · iOS";
  const approve = plan.build.packageOnly || !plan.build.repository ? (ru?"Одобрить и собрать":"Approve & build")
    : plan.build.release ? (ru?"Одобрить публикацию":"Approve release") : (ru?"Одобрить план":"Approve plan");
  return {text:headline+"\n\n"+plan.goal+(delivery?"\n\n"+delivery:""),entities:[{type:"bold",offset:0,length:headline.length}],
    buttons:[[{text:ru?"Править план":"Edit plan",callback_data:"plan:edit:"+plan.id},{text:approve,callback_data:"plan:approve:"+plan.id}]]};
}

/** Resolve only messages the Home actually delivered in this chat; a copied button or quoted title identifies nothing. */
export function planAddress(store:Store,chatId:string,messageId:number) {
  const key=store.db.prepare("SELECT key FROM telegram_outbox WHERE chat_id=? AND message_id=? AND status='delivered'").get(chatId,String(messageId))?.key;
  const [,kind,id] = String(key??"").split(":");
  return (kind==="build-plan" || kind==="edit-plan") && id ? {id,edit:kind==="edit-plan"} : undefined;
}

export async function sendPlanVersion(store:Store,service:AiGidBuilds,telegram:TelegramAdapter,chatId:string,conversation:string,plan:Plan,replyTo:number,assertCurrent:()=>void) {
  const {text,entities,buttons}=planPresentation(plan);
  await telegram.sendMessage(chatId,{text,entities},"build-plan:"+plan.id,replyTo,{buttons,assertCurrent});
  if (!plan.replaces) return;
  const previous=service.queue.proposal(plan.replaces,conversation);
  const old=store.db.prepare("SELECT message_id FROM telegram_outbox WHERE key=? AND status='delivered'").get(chatId+":build-plan:"+plan.replaces+":0");
  if (old?.message_id && previous) {
    const {text,entities}=planPresentation(previous);
    await telegram.editCard(chatId,Number(old.message_id),{text:text+(projectUsesRussian(previous.goal)?"\n\nЕсть обновлённый план.":"\n\nA revised plan follows."),entities},[]);
  }
}

export async function reflectPlanDecision(store:Store,telegram:TelegramAdapter,chatId:string,plan:Plan,cancelled=false) {
  const shown=store.db.prepare("SELECT message_id FROM telegram_outbox WHERE key=? AND status='delivered'").get(chatId+":build-plan:"+plan.id+":0");
  if (!shown?.message_id) return;
  const {text,entities}=planPresentation(plan),ru=projectUsesRussian(plan.goal);
  const status=cancelled ? (ru?"План закрыт":"Plan closed") : (ru?"В очереди":"Queued");
  await telegram.editCard(chatId,Number(shown.message_id),{text:text+"\n\n"+status,entities},[]);
}

/** A tool invocation is not a tester's consent. Accept an explicit affirmative from the current speaker. */
export function approvesPlan(words:string,build?:ProposedBuild) {
  let phrase=words.trim().toLowerCase();
  // A build-only approval can restate the approved boundary in either language.
  if (build?.change===false) phrase=phrase.replace(/\bno (?:source |code |app )?changes?\b/gu,"").replace(/код не меня(?:й|ть)|не менять код/gu,"");
  if (/[?？]/.test(phrase) || /(?:^|[^\p{L}])(?:не|нет|если|пока|но|not|no|don't|unless|if|but|wait)(?:$|[^\p{L}])/u.test(phrase)) return false;
  if (/^(?:yes|давай|да)[.!\s]*$/u.test(phrase)) return true;
  const decision=phrase.replace(/^(?:yes|да)[, ]+/u,"");
  return /^(?:одобряю|подтверждаю|соглас(?:ен|на)|утверждаю|делай|делаем|собирай|запускай|в работу|approve(?:d)?|i approve|go ahead|ship it|build it|let.s (?:do it|build)|proceed)(?:$|[^\p{L}])/u.test(decision);
}

export function pressPlan(store:Store,service:AiGidBuilds|undefined,telegram:TelegramAdapter,input:{chatId:string;messageId:number;sender:string;data:string}):{toast:string;alert:boolean;carry?:()=>Promise<void>} {
  const {chatId,messageId,sender,data}=input, [,action,id]=data.split(":");
  const address=planAddress(store,chatId,messageId);
  const source=id && store.db.prepare("SELECT conversation_id FROM messages WHERE id=? AND direction='inbound'").get(id);
  const conversation=source ? String(source.conversation_id) : "";
  const plan=service && id ? service.queue.proposal(id,conversation) : undefined;
  const turn:TelegramToolContext={channel:"telegram",conversationId:conversation,messageId:id??"",telegramSenderId:sender};
  const ru=projectUsesRussian(plan?.goal??"План");
  const unavailable={toast:ru?"Этот план уже недоступен.":"This plan is no longer available.",alert:true};
  if (!service || !plan || data!=="plan:"+action+":"+id || !address || address.id!==id || address.edit || !["edit","approve"].includes(action??"") || !service.canRunPlan(turn,plan.build)) return unavailable;
  if (plan.state!=="pending") return plan.state==="approved" && action==="approve" ? {toast:ru?"План уже одобрен.":"Already approved.",alert:false} : unavailable;
  if (action==="edit") {
    const prompt=ru?"Что изменить в плане?":"What should change in the plan?";
    return {toast:ru?"Напишите правку.":"Reply with your edit.",alert:false, carry:async()=>{
      await telegram.sendMessage(chatId,prompt,"edit-plan:"+id+":"+sender,messageId,{forceReply:ru?"Ваша правка":"Your edit",silent:true,plain:true,retryRejected:true});
    }};
  }
  const approval=ru?"Одобряю план":"Approve the plan";
  // The source is the actual button press, recorded once across retries and identified separately from the proposal.
  const receipt=store.addMessage({conversationId:conversation,channel:"telegram",direction:"inbound",replyToId:id,
    externalId:chatId+":plan:"+messageId,text:approval,author:store.getTelegramChat(sender)?.title??sender});
  service.queue.approve(plan.id,receipt.id,conversation,"telegram",sender);
  return {toast:ru?"План одобрен.":"Plan approved.",alert:false, carry:async()=>{
    try { await reflectPlanDecision(store,telegram,chatId,plan); }
    finally { service.kick(); }
  }};
}
