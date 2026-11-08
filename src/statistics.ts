import { quiet, trimmed } from "./activity.js";
import { HomeError } from "./home.js";
import { providerInfo, providerInfos, subscriptionModels } from "./providers.js";
import type { Store } from "./store.js";
import { ownerTimezone } from "./timezone.js";
import { TICKS_PER_USD } from "./usage.js";
import type { Schedule, Scheduler } from "./scheduler.js";

/** Where a request came from: the app, a Telegram chat, a schedule, or an event a connected source delivered
 * (correspondence, the owner's pipelines). The app names its requests with a UUID; automatic ones carry a `word:` prefix. */
export type RequestSource = "app" | "telegram" | "schedule" | "events";
type Tokens = { input: number; cached: number; output: number; reasoning: number };
export interface Spend { requests: number; tokens: number; costUsd: number | null }

export interface StatisticsPeriod {
  /** The local date the day or the week (from Monday) starts on. */
  start: string;
  requests: number;
  sources: Record<RequestSource, number>;
  /** Answered, a quiet check with nothing new (NO_REPLY), failed. A request still running has no outcome yet. */
  outcomes: { answered: number; quiet: number; failed: number };
  /** Requests whose engine reported what they spent. */
  measured: number;
  tokens: Tokens;
  /** At the providers' API prices; null when no measured request has a published price. */
  costUsd: number | null;
  /** Measured requests without a published price, so `costUsd` leaves them out. */
  unpriced: number;
  chats: Array<{ id: string } & Spend & { failed: number }>;
  models: Array<{ provider: string | null; model: string | null; name: string } & Spend>;
  schedules: Array<{ id: string; runs: number; quiet: number; failed: number; tokens: number; costUsd: number | null }>;
  /** The current, unfinished period only: the previous one up to the same moment, for a fair comparison. */
  previousToDate?: Spend;
}

export interface Statistics {
  checkedAt: string;
  timeZone: string;
  /** The first local date with a request on this Home; earlier periods are empty because nothing ran, not because nothing was kept. */
  firstDay: string | null;
  /** The first local date with reported usage: tokens and cost exist from here on. */
  usageSince: string | null;
  /** Thirty days and twelve weeks, oldest first; the last one is unfinished. */
  days: StatisticsPeriod[];
  weeks: StatisticsPeriod[];
  chats: Record<string, { title: string; employee: string | null; kind: "main" | "employee" | "telegram" | "group" | "chat" }>;
  schedules: Record<string, { name: string; chatId: string; enabled: boolean }>;
}

type Row = Record<string, any>;
const DAYS = 30, WEEKS = 12, day = 86_400_000;
/** The same quiet and failed answers the scheduler and Insights recognize. */
const quietReply = quiet("m"), failedReply = `substr(${trimmed("m")},1,7)='FAILED:'`;

