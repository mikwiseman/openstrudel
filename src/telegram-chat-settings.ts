import type { Store } from "./store.js";
import type { TelegramAdapter } from "./telegram.js";
import type { TelegramActionButton } from "./types.js";

type Language = "en" | "ru";
type ReplyMode = "all" | "mentions" | "on" | "paused";
const copy = {
  en: {
    group: "Replies in this group", dm: "Replies in this chat",
    all: ["Automatic", "Wolf can reply to approved people without an @mention."],
    mentions: ["Mentions & replies", "Mention Wolf or reply to a message from Wolf."],
    on: ["On", "Wolf replies to your messages here."],
    paused: ["Pause", "Replies to new messages are paused. Open /settings to turn them back on."],
  },
  ru: {
    group: "Ответы в этой группе", dm: "Ответы в личном чате",
    all: ["Автоматически", "Волк может отвечать выбранным людям без упоминания."],
    mentions: ["Упоминания и ответы", "Упомяните Волка или ответьте на его сообщение."],
    on: ["Включены", "Волк отвечает на ваши сообщения здесь."],
    paused: ["Пауза", "Ответы на новые сообщения приостановлены. Откройте /settings, чтобы включить их."],
  },
} as const;
export function isChatSettingsCommand(text?:string):boolean {
  const body=(text??"").trim().replace(/\r?\n[ \t]*\r?\n(__|)(?:Sent by an AI assistant\.|Отправлено AI-помощником\.)\1$/iu,"");
  return /^\/settings(?:@\w+)?$/iu.test(body);
}
export const privateRepliesPaused = (store:Store,chatId:string) => store.getSetting("telegram.privateRepliesPaused."+chatId)==="true";
const key = (id:number,lang:Language) => "reply-settings:"+id+":"+lang;

function panel(store:Store,telegram:TelegramAdapter,chatId:string,sender:number,id:number,lang:Language) {
  const words=copy[lang], group=Number(chatId)<0;
  const title=group ? words.group : words.dm;
  const current=group ? telegram.groupReplyMode(chatId,sender) : privateRepliesPaused(store,chatId) ? "paused" : "on";
  const button=(mode:ReplyMode):TelegramActionButton=>({
    text:(current===mode?"✓ ":"")+words[mode][0], callback_data:"replyset:"+id+":"+lang+":"+mode,
  });
  const buttons=group ? [[button("all")],[button("mentions")]] : [[button("on"),button("paused")]];
  return {card:{text:title+"\n"+words[current][1],entities:[{type:"bold",offset:0,length:title.length}]},buttons};
}

export async function showChatReplySettings(store:Store,telegram:TelegramAdapter,chatId:string,sender:number,id:number,lang:Language,replyTo:number,threadId?:number) {
  const {card,buttons}=panel(store,telegram,chatId,sender,id,lang);
  await telegram.sendMessage(chatId,card,key(id,lang),replyTo,{buttons,threadId,retryRejected:true});
}

export function pressChatReplySettings(store:Store,telegram:TelegramAdapter,chatId:string,sender:number|undefined,messageId:number|undefined,data:string) {
  const match=/^replyset:(\d+):(en|ru):(all|mentions|on|paused)$/u.exec(data);
  const lang=match?.[2]==="ru"?"ru":"en";
  const denied={toast:lang==="ru"?"Настройки недоступны.":"Settings unavailable.",alert:true};
  if (!match || !sender || !messageId || !telegram.canManageChatReplies(chatId,sender)) return denied;
  const id=Number(match[1]), mode=match[3];
  const origin=store.db.prepare("SELECT 1 FROM telegram_outbox WHERE key=? AND chat_id=? AND message_id=? AND status='delivered'")
    .get(chatId+":"+key(id,lang)+":0",chatId,String(messageId));
  if (!origin) return denied;
  if (Number(chatId)<0 && (mode==="all" || mode==="mentions")) telegram.setChatGroupReplyMode(chatId,sender,mode);
  else if (chatId===String(sender) && (mode==="on" || mode==="paused")) {
    if (mode==="paused") store.setSetting("telegram.privateRepliesPaused."+chatId,"true");
    else store.deleteSetting("telegram.privateRepliesPaused."+chatId);
  } else return denied;
  return {toast:lang==="ru"?"Сохранено":"Saved",alert:false,carry:async()=>{
    const {card,buttons}=panel(store,telegram,chatId,sender,id,lang);
    await telegram.editCard(chatId,messageId,card,buttons);
  }};
}
