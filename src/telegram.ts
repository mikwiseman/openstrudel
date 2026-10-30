import { recordDiagnostic } from "./diagnostics.js";
import { randomBytes, randomUUID } from "node:crypto";
import { sha256, sleep } from "./util.js";
import type { Attachment, Interaction, MessageInput, MessageResult, TelegramChat } from "./types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramText, type TelegramText } from "./telegram-format.js";
import { isSpeechFile, transcribeRecording } from "./speech.js";
import { errorProblem, quietReply } from "./operations.js";
import type { MessageService } from "./messages.js";
import type { Store } from "./store.js";
import { agentTransfer, assertAgentWritable } from "./agent-move.js";
import { isProtectedTelegramAudience, isRestrictedChat, isRestrictedSubject, telegramAuthorization, migrateScopedChat, protectScopedTelegramTransport } from "./authorization.js";

export interface TelegramUpdate {
  update_id: number;
  my_chat_member?: { chat: { id: number | string; title?: string; type?: string }; from: { id: number }; date: number; old_chat_member: { status: string }; new_chat_member: { status: string; is_member?: boolean } };
  callback_query?: { id: string; from?: { id:number }; data?: string; message?: { message_id: number; chat: { id: number | string } } };
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}
type TelegramMessage = { from?: { id:number; first_name?:string; last_name?:string; is_bot?:boolean }; sender_chat?: { id:number }; is_topic_message?:boolean; message_thread_id?:number; date?:number; migrate_to_chat_id?:number|string; migrate_from_chat_id?:number|string; voice?:TelegramFile; audio?:TelegramFile; video_note?:TelegramFile; video?:TelegramFile & {file_name?:string;mime_type?:string}; document?:TelegramFile & {file_name?:string;mime_type?:string}; photo?:TelegramFile[]; caption?:string;
  reply_to_message?: { message_id: number; from?: { id: number; is_bot?: boolean; username?: string; first_name?: string; last_name?: string }; text?: string; caption?: string; photo?: TelegramFile[]; document?: { file_name?: string } };
  quote?: { text?: string }; message_id: number; text?: string; chat: { id: number | string; title?: string; type?: string } };
type TelegramFile = {file_id:string;file_size?:number};

interface TelegramResponse<T> { ok: boolean; result: T; description?: string; error_code?: number; parameters?: { retry_after?: number } }
interface TelegramBot { id: number; is_bot: boolean; first_name: string; username?: string }

class TelegramRequestError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
}
/** Telegram answered with a client error: it refused the request and sent nothing. */
const refused = (error: unknown) => error instanceof TelegramRequestError && error.code !== undefined && error.code >= 400 && error.code < 500;
const REFUSED = "Telegram отклонил сообщение, оно не отправлено. Проверьте, что бот остался в чате.";

/** Telegram counts a caption's 1024 characters after formatting. Null: the text needs its own message. */
function captionFor(text: string): TelegramText | null {
  const chunks = telegramText(text);
  return chunks.length > 1 || (chunks[0]?.text.length ?? 0) > 1024 ? null : chunks[0] ?? { text: "", entities: [] };
}

/** Pixel size from a JPEG, PNG or still WebP header; null for anything else. */
function imageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a && bytes.toString("latin1", 12, 16) === "IHDR")
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 30 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    const chunk = bytes.toString("latin1", 12, 16), bits = bytes.readUInt32LE(21);
    // An animated WebP would lose its motion as a photo.
    return chunk === "VP8 " ? { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
      : chunk === "VP8L" ? { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
      : chunk === "VP8X" && !(bytes[20]! & 0x02) ? { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 } : null;
  }
  // A JPEG states its size in the frame header; 0xc4, 0xc8 and 0xcc share that marker range but are other segments.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) for (let at = 2; at + 9 < bytes.length;) {
    const marker = bytes[at + 1]!;
    if (bytes[at] !== 0xff || marker === 0xd9 || marker === 0xda) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    at += marker === 0xff ? 1 : marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8) ? 2 : 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}

function telegramConnectionError(error: unknown): string {
  if (error instanceof TelegramRequestError) {
    if (error.code === 401 || error.code === 404) return "Ключ бота больше не действует. Подключите бота заново с ключом из BotFather.";
    if (error.code === 409) return "Этот бот уже используется другим приложением или устройством. Для OpenStrudel нужен отдельный бот.";
    if (error.code === 429) return "Telegram просит подождать. Подключимся автоматически.";
  }
  return "Нет связи с Telegram. Подключимся автоматически, когда связь восстановится.";
}

/** A silent H.264 MP4 of a GIF, the form Telegram keeps animations in; null without the server's ffmpeg or when the GIF does not convert. */
async function gifToMp4(path: string, ffmpeg = "/usr/bin/ffmpeg"): Promise<Buffer<ArrayBuffer> | null> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "openstrudel-gif-"));
    const output = join(directory, "animation.mp4");
    // Bounded so one GIF cannot take the Home's memory: a canvas up to 4K, two encoder threads and at most 1280 px on the longer
    // side, even and in proportion (without them a 2048×2048 GIF peaked at 1–1.5 GB). With no frame encoded, ffmpeg fails
    // instead of writing an MP4 without video.
    await promisify(execFile)(ffmpeg, ["-nostdin", "-v", "error", "-abort_on", "empty_output", "-protocol_whitelist", "file", "-max_pixels", String(3840*2160),
      "-f", "gif", "-i", path, "-an", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-vf", "scale='min(iw,1280)':'min(ih,1280)':force_original_aspect_ratio=decrease:force_divisible_by=2", output], { timeout: 60_000, maxBuffer: 65_536 });
    return await readFile(output);
  } catch { return null; }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}

export interface TelegramLink { code: string; expiresAt: string; url: string | null }
type PendingLink = { kind: "private" | "group"; profileId?: string; expiresAt: string; tokenHash: string; chatId?: string; error?: string };

export interface TelegramIntegrationStatus {
  configured: boolean;
  running: boolean;
  botUsername: string | null;
  botName: string | null;
  linkedChats: string[];
  chats: TelegramChat[];
  lastError: string | null;
  connectionError: string | null;
  lastCheckedAt: string | null;
}

export class TelegramAdapter {
  private token: string | undefined;
  private running = false;
  private offset = 0;
  private controller: AbortController | null = null;
  private flushingOwnerNotices?:Promise<void>;
  private bot: TelegramBot | null = null;
  private lastError: string | null = null;
  private connectionError: { message: string; code?: number } | null = null;
  private lastCheckedAt: string | null = null;
  private checking?: Promise<TelegramIntegrationStatus>;
  private readonly pendingUpdates = new Map<number, Promise<void>>();
  private readonly questionMessages = new Map<string, string>();
  private cleaningInteractions?: Promise<void>;
  private readonly preparations = new Map<string, Promise<Pick<MessageInput,"text"|"uploads"> & { transcript?: string }>>();
  private readonly activeChats = new Map<string, number>();
  private readonly typing = new Map<string, { users: number; timer: ReturnType<typeof setInterval> }>();
  transcribe = (bytes: Uint8Array, extension = "ogg") => transcribeRecording(this.store, bytes, "voice." + extension);
  convertGif = gifToMp4;

