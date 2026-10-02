import { randomBytes, randomUUID } from "node:crypto";
import { sha256, sleep } from "./util.js";
import type { Attachment, Interaction, MessageInput, MessageResult, TelegramChat } from "./types.js";
import { readFile } from "node:fs/promises";
import { telegramText } from "./telegram-format.js";
import { transcribeVoice } from "./voice.js";
import type { MessageService } from "./messages.js";
import type { Store } from "./store.js";

export interface TelegramUpdate {
  update_id: number;
  my_chat_member?: { chat: { id: number | string; title?: string; type?: string }; from: { id: number }; date: number; old_chat_member: { status: string }; new_chat_member: { status: string; is_member?: boolean } };
  callback_query?: { id: string; from?: { id:number }; data?: string; message?: { message_id: number; chat: { id: number | string } } };
  message?: { from?: { id:number; first_name?:string; last_name?:string }; date?:number; migrate_to_chat_id?:number|string; migrate_from_chat_id?:number|string; voice?:TelegramFile; audio?:TelegramFile; document?:TelegramFile & {file_name?:string;mime_type?:string}; photo?:TelegramFile[]; caption?:string; reply_to_message?: { message_id: number }; message_id: number; text?: string; chat: { id: number | string; title?: string; type?: string } };
}
type TelegramFile = {file_id:string;file_size?:number};

interface TelegramResponse<T> { ok: boolean; result: T; description?: string; error_code?: number; parameters?: { retry_after?: number } }
interface TelegramBot { id: number; is_bot: boolean; first_name: string; username?: string }

export interface TelegramLink { code: string; expiresAt: string; url: string | null }

export interface TelegramIntegrationStatus {
  configured: boolean;
  running: boolean;
  botUsername: string | null;
  botName: string | null;
  linkedChats: string[];
  chats: TelegramChat[];
  lastError: string | null;
}

export class TelegramAdapter {
  private token: string | undefined;
  private running = false;
  private offset = 0;
  private controller: AbortController | null = null;
  private bot: TelegramBot | null = null;
  private lastError: string | null = null;
  private readonly pendingUpdates = new Map<number, Promise<void>>();
  private readonly questionMessages = new Map<string, string>();
  private readonly preparations = new Map<string, Promise<Pick<MessageInput,"text"|"uploads">>>();
  transcribe = transcribeVoice;