const shiftDate = (date: string, days: number) => new Date(Date.parse(date + "T00:00:00Z") + days * day).toISOString().slice(0, 10);
const monday = (date: string) => shiftDate(date, -((new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7));
const usd = (ticks: number) => Math.round(ticks / TICKS_PER_USD * 10_000) / 10_000;

/** Local dates in the owner's zone, cached per quarter hour since zones differ from UTC by quarter hours at most. */
function localCalendar(timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const cache = new Map<number, string>();
  const date = (instant: number) => {
    const slot = Math.floor(instant / 900_000);
    let value = cache.get(slot);
    if (!value) {
      const parts = formatter.formatToParts(slot * 900_000);
      value = ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
      cache.set(slot, value);
    }
    return value;
  };
  /** The first instant of a local date, daylight saving changes at midnight included. */
  const start = (target: string) => {
    let low = Date.parse(target + "T00:00:00Z") - 36 * 3_600_000, high = low + 72 * 3_600_000;
    while (low < high) { const middle = Math.floor((low + high) / 2); if (date(middle) < target) low = middle + 1; else high = middle; }
    return low;
  };
  return { date, start };
}

class Bucket {
  requests = 0; measured = 0; costTicks = 0; priced = 0; unpriced = 0;
  sources: Record<RequestSource, number> = { app: 0, telegram: 0, schedule: 0, events: 0 };
  outcomes = { answered: 0, quiet: 0, failed: 0 };
  tokens: Tokens = { input: 0, cached: 0, output: 0, reasoning: 0 };
  chats = new Map<string, { requests: number; failed: number; tokens: number; costTicks: number; priced: number }>();
  models = new Map<string, { provider: string | null; model: string | null; requests: number; tokens: number; costTicks: number; priced: number }>();
  schedules = new Map<string, { runs: number; quiet: number; failed: number; tokens: number; costTicks: number; priced: number }>();
}

export function modelName(store: Store, provider: string | null, model: string | null): string {
  if (!model) return provider === "grok" ? "Grok" : "Автоматически";
  // The Grok subscription and the xAI key share model ids, so a static name from any provider fits.
  const known = providerInfo(provider ?? "")?.models.find(m => m.id === model)?.name
    ?? (provider === "grok" ? subscriptionModels(store, "grok").find(m => m.id === model)?.name : undefined)
    ?? providerInfos().flatMap(p => p.models).find(m => m.id === model)?.name;
  if (known) return known;
  // ChatGPT's catalog names its models like this: gpt-6-astra is GPT-6-Astra.
  return /^gpt-/i.test(model) ? "GPT-" + model.slice(4).split("-").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join("-") : model;
}

type ChatInfo = Statistics["chats"][string];
/** How the app names a chat: the main chat, an employee's own, a Telegram group or a private Telegram chat. */
function chatInfo(store: Store, ids: Iterable<string>): Record<string, ChatInfo> {
  const chats: Record<string, ChatInfo> = {};
  const query = store.db.prepare(`SELECT c.id,c.channel,c.external_id,c.title,p.name AS employee FROM conversations c LEFT JOIN employee_profiles p ON p.id=c.profile_id WHERE c.id=?`);
  // A private Telegram chat is titled by its id until it has a name; the person's own messages carry theirs.
  const author = store.db.prepare(`SELECT author FROM messages WHERE conversation_id=? AND direction='inbound' AND author IS NOT NULL AND trim(author)<>'' ORDER BY rowid DESC LIMIT 1`);
  for (const id of ids) {
    const row = query.get(id) as Row | undefined;
    const external = String(row?.external_id ?? ""), chat = external.split("::")[0]!;
    const kind = row?.channel === "telegram" ? Number(chat) < 0 ? "group" : "telegram" : external === "home" ? "main" : row?.employee != null ? "employee" : "chat";
    let title = String(row?.title ?? row?.employee ?? "Чат");
    if (kind === "telegram" && /^Telegram \d+$/.test(title)) title = String((author.get(id) as Row | undefined)?.author ?? title);
    chats[id] = { title, employee: row?.employee == null ? null : String(row.employee), kind };
  }
  return chats;
}

/** Usage of this Home by day and by week in the owner's zone, read from retained requests and the usage each turn reported.
 * Read-only: it creates no table and changes no setting. Requests are executed turns; a steer joins its running turn and
 * imported or context-only messages never ran. */
export function readStatistics(store: Store, owner: boolean, now = new Date()): Statistics {
  if (owner !== true) throw new HomeError("Статистика доступна владельцу.", 403);
  if (!Number.isFinite(now.getTime())) throw new HomeError("Некорректное время проверки.");
  let timeZone = ownerTimezone(store) ?? "UTC";
  try { timeZone = new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone; } catch { timeZone = "UTC"; }
  const calendar = localCalendar(timeZone), today = calendar.date(now.getTime()), thisWeek = monday(today);
  const dayKeys = Array.from({ length: DAYS }, (_, i) => shiftDate(today, i - DAYS + 1));
  const weekKeys = Array.from({ length: WEEKS }, (_, i) => shiftDate(thisWeek, 7 * (i - WEEKS + 1)));
  const from = new Date(calendar.start(weekKeys[0]! < dayKeys[0]! ? weekKeys[0]! : dayKeys[0]!)).toISOString(), until = now.toISOString();
  const tables = new Set((store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('turn_usage','schedule_runs','schedules')").all() as Row[]).map(r => String(r.name)));
  const usage = tables.has("turn_usage"), runs = tables.has("schedule_runs") && tables.has("schedules");

  const rows = store.db.prepare(`SELECT i.id,i.conversation_id,i.created_at,i.channel,i.external_id,i.status,
      ${runs ? "r.schedule_id,r.status AS run_status" : "NULL AS schedule_id,NULL AS run_status"},
      m.id AS reply_id,${quietReply} AS quiet,${failedReply} AS failed_reply,
      ${usage ? "u.provider,u.model,u.input_tokens,u.cached_tokens,u.output_tokens,u.reasoning_tokens,u.cost_ticks" : "NULL AS provider,NULL AS model,NULL AS input_tokens,NULL AS cached_tokens,NULL AS output_tokens,NULL AS reasoning_tokens,NULL AS cost_ticks"}
    FROM messages i
    LEFT JOIN messages m ON m.id=(SELECT o.id FROM messages o WHERE o.reply_to_id=i.id AND o.direction='outbound' AND o.conversation_id=i.conversation_id AND o.kind='text' ORDER BY o.rowid LIMIT 1)
    ${runs ? "LEFT JOIN schedule_runs r ON i.external_id GLOB 'schedule:*' AND r.id=substr(i.external_id,10) AND r.conversation_id=i.conversation_id" : ""}
    ${usage ? "LEFT JOIN turn_usage u ON u.message_id=i.id" : ""}
    WHERE i.direction='inbound' AND i.imported=0 AND i.context_only=0 AND i.status IN ('completed','failed','running')
      AND i.created_at>=:from AND i.created_at<=:until
      AND NOT EXISTS (SELECT 1 FROM messages s WHERE s.id=i.reply_to_id AND s.direction='inbound')`).all({ from, until }) as Row[];

  const days = new Map(dayKeys.map(key => [key, new Bucket()])), weeks = new Map(weekKeys.map(key => [key, new Bucket()]));
  // The unfinished day and week are compared with the previous ones up to the same moment.
  const elapsedToday = now.getTime() - calendar.start(today), elapsedWeek = now.getTime() - calendar.start(thisWeek);
  const yesterday = shiftDate(today, -1), lastWeek = shiftDate(thisWeek, -7);
  const yesterdayCut = calendar.start(yesterday) + elapsedToday, lastWeekCut = calendar.start(lastWeek) + elapsedWeek;
  const toDate = { day: { requests: 0, tokens: 0, costTicks: 0, priced: 0 }, week: { requests: 0, tokens: 0, costTicks: 0, priced: 0 } };
  const chatIds = new Set<string>(), scheduleIds = new Set<string>();

  for (const row of rows) {
    const instant = Date.parse(String(row.created_at));
    if (!Number.isFinite(instant)) continue;
    const date = calendar.date(instant), week = monday(date);
    const external = row.external_id == null ? "" : String(row.external_id);
    const source: RequestSource = row.channel === "telegram" ? "telegram" : external.startsWith("schedule:") ? "schedule" : /^[a-z][a-z-]*:/.test(external) ? "events" : "app";
    const runStatus = row.run_status == null ? null : String(row.run_status);
    const outcome = row.status === "failed" || runStatus === "failed" || row.reply_id && row.failed_reply === 1 ? "failed"
      : runStatus === "quiet" || row.reply_id && row.quiet === 1 ? "quiet" : row.status === "completed" ? "answered" : null;
    const measured = row.input_tokens != null || row.output_tokens != null;
    const tokens = { input: Number(row.input_tokens ?? 0), cached: Number(row.cached_tokens ?? 0), output: Number(row.output_tokens ?? 0), reasoning: Number(row.reasoning_tokens ?? 0) };
    const total = tokens.input + tokens.output, cost = row.cost_ticks == null ? null : Number(row.cost_ticks);
    const conversation = String(row.conversation_id), schedule = row.schedule_id == null ? null : String(row.schedule_id);
    chatIds.add(conversation); if (schedule) scheduleIds.add(schedule);
    for (const bucket of [days.get(date), weeks.get(week)]) {
      if (!bucket) continue;
      bucket.requests++; bucket.sources[source]++;
      if (outcome) bucket.outcomes[outcome]++;
      if (measured) {
        bucket.measured++;
        bucket.tokens.input += tokens.input; bucket.tokens.cached += tokens.cached; bucket.tokens.output += tokens.output; bucket.tokens.reasoning += tokens.reasoning;
        if (cost === null) bucket.unpriced++; else { bucket.costTicks += cost; bucket.priced++; }
      }
      const chat = bucket.chats.get(conversation) ?? { requests: 0, failed: 0, tokens: 0, costTicks: 0, priced: 0 };
      chat.requests++; if (outcome === "failed") chat.failed++; chat.tokens += total; if (cost !== null) { chat.costTicks += cost; chat.priced++; }
      bucket.chats.set(conversation, chat);
      const modelKey = JSON.stringify([row.provider ?? null, row.model ?? null]);
      const model = bucket.models.get(modelKey) ?? { provider: row.provider ?? null, model: row.model ?? null, requests: 0, tokens: 0, costTicks: 0, priced: 0 };
      model.requests++; model.tokens += total; if (cost !== null) { model.costTicks += cost; model.priced++; }
      bucket.models.set(modelKey, model);
      if (schedule) {
        const run = bucket.schedules.get(schedule) ?? { runs: 0, quiet: 0, failed: 0, tokens: 0, costTicks: 0, priced: 0 };
        run.runs++; if (outcome === "quiet") run.quiet++; if (outcome === "failed") run.failed++; run.tokens += total; if (cost !== null) { run.costTicks += cost; run.priced++; }
        bucket.schedules.set(schedule, run);
      }
    }
    for (const [mark, period, cut] of [[toDate.day, yesterday === date, yesterdayCut], [toDate.week, lastWeek === week, lastWeekCut]] as const) {
      if (!period || instant >= cut) continue;
      mark.requests++; mark.tokens += measured ? total : 0; if (cost !== null) { mark.costTicks += cost; mark.priced++; }
    }
  }

  const price = (ticks: number, priced: number) => priced ? usd(ticks) : null;
  const period = (start: string, bucket: Bucket, previous?: typeof toDate.day): StatisticsPeriod => ({
    start, requests: bucket.requests, sources: bucket.sources, outcomes: bucket.outcomes, measured: bucket.measured, tokens: bucket.tokens,
    costUsd: price(bucket.costTicks, bucket.priced), unpriced: bucket.unpriced,
    chats: [...bucket.chats].map(([id, c]) => ({ id, requests: c.requests, failed: c.failed, tokens: c.tokens, costUsd: price(c.costTicks, c.priced) }))
      .sort((a, b) => b.requests - a.requests || (b.costUsd ?? 0) - (a.costUsd ?? 0) || a.id.localeCompare(b.id)),
    models: [...bucket.models.values()].map(m => ({ provider: m.provider, model: m.model, name: modelName(store, m.provider, m.model), requests: m.requests, tokens: m.tokens, costUsd: price(m.costTicks, m.priced) }))
      .sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name)),
    schedules: [...bucket.schedules].map(([id, s]) => ({ id, runs: s.runs, quiet: s.quiet, failed: s.failed, tokens: s.tokens, costUsd: price(s.costTicks, s.priced) }))
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.runs - a.runs || a.id.localeCompare(b.id)),
    ...previous ? { previousToDate: { requests: previous.requests, tokens: previous.tokens, costUsd: price(previous.costTicks, previous.priced) } } : {},
  });

  const chats = chatInfo(store, chatIds);
  const schedules: Statistics["schedules"] = {};
  if (scheduleIds.size) {
    const query = store.db.prepare("SELECT id,name,conversation_id,enabled FROM schedules WHERE id=?");
    for (const id of scheduleIds) {
      const row = query.get(id) as Row | undefined;
      if (row) schedules[id] = { name: String(row.name), chatId: String(row.conversation_id), enabled: row.enabled === 1 };
    }
  }
  const first = store.db.prepare(`SELECT min(created_at) AS at FROM messages WHERE direction='inbound' AND imported=0 AND context_only=0 AND status IN ('completed','failed','running')`).get() as Row;
  const measuredSince = usage ? store.db.prepare(`SELECT min(i.created_at) AS at FROM turn_usage u JOIN messages i ON i.id=u.message_id WHERE u.input_tokens IS NOT NULL OR u.output_tokens IS NOT NULL`).get() as Row : undefined;
  const local = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? calendar.date(Date.parse(value)) : null;
  return {
    checkedAt: until, timeZone, firstDay: local(first?.at), usageSince: local(measuredSince?.at),
    days: dayKeys.map(key => period(key, days.get(key)!, key === today ? toDate.day : undefined)),
    weeks: weekKeys.map(key => period(key, weeks.get(key)!, key === thisWeek ? toDate.week : undefined)),
    chats, schedules,
  };
}

