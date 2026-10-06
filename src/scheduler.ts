import { CronExpressionParser } from "cron-parser";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { MessageService } from "./messages.js";
import type { Attachment } from "./types.js";
import { agentTransfer } from "./agent-move.js";

export interface ScheduleInput {
  id?: string; conversationId: string; name: string; prompt: string; cron: string; timezone: string;
  enabled?: boolean; telegramChatId?: string | null; delivery?: "app" | "telegram" | "bound"; backupOf?: string | null;
}
export interface Schedule extends ScheduleInput { id: string; enabled: boolean; nextRunAt: string }
type Row = Record<string, any>;

/** The clock only wakes the existing chat. Codex still owns the work. */
export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private readonly active = new Map<string, Promise<void>>();
  get hasActiveRuns() { return this.active.size > 0; }
  deliver?: (chatId: string, text: string, key: string, attachments?: Attachment[]) => Promise<void>;
  constructor(private readonly store: Store, private readonly messages: MessageService) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      name TEXT NOT NULL, prompt TEXT NOT NULL, cron TEXT NOT NULL, timezone TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT NOT NULL, telegram_chat_id TEXT);
      CREATE TABLE IF NOT EXISTS schedule_runs (
      id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES schedules(id), conversation_id TEXT NOT NULL,
      scheduled_for TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
      message_id TEXT, error TEXT, UNIQUE(schedule_id,scheduled_for));`);
    const columns = store.db.prepare("PRAGMA table_info(schedules)").all() as Row[];
    // Existing schedules retain their previously agreed delivery. New ones are app-only.
    if (!columns.some(c => c.name === "delivery")) store.db.exec("ALTER TABLE schedules ADD COLUMN delivery TEXT NOT NULL DEFAULT 'bound'");
    if (!columns.some(c => c.name === "backup_of")) store.db.exec("ALTER TABLE schedules ADD COLUMN backup_of TEXT REFERENCES schedules(id)");
  }
  save(input: ScheduleInput, now = new Date()): Schedule {
    if (!this.store.getConversation(input.conversationId)) throw new Error("Чат не найден");
    if (!input.name?.trim() || !input.prompt?.trim() || input.name.length > 120 || input.prompt.length > 12000) throw new Error("Укажите название и поручение");
    new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(now);
    if (input.cron.trim().split(/\s+/).length !== 5) throw new Error("Cron должен содержать пять полей: минуты, часы, день, месяц, день недели");
    const next = CronExpressionParser.parse(input.cron, { currentDate: now, tz: input.timezone }).next().toISOString()!;
    if (input.telegramChatId && !this.store.getTelegramChat(input.telegramChatId)) throw new Error("Сначала подключите этот Telegram-чат");
    const delivery = input.delivery ?? (input.telegramChatId ? "telegram" : "app");
    if (!["app", "telegram", "bound"].includes(delivery)) throw new Error("Выберите место доставки");
    if (delivery === "telegram" && !input.telegramChatId) throw new Error("Выберите подключённый Telegram-чат");
    if (input.id && !this.list(input.conversationId).some(s => s.id === input.id)) throw new Error("Расписание этого чата не найдено");
    if (input.backupOf && (input.backupOf === input.id || !this.list(input.conversationId).some(s => s.id === input.backupOf && !s.backupOf))) throw new Error("Основное расписание этого чата не найдено");
    const id = input.id ?? randomUUID();
    this.store.db.prepare(`INSERT INTO schedules(id,conversation_id,name,prompt,cron,timezone,enabled,next_run_at,telegram_chat_id,delivery,backup_of) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,prompt=excluded.prompt,cron=excluded.cron,timezone=excluded.timezone,
      enabled=excluded.enabled,next_run_at=excluded.next_run_at,telegram_chat_id=excluded.telegram_chat_id,delivery=excluded.delivery,backup_of=excluded.backup_of`)
      .run(id,input.conversationId,input.name.trim(),input.prompt.trim(),input.cron,input.timezone,input.enabled === false ? 0 : 1,next,input.telegramChatId ?? null,delivery,input.backupOf ?? null);
    return this.list(input.conversationId).find(s => s.id === id)!;
  }
  list(conversationId: string): Schedule[] {
    return (this.store.db.prepare("SELECT * FROM schedules WHERE conversation_id=? ORDER BY rowid").all(conversationId) as Row[]).map(r => ({ id:r.id,conversationId:r.conversation_id,name:r.name,prompt:r.prompt,cron:r.cron,timezone:r.timezone,enabled:r.enabled===1,nextRunAt:r.next_run_at,telegramChatId:r.telegram_chat_id,delivery:r.delivery,backupOf:r.backup_of }));
  }
  runs(conversationId: string) {
    return (this.store.db.prepare("SELECT * FROM schedule_runs WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 30").all(conversationId) as Row[]).map(r => ({ id:r.id,scheduleId:r.schedule_id,status:r.status,scheduledFor:r.scheduled_for,messageId:r.message_id,error:r.error }));
  }
  remove(id: string, conversationId: string): void {
    // Keep receipts, including ambiguous deliveries, after the user removes a schedule.
    const result = this.store.db.prepare("UPDATE schedules SET enabled=0 WHERE id=? AND conversation_id=?").run(id,conversationId);
    if (!Number(result.changes)) throw new Error("Расписание этого чата не найдено");
  }
  recover(): void {
    for (const r of this.store.db.prepare("SELECT * FROM schedule_runs WHERE status='running'").all() as Row[]) {
      const inbound = this.store.findMessageByExternal("api", `schedule:${r.id}`);
      const reply = inbound && this.store.findReplyTo(inbound.id);
      this.store.db.prepare("UPDATE schedule_runs SET status=?,message_id=?,error=? WHERE id=?")
        .run(reply ? "ready" : "uncertain",reply?.id ?? null,reply ? null : "Выполнение прервано. Проверьте результат в чате перед повтором.",r.id);
    }
  }
  start(): void {
    this.recover();
    const poll=()=>{ void this.tick().catch(error=>console.error("[schedule]",error instanceof Error ? error.message : "clock failed")); };
    poll(); this.timer = setInterval(poll,15_000); this.timer.unref();
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; }
  async idle(): Promise<void> { await Promise.allSettled(this.active.values()); }
  async tick(now = new Date()): Promise<void> {
    const due = this.store.db.prepare("SELECT * FROM schedules WHERE enabled=1 AND next_run_at<=?").all(now.toISOString()) as Row[];
    for (const row of due) {
      if (agentTransfer(this.store, this.store.getConversation(row.conversation_id)?.profileId ?? "main")) continue;
      if (this.active.has(row.id)) continue;
      const schedule = this.list(row.conversation_id).find(s => s.id === row.id)!;
      // After sleep, produce only the latest due edition, never a burst of old digests.
      const scheduledFor = CronExpressionParser.parse(schedule.cron, { currentDate: new Date(now.getTime()+1), tz: schedule.timezone }).prev().toISOString()!;
      const next = CronExpressionParser.parse(schedule.cron, { currentDate: now, tz: schedule.timezone }).next().toISOString()!;
      const runId = randomUUID();
      this.store.db.exec("BEGIN IMMEDIATE");
      let claimed = false;
      try {
        claimed = Number(this.store.db.prepare("INSERT OR IGNORE INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at) VALUES(?,?,?,?,'running',?)").run(runId,schedule.id,schedule.conversationId,scheduledFor,now.toISOString()).changes) > 0;
        this.store.db.prepare("UPDATE schedules SET next_run_at=? WHERE id=?").run(next,schedule.id);
        this.store.db.exec("COMMIT");
      } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
      if (claimed) this.track(schedule.id, this.execute(schedule,runId,scheduledFor));
    }
    for (const row of this.store.db.prepare("SELECT r.*,s.telegram_chat_id,s.delivery FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id WHERE r.status='ready'").all() as Row[]) {
      if (agentTransfer(this.store, this.store.getConversation(row.conversation_id)?.profileId ?? "main")) continue;
      if (!this.active.has(row.schedule_id)) this.track(row.schedule_id,this.finish(row.id,row.conversation_id,row.message_id,row.telegram_chat_id,row.delivery));
    }
  }
  private track(id: string, run: Promise<void>): void { this.active.set(id,run); void run.finally(() => this.active.delete(id)).catch(() => undefined); }
  private async execute(schedule: Schedule, runId: string, scheduledFor: string): Promise<void> {
    try {
      if (schedule.backupOf) {
        await this.active.get(schedule.backupOf);
        const primary = this.list(schedule.conversationId).find(s => s.id === schedule.backupOf)!;
        const sameDay = new Intl.DateTimeFormat("en-CA", {timeZone:primary.timezone,year:"numeric",month:"2-digit",day:"2-digit"});
        const day = sameDay.format(new Date(scheduledFor));
        const receipts = this.store.db.prepare("SELECT scheduled_for,status FROM schedule_runs WHERE schedule_id=?").all(primary.id) as Row[];
        if (receipts.some(r => sameDay.format(new Date(r.scheduled_for)) === day && ["running","ready","completed","quiet","uncertain"].includes(r.status))) {
          this.store.db.prepare("UPDATE schedule_runs SET status='skipped' WHERE id=?").run(runId); return;
        }
      }
      const result = await this.messages.handle({ channel:"api",conversationId:schedule.conversationId,externalId:`schedule:${runId}`,scheduled:true,
        text:`Scheduled request: ${schedule.name}\nScheduled for: ${scheduledFor} (${schedule.timezone}). Current time: ${new Date().toISOString()}.\n${schedule.prompt}\nReturn the completed edition here; the application handles delivery. Do not send it elsewhere or create another schedule. If verification fails, state what is unavailable; never invent news or sources.` });
      this.store.db.prepare("UPDATE schedule_runs SET status='ready',message_id=? WHERE id=?").run(result.messageId,runId);
      await this.finish(runId,schedule.conversationId,result.messageId,schedule.telegramChatId,schedule.delivery);
    } catch (error) { this.fail(runId,error); }
  }
  private async finish(runId: string, conversationId: string, messageId: string, chatId?: string | null, delivery = "app"): Promise<void> {
    let deliveryAttempted = false;
    try {
      const reply = this.store.db.prepare("SELECT text,attachments_json FROM messages WHERE id=? AND conversation_id=?").get(messageId,conversationId) as Row | undefined;
      if (!reply) throw new Error("Ответ не найден");
      if (reply.text.trim() === "NO_REPLY") {
        this.store.db.prepare("UPDATE schedule_runs SET status='quiet',error=NULL WHERE id=?").run(runId); return;
      }
      const destination = delivery === "app" ? null : chatId ?? (delivery === "bound" ? this.store.telegramChats().find(c => c.conversationId === conversationId)?.chatId : null);
      if (destination) {
        if (!this.deliver) throw new Error("Доставка Telegram недоступна");
        const profileId=this.store.getConversation(conversationId)?.profileId;
        const name=profileId ? this.store.getProfile(profileId)?.name : null;
        deliveryAttempted = true;
        await this.deliver(destination,name ? `**${name.replace(/[*_`]/g,"")}**\n\n${reply.text}` : reply.text,`schedule:${runId}`,JSON.parse(reply.attachments_json ?? "[]") as Attachment[]);
      }
      this.store.db.prepare("UPDATE schedule_runs SET status='completed',error=NULL WHERE id=?").run(runId);
    } catch (error) {
      if (deliveryAttempted) this.store.db.prepare("UPDATE schedule_runs SET status='uncertain',error=? WHERE id=?").run("Ответ сохранён. Подтверждение Telegram не получено; проверьте чат перед повтором.",runId);
      else this.fail(runId,error);
    }
  }
  private fail(id: string, error: unknown): void {
    this.store.db.prepare("UPDATE schedule_runs SET status='failed',error=? WHERE id=?").run(error instanceof Error ? error.message : String(error),id);
  }
}
