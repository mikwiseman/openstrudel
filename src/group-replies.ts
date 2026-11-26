import { telegramAuthorization } from "./authorization.js";
import type { Store } from "./store.js";
import { jsonArray } from "./util.js";

export type GroupReplyMode = "all" | "mentions";

/** The server designates who may activate a group. This is independent of private tools and Home management. */
export function groupReplyPerson(store:Store, senderId?:string):boolean {
  return !!senderId && /^[1-9]\d{0,15}$/.test(senderId) && Number.isSafeInteger(Number(senderId))
    && jsonArray(store.getSetting("telegram.groupReplyPeople")).includes(senderId);
}
export function mayActivateGroup(store:Store, chatId:string, senderId:string):boolean {
  if(!/^-[1-9]\d*$/.test(chatId) || !groupReplyPerson(store,senderId)) return false;
  const auth=telegramAuthorization(store),subject=auth.subjects[senderId],chat=auth.chats[chatId];
  return subject?.enabled!==false && chat?.enabled!==false && (!subject || !!chat);
}
export function supportedGroupReplyMode(store:Store,chatId?:string,senderId?:string):GroupReplyMode | undefined {
  if(!senderId || !chatId || !mayActivateGroup(store,chatId,senderId)) return;
  const binding=store.getTelegramChat(chatId);
  if(!binding?.conversationId || binding.enabled===false) return;
  if(binding.supportedReplies) return binding.supportedReplies;
  // Scoped transports store "mentions" for all other participants. In ordinary chats a saved mention setting is an existing owner's choice.
  return telegramAuthorization(store).chats[chatId] || binding.replies!=="mentions" ? "all" : "mentions";
}
export function automaticGroupReply(store:Store, chatId?:string, senderId?:string):boolean {
  return supportedGroupReplyMode(store,chatId,senderId)==="all";
}