export interface ScheduleOverview {
  checkedAt: string;
  /** Every recurring schedule on this Home with its chat and what it ran and spent this week (from Monday). One-time reminders are left out. */
  schedules: Array<Schedule & { chat: ChatInfo; week: { runs: number; quiet: number; failed: number; tokens: number; costUsd: number | null } }>;
}

/** The owner's switchboard: each recurring schedule, its chat and this week's runs and cost. Switching one uses the chat's own schedule save. */
export function readScheduleOverview(store: Store, scheduler: Pick<Scheduler, "list"> | undefined, owner: boolean, now = new Date()): ScheduleOverview {
  if (owner !== true) throw new HomeError("Расписания устройства видит владелец.", 403);
  const list = (scheduler?.list() ?? []).filter(schedule => !schedule.cron.startsWith("@once "));
  const week = new Map((readStatistics(store, true, now).weeks.at(-1)?.schedules ?? []).map(run => [run.id, run]));
  const chats = chatInfo(store, new Set(list.map(schedule => schedule.conversationId)));
  return { checkedAt: now.toISOString(), schedules: list.map(schedule => {
    const spent = week.get(schedule.id);
    return { ...schedule, chat: chats[schedule.conversationId]!, week: { runs: spent?.runs ?? 0, quiet: spent?.quiet ?? 0, failed: spent?.failed ?? 0, tokens: spent?.tokens ?? 0, costUsd: spent?.costUsd ?? null } };
  }) };
}