  constructor(token: string | undefined, private readonly store: Store, private readonly messages: MessageService) {
    this.token = token?.trim() || undefined;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS telegram_inbox(update_id INTEGER PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_outbox(key TEXT PRIMARY KEY,chat_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS telegram_links(hash TEXT PRIMARY KEY,payload TEXT NOT NULL,expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_interactions(bot_id TEXT NOT NULL,chat_id TEXT NOT NULL,message_id INTEGER NOT NULL,interaction_id TEXT NOT NULL,PRIMARY KEY(bot_id,chat_id,message_id));`);
    const outbox=this.store.db.prepare("PRAGMA table_info(telegram_outbox)").all().map(row=>row.name);
    for (const column of ["media_group_id","kind"]) if (!outbox.includes(column)) this.store.db.exec(`ALTER TABLE telegram_outbox ADD COLUMN ${column} TEXT`);
    this.store.db.prepare("UPDATE telegram_outbox SET status='unknown',error='Перезапуск во время отправки; проверьте Telegram перед повтором' WHERE status='sending'").run();
    this.offset=Number(this.store.getSetting("telegram.offset") ?? 0);
    // Legacy private pairings remain owned by that Telegram user.
    for (const id of this.linkedChats()) if (!this.store.getTelegramChat(id)) this.store.linkTelegramChat({chatId:id,title:`Telegram ${id}`,allowedSenders:id.startsWith("-")?[]:[id]});
    messages.interactions?.subscribe(card => { void this.sendInteraction(card).catch(() => { this.lastError = "Не удалось доставить запрос подтверждения"; }); });
    messages.interactions?.onSettled(card => {
      for (const [key, id] of this.questionMessages) if (id === card.id) {
        this.questionMessages.delete(key);
      }
      void this.cleanupInteractions().catch(() => undefined);
    });
  }

  enabled(): boolean { return Boolean(this.token); }

  /** Operational notices use the existing outbox and only explicitly paired owners. */
  async notifyOwner(notice: {id:string;text:string}, exceptChatId?: string): Promise<void> {
    if(!this.token)return;
    for(const chat of this.store.telegramChats()) {
      if(chat.chatId===exceptChatId || !this.isOwner(Number(chat.chatId)) || chat.enabled===false || this.store.getSetting("telegram.paused."+chat.chatId)==="true")continue;
      try {await this.sendMessage(chat.chatId,notice.text,"operation:"+notice.id);}
      catch {this.lastError="Не удалось подтвердить доставку уведомления владельцу. Оно сохранено в главном чате.";}
    }
  }

  /** Status notices may repeat after a lost acknowledgement; business actions never do. */
  async flushOwnerNotices():Promise<void> {
    if(!this.token)return;
    if(this.flushingOwnerNotices)return this.flushingOwnerNotices;
    this.flushingOwnerNotices=(async()=>{
      const rows=this.store.db.prepare("SELECT key,chat_id FROM telegram_outbox WHERE status IN ('pending','unknown','not_sent') AND key LIKE '%:operation:%' ORDER BY rowid").all();
      const attempted=new Set<string>();
      for(const row of rows){
        const match=String(row.key).match(/^\d+:operation:([a-f0-9-]+):\d+$/),chat=this.store.getTelegramChat(String(row.chat_id));
        if(!match || !chat || !this.isOwner(Number(chat.chatId)) || chat.enabled===false || this.store.getSetting("telegram.paused."+chat.chatId)==="true")continue;
        const notice=this.store.db.prepare("SELECT id,text FROM messages WHERE id=? AND kind='notice'").get(match[1]!);
        const delivery=chat.chatId+":"+match[1];if(!notice || attempted.has(delivery))continue;attempted.add(delivery);
        this.store.db.prepare("UPDATE telegram_outbox SET status='pending' WHERE chat_id=? AND key LIKE ? AND status IN ('unknown','not_sent')").run(chat.chatId,chat.chatId+":operation:"+match[1]+":%");
        try{await this.sendMessage(chat.chatId,String(notice.text),"operation:"+notice.id);}
        catch{this.lastError="Уведомление сохранено в главном чате. Повторим доставку при восстановлении Telegram.";break;}
      }
    })().finally(()=>{this.flushingOwnerNotices=undefined;});
    return this.flushingOwnerNotices;
  }

  status(): TelegramIntegrationStatus {
    return {
      configured: Boolean(this.token), running: this.running,
      botUsername: this.bot?.username ?? this.store.getSetting("telegram.bot_username"),
      botName: this.bot?.first_name ?? this.store.getSetting("telegram.bot_name"),
      linkedChats: this.linkedChats(), chats:this.store.telegramChats(), lastError: this.connectionError?.message ?? this.lastError,
      connectionError: this.connectionError?.message ?? null, lastCheckedAt: this.lastCheckedAt,
    };
  }

  /** A read-only probe. Never consumes updates or sends a Telegram message. */
  checkConnection(): Promise<TelegramIntegrationStatus> {
    if (!this.checking) {
      const token = this.token;
      const check = (async () => {
        if (!token) throw new Error("Сначала подключите бота Telegram.");
        try {
          const bot = await this.call<TelegramBot>("getMe", {}, token, 10_000);
          if (token !== this.token) return this.status();
          this.bot = bot;
          this.lastCheckedAt = new Date().toISOString();
          // getMe proves transport/auth recovery, not that a conflicting poller
          // or webhook stopped. A successful getUpdates clears that separately.
          if (this.connectionError?.code !== 409) this.connectionError = null;
        } catch (error) {
          if (token === this.token) this.connectionError = { message: telegramConnectionError(error), code: error instanceof TelegramRequestError ? error.code : undefined };
        }
        return this.status();
      })().finally(() => { if (this.checking === check) this.checking = undefined; });
      this.checking = check;
    }
    return this.checking;
  }

  async configure(token: string): Promise<TelegramIntegrationStatus> {
    const normalized = token.trim();
    if (!normalized) throw new Error("Telegram bot token is required");
    const bot = await this.call<TelegramBot>("getMe", {}, normalized);
    if (!bot.is_bot) throw new Error("Telegram token does not belong to a bot");
    const previousId = this.bot?.id.toString() ?? this.store.getSetting("telegram.bot_id") ?? this.token?.split(":")[0];
    if (this.token && previousId !== String(bot.id)) throw new Error("Сначала отключите прежнего бота. Его чаты не переносятся к другому боту.");
    const lastBot = previousId ?? this.store.getSetting("telegram.last_bot_id");
    if (!this.token && lastBot && lastBot !== String(bot.id)) {
      // Update IDs and membership events belong to the bot. Product history
      // remains intact; a different bot starts its own transport cursor.
      this.offset = 0; this.store.deleteSetting("telegram.offset");
      this.store.db.exec("DELETE FROM telegram_updates; DELETE FROM telegram_inbox; DELETE FROM telegram_links; DELETE FROM settings WHERE key LIKE 'telegram.membership.%' OR key LIKE 'telegram.removed.%' OR key LIKE 'telegram.paused.%';");
    }
    this.token = normalized; this.bot = bot; this.lastError = null; this.connectionError = null;
    this.lastCheckedAt = new Date().toISOString();
    this.store.setSetting("telegram.bot_token", normalized);
    this.store.setSetting("telegram.bot_name", bot.first_name);
    this.store.setSetting("telegram.bot_id", String(bot.id));
    if (bot.username) this.store.setSetting("telegram.bot_username", bot.username);
    await this.start();
    return this.status();
  }

  createLink(profileId?: string, kind: "private" | "group" = "private"): TelegramLink {
    if (!this.token) throw new Error("Connect Telegram before creating a link");
    if (profileId && !this.store.getProfile(profileId)) throw new Error("Сотрудник не найден");
    if (kind === "group" && !this.store.telegramChats().some(c => this.isOwner(Number(c.chatId)))) throw new Error("Сначала свяжите свой личный Telegram в настройках устройства.");
    const username = this.bot?.username ?? this.store.getSetting("telegram.bot_username");
    if (!username && kind === "group") throw new Error("Проверьте связь с ботом и попробуйте ещё раз.");
    const code = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const link: PendingLink = { kind, profileId, expiresAt, tokenHash: sha256(this.token) };
    this.store.db.prepare("DELETE FROM telegram_links WHERE expires_at < ?").run(new Date().toISOString());
    this.store.db.prepare("INSERT INTO telegram_links VALUES(?,?,?)").run(sha256(code), JSON.stringify(link), expiresAt);
    return { code, expiresAt, url: username ? `https://t.me/${username}?${kind === "group" ? "startgroup" : "start"}=${code}` : null };
  }

  bindChat(chatId: string, profileId: string | null): void {
    if (this.activeChats.has(chatId)) throw new Error("В этом чате ещё идёт ответ. Дождитесь его и повторите.");
    const previous = this.store.getTelegramChat(chatId);
    this.store.bindTelegramChat(chatId, profileId);
    // Only groups pause; a private chat always answers.
    if (profileId || Number(chatId) > 0) this.store.deleteSetting("telegram.paused." + chatId);
    else this.store.setSetting("telegram.paused." + chatId, "true");
    if (Number(chatId) < 0 && profileId && !previous?.profileId && !previous?.conversationId && !protectScopedTelegramTransport(this.store, chatId)) this.store.db.prepare("UPDATE telegram_chats SET access='members',replies='instructions' WHERE chat_id=?").run(chatId);
  }

  setGroupEnabled(chatId: string, enabled: boolean): void {
    if (Number(chatId) >= 0 || !this.store.getTelegramChat(chatId)) throw new Error("Группа Telegram не найдена");
    // Pausing a protected group revokes its running turns at their next check; it never waits for participants.
    if (this.activeChats.has(chatId) && (enabled || !isRestrictedChat(this.store, chatId))) throw new Error("Дождитесь текущего ответа и повторите.");
    if (enabled) { this.store.connectTelegramGroup(chatId); this.store.deleteSetting("telegram.paused." + chatId); }
    else this.store.setSetting("telegram.paused." + chatId, "true");
  }

  linkStatus(code: string): { status: "waiting" | "connected" | "expired"; error?: string } {
    const row = this.store.db.prepare("SELECT payload FROM telegram_links WHERE hash=?").get(sha256(code));
    const link = row ? JSON.parse(String(row.payload)) as PendingLink : null;
    if (!link || link.tokenHash !== sha256(this.token ?? "")) return { status: "expired" };
    if (link.chatId) return { status: "connected" };
    return { status: link.expiresAt < new Date().toISOString() ? "expired" : "waiting", error: link.error };
  }

  disconnect(): TelegramIntegrationStatus {
    if (this.activeChats.size) throw new Error("Сотрудник ещё отвечает в Telegram. Дождитесь ответа и повторите отключение.");
    const botId = this.bot?.id.toString() ?? this.store.getSetting("telegram.bot_id") ?? this.token?.split(":")[0];
    if (botId) this.store.setSetting("telegram.last_bot_id", botId);
    this.stop(); this.token = undefined; this.bot = null; this.lastError = null; this.connectionError = null; this.lastCheckedAt = null;
    for (const key of ["telegram.bot_token", "telegram.bot_name", "telegram.bot_username", "telegram.bot_id", "telegram.link_hash", "telegram.link_expires_at", "telegram.link_profile", "telegram.linked_chats"]) this.store.deleteSetting(key);
    this.store.db.exec("DELETE FROM telegram_chats; DELETE FROM telegram_inbox; DELETE FROM telegram_links;");
    return this.status();
  }

  async start(): Promise<void> {
    if (!this.token || this.running) return;
    this.running = true; this.controller = new AbortController();
    for (const row of this.store.db.prepare("SELECT payload FROM telegram_inbox ORDER BY update_id").all()) void this.processUpdate(JSON.parse(String(row.payload))).catch(() => { this.lastError="Не удалось восстановить входящее сообщение"; });
    void this.poll();
  }

  stop(): void {
    this.running = false; this.controller?.abort(); this.controller = null;
    for (const entry of this.typing.values()) clearInterval(entry.timer);
    this.typing.clear();
  }

  private startTyping(chatId: string, topic?: number): () => void {
    const key = `${chatId}:${topic ?? ""}`;
    const existing = this.typing.get(key);
    if (existing) existing.users++;
    else {
      const token = this.token;
      let sending = false;
      const pulse = async () => {
        if (sending || this.token !== token || !this.typing.has(key)) return;
        sending = true;
        try { await this.call("sendChatAction", {chat_id:chatId,action:"typing",...(topic ? {message_thread_id:topic} : {})}, token, 3500); }
        catch { /* Presence is best-effort; it must never block the actual reply. */ }
        finally { sending = false; }
      };
      const timer = setInterval(() => void pulse(), 4000); timer.unref();
      this.typing.set(key,{users:1,timer}); void pulse();
    }
    return () => {
      const entry = this.typing.get(key);
      if (entry && --entry.users === 0) {clearInterval(entry.timer);this.typing.delete(key);}
    };
  }

  /** An explicit app reply never runs the assistant or changes its audience. */
  async replyFromApp(input: { conversationId: string; replyToId: string; text: string; externalId: string; attachments?: string[] }) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.externalId)) throw new Error("Не удалось определить отправку. Откройте ответ заново.");
    const text = input.text.trim();
    if (!text) throw new Error("Введите ответ.");
    const files = this.messages.files.forMessage(input.conversationId, input.attachments ?? []).map(file => this.messages.files.public(file));
    const previous = this.store.findMessageByExternal("telegram", input.externalId);
    if (previous) {
      if (previous.direction !== "outbound" || previous.conversationId !== input.conversationId || previous.replyToId !== input.replyToId || previous.text !== text
          || JSON.stringify(previous.attachments ?? []) !== JSON.stringify(files)) throw new Error("Этот ответ уже отправлялся с другим содержимым.");
      return { messageId: previous.id };
    }
    if (!this.token) throw new Error("Telegram не подключён");
    const conversation = this.store.getConversation(input.conversationId);
    const reference = this.store.getMessage(input.conversationId, input.replyToId);
    if (!conversation || !reference || reference.channel !== "telegram" || reference.direction !== "inbound") throw new Error("Обращение Telegram не найдено.");
    const origin = reference.externalId?.match(/^(-?\d+):(\d+)$/);
    const chat = origin && this.store.getTelegramChat(origin[1]!);
    if (!chat || chat.conversationId !== conversation.id || chat.profileId !== (conversation.profileId ?? null)
        || chat.enabled === false || this.store.getSetting("telegram.paused." + chat.chatId) === "true") throw new Error("Подключение этой группы изменилось. Откройте её в Telegram.");
    assertAgentWritable(this.store, conversation.profileId ?? "main");
    const reply = this.store.addMessage({ conversationId: conversation.id, channel: "telegram", direction: "outbound", replyToId: reference.id,
      text, externalId: input.externalId, author: "OpenStrudel", attachments: files });
    this.store.setMessageStatus(reply.id, "running");
    this.activeChats.set(chat.chatId, (this.activeChats.get(chat.chatId) ?? 0) + 1);
    try {
      await this.sendAnswer(chat.chatId, text, files, "reply:" + reply.id, Number(origin![2]));
      this.store.setMessageStatus(reply.id, "completed");
    } catch (error) {
      // The durable receipt survives a lost HTTP acknowledgement. Repeating
      // the same app request reads it; it never sends an uncertain reply again.
      this.store.setMessageStatus(reply.id, "failed", refused(error) ? REFUSED : "Доставка не завершена. Проверьте сообщение в Telegram перед новой отправкой.");
    } finally {
      const remaining = (this.activeChats.get(chat.chatId) ?? 1) - 1;
      if (remaining) this.activeChats.set(chat.chatId, remaining); else this.activeChats.delete(chat.chatId);
    }
    return { messageId: reply.id };
  }

