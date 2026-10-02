import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Attachment, Channel, Conversation, EmployeeProfile, Message, TelegramChat, HistoryEntry } from "./types.js";
import { id, jsonArray, nowIso } from "./util.js";

type Row = Record<string, unknown>;

/**
 * OpenStrudel owns only the small amount of product state needed to join
 * channels to Codex threads. Codex owns the model history and tool state.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(filename = process.env.OPENSTRUDEL_DB ?? resolve(".data", "openstrudel.sqlite")) {
    const path = filename === ":memory:" ? filename : resolve(filename);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    // These tables belonged to the removed task/source/device product. Drop
    // them during upgrade so an old local Home does not keep dead state alive.
    this.db.exec("DROP TABLE IF EXISTS messages_fts; DROP TABLE IF EXISTS task_events; DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS receipts; DROP TABLE IF EXISTS devices;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        external_id TEXT,
        title TEXT,
        codex_thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel, external_id)
      );
      CREATE TABLE IF NOT EXISTS employee_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        instructions TEXT NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        model TEXT,
        token_limit INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS telegram_updates (
        update_id INTEGER PRIMARY KEY,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // Profiles from the short-lived local-model experiment stay usable on
    // the single Codex engine; their obsolete provider override is cleared.
    this.db.exec("UPDATE employee_profiles SET model = NULL WHERE model LIKE 'local:%'");
    const profileColumns = new Set((this.db.prepare("PRAGMA table_info(employee_profiles)").all() as Row[]).map(c => String(c.name)));
    if (!profileColumns.has("domain")) this.db.exec("ALTER TABLE employee_profiles ADD COLUMN domain TEXT NOT NULL DEFAULT 'personal'");
    if (!profileColumns.has("purpose")) this.db.exec("ALTER TABLE employee_profiles ADD COLUMN purpose TEXT NOT NULL DEFAULT ''");

    const oldMessages = this.db.prepare("PRAGMA table_info(messages)").all() as Row[];
    const oldNames = new Set(oldMessages.map((column) => String(column.name)));
    const needsMessageMigration = oldNames.has("task_id");
    if (needsMessageMigration) {
      this.db.exec("ALTER TABLE messages RENAME TO messages_legacy");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        reply_to_id TEXT,
        text TEXT NOT NULL,
        external_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(channel, external_id)
      );
      CREATE INDEX IF NOT EXISTS messages_reply_idx ON messages(reply_to_id, direction);
    `);
    if (needsMessageMigration) {
      const replyExpression = oldNames.has("reply_to_id") ? "reply_to_id" : "NULL";
      this.db.exec(`
        INSERT OR IGNORE INTO messages (id, conversation_id, channel, direction, reply_to_id, text, external_id, created_at)
        SELECT id, conversation_id, channel, direction, ${replyExpression}, text, external_id, created_at FROM messages_legacy;
        DROP TABLE messages_legacy;
      `);
    }
    const columns = new Set((this.db.prepare("PRAGMA table_info(messages)").all() as Row[]).map(r => String(r.name)));
    if (!columns.has("status")) this.db.exec("ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'");
    if (!columns.has("error")) this.db.exec("ALTER TABLE messages ADD COLUMN error TEXT");
    if (!columns.has("kind")) this.db.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'");
    if (!columns.has("author")) this.db.exec("ALTER TABLE messages ADD COLUMN author TEXT");
    if (!columns.has("imported")) this.db.exec("ALTER TABLE messages ADD COLUMN imported INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("attachments_json")) this.db.exec("ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has("hidden")) this.db.exec("ALTER TABLE messages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
    const conversationColumns = new Set((this.db.prepare("PRAGMA table_info(conversations)").all() as Row[]).map(r => String(r.name)));
    if (!conversationColumns.has("profile_id")) this.db.exec("ALTER TABLE conversations ADD COLUMN profile_id TEXT REFERENCES employee_profiles(id)");
    this.db.exec(`CREATE TABLE IF NOT EXISTS telegram_chats (
      chat_id TEXT PRIMARY KEY, title TEXT NOT NULL, conversation_id TEXT REFERENCES conversations(id),
      profile_id TEXT REFERENCES employee_profiles(id), allowed_senders_json TEXT NOT NULL
    ); CREATE UNIQUE INDEX IF NOT EXISTS telegram_conversation_unique ON telegram_chats(conversation_id) WHERE conversation_id IS NOT NULL;`);
    for (const row of this.db.prepare("SELECT id, external_id FROM conversations WHERE external_id LIKE '%::employee::%' AND profile_id IS NULL").all() as Row[]) {
      const profile = String(row.external_id).split("::employee::")[1];
      if (profile && this.getProfile(profile)) this.db.prepare("UPDATE conversations SET profile_id=? WHERE id=?").run(profile, String(row.id));
    }
    // Existing private links retain their owner. Legacy groups remain closed
    // until their allowed participants are explicitly provided.
    for (const chatId of jsonArray(this.getSetting("telegram.linked_chats"))) {
      if (!this.getTelegramChat(chatId)) this.linkTelegramChat({ chatId, title: chatId.startsWith("-") ? "Telegram-группа" : "Личный чат", allowedSenders: chatId.startsWith("-") ? [] : [chatId] });
    }
    this.migrateLegacyMainConversation();
  }


  private migrateLegacyMainConversation(): void {
    const main = this.db.prepare("SELECT id, codex_thread_id FROM conversations WHERE channel = 'api' AND external_id = 'home'").get() as Row | undefined;
    const legacy = this.db.prepare("SELECT id, codex_thread_id FROM conversations WHERE channel = 'api' AND external_id = 'native-home'").get() as Row | undefined;
    if (!legacy) return;
    if (!main) {
      this.db.prepare("UPDATE conversations SET external_id = 'home', title = COALESCE(title, 'Главный чат') WHERE id = ?").run(String(legacy.id));
      return;
    }
    if (String(main.id) === String(legacy.id)) return;
    this.db.prepare("UPDATE messages SET conversation_id = ? WHERE conversation_id = ?").run(String(main.id), String(legacy.id));
    if (main.codex_thread_id == null && legacy.codex_thread_id != null) {
      this.db.prepare("UPDATE conversations SET codex_thread_id = ? WHERE id = ?").run(String(legacy.codex_thread_id), String(main.id));
    }
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(String(legacy.id));
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(key, value, nowIso());
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  getOrCreateConversation(input: { channel: Channel; externalId?: string; title?: string }): Conversation {
    if (input.externalId) {
      const existing = this.db.prepare("SELECT * FROM conversations WHERE channel = ? AND external_id = ?").get(input.channel, input.externalId) as Row | undefined;
      if (existing) return this.mapConversation(existing);
    }
    const createdAt = nowIso();
    const conversation: Conversation = {
      id: id(),
      channel: input.channel,
      externalId: input.externalId ?? null,
      title: input.title ?? null,
      codexThreadId: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.db.prepare(
      "INSERT INTO conversations (id, channel, external_id, title, codex_thread_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(conversation.id, conversation.channel, conversation.externalId, conversation.title, null, conversation.createdAt, conversation.updatedAt);
    return conversation;
  }

  getConversation(conversationId: string): Conversation | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as Row | undefined;
    return row ? this.mapConversation(row) : null;
  }

  primaryConversation(): Conversation {
    return this.getOrCreateConversation({ channel: "api", externalId: "home", title: "Главный чат" });
  }

  profileConversation(profileId: string): Conversation {
    const profile = this.getProfile(profileId);
    if (!profile) throw new Error("Сотрудник не найден");
    const c = this.getOrCreateConversation({ channel: "api", externalId: `home::employee::${profile.id}`, title: profile.name });
    this.db.prepare("UPDATE conversations SET profile_id=? WHERE id=?").run(profile.id, c.id);
    return { ...c, profileId: profile.id };
  }

  getTelegramChat(chatId: string): TelegramChat | null {
    const row = this.db.prepare("SELECT * FROM telegram_chats WHERE chat_id=?").get(chatId) as Row | undefined;
    return row ? { chatId: String(row.chat_id), title: String(row.title), conversationId: row.conversation_id == null ? null : String(row.conversation_id), profileId: row.profile_id == null ? null : String(row.profile_id), allowedSenders: jsonArray(row.allowed_senders_json as string) } : null;
  }

  telegramChats(): TelegramChat[] {
    return (this.db.prepare("SELECT chat_id FROM telegram_chats ORDER BY rowid").all() as Row[]).map(r => this.getTelegramChat(String(r.chat_id))!);
  }

  linkTelegramChat(input: { chatId: string; title: string; allowedSenders: string[] }): TelegramChat {
    if (!/^-?\d+$/.test(input.chatId) || input.allowedSenders.some(s => !/^\d+$/.test(s))) throw new Error("Некорректный Telegram-чат или участник");
    this.db.prepare("INSERT INTO telegram_chats(chat_id,title,allowed_senders_json) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title, allowed_senders_json=excluded.allowed_senders_json")
      .run(input.chatId, input.title, JSON.stringify([...new Set(input.allowedSenders)]));
    return this.getTelegramChat(input.chatId)!;
  }

  bindTelegramChat(chatId: string, profileId: string | null): TelegramChat {
    const chat = this.getTelegramChat(chatId);
    if (!chat) throw new Error("Сначала подключите этот Telegram-чат");
    if (chat.profileId === profileId && chat.conversationId && (Number(chatId) > 0 || this.getConversation(chat.conversationId)?.externalId === `${chatId}::employee::${profileId}`)) return chat;
    if (!profileId) {
      this.db.prepare("UPDATE telegram_chats SET conversation_id=NULL, profile_id=NULL WHERE chat_id=?").run(chatId);
      return this.getTelegramChat(chatId)!;
    }
    const primary = this.profileConversation(profileId);
    const used = this.telegramChats().some(c => c.chatId !== chatId && c.conversationId === primary.id);
    const conversation = Number(chatId) < 0 || used ? this.getOrCreateConversation({ channel: "telegram", externalId: `${chatId}::employee::${profileId}`, title: chat.title }) : primary;
    this.db.prepare("UPDATE conversations SET profile_id=? WHERE id=?").run(profileId, conversation.id);
    this.db.prepare("UPDATE telegram_chats SET conversation_id=?, profile_id=? WHERE chat_id=?").run(conversation.id, profileId, chatId);
    return this.getTelegramChat(chatId)!;
  }

  /** Telegram upgrades ordinary groups when admin rights are configured. */
  migrateTelegramGroup(oldId: string, newId: string): void {
    if (!/^-[1-9]\d*$/.test(oldId) || !/^-[1-9]\d*$/.test(newId) || oldId === newId || !this.getTelegramChat(oldId)) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Membership discovery can create the destination before this service event.
      // Keep the established binding, participants, threads and file workspace.
      this.db.prepare("DELETE FROM telegram_chats WHERE chat_id=?").run(newId);
      this.db.prepare("UPDATE telegram_chats SET chat_id=? WHERE chat_id=?").run(newId, oldId);
      const conversations = this.db.prepare("SELECT id,external_id FROM conversations WHERE channel='telegram' AND (external_id=? OR external_id LIKE ?)").all(oldId, oldId + "::employee::%") as Row[];
      for (const row of conversations) {
        const externalId = newId + String(row.external_id).slice(oldId.length);
        // Preserve any already-created destination history rather than delete it.
        this.db.prepare("UPDATE conversations SET external_id=NULL WHERE channel='telegram' AND external_id=? AND id!=?").run(externalId, String(row.id));
        this.db.prepare("UPDATE conversations SET external_id=? WHERE id=?").run(externalId, String(row.id));
      }
      this.setSetting("telegram.group_origin." + newId, this.getSetting("telegram.group_origin." + oldId) ?? oldId);
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schedules'").get()) {
        this.db.prepare("UPDATE schedules SET telegram_chat_id=? WHERE telegram_chat_id=?").run(newId, oldId);
      }
      const legacy = jsonArray(this.getSetting("telegram.linked_chats"));
      if (legacy.includes(oldId)) this.setSetting("telegram.linked_chats", JSON.stringify([...new Set(legacy.map(id => id === oldId ? newId : id))]));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  importHistory(conversationId: string, entries: HistoryEntry[]): number {
    if (!this.getConversation(conversationId)) throw new Error("Чат не найден");
    const normalized = entries.map(e => {
      if (!e.sourceId || !e.author || typeof e.text !== "string" || !["inbound", "outbound"].includes(e.direction) || !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(e.date) || !Number.isFinite(Date.parse(e.date))) throw new Error("Проверьте историю: нужны дата, автор, текст и идентификатор источника");
      return { ...e, date: new Date(e.date).toISOString() };
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let count = 0;
      const insert = this.db.prepare("INSERT OR IGNORE INTO messages(id,conversation_id,channel,direction,text,external_id,created_at,author,imported) VALUES(?,?,'api',?,?,?,?,?,1)");
      for (const e of normalized) count += Number(insert.run(id(), conversationId, e.direction, e.text, `history:${conversationId}:${e.sourceId}`, e.date, e.author).changes);
      this.db.exec("COMMIT"); return count;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  importedMessages(conversationId: string): Message[] {
    return (this.db.prepare("SELECT * FROM messages WHERE conversation_id=? AND imported=1 ORDER BY created_at,rowid").all(conversationId) as Row[]).map(r => this.mapMessage(r));
  }

  listConversations(): Conversation[] {
    return (this.db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 100").all() as Row[]).map((row) => this.mapConversation(row));
  }

  setConversationThread(conversationId: string, threadId: string): void {
    this.db.prepare("UPDATE conversations SET codex_thread_id = ?, updated_at = ? WHERE id = ?").run(threadId, nowIso(), conversationId);
  }

  clearConversationThread(conversationId: string): void {
    this.db.prepare("UPDATE conversations SET codex_thread_id = NULL, updated_at = ? WHERE id = ?").run(nowIso(), conversationId);
  }

  clearConversationThreads(): void {
    this.db.prepare("UPDATE conversations SET codex_thread_id = NULL, updated_at = ?").run(nowIso());
  }

  addMessage(input: {
    conversationId: string;
    channel: Channel;
    direction: "inbound" | "outbound";
    replyToId?: string;
    text: string;
    externalId?: string;
    kind?: "text" | "notice";
    author?: string;
    attachments?: Attachment[];
  }): Message {
    if (input.externalId) {
      const duplicate = this.db.prepare("SELECT * FROM messages WHERE channel = ? AND external_id = ?").get(input.channel, input.externalId) as Row | undefined;
      if (duplicate) return this.mapMessage(duplicate);
    }
    const message: Message = {
      id: id(),
      conversationId: input.conversationId,
      channel: input.channel,
      direction: input.direction,
      replyToId: input.replyToId ?? null,
      text: input.text,
      externalId: input.externalId ?? null,
      createdAt: nowIso(),
    };
    this.db.prepare(
      "INSERT INTO messages (id, conversation_id, channel, direction, reply_to_id, text, external_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(message.id, message.conversationId, message.channel, message.direction, message.replyToId, message.text, message.externalId, message.createdAt);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(message.createdAt, message.conversationId);
    if (input.kind) this.db.prepare("UPDATE messages SET kind = ? WHERE id = ?").run(input.kind, message.id);
    if (input.author) this.db.prepare("UPDATE messages SET author = ? WHERE id = ?").run(input.author, message.id);
    if (input.attachments?.length) this.db.prepare("UPDATE messages SET attachments_json=? WHERE id=?").run(JSON.stringify(input.attachments),message.id);
    return { ...message, kind: input.kind ?? "text", status: "completed", attachments: input.attachments ?? [] };
  }

  setMessageStatus(messageId: string, status: NonNullable<Message["status"]>, error?: string): void {
    this.db.prepare("UPDATE messages SET status = ?, error = ? WHERE id = ?").run(status, error ?? null, messageId);
  }

  interruptUnfinishedMessages(): void {
    this.db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE status IN ('queued','running')")
      .run("OpenStrudel перезапустился. Проверьте результат перед повторной отправкой.");
  }

  findMessageByExternal(channel: Channel, externalId: string): Message | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE channel = ? AND external_id = ?").get(channel, externalId) as Row | undefined;
    return row ? this.mapMessage(row) : null;
  }

  findReplyTo(messageId: string): Message | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE reply_to_id = ? AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1").get(messageId) as Row | undefined;
    return row ? this.mapMessage(row) : null;
  }

  listMessages(conversationId: string, limit = 50): Message[] {
    const rows = this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND hidden=0 ORDER BY created_at DESC, rowid DESC LIMIT ?").all(conversationId, limit) as Row[];
    return rows.reverse().map((row) => this.mapMessage(row));
  }

  createProfile(input: { name?: string; instructions?: string; capabilities?: string[]; model?: string; tokenLimit?: number; domain?: EmployeeProfile["domain"]; purpose?: string }): EmployeeProfile {
    let name = input.name?.trim() || "Новый бот";
    if (!input.name?.trim()) { let n = 2; while (this.getProfile(name)) name = `Новый бот ${n++}`; }
    if (name.length > 80 || (input.instructions?.length ?? 0) > 12000) throw new Error("Слишком длинное имя или характер");
    if (this.getProfile(name)) throw new Error("Сотрудник с таким именем уже есть");
    if (input.domain && !["personal", "work"].includes(input.domain)) throw new Error("Выберите личного или рабочего сотрудника");
    if ((input.purpose?.length ?? 0) > 240) throw new Error("Опишите роль короче");
    const profile: EmployeeProfile = {
      id: id(),
      name,
      instructions: input.instructions?.trim() ?? "",
      capabilities: input.capabilities ?? [],
      model: input.model ?? null,
      tokenLimit: input.tokenLimit ?? null,
      createdAt: nowIso(),
      domain: input.domain ?? "personal",
      purpose: input.purpose?.trim() ?? "",
    };
    this.db.prepare("INSERT INTO employee_profiles (id, name, instructions, capabilities_json, model, token_limit, created_at, domain, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      profile.id,
      profile.name,
      profile.instructions,
      JSON.stringify(profile.capabilities),
      profile.model,
      profile.tokenLimit,
      profile.createdAt,
      profile.domain!,
      profile.purpose!,
    );
    return profile;
  }

  listProfiles(): EmployeeProfile[] {
    const rows = this.db.prepare(`SELECT p.*, (
      SELECT substr(m.text,1,240) FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE c.profile_id=p.id AND m.direction='outbound' AND m.kind='text' AND m.hidden=0
      ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1
    ) AS preview FROM employee_profiles p ORDER BY p.name ASC`).all() as Row[];
    return rows.map((row) => this.mapProfile(row));
  }

  getProfile(profileIdOrName: string): EmployeeProfile | null {
    const row = this.db.prepare("SELECT * FROM employee_profiles WHERE id = ? OR name = ?").get(profileIdOrName, profileIdOrName) as Row | undefined;
    return row ? this.mapProfile(row) : null;
  }

  updateProfile(profileId: string, input: { name: string; instructions: string; purpose?: string }): EmployeeProfile {
    const name = input.name.trim();
    const instructions = input.instructions.trim();
    if (!name || name.length > 80 || instructions.length > 12000) throw new Error("Проверьте имя и длину характера");
    if (input.purpose !== undefined && input.purpose.length > 240) throw new Error("Опишите роль короче");
    const named = this.getProfile(name);
    if (named && named.id !== profileId) throw new Error("Сотрудник с таким именем уже есть");
    this.db.prepare("UPDATE employee_profiles SET name = ?, instructions = ? WHERE id = ?").run(name, instructions, profileId);
    if (input.purpose !== undefined) {
      this.db.prepare("UPDATE employee_profiles SET purpose=? WHERE id=?").run(input.purpose.trim(),profileId);
    }
    const profile = this.getProfile(profileId);
    if (!profile) throw new Error(`employee not found: ${profileId}`);
    return profile;
  }

  wasTelegramUpdateProcessed(updateId: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM telegram_updates WHERE update_id = ?").get(updateId));
  }

  markTelegramUpdate(updateId: number): void {
    this.db.prepare("INSERT OR IGNORE INTO telegram_updates (update_id, received_at) VALUES (?, ?)").run(updateId, nowIso());
  }

  private mapConversation(row: Row): Conversation {
    return {
      id: String(row.id),
      channel: String(row.channel) as Channel,
      externalId: row.external_id == null ? null : String(row.external_id),
      title: row.title == null ? null : String(row.title),
      codexThreadId: row.codex_thread_id == null ? null : String(row.codex_thread_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      profileId: row.profile_id == null ? null : String(row.profile_id),
    };
  }

  private mapMessage(row: Row): Message {
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      channel: String(row.channel) as Channel,
      direction: String(row.direction) as Message["direction"],
      replyToId: row.reply_to_id == null ? null : String(row.reply_to_id),
      text: String(row.text),
      status: String(row.status ?? "completed") as Message["status"],
      error: row.error == null ? null : String(row.error),
      kind: String(row.kind ?? "text") as Message["kind"],
      author: row.author == null ? null : String(row.author),
      imported: row.imported === 1,
      attachments: JSON.parse(String(row.attachments_json ?? "[]")) as Attachment[],
      externalId: row.external_id == null ? null : String(row.external_id),
      createdAt: String(row.created_at),
    };
  }

  private mapProfile(row: Row): EmployeeProfile {
    return {
      id: String(row.id),
      name: String(row.name),
      instructions: String(row.instructions),
      capabilities: jsonArray(row.capabilities_json as string | null),
      model: row.model == null ? null : String(row.model),
      tokenLimit: row.token_limit == null ? null : Number(row.token_limit),
      createdAt: String(row.created_at),
      preview: row.preview == null ? null : String(row.preview),
      domain: row.domain === "work" ? "work" : "personal",
      purpose: String(row.purpose ?? ""),
    };
  }
}