  constructor(token: string | undefined, private readonly store: Store, private readonly messages: MessageService) {
    this.token = token?.trim() || undefined;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS telegram_inbox(update_id INTEGER PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_outbox(key TEXT PRIMARY KEY,chat_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT,error TEXT);`);
    this.store.db.prepare("UPDATE telegram_outbox SET status='unknown',error='Перезапуск во время отправки; проверьте Telegram перед повтором' WHERE status='sending'").run();
    this.offset=Number(this.store.getSetting("telegram.offset") ?? 0);
    // Legacy private pairings remain owned by that Telegram user.
    for (const id of this.linkedChats()) if (!this.store.getTelegramChat(id)) this.store.linkTelegramChat({chatId:id,title:`Telegram ${id}`,allowedSenders:id.startsWith("-")?[]:[id]});
    messages.interactions?.subscribe(card => { void this.sendInteraction(card).catch(() => { this.lastError = "Не удалось доставить запрос подтверждения"; }); });
    messages.interactions?.onSettled(card => {
      for (const [key, id] of this.questionMessages) if (id === card.id) {
        this.questionMessages.delete(key);
        const [chatId, messageId] = key.split(":");
        void this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: Number(messageId), reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      }
    });
  }

  enabled(): boolean { return Boolean(this.token); }

  status(): TelegramIntegrationStatus {
    return {
      configured: Boolean(this.token), running: this.running,
      botUsername: this.bot?.username ?? this.store.getSetting("telegram.bot_username"),
      botName: this.bot?.first_name ?? this.store.getSetting("telegram.bot_name"),
      linkedChats: this.linkedChats(), chats:this.store.telegramChats(), lastError: this.lastError,
    };
  }

  async configure(token: string): Promise<TelegramIntegrationStatus> {
    const normalized = token.trim();
    if (!normalized) throw new Error("Telegram bot token is required");
    const bot = await this.call<TelegramBot>("getMe", {}, normalized);
    if (!bot.is_bot) throw new Error("Telegram token does not belong to a bot");
    this.token = normalized; this.bot = bot; this.lastError = null;
    this.store.setSetting("telegram.bot_token", normalized);
    this.store.setSetting("telegram.bot_name", bot.first_name);
    if (bot.username) this.store.setSetting("telegram.bot_username", bot.username);
    await this.start();
    return this.status();
  }

  createLink(profileId?: string): TelegramLink {
    if (!this.token) throw new Error("Connect Telegram before creating a link");
    const code = randomBytes(6).toString("base64url");
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    this.store.setSetting("telegram.link_hash", sha256(code));
    this.store.setSetting("telegram.link_expires_at", expiresAt);
    if (profileId && !this.store.getProfile(profileId)) throw new Error("Сотрудник не найден");
    this.store.setSetting("telegram.link_profile",profileId ?? "");
    const username = this.bot?.username ?? this.store.getSetting("telegram.bot_username");
    return { code, expiresAt, url: username ? `https://t.me/${username}?start=${code}` : null };
  }

  disconnect(): TelegramIntegrationStatus {
    this.stop(); this.token = undefined; this.bot = null; this.lastError = null;
    for (const key of ["telegram.bot_token", "telegram.bot_name", "telegram.bot_username", "telegram.link_hash", "telegram.link_expires_at", "telegram.linked_chats"]) this.store.deleteSetting(key);
    this.store.db.exec("DELETE FROM telegram_chats; DELETE FROM telegram_inbox;");
    return this.status();
  }

  async start(): Promise<void> {
    if (!this.token || this.running) return;
    this.running = true; this.controller = new AbortController();
    for (const row of this.store.db.prepare("SELECT payload FROM telegram_inbox ORDER BY update_id").all()) void this.processUpdate(JSON.parse(String(row.payload))).catch(() => { this.lastError="Не удалось восстановить входящее сообщение"; });
    void this.poll();
  }

  stop(): void { this.running = false; this.controller?.abort(); this.controller = null; }

  async sendMessage(chatId: string | number, text: string, deliveryKey: string = randomUUID()): Promise<void> {
    if (!this.token) throw new Error("Telegram не подключён");
    const chunks=telegramText(text);
    for (const [index,chunk] of chunks.entries()) {
      const key=`${chatId}:${deliveryKey}:${index}`;
      const payload=JSON.stringify({chat_id:chatId,...chunk,link_preview_options:{is_disabled:true}});
      this.store.db.prepare("INSERT OR IGNORE INTO telegram_outbox(key,chat_id,payload,status) VALUES(?,?,?,'pending')").run(key,String(chatId),payload);
      const row=this.store.db.prepare("SELECT * FROM telegram_outbox WHERE key=?").get(key)!;
      if(row.payload!==payload) throw new Error("Содержимое доставки изменилось");
      if(row.status==="delivered") continue;
      if(row.status!=="pending") throw new Error("Доставка требует проверки в Telegram перед повтором");
      this.store.db.prepare("UPDATE telegram_outbox SET status='sending' WHERE key=?").run(key);
      try {
        const sent=await this.call<{message_id:number}>("sendMessage",JSON.parse(payload));
        this.store.db.prepare("UPDATE telegram_outbox SET status='delivered',message_id=? WHERE key=?").run(String(sent.message_id),key);
      } catch (error) {
        this.store.db.prepare("UPDATE telegram_outbox SET status='unknown',error=? WHERE key=?").run("Ответ Telegram не подтверждён; автоматический повтор остановлен",key);
        throw error;
      }
    }
  }

  async sendFiles(chatId: string | number, files: Attachment[] = [], deliveryKey: string = randomUUID()): Promise<void> {
    for (const file of files) {
      const stored = this.messages.files.get(file.id);
      if (!stored || stored.conversationId !== file.conversationId) throw new Error("Файл ответа не найден");
      const key = `${chatId}:${deliveryKey}:file:${file.id}`;
      const payload = JSON.stringify({chat_id:chatId,fileId:file.id,name:file.name});
      this.store.db.prepare("INSERT OR IGNORE INTO telegram_outbox(key,chat_id,payload,status) VALUES(?,?,?,'pending')").run(key,String(chatId),payload);
      const row = this.store.db.prepare("SELECT * FROM telegram_outbox WHERE key=?").get(key)!;
      if (row.payload !== payload) throw new Error("Содержимое доставки изменилось");
      if (row.status === "delivered") continue;
      if (row.status !== "pending") throw new Error("Проверьте доставку файла в Telegram перед повтором");
      const form = new FormData();form.set("chat_id",String(chatId));
      form.set("document",new Blob([await readFile(stored.path)],{type:file.mimeType}),file.name);
      this.store.db.prepare("UPDATE telegram_outbox SET status='sending' WHERE key=?").run(key);
      try {
        const sent = await this.call<{message_id:number}>("sendDocument",form);
        this.store.db.prepare("UPDATE telegram_outbox SET status='delivered',message_id=? WHERE key=?").run(String(sent.message_id),key);
      } catch (error) {
        this.store.db.prepare("UPDATE telegram_outbox SET status='unknown',error=? WHERE key=?").run("Доставка файла не подтверждена. Проверьте Telegram перед повтором.",key);
        throw error;
      }
    }
  }

  async processUpdate(update: TelegramUpdate): Promise<void> {
    const existing = this.pendingUpdates.get(update.update_id);
    if (existing) return existing;
    this.store.db.prepare("INSERT OR IGNORE INTO telegram_inbox VALUES(?,?)").run(update.update_id,JSON.stringify(update));
    const pending = this.handleUpdate(update);
    this.pendingUpdates.set(update.update_id, pending);
    try { await pending; this.store.db.prepare("DELETE FROM telegram_inbox WHERE update_id=?").run(update.update_id); } finally { this.pendingUpdates.delete(update.update_id); }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (this.store.wasTelegramUpdateProcessed(update.update_id)) return;
    if (update.my_chat_member) {
      const member = update.my_chat_member;
      const chatId = String(member.chat.id);
      if (Number(chatId) < 0 && member.chat.type !== "channel") {
        const key = "telegram.membership." + chatId;
        const previous = this.membershipEvent(chatId);
        // Telegram can replay a saved older update after a restart.
        // IDs may also reset after a quiet week; compare Telegram's date first.
        if (member.date > previous.date || (member.date === previous.date && update.update_id > previous.id)) {
          this.store.setSetting(key, JSON.stringify({date:member.date,id:update.update_id}));
          const active = ["member", "administrator", "creator"].includes(member.new_chat_member.status)
            || (member.new_chat_member.status === "restricted" && member.new_chat_member.is_member === true);
          if (!active) this.store.db.prepare("DELETE FROM telegram_chats WHERE chat_id=?").run(chatId);
          else await this.discoverGroup(chatId, member.chat.title ?? "Группа", member.from.id, update.update_id);
        }
      }
      this.store.markTelegramUpdate(update.update_id); return;
    }
    if (update.callback_query) {
      const query = update.callback_query;
      const chatId = String(query.message?.chat.id ?? "");
      const [id, q, o] = (query.data ?? "").split(":");
      const card = id ? this.messages.interactions.get(id) : undefined;
      let feedback = "Этот запрос уже завершён";
      if (card && this.authorizedSender(chatId,query.from?.id) && this.ownsInteraction(chatId, card)) {
        const question = card.questions[Number(q)];
        const option = question?.options[Number(o)];
        if (question && option) {
          try { await this.messages.interactions.answer(card.id, card.conversationId, { [question.id]: option }); feedback = "Ответ принят"; }
          catch (error) { feedback = error instanceof Error ? error.message : "Не удалось принять ответ"; }
        }
      }
      await this.call("answerCallbackQuery", { callback_query_id: query.id, text: feedback.slice(0, 190), show_alert: feedback !== "Ответ принят" });
      if (!card && this.linkedChats().includes(chatId)) {
        await this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: query.message?.message_id, reply_markup: { inline_keyboard: [] } });
      }
      this.store.markTelegramUpdate(update.update_id); return;
    }
    const message = update.message;
    if (message?.migrate_to_chat_id || message?.migrate_from_chat_id) {
      const oldId = String(message.migrate_from_chat_id ?? message.chat.id);
      const newId = String(message.migrate_to_chat_id ?? message.chat.id);
      this.store.migrateTelegramGroup(oldId, newId);
      this.store.markTelegramUpdate(update.update_id); return;
    }
    if (!message || (!message.text?.trim() && !message.voice && !message.audio && !message.document && !message.photo?.length)) { this.store.markTelegramUpdate(update.update_id); return; }
    const chatId = String(message.chat.id); let text = (message.text ?? message.caption)?.trim() ?? "";
    const groupStart = text.match(/^\/start@([\w]+)\s+choose$/i);
    if (groupStart && Number(chatId) < 0 && groupStart[1]!.toLowerCase() === (this.bot?.username ?? this.store.getSetting("telegram.bot_username"))?.toLowerCase()) {
      const previous = this.membershipEvent(chatId);
      const date = message.date ?? previous.date;
      if ((date > previous.date || (date === previous.date && update.update_id >= previous.id)) && message.from) {
        await this.discoverGroup(chatId, message.chat.title ?? "Группа", message.from.id, update.update_id);
      }
      this.store.markTelegramUpdate(update.update_id); return;
    }
    const linkCode = text.match(/^\/(?:start|link)(?:@\w+)?\s+([^\s]+)$/i)?.[1];
    if (linkCode && this.consumeLink(linkCode)) {
      const sender=message.from?.id ?? (Number(chatId)>0 ? Number(chatId) : undefined);
      if (!sender) throw new Error("Не удалось определить владельца чата");
      this.store.linkTelegramChat({chatId,title:message.chat.title ?? message.from?.first_name ?? "Личный Telegram",allowedSenders:[...new Set([...(this.store.getTelegramChat(chatId)?.allowedSenders ?? []),String(sender)])]});
      const profile=this.store.getSetting("telegram.link_profile");
      if(profile) this.store.bindTelegramChat(chatId,profile);
      await this.sendMessage(message.chat.id, "Готово. Чат подключён к OpenStrudel.");
      this.store.markTelegramUpdate(update.update_id); return;
    }
    if (!this.linkedChats().includes(chatId)) {
      if (Number(chatId) > 0) await this.sendMessage(message.chat.id, "Откройте OpenStrudel → Настройки → Telegram и нажмите «Продолжить в Telegram».");
      this.store.markTelegramUpdate(update.update_id); return;
    }
    if (!this.authorizedSender(chatId,message.from?.id)) { this.store.markTelegramUpdate(update.update_id); return; }
    const bind=text.match(/^\/bind(?:@\w+)?\s+(.+)$/i);
    if(bind) {
      const profile=this.store.getProfile(bind[1]!.trim());
      if(profile) this.store.bindTelegramChat(chatId,profile.id);
      await this.sendMessage(chatId,profile ? `Здесь отвечает ${profile.name}. История общая с приложением.` : "Сотрудник не найден. Укажите его полное имя.");
      this.store.markTelegramUpdate(update.update_id); return;
    }
    if (Number(chatId) < 0 && !this.store.getTelegramChat(chatId)?.profileId) {
      this.store.markTelegramUpdate(update.update_id); return;
    }
    const replyKey = chatId + ":" + message.reply_to_message?.message_id;
    const cardId = this.questionMessages.get(replyKey);
    const card = cardId ? this.messages.interactions.get(cardId) : undefined;
    if (card && this.ownsInteraction(chatId, card)) {
      const question = card.questions.find(q => q.options.length === 0);
      if (question) {
        await this.messages.interactions.answer(card.id, card.conversationId, { [question.id]: text });
        this.store.markTelegramUpdate(update.update_id); return;
      }
    }
    const replyConversation=message.reply_to_message ? this.replyConversation(chatId,message.reply_to_message.message_id) : null;
    const conversation = replyConversation ?? this.store.getOrCreateConversation({ channel: "telegram", externalId: chatId, title: message.chat.title ?? "Telegram " + chatId });
    const prepared=(this.preparations.get(chatId) ?? Promise.resolve({text:""})).catch(()=>({text:""})).then(async()=>{
      const media=message.voice ?? message.audio ?? message.document ?? message.photo?.at(-1);
      if(!media) return {text};
      if((media.file_size ?? 0)>20_000_000) throw new Error("Отправьте файл до 20 МБ.");
      const file=await this.call<{file_path:string;file_size?:number}>("getFile",{file_id:media.file_id});
      if(!file.file_path || (file.file_size ?? 0)>20_000_000) throw new Error("Не удалось получить файл до 20 МБ");
      const response=await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`,{signal:AbortSignal.timeout(30_000)});
      if(!response.ok) throw new Error("Не удалось скачать вложение");
      const bytes=new Uint8Array(await response.arrayBuffer());
      if(bytes.length>20_000_000) throw new Error("Отправьте файл до 20 МБ.");
      if(message.voice || message.audio) return {text:[text,await this.transcribe(bytes,file.file_path.split(".").at(-1))].filter(Boolean).join("\n")};
      const hex=sha256(`${chatId}:${message.message_id}:${media.file_id}`).slice(0,32);
      const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
      return {text,uploads:[{id,name:message.document?.file_name ?? "photo.jpg",mimeType:message.document ? message.document.mime_type ?? "application/octet-stream" : "image/jpeg",contentBase64:Buffer.from(bytes).toString("base64")}]};
    });
    this.preparations.set(chatId,prepared);
    try {
    const input = await prepared;text=input.text;
    const result: MessageResult = await this.messages.handle({ channel: "telegram", conversationId: conversation.id, text, uploads:input.uploads, author:[message.from?.first_name,message.from?.last_name].filter(Boolean).join(" ") || undefined, externalId: chatId + ":" + String(message.message_id), externalChatId: chatId, title: message.chat.title ?? "Telegram " + chatId });
    try { await this.sendMessage(message.chat.id, result.text,`reply:${result.messageId}`); await this.sendFiles(message.chat.id,result.attachments,`reply:${result.messageId}`); }
    catch { this.lastError="Ответ сохранён в приложении; доставку в Telegram нужно проверить"; }
    } catch (error) {
      await this.sendMessage(message.chat.id, error instanceof Error ? error.message : "Не удалось завершить ответ",`error:${update.update_id}`);
    } finally { if(this.preparations.get(chatId)===prepared) this.preparations.delete(chatId); }
    this.store.markTelegramUpdate(update.update_id);
  }

  private ownsInteraction(chatId: string, card: Interaction): boolean {
    if (!this.linkedChats().includes(chatId)) return false;
    const origin = this.interactionOrigin(card);
    if (origin) return origin === chatId;
    const conversation = this.store.getConversation(card.conversationId);
    return this.store.getTelegramChat(chatId)?.conversationId===card.conversationId || (conversation?.channel === "telegram" && (conversation.externalId === chatId || conversation.externalId?.startsWith(chatId + "::employee::") === true));
  }

  private async sendInteraction(card: Interaction): Promise<void> {
    const conversation = this.store.getConversation(card.conversationId);
    const bound=this.store.telegramChats().find(c=>c.conversationId===card.conversationId);
    const origin = this.interactionOrigin(card);
    if (!origin && !bound && (conversation?.channel !== "telegram" || !conversation.externalId)) return;
    const chatId = origin ?? bound?.chatId ?? conversation!.externalId!.split("::employee::")[0]!;
    if (!this.ownsInteraction(chatId, card)) return;
    const rows: Array<Array<Record<string, string>>> = [];
    if (card.url) rows.push([{ text: "Открыть подключение", url: card.url }]);
    card.questions.forEach((q, qi) => q.options.forEach((option, oi) => rows.push([{ text: option, callback_data: `${card.id}:${qi}:${oi}` }])));
    const result = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: [card.title, card.detail, ...card.questions.map(q => q.question)].filter(Boolean).join("\n").slice(0, 4000),
      reply_markup: rows.length ? { inline_keyboard: rows } : { force_reply: true },
    });
    this.questionMessages.set(chatId + ":" + result.message_id, card.id);
  }

  private interactionOrigin(card: Interaction): string | undefined {
    const message = this.store.db.prepare("SELECT external_id FROM messages WHERE id=? AND channel='telegram'").get(card.messageId);
    return message?.external_id ? String(message.external_id).split(":")[0] : undefined;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.call<TelegramUpdate[]>("getUpdates", { offset: this.offset, timeout: 20, allowed_updates: ["message", "callback_query", "my_chat_member"] });
        for (const update of updates) {
          void this.processUpdate(update).catch(() => { this.lastError = "Входящее сообщение не завершено; оно сохранено для восстановления"; });
          this.offset = Math.max(this.offset, update.update_id + 1); this.store.setSetting("telegram.offset",String(this.offset));
        }
      } catch (error) {
        if (!this.running) return;
        this.lastError = error instanceof Error ? error.message : String(error);
        console.error("[telegram] " + this.lastError); await sleep(2_000).catch(() => undefined);
      }
    }
  }

  private consumeLink(code: string): boolean {
    const expiresAt = this.store.getSetting("telegram.link_expires_at"); const hash = this.store.getSetting("telegram.link_hash");
    if (!hash || hash !== sha256(code) || !expiresAt || expiresAt < new Date().toISOString()) return false;
    this.store.deleteSetting("telegram.link_hash"); this.store.deleteSetting("telegram.link_expires_at"); return true;
  }

  private async discoverGroup(chatId: string, title: string, sender: number, updateId: number): Promise<void> {
    // A group's invitation is not proof of ownership. Only a previously paired
    // private Telegram account may add it to this Home.
    if (!this.authorizedSender(String(sender), sender)) return;
    const existing = this.store.getTelegramChat(chatId);
    if (existing) {
      this.store.linkTelegramChat({ chatId, title, allowedSenders: existing.allowedSenders });
      return;
    }
    this.store.linkTelegramChat({ chatId, title, allowedSenders: [String(sender)] });
    await this.sendMessage(String(sender), `Группа «${title}» появилась в OpenStrudel. Откройте нужного сотрудника → Telegram и выберите эту группу. До привязки бот в ней молчит.`, "group-added:" + updateId);
  }

  private membershipEvent(chatId: string): {date:number;id:number} {
    try { return JSON.parse(this.store.getSetting("telegram.membership." + chatId) ?? '{"date":0,"id":0}'); }
    catch { return {date:0,id:0}; }
  }

  private linkedChats(): string[] {
    const chats=this.store.telegramChats().map(c=>c.chatId);
    const raw = this.store.getSetting("telegram.linked_chats"); if (!raw) return chats;
    try { const value: unknown = JSON.parse(raw); return [...new Set([...chats,...(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])])]; } catch { return chats; }
  }
  private authorizedSender(chatId:string, sender?:number):boolean {
    const actual=sender ?? (Number(chatId)>0 ? Number(chatId) : undefined);
    return actual!==undefined && this.store.getTelegramChat(chatId)?.allowedSenders.includes(String(actual))===true;
  }
  private replyConversation(chatId:string,messageId:number) {
    const row=this.store.db.prepare("SELECT key FROM telegram_outbox WHERE chat_id=? AND message_id=? AND status='delivered'").get(chatId,String(messageId));
    if(!row) return null;
    const [,kind,id]=String(row.key).split(":");
    const target=kind==="schedule" ? this.store.db.prepare("SELECT conversation_id FROM schedule_runs WHERE id=?").get(id!)
      : kind==="reply" ? this.store.db.prepare("SELECT conversation_id FROM messages WHERE id=?").get(id!) : undefined;
    return target ? this.store.getConversation(String(target.conversation_id)) : null;
  }

  private async call<T = unknown>(method: string, body: Record<string, unknown> | FormData, token = this.token): Promise<T> {
    if (!token) throw new Error("Telegram is not configured");
    for (let attempt=0;;attempt++) {
      const multipart = body instanceof FormData;
      const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, { method: "POST", headers: multipart ? undefined : { "content-type": "application/json" }, body: multipart ? body : JSON.stringify(body), signal: this.controller ? AbortSignal.any([this.controller.signal,AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000) });
      const payload = (await response.json()) as TelegramResponse<T>;
      // A 429 explicitly confirms no send happened. Network failures do not,
      // so only retry this documented rejection, never an ambiguous delivery.
      const retryAfter=payload.parameters?.retry_after;
      if (!payload.ok && payload.error_code===429 && Number.isFinite(retryAfter) && retryAfter!>=0 && retryAfter!<=60 && attempt<2) {
        await sleep(Math.max(1,retryAfter!)*1000,this.controller?.signal); continue;
      }
      if (!response.ok || !payload.ok) throw new Error(payload.description ?? "Telegram " + method + " failed");
      return payload.result;
    }
  }
}