  async sendMessage(chatId: string | number, text: string, deliveryKey: string = randomUUID(), replyToMessageId?: number, options: { silent?: boolean; linkPreview?: boolean; assertCurrent?: () => void } = {}): Promise<void> {
    if (!this.token) throw new Error("Telegram не подключён");
    const chunks=telegramText(text);
    for (const [index,chunk] of chunks.entries()) {
      options.assertCurrent?.();
      const key=`${chatId}:${deliveryKey}:${index}`;
      const payload=JSON.stringify({chat_id:chatId,...chunk,link_preview_options:{is_disabled:options.linkPreview !== true},
        ...(options.silent ? { disable_notification:true } : {}),
        // The owner's words still reach the group if the original was deleted.
        ...(index === 0 && replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {})});
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
        this.store.db.prepare("UPDATE telegram_outbox SET status=?,error=? WHERE key=?").run(...(refused(error) ? ["not_sent", REFUSED] : ["unknown", "Ответ Telegram не подтверждён; автоматический повтор остановлен"]), key);
        throw error;
      }
    }
  }

  /** An answer and its files. Photos Telegram accepts arrive as one captioned photo or album; other files keep their form. */
  async sendAnswer(chatId: string | number, text: string, files: Attachment[] = [], deliveryKey: string, replyToMessageId?: number, assertCurrent?: () => void): Promise<void> {
    assertCurrent?.();
    const prefix = `${chatId}:${deliveryKey}:`;
    const begun = new Set(this.store.db.prepare("SELECT key FROM telegram_outbox WHERE key>=? AND key<?").all(prefix, prefix + "\uffff").map(row => String(row.key)));
    // A delivery begun as text and documents finishes that way; a receipt is never sent again in another form.
    const photos: Attachment[] = [];
    for (const file of files) if (!begun.has(prefix + "file:" + file.id) && await this.isPhoto(file)) photos.push(file);
    const caption = photos.length && !begun.has(prefix + "0") ? captionFor(text) : null;
    if (!caption) await this.sendMessage(chatId, text, deliveryKey, replyToMessageId, { assertCurrent });
    for (let first = 0; first < photos.length; first += 10) {
      const batch = photos.slice(first, first + 10), captioned = Boolean(caption && !first);
      assertCurrent?.();
      try { await this.sendPhotos(String(chatId), batch, deliveryKey, first, captioned ? { caption: caption!, replyTo: replyToMessageId } : {}); }
      catch (error) {
        // Telegram refused the photos, so nothing went out: the answer still arrives as text and files.
        if (!refused(error)) throw error;
        if (captioned) await this.sendMessage(chatId, text, deliveryKey, replyToMessageId, { assertCurrent });
        await this.sendFiles(chatId, batch, deliveryKey, { assertCurrent });
      }
    }
    await this.sendFiles(chatId, files.filter(file => !photos.includes(file)), deliveryKey, { assertCurrent });
  }

  /** Telegram's photo limits: JPEG, PNG or still WebP up to 10 MB, width plus height at most 10000, sides within 1:20. */
  private async isPhoto(file: Attachment): Promise<boolean> {
    const stored = this.messages.files.get(file.id);
    if (!stored || stored.conversationId !== file.conversationId || !["image/jpeg", "image/png", "image/webp"].includes(file.mimeType) || stored.size > 10*1024*1024) return false;
    const bytes = await readFile(stored.path).catch(() => Buffer.alloc(0)), size = bytes.length <= 10*1024*1024 ? imageSize(bytes) : null;
    const short = Math.min(size?.width ?? 0, size?.height ?? 0), long = Math.max(size?.width ?? 0, size?.height ?? 0);
    return short > 0 && long <= 20 * short && short + long <= 10000;
  }

  /** Checks without sending that a chat can receive a requested delivery, so a caller can check several chats before sending to any. Album and file checks stay in sendToChat. */
  deliveryTarget(chatId:string, externalId:string) {
    if (!this.token) throw new Error("Telegram не подключён");
    // Model turns and the notification hook never post to a protected audience, as the scheduler already refuses.
    // Restricted answers use sendAnswer for their own verified request and are not affected.
    if (isProtectedTelegramAudience(this.store, chatId)) throw new Error("Отправка в чат с ограниченным доступом недоступна.");
    const chat = this.store.getTelegramChat(chatId);
    if (!chat || chat.enabled === false) throw new Error("Бот больше не подключён к этому чату.");
    assertAgentWritable(this.store,chat.profileId ?? "main");
    const previous = this.store.findMessageByExternal("telegram",externalId);
    const conversation = chat.conversationId ? this.store.getConversation(chat.conversationId)
      : Number(chat.chatId)>0 ? this.store.getOrCreateConversation({channel:"telegram",externalId:chat.chatId,title:chat.title}) : null;
    if (!conversation) throw new Error("Чат бота недоступен.");
    if (previous && previous.conversationId !== conversation.id) throw new Error("Подключение чата изменилось; проверьте предыдущую отправку.");
    return {chat,conversation,previous};
  }

  /** A requested cross-chat delivery uses the same durable outbox as ordinary replies. */
  async sendToChat(input: {chatId:string;text:string;files:Array<{name:string;mimeType?:string;contentBase64:string}>;externalId:string;silent?:boolean;linkPreview?:boolean;album?:boolean}) {
    const {chat,conversation,previous} = this.deliveryTarget(input.chatId,input.externalId);
    const receipt = (messageId:string) => {
      const message = this.store.getMessage(conversation.id,messageId)!;
      const prefix=`${chat.chatId}:reply:${messageId}:`;
      const deliveries=this.store.db.prepare("SELECT key,message_id,status,media_group_id,kind FROM telegram_outbox WHERE key>=? AND key<? ORDER BY key").all(prefix,prefix+"\uffff");
      const delivered=deliveries.filter(row=>row.status === "delivered");
      const albums=[...new Set(delivered.filter(row=>row.media_group_id).map(row=>String(row.media_group_id)))];
      // What Telegram made of each file, from its reply: a GIF sent as an animation can still arrive as a plain file. Listed in the
      // requested order, not by outbox key (a random file id); each file's own message tells two files of the same name apart.
      const rows=new Map(delivered.map(row=>[String(row.key),row]));
      const files=(message.attachments ?? []).flatMap(file=>{const row=rows.get(prefix+"file:"+file.id);
        return row?.kind ? [{name:file.name,kind:String(row.kind),telegramMessageId:String(row.message_id)}] : [];});
      const status=message.status === "completed" ? "delivered" : message.status === "running" ? "pending"
        : deliveries.some(row=>row.status === "unknown" || row.status === "sending") ? "unknown" : delivered.length ? "partial" : "not_sent";
      return {sent:status === "delivered",status,chatId:chat.chatId,title:chat.title,messageId,
        telegramMessageIds:delivered.map(row=>String(row.message_id)),...(files.length?{files}:{}),...(albums.length?{telegramMediaGroupIds:albums}:{}),...(message.error?{error:message.error}:{})};
    };
    if (previous) return receipt(previous.id);
    if (input.album) {
      if (input.files.length < 2 || input.files.length > 10) throw new Error("Фотоальбом должен содержать 2–10 фотографий.");
      if (!captionFor(input.text)) throw new Error("Подпись фотоальбома — до 1024 символов.");
      if (input.files.some(file=>!["image/jpeg","image/png"].includes(file.mimeType ?? ""))) throw new Error("Для фотоальбома нужны JPEG или PNG.");
      if (input.files.some(file=>Buffer.from(file.contentBase64,"base64").length > 10*1024*1024)) throw new Error("Фотография в альбоме — до 10 МБ.");
    }
    const files=input.files.map(file=>this.messages.files.put(conversation.id,this.messages.contextFor(conversation.id),file));
    const message=this.store.addMessage({conversationId:conversation.id,channel:"telegram",direction:"outbound",text:input.text,
      externalId:input.externalId,attachments:files,author:this.bot?.first_name ?? this.store.getSetting("telegram.bot_name") ?? "OpenStrudel"});
    this.store.setMessageStatus(message.id,"running");
    this.activeChats.set(chat.chatId,(this.activeChats.get(chat.chatId) ?? 0)+1);
    try {
      if (input.album) await this.sendPhotos(chat.chatId,files,"reply:"+message.id,0,{silent:input.silent,caption:captionFor(input.text)!});
      else {
        await this.sendMessage(chat.chatId,input.text,"reply:"+message.id,undefined,input);
        await this.sendFiles(chat.chatId,files,"reply:"+message.id,input);
      }
      this.store.setMessageStatus(message.id,"completed");
    } catch (error) {
      this.store.setMessageStatus(message.id,"failed",refused(error)?REFUSED:"Доставка не подтверждена. Проверьте Telegram перед новой отправкой.");
    } finally {
      const remaining=(this.activeChats.get(chat.chatId) ?? 1)-1;
      if (remaining) this.activeChats.set(chat.chatId,remaining); else this.activeChats.delete(chat.chatId);
    }
    return receipt(message.id);
  }

  /** Up to ten photos in one request: sendPhoto for one, sendMediaGroup for an album. Each photo keeps an album receipt. */
  private async sendPhotos(chatId:string, files:Attachment[], deliveryKey:string, first:number, options:{silent?:boolean;caption?:TelegramText;replyTo?:number}):Promise<void> {
    const single=files.length===1, form=new FormData();form.set("chat_id",chatId);
    if (options.silent) form.set("disable_notification","true");
    const reply=options.replyTo ? {message_id:options.replyTo,allow_sending_without_reply:true} : undefined;
    if (reply) form.set("reply_parameters",JSON.stringify(reply));
    const caption=options.caption?.text ? {caption:options.caption.text,caption_entities:options.caption.entities} : undefined;
    const media=files.map((_file,index)=>({type:"photo",media:`attach://photo${first+index}`,...(index===0 ? caption : {})}));
    if (!single) form.set("media",JSON.stringify(media));
    else if (caption) {form.set("caption",caption.caption);form.set("caption_entities",JSON.stringify(caption.caption_entities));}
    for (const [index,file] of files.entries()) {
      const stored=this.messages.files.get(file.id);
      if (!stored || stored.conversationId!==file.conversationId) throw new Error("Файл ответа не найден");
      form.set(single ? "photo" : `photo${first+index}`,new Blob([await readFile(stored.path)],{type:file.mimeType}),file.name);
    }
    const rows=files.map((file,index)=>({key:`${chatId}:${deliveryKey}:album:${first+index}`,
      payload:JSON.stringify({chat_id:chatId,media,fileIds:files.map(f=>f.id),fileId:file.id,...(options.silent?{disable_notification:true}:{}),...(reply?{reply_parameters:reply}:{})})}));
    // Reserve every photo together; a lost response must not replay the album.
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) this.store.db.prepare("INSERT OR IGNORE INTO telegram_outbox(key,chat_id,payload,status) VALUES(?,?,?,'pending')").run(row.key,chatId,row.payload);
      const saved=rows.map(row=>this.store.db.prepare("SELECT payload,status FROM telegram_outbox WHERE key=?").get(row.key)!);
      if (saved.some((row,index)=>row.payload!==rows[index]!.payload)) throw new Error("Содержимое доставки изменилось");
      if (saved.every(row=>row.status==="delivered")) {this.store.db.exec("COMMIT");return;}
      if (saved.some(row=>row.status!=="pending")) throw new Error("Проверьте доставку фотоальбома в Telegram перед повтором");
      for (const row of rows) this.store.db.prepare("UPDATE telegram_outbox SET status='sending' WHERE key=?").run(row.key);
      this.store.db.exec("COMMIT");
    } catch(error) {this.store.db.exec("ROLLBACK");throw error;}
    try {
      const result=await this.call<unknown>(single?"sendPhoto":"sendMediaGroup",form);
      const sent=(single?[result]:result) as Array<{message_id:number;media_group_id?:string}>;
      if (!Array.isArray(sent) || sent.length!==files.length || !single && !sent[0]?.media_group_id
        || sent.some(item=>!Number.isSafeInteger(item?.message_id) || item.message_id<=0 || item.media_group_id!==sent[0]!.media_group_id)
        || new Set(sent.map(item=>item.message_id)).size!==files.length) throw new Error("Telegram не подтвердил весь фотоальбом");
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        for (const [index,item] of sent.entries()) this.store.db.prepare("UPDATE telegram_outbox SET status='delivered',message_id=?,media_group_id=? WHERE key=?").run(String(item.message_id),item.media_group_id ?? null,rows[index]!.key);
        this.store.db.exec("COMMIT");
      } catch(error) {this.store.db.exec("ROLLBACK");throw error;}
    } catch(error) {
      for (const row of rows) this.store.db.prepare("UPDATE telegram_outbox SET status=?,error=? WHERE key=?").run(...(refused(error)?["not_sent",REFUSED]:["unknown","Доставка фотоальбома не подтверждена. Проверьте Telegram перед повтором."]),row.key);
      throw error;
    }
  }

  async sendFiles(chatId: string | number, files: Attachment[] = [], deliveryKey: string = randomUUID(), options: { silent?: boolean; assertCurrent?: () => void } = {}): Promise<void> {
    for (const file of files) {
      options.assertCurrent?.();
      const stored = this.messages.files.get(file.id);
      if (!stored || stored.conversationId !== file.conversationId) throw new Error("Файл ответа не найден");
      const key = `${chatId}:${deliveryKey}:file:${file.id}`;
      const payload = JSON.stringify({chat_id:chatId,fileId:file.id,name:file.name,...(options.silent ? {disable_notification:true} : {})});
      this.store.db.prepare("INSERT OR IGNORE INTO telegram_outbox(key,chat_id,payload,status) VALUES(?,?,?,'pending')").run(key,String(chatId),payload);
      const row = this.store.db.prepare("SELECT * FROM telegram_outbox WHERE key=?").get(key)!;
      if (row.payload !== payload) throw new Error("Содержимое доставки изменилось");
      if (row.status === "delivered") continue;
      if (row.status !== "pending") throw new Error("Проверьте доставку файла в Telegram перед повтором");
      let attempted=false;
      try {
        const form = new FormData();form.set("chat_id",String(chatId));
        if (options.silent) form.set("disable_notification","true");
        const animation=file.mimeType === "image/gif", audio=["audio/mpeg", "audio/mp4"].includes(file.mimeType);
        // Observed, not documented: a 5.4 MB GIF became an animation, an 11.6 MB one stayed a plain file. 8 MB is a cut between
        // those two sends, not a known Telegram limit. A larger GIF goes as our own MP4 when this Home has ffmpeg.
        const video=animation && stored.size > 8*1024*1024 ? await this.convertGif(stored.path) : null;
        form.set(animation?"animation":audio?"audio":"document",new Blob([video ?? await readFile(stored.path)],{type:video?"video/mp4":file.mimeType}),video?file.name.replace(/\.gif$/i,"")+".mp4":file.name);
        this.store.db.prepare("UPDATE telegram_outbox SET status='sending' WHERE key=?").run(key);
        attempted=true;
        const sent = await this.call<{message_id:number}&Record<string,unknown>>(animation?"sendAnimation":audio?"sendAudio":"sendDocument",form);
        // The Bot API server writes an animation as both animation and document, and a file it kept plain as document only
        // (tdlib/telegram-bot-api, Client::JsonMessage::store), so animation is checked first.
        const kind=["animation","video","audio","voice","photo","sticker","document"].find(field=>sent[field]) ?? null;
        this.store.db.prepare("UPDATE telegram_outbox SET status='delivered',message_id=?,kind=? WHERE key=?").run(String(sent.message_id),kind,key);
      } catch (error) {
        this.store.db.prepare("UPDATE telegram_outbox SET status=?,error=? WHERE key=?").run(...(!attempted ? ["not_sent","Файл недоступен. Он не отправлен."] : refused(error) ? ["not_sent", REFUSED] : ["unknown", "Доставка файла не подтверждена. Проверьте Telegram перед повтором."]), key);
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
    try {
      await pending;
      this.store.db.prepare("DELETE FROM telegram_inbox WHERE update_id=?").run(update.update_id);
      this.store.deleteSetting("telegram.transcript." + update.update_id);
    } finally { this.pendingUpdates.delete(update.update_id); }
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
          if (!active) {
            const chat = this.store.getTelegramChat(chatId);
            if (chat) this.store.setSetting("telegram.removed." + chatId, JSON.stringify(chat));
            this.store.db.prepare("DELETE FROM telegram_chats WHERE chat_id=?").run(chatId);
          }
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
      if (card && this.authorizedSender(chatId,query.from?.id) && this.ownsInteraction(chatId, card) && card.requestedBy && card.requestedBy !== String(query.from?.id)) {
        feedback = "Подтвердить может тот, кто дал поручение";
      } else if (card && this.authorizedSender(chatId,query.from?.id) && this.ownsInteraction(chatId, card)) {
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
    const edited = update.edited_message;
    if (edited) {
      const chatId = String(edited.chat.id), text = (edited.text ?? edited.caption)?.trim();
      const speech = edited.voice || edited.audio || edited.video_note || edited.video || edited.document && isSpeechFile(edited.document.file_name ?? "", edited.document.mime_type);
      // A correction reaches a request still waiting for its turn. It never starts a turn or rewrites an answered one.
      if (text && !speech && this.linkedChats().includes(chatId) && this.authorizedSender(chatId, edited.from?.id))
        this.store.db.prepare("UPDATE messages SET text=? WHERE channel='telegram' AND direction='inbound' AND status='queued' AND external_id=?").run(text, chatId + ":" + edited.message_id);
      this.store.markTelegramUpdate(update.update_id); return;
    }
    const message = update.message;
    if (message?.migrate_to_chat_id || message?.migrate_from_chat_id) {
      const oldId = String(message.migrate_from_chat_id ?? message.chat.id);
      const newId = String(message.migrate_to_chat_id ?? message.chat.id);
      if (!migrateScopedChat(this.store, oldId, newId)) this.store.migrateTelegramGroup(oldId, newId);
      this.store.markTelegramUpdate(update.update_id); return;
    }
    if (message?.chat.title) this.store.renameTelegramGroup(String(message.chat.id), message.chat.title);
    if (!message || (!message.text?.trim() && !message.voice && !message.audio && !message.video_note && !message.video && !message.document && !message.photo?.length)) { this.store.markTelegramUpdate(update.update_id); return; }
    const chatId = String(message.chat.id); let text = (message.text ?? message.caption)?.trim() ?? "";
    const username = this.bot?.username ?? this.store.getSetting("telegram.bot_username");
    const commandRecipient = text.match(/^\/\w+@([\w]+)(?:\s|$)/)?.[1];
    if (commandRecipient && commandRecipient.toLowerCase() !== username?.toLowerCase()) {
      this.store.markTelegramUpdate(update.update_id); return;
    }
    const groupStart = text.match(/^\/start@([\w]+)\s+choose$/i);
    if (groupStart && Number(chatId) < 0 && groupStart[1]!.toLowerCase() === (this.bot?.username ?? this.store.getSetting("telegram.bot_username"))?.toLowerCase()) {
      const previous = this.membershipEvent(chatId);
      const date = message.date ?? previous.date;
      if ((date > previous.date || (date === previous.date && update.update_id >= previous.id)) && message.from) {
        await this.discoverGroup(chatId, message.chat.title ?? "Группа", message.from.id, update.update_id);
      }
      this.store.markTelegramUpdate(update.update_id); return;
    }
    const start = text.match(/^\/(?:start|link)(?:@([\w]+))?\s+([^\s]+)$/i);
    if (start) {
      const username = this.bot?.username ?? this.store.getSetting("telegram.bot_username");
      if (!start[1] || start[1].toLowerCase() === username?.toLowerCase()) {
        await this.acceptLink(start[2]!, update);
      }
      this.store.markTelegramUpdate(update.update_id); return;
    }
    // Forum topics have separate audiences. They are not routed through a
    // group's binding until topic support can carry the address end to end.
    if (message.is_topic_message || message.sender_chat || message.from?.is_bot) { this.store.markTelegramUpdate(update.update_id); return; }
    if (!this.linkedChats().includes(chatId)) {
      if (Number(chatId) > 0) await this.sendMessage(message.chat.id, "Откройте OpenStrudel → Настройки → Аккаунты → Telegram и нажмите «Связать мой Telegram».");
      this.store.markTelegramUpdate(update.update_id); return;
    }
    if (!this.authorizedSender(chatId,message.from?.id)) { this.store.markTelegramUpdate(update.update_id); return; }
    if (/^\/bind(?:@\w+)?(?:\s|$)/i.test(text)) {
      if (this.isOwner(message.from?.id)) await this.sendMessage(chatId, "Опишите задачу: помощник ответит сам или подключит подходящего сотрудника.", `bind-help:${update.update_id}`);
      this.store.markTelegramUpdate(update.update_id); return;
    }
    const binding = this.store.getTelegramChat(chatId);
    if (binding?.enabled === false) { this.store.markTelegramUpdate(update.update_id); return; }
    if (Number(chatId) < 0 && !binding?.conversationId) {
      this.store.markTelegramUpdate(update.update_id); return;
    }
    const replyAuthor = message.reply_to_message?.from;
    const replyToBot = Boolean(replyAuthor && (replyAuthor.id === this.bot?.id || replyAuthor.is_bot && username && replyAuthor.username?.toLowerCase() === username.toLowerCase()));
    const mentioned = Boolean(username && new RegExp(`@${username}(?![\\w])`, "i").test(text));
    if (Number(chatId) < 0 && replyAuthor?.is_bot && !replyToBot && !mentioned) {
      this.store.markTelegramUpdate(update.update_id); return;
    }
    const protectedAudience = isProtectedTelegramAudience(this.store, chatId);
    // A protected group never runs a turn for ordinary discussion, whatever its stored reply mode.
    const mentionsOnly = binding?.replies === "mentions" || protectedAudience;
    // Participants cannot keep a protected queue busy indefinitely: beyond the backlog, a message stays as context.
    const saturated = protectedAudience && Boolean(binding?.conversationId) && this.messages.restrictedSaturated(binding!.conversationId!);
    const contextOnly = Number(chatId) < 0 && mentionsOnly && !replyToBot && !mentioned || saturated;
    const replyKey = chatId + ":" + message.reply_to_message?.message_id;
    const cardId = this.questionMessages.get(replyKey);
    const card = cardId ? this.messages.interactions.get(cardId) : undefined;
    if (card && this.ownsInteraction(chatId, card)) {
      const question = (!card.requestedBy || card.requestedBy === String(message.from?.id)) ? card.questions.find(q => q.options.length === 0) : undefined;
      if (question) {
        await this.messages.interactions.answer(card.id, card.conversationId, { [question.id]: text });
        this.store.markTelegramUpdate(update.update_id); return;
      }
    }
    const replyConversation=message.reply_to_message ? this.replyConversation(chatId,message.reply_to_message.message_id) : null;
    const conversation = replyConversation ?? (binding?.conversationId ? this.store.getConversation(binding.conversationId) : null) ?? this.store.getOrCreateConversation({ channel: "telegram", externalId: chatId, title: message.chat.title ?? "Telegram " + chatId });
    this.activeChats.set(chatId, (this.activeChats.get(chatId) ?? 0) + 1);
    const stopTyping = contextOnly ? () => {} : this.startTyping(chatId, message.message_thread_id);
    const externalId = chatId + ":" + String(message.message_id), author = [message.from?.first_name,message.from?.last_name].filter(Boolean).join(" ") || undefined;
    let received = false;
    const prepared=(this.preparations.get(chatId) ?? Promise.resolve({text:""})).catch(()=>({text:""})).then(async()=>{
      const media=message.voice ?? message.audio ?? message.video_note ?? message.video ?? message.document ?? message.photo?.at(-1);
      if(!media) return {text};
      const speech = Boolean(message.voice || message.audio || message.video_note || message.video || message.document && isSpeechFile(message.document.file_name ?? "", message.document.mime_type));
      // A restricted turn reads text and speech only. In a protected audience nothing is downloaded or
      // transcribed unless the message addresses the bot, and photos or other files are never fetched.
      if (protectedAudience && (contextOnly || !speech)) return {text};
      const cached = speech ? this.store.getSetting("telegram.transcript." + update.update_id) : null;
      if (cached) return { text: [text, cached].filter(Boolean).join("\n"), transcript: cached };
      if((media.file_size ?? 0)>20_000_000) throw new Error("Отправьте файл до 20 МБ.");
      const file=await this.call<{file_path:string;file_size?:number}>("getFile",{file_id:media.file_id});
      if(!file.file_path || (file.file_size ?? 0)>20_000_000) throw new Error("Не удалось получить файл до 20 МБ");
      const response=await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`,{signal:AbortSignal.timeout(30_000)});
      if(!response.ok) throw new Error("Не удалось скачать вложение");
      const bytes=new Uint8Array(await response.arrayBuffer());
      if(bytes.length>20_000_000) throw new Error("Отправьте файл до 20 МБ.");
      if (speech) try {
        const transcript = await this.transcribe(bytes, (message.document?.file_name ?? file.file_path).split(".").at(-1));
        this.store.setSetting("telegram.transcript." + update.update_id, transcript);
        return { text: [text, transcript].filter(Boolean).join("\n"), transcript };
      } catch (error) {
        // A video is a file first: when its speech cannot be heard, the employee opens it like any other attachment.
        // A protected audience has no file handling, so its unheard video stays a failed request.
        if (protectedAudience || !message.video && !/^video\//i.test(message.document?.mime_type ?? "")) throw error;
      }
      const hex=sha256(`${chatId}:${message.message_id}:${media.file_id}`).slice(0,32);
      const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
      return {text,uploads:[{id,name:message.video ? message.video.file_name ?? "video.mp4" : message.document?.file_name ?? "photo.jpg",mimeType:message.video ? message.video.mime_type ?? "video/mp4" : message.document ? message.document.mime_type ?? "application/octet-stream" : "image/jpeg",contentBase64:Buffer.from(bytes).toString("base64")}]};
    }).then(async input => {
      const current = this.store.getTelegramChat(chatId);
      if (input.transcript && !contextOnly && current && current.enabled !== false && current.profileId === binding?.profileId && current.conversationId === binding?.conversationId) {
        // Keep the preview inside the existing preparation FIFO: later text
        // must not overtake its voice message while Telegram sends the preview.
        await this.sendMessage(chatId, "📝 " + input.transcript, "transcript:" + message.message_id)
          .catch(() => { this.lastError = "Доставка расшифровки не подтверждена. Текст сохранится в приложении вместе с ответом."; });
      }
      return input;
    });
    this.preparations.set(chatId,prepared);
    try {
    const input = await prepared;text=input.text;received=true;
    // A protected message without words or speech carries nothing a restricted turn could use.
    if (protectedAudience && !text.trim() && !input.uploads?.length) { this.store.markTelegramUpdate(update.update_id); return; }
    const replyToAssistant = Boolean(replyConversation || replyAuthor && (replyAuthor.id === this.bot?.id || replyAuthor.is_bot && replyAuthor.username?.toLowerCase() === (this.bot?.username ?? this.store.getSetting("telegram.bot_username"))?.toLowerCase()));
    // The exact message answered, from Telegram itself: the bot's own posts may never have passed through Home.
    const target = message.reply_to_message;
    const replyTo = target ? { messageId: target.message_id, author: replyToAssistant ? "assistant" : [target.from?.first_name, target.from?.last_name].filter(Boolean).join(" ") || undefined,
      text: (message.quote?.text ?? target.text ?? target.caption ?? "").slice(0, 1500) || (target.photo ? "[photo]" : target.document ? `[${target.document.file_name ?? "file"}]` : "") } : undefined;
    // Only the paired owner in a private chat; a group's audience is never just the owner.
    const byOwner = Number(chatId) > 0 && this.isOwner(message.from?.id);
    const submission = { channel: "telegram" as const, conversationId: conversation.id, text, uploads:input.uploads, replyToAssistant, replyTo, telegramSenderId:message.from ? String(message.from.id) : undefined, author, externalId, externalChatId: chatId, title: message.chat.title ?? "Telegram " + chatId, byOwner };
    if (contextOnly) {
      await this.messages.submit({ ...submission, contextOnly:true });
      this.store.markTelegramUpdate(update.update_id); return;
    }
    if (input.transcript) {
      const current = this.store.getTelegramChat(chatId);
      if (!current || current.enabled === false || current.profileId !== binding?.profileId || current.conversationId !== binding?.conversationId) {
        this.store.markTelegramUpdate(update.update_id); return;
      }
    }
    const result: MessageResult = await this.messages.handle(submission);
    const currentBinding = this.store.getTelegramChat(chatId);
    try {
      this.messages.assertDelivery(submission, result.messageId);
      // The chat changed hands during the turn. Record that nothing was sent.
      if (!currentBinding || currentBinding.profileId !== binding?.profileId) this.store.db.prepare("INSERT OR IGNORE INTO telegram_outbox(key,chat_id,payload,status,error) VALUES(?,?,'{}','not_sent',?)")
        .run(`${chatId}:reply:${result.messageId}:0`, chatId, "Подключение этого чата изменилось. Ответ не отправлен в Telegram.");
      else if (Number(chatId) >= 0 || !quietReply(result.text)) await this.sendAnswer(message.chat.id, result.text, result.attachments, `reply:${result.messageId}`, Number(chatId) < 0 ? message.message_id : undefined, () => this.messages.assertDelivery(submission, result.messageId));
    }
    catch { this.lastError="Ответ сохранён в приложении; доставку в Telegram нужно проверить"; }
    } catch (error) {
      if (contextOnly) {
        this.lastError = "Не удалось сохранить часть контекста группы. Отправьте нужное вложение в ответ на сообщение бота.";
        this.store.markTelegramUpdate(update.update_id); return;
      }
      // A file Telegram could not hand over never reached the employee. Keep the request visible
      // and the update done, so a replay cannot turn it into a duplicate.
      const recorded = !received && !agentTransfer(this.store, conversation.profileId ?? "main") && !this.store.findMessageByExternal("telegram", externalId);
      if (recorded) {
        const failed = this.store.addMessage({ conversationId: conversation.id, channel: "telegram", direction: "inbound", text, externalId, author });
        this.store.setMessageStatus(failed.id, "failed", error instanceof TelegramRequestError ? "Не удалось получить файл до 20 МБ" : error instanceof Error ? error.message : "Не удалось скачать вложение");
        this.store.markTelegramUpdate(update.update_id);
      }
      if (Number(chatId) > 0 && this.isOwner(message.from?.id)) {
        // A lost notice leaves a recorded request as it is.
        await this.sendMessage(message.chat.id, error instanceof Error ? error.message : "Не удалось завершить ответ",`error:${update.update_id}`).catch(notice => { if (!recorded) throw notice; });
      } else {
        // Groups and other people never see technical failures. The owner gets
        // one private notice per incident instead; the request stays in Home.
        // MessageService already records and reports execution failures with their precise cause.
        if (!received || !this.store.findMessageByExternal("telegram",externalId)?.error)
          await this.messages.reportProblem(conversation.id, `telegram:${update.update_id}`, errorProblem(error));
      }
    } finally {
      stopTyping();
      if(this.preparations.get(chatId)===prepared) this.preparations.delete(chatId);
      const remaining = (this.activeChats.get(chatId) ?? 1) - 1;
      if (remaining) this.activeChats.set(chatId, remaining); else this.activeChats.delete(chatId);
    }
    this.store.markTelegramUpdate(update.update_id);
  }

  private ownsInteraction(chatId: string, card: Interaction): boolean {
    if (!this.linkedChats().includes(chatId)) return false;
    // Restricted turns never ask for approval. No card, button or reply may cross into a protected audience.
    if (isProtectedTelegramAudience(this.store, chatId)) return false;
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
    const text = [card.title, card.detail, ...card.questions.map(q => q.question), card.requestedBy && Number(chatId) < 0 ? "Подтвердить может тот, кто дал поручение." : null].filter(Boolean).join("\n");
    // Never offer approval for an action whose details were cut off by Telegram.
    const tooLong = text.length > 4000;
    const result = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: tooLong ? `${card.title}\nПолное описание действия доступно в OpenStrudel. Откройте эту переписку в приложении, чтобы проверить и подтвердить его.` : text,
      reply_markup: tooLong ? { inline_keyboard: [] } : rows.length ? { inline_keyboard: rows } : { force_reply: true },
    });
    this.questionMessages.set(chatId + ":" + result.message_id, card.id);
    this.store.db.prepare('INSERT OR REPLACE INTO telegram_interactions VALUES(?,?,?,?)').run(this.token!.split(':')[0]!,chatId,result.message_id,card.id);
    // Approval may have completed in the app while Telegram was still acknowledging the card.
    if (!this.messages.interactions.get(card.id)) await this.cleanupInteractions();
  }

  /** Native requests do not survive a Home restart. Remove only their old controls, never replay an approval. */
  async cleanupInteractions(): Promise<void> {
    if (!this.token) return;
    if (this.cleaningInteractions) return this.cleaningInteractions;
    const botId = this.token.split(':')[0]!;
    this.cleaningInteractions = (async () => {
      const rows = this.store.db.prepare('SELECT chat_id,message_id,interaction_id FROM telegram_interactions WHERE bot_id=?').all(botId)
        .filter(row => !this.messages.interactions?.get(String(row.interaction_id))).slice(0,50);
      for (const row of rows) {
        if (this.token?.split(':')[0] !== botId) return;
        try {
          await this.call('editMessageReplyMarkup',{chat_id:String(row.chat_id),message_id:Number(row.message_id),reply_markup:{inline_keyboard:[]}});
        } catch (error) {
          // Already removed or too old to edit: there is nothing left we can clear.
          if (!(error instanceof TelegramRequestError && error.code === 400 && /message (?:is not modified|to edit not found|can.t be edited)/i.test(error.message))) continue;
        }
        this.store.db.prepare('DELETE FROM telegram_interactions WHERE bot_id=? AND chat_id=? AND message_id=?').run(botId,row.chat_id!,row.message_id!);
        this.questionMessages.delete(String(row.chat_id)+':'+row.message_id);
      }
    })().finally(() => { this.cleaningInteractions = undefined; });
    return this.cleaningInteractions;
  }

  private interactionOrigin(card: Interaction): string | undefined {
    const message = this.store.db.prepare("SELECT external_id FROM messages WHERE id=? AND channel='telegram'").get(card.messageId);
    return message?.external_id ? String(message.external_id).split(":")[0] : undefined;
  }

  private async poll(): Promise<void> {
    const controller = this.controller;
    while (this.running && controller === this.controller) {
      try {
        const updates = await this.call<TelegramUpdate[]>("getUpdates", { offset: this.offset, timeout: 20, allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member"] });
        if (!this.running || controller !== this.controller) return;
        if (this.connectionError) recordDiagnostic(this.store, "telegram.connected");
        this.connectionError = null;
        this.lastCheckedAt = new Date().toISOString();
        void this.cleanupInteractions().catch(() => undefined);
        void this.flushOwnerNotices().catch(() => undefined);
        for (const update of updates) {
          void this.processUpdate(update).catch(() => { this.lastError = "Входящее сообщение не завершено; оно сохранено для восстановления"; });
          this.offset = Math.max(this.offset, update.update_id + 1); this.store.setSetting("telegram.offset",String(this.offset));
        }
      } catch (error) {
        if (!this.running || controller !== this.controller) return;
        const code = error instanceof TelegramRequestError ? error.code : undefined;
        if (!this.connectionError || this.connectionError.code !== code) recordDiagnostic(this.store, "telegram.disconnected", { status: code, reason: "network" });
        this.connectionError = { message: telegramConnectionError(error), code };
        console.error("[telegram] " + this.connectionError.message); await sleep(2_000, controller?.signal).catch(() => undefined);
      }
    }
  }

  private isOwner(sender?: number): boolean {
    return sender !== undefined && sender > 0 && !isRestrictedSubject(this.store, String(sender)) && this.store.getTelegramChat(String(sender))?.allowedSenders.includes(String(sender)) === true;
  }

  private async acceptLink(code: string, update: TelegramUpdate): Promise<void> {
    const message = update.message!;
    const chatId = String(message.chat.id);
    const sender = message.from?.id ?? (Number(chatId) > 0 ? Number(chatId) : undefined);
    if (!sender || message.sender_chat || message.from?.is_bot) return;
    // Owner pairing is never a way for a scoped participant to upgrade themselves.
    if (isRestrictedSubject(this.store, String(sender))) return;
    const row = this.store.db.prepare("SELECT payload FROM telegram_links WHERE hash=?").get(sha256(code));
    const link = row ? JSON.parse(String(row.payload)) as PendingLink : null;
    const fail = async (text: string) => {
      if (link && !link.chatId && this.isOwner(sender)) this.store.db.prepare("UPDATE telegram_links SET payload=? WHERE hash=?").run(JSON.stringify({ ...link, error: text }), sha256(code));
      if (Number(chatId) > 0 || this.isOwner(sender)) await this.sendMessage(String(sender), text, `link:${update.update_id}`);
    };
    // Telegram can deliver the same /start twice; the chat that redeemed this link is already connected.
    if (link?.chatId === chatId) return;
    if (!link || link.chatId || link.expiresAt < new Date().toISOString() || link.tokenHash !== sha256(this.token ?? "")) {
      await fail("Ссылка уже использована или устарела. Откройте новую в OpenStrudel."); return;
    }
    if ((link.kind === "private") !== (Number(chatId) > 0) || message.is_topic_message || message.chat.type === "channel") {
      await fail(link.kind === "group" ? "Выберите обычную группу через кнопку «Добавить в группу» в OpenStrudel. Темы пока не поддерживаются." : "Откройте эту ссылку в личном чате с ботом."); return;
    }
    if (link.kind === "group" && !this.isOwner(sender)) return;
    if (link.profileId && !this.store.getProfile(link.profileId)) { await fail("Этот сотрудник удалён. Выберите другого в OpenStrudel."); return; }
    const previous = this.membershipEvent(chatId);
    if (link.kind === "group" && message.date && (message.date < previous.date || message.date === previous.date && update.update_id < previous.id)) return;
    const existing = this.store.getTelegramChat(chatId);
    if (link.kind === "group" && link.profileId && existing?.profileId && existing.profileId !== link.profileId) {
      await fail(`В группе «${existing.title}» уже отвечает другой сотрудник. Заменить его можно в OpenStrudel → Сотрудник → Telegram → Выбрать подключённую группу.`); return;
    }
    if (this.activeChats.has(chatId)) { await fail("Сотрудник ещё отвечает. Дождитесь ответа и снова откройте ссылку."); return; }
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.linkTelegramChat({ chatId, title: message.chat.title ?? message.from?.first_name ?? "Личный Telegram", allowedSenders: [...new Set([...(existing?.allowedSenders ?? []), String(sender)])] });
      // Reconnecting an established private chat never changes its employee.
      if (link.profileId && (link.kind === "group" || !existing)) this.store.bindTelegramChat(chatId, link.profileId);
      if (link.kind === "group" && !link.profileId && !existing?.profileId) this.store.connectTelegramGroup(chatId);
      if (link.kind === "group" && !existing?.profileId && !existing?.conversationId && !protectScopedTelegramTransport(this.store, chatId)) this.store.db.prepare("UPDATE telegram_chats SET access='members',replies='instructions' WHERE chat_id=?").run(chatId);
      this.store.db.prepare("UPDATE telegram_links SET payload=? WHERE hash=?").run(JSON.stringify({ ...link, chatId, error: undefined }), sha256(code));
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    const connected = this.store.getTelegramChat(chatId);
    const name = connected?.profileId;
    const employee = name ? this.store.getProfile(name)?.name : "Общий помощник";
    await this.sendMessage(chatId, link.kind === "group"
      ? `Здесь отвечает «${employee}». ${connected?.replies === "mentions" ? `Упомяните @${this.status().botUsername} или ответьте на сообщение бота.` : "Прежние правила участия сохранены."} У этой группы своя переписка.`
      : `Telegram подключён. Здесь отвечает «${employee}».`, `link:${update.update_id}`);
  }

  private async discoverGroup(chatId: string, title: string, sender: number, updateId: number): Promise<void> {
    // A group's invitation is not proof of ownership. Only a previously paired
    // private Telegram account may add it to this Home.
    if (!this.isOwner(sender)) return;
    const existing = this.store.getTelegramChat(chatId);
    if (existing) {
      this.store.linkTelegramChat({ chatId, title, allowedSenders: existing.allowedSenders });
      if (!this.store.getSetting("telegram.paused." + chatId)) this.store.connectTelegramGroup(chatId);
      return;
    }
    this.store.linkTelegramChat({ chatId, title, allowedSenders: [String(sender)] });
    // Re-adding the same bot restores the group's established character and
    // participation policy, never another group's or an employee's private chat.
    const removed = this.store.getSetting("telegram.removed." + chatId);
    const previous = removed ? JSON.parse(removed) as TelegramChat : null;
    const conversation = previous?.conversationId ? this.store.getConversation(previous.conversationId) : null;
    if (previous && conversation && conversation.channel === "telegram" && conversation.externalId?.split("::")[0] === chatId && (!previous.profileId || this.store.getProfile(previous.profileId))) {
      const scoped = protectScopedTelegramTransport(this.store, chatId);
      this.store.db.prepare("UPDATE telegram_chats SET conversation_id=?,profile_id=?,allowed_senders_json=?,access=?,replies=? WHERE chat_id=?")
        .run(conversation.id, previous.profileId, JSON.stringify(scoped ? [] : [...new Set([...previous.allowedSenders,String(sender)])]),scoped ? "approved" : previous.access,scoped ? "mentions" : previous.replies,chatId);
    } else this.store.connectTelegramGroup(chatId);
    this.store.deleteSetting("telegram.removed." + chatId);
    // Membership alone starts no model run and sends no unsolicited group post.
    // The next @mention or reply is the first actual request.
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
    const chat = this.store.getTelegramChat(chatId);
    const config = telegramAuthorization(this.store);
    const subject = actual ? config.subjects[String(actual)] : undefined;
    if (subject?.enabled === false || config.chats[chatId]?.enabled === false) return false;
    // Policy is the authority for protected audiences. The legacy transport is
    // deliberately empty for rollback safety; never infer a scoped sender from
    // a private chat id when Telegram did not supply an actual human sender.
    const realSender = sender !== undefined && Number.isSafeInteger(sender) && sender > 0;
    if (config.chats[chatId]) return realSender && Boolean(chat && chat.enabled !== false);
    if (subject && Number(chatId) > 0) return realSender && String(sender) === chatId && subject.enabled && Boolean(chat && chat.enabled !== false);
    if (subject && Number(chatId) < 0 && !config.chats[chatId]) return false;
    return actual !== undefined && actual > 0 && Boolean(chat && (chat.allowedSenders.includes(String(actual)) || Number(chatId) < 0 && chat.access === "members"));
  }
  private replyConversation(chatId:string,messageId:number) {
    const row=this.store.db.prepare("SELECT key FROM telegram_outbox WHERE chat_id=? AND message_id=? AND status='delivered'").get(chatId,String(messageId));
    if(!row) return null;
    const [,kind,id]=String(row.key).split(":");
    const target=kind==="schedule" ? this.store.db.prepare("SELECT conversation_id FROM schedule_runs WHERE id=?").get(id!)
      : kind==="reply" ? this.store.db.prepare("SELECT conversation_id FROM messages WHERE id=?").get(id!) : undefined;
    return target ? this.store.getConversation(String(target.conversation_id)) : null;
  }

  private async call<T = unknown>(method: string, body: Record<string, unknown> | FormData, token = this.token, timeoutMs = 35_000): Promise<T> {
    if (!token) throw new Error("Telegram is not configured");
    for (let attempt=0;;attempt++) {
      const multipart = body instanceof FormData;
      const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, { method: "POST", headers: multipart ? undefined : { "content-type": "application/json" }, body: multipart ? body : JSON.stringify(body), signal: this.controller ? AbortSignal.any([this.controller.signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      const payload = (await response.json()) as TelegramResponse<T>;
      // A 429 explicitly confirms no send happened. Network failures do not,
      // so only retry this documented rejection, never an ambiguous delivery.
      const retryAfter=payload.parameters?.retry_after;
      if (!payload.ok && payload.error_code===429 && Number.isFinite(retryAfter) && retryAfter!>=0 && retryAfter!<=60 && attempt<2 && timeoutMs === 35_000) {
        await sleep(Math.max(1,retryAfter!)*1000,this.controller?.signal); continue;
      }
      if (!response.ok || !payload.ok) throw new TelegramRequestError(payload.description ?? "Telegram " + method + " failed", payload.error_code ?? response.status);
      return payload.result;
    }
  }
}
