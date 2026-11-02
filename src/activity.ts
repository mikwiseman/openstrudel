import { createHash } from "node:crypto";
import { HomeError } from "./home.js";
import { problemText, type ProblemCode } from "./operations.js";
import type { Store } from "./store.js";
import { ownerTimezone } from "./timezone.js";

export interface ActivityInsight {
  id: string; kind: "result" | "attention"; title: string; text: string; occurredAt: string;
  conversationId: string; profileId: string | null; employeeName: string; messageId: string | null; status: string;
}
export interface Activity {
  checkedAt: string;
  period: { start: string; end: string; timeZone: string };
  insights: ActivityInsight[];
  progress: {
    activeDays: number; completedRequests: number; completedRuns: number; quietRuns: number; failedRuns: number; activeSchedules: number;
    milestones: Array<{ id: "first-request" | "first-automation" | "three-active-days"; reached: boolean }>;
  };
}

type Row = Record<string, unknown>;
const day = 86_400_000;
const limit = 30;
const textLimit = 6_000;
function excerpt(value: unknown, length: number): string {
  const text = String(value).slice(0, length), last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}
// Match the whitespace accepted by String.trim()/quietReply without returning whole transcripts to JS.
const whitespace = "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";
const trimmed = (alias: string) => `trim(${alias}.text,${whitespace})`;
function quiet(alias: string): string {
  const body = trimmed(alias), before = `rtrim(substr(${body},1,length(${body})-8),char(9,32))`;
  return `(substr(${body},-8)='NO_REPLY' AND (${before}='' OR substr(${before},-1)=char(10)))`;
}
function output(alias: string): string {
  return `${alias}.direction='outbound' AND ${alias}.status='completed' AND ${alias}.hidden=0
    AND ${alias}.imported=0 AND ${alias}.context_only=0 AND ${alias}.kind='text'
    AND ${trimmed(alias)}<>'' AND substr(${trimmed(alias)},1,7)<>'FAILED:' AND NOT ${quiet(alias)}`;
}
const validDate = (value: string) => `typeof(${value})='text' AND length(${value})=24
  AND strftime('%Y-%m-%dT%H:%M:%fZ',${value})=${value}`;
const profileExists = "(c.profile_id IS NULL OR p.id IS NOT NULL)";

function calendar(store: Store, now: Date) {
  let timeZone = ownerTimezone(store) ?? "UTC";
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }); }
  catch { timeZone = "UTC"; formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }); }
  const dateKey = (instant: number) => {
    const parts = formatter.formatToParts(instant);
    return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
  };
  const today = Date.parse(dateKey(now.getTime()) + "T00:00:00.000Z");
  // Find the first instant of the local date, including DST changes at midnight.
  const startOfDate = (daysAgo: number) => {
    const wallDate = today - daysAgo * day, target = new Date(wallDate).toISOString().slice(0, 10);
    let low = wallDate - 36 * 3_600_000, high = wallDate + 36 * 3_600_000;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (dateKey(middle) < target) low = middle + 1; else high = middle;
    }
    return new Date(low).toISOString();
  };
  return { timeZone, starts: Array.from({ length: 7 }, (_, i) => startOfDate(6 - i)), insightStart: startOfDate(29) };
}

const requestReceipts = `WITH requests AS (
  SELECT i.id, MIN(julianday(m.created_at)) AS completed_at
  FROM messages i JOIN conversations c ON c.id=i.conversation_id
  LEFT JOIN employee_profiles p ON p.id=c.profile_id
  JOIN messages m ON m.reply_to_id=i.id AND m.conversation_id=i.conversation_id
  WHERE i.direction='inbound' AND i.status='completed' AND i.hidden=0 AND i.imported=0
    AND i.context_only=0 AND i.kind='text' AND i.reply_to_id IS NULL AND ${profileExists}
    AND (i.external_id IS NULL OR (i.external_id NOT GLOB 'schedule:*' AND i.external_id NOT GLOB 'operations:*'))
    AND ${output("m")} AND ${validDate("i.created_at")} AND ${validDate("m.created_at")}
    AND julianday(i.created_at)<=julianday(m.created_at) AND julianday(m.created_at)<=julianday(:end)
  GROUP BY i.id
)`;

const runReceipts = `WITH runs AS (
  SELECT r.id,r.status,r.created_at,r.conversation_id,s.name,c.profile_id,p.name AS employee_name,
    m.created_at AS output_at,m.id AS output_id,
    (${output("m")} AND i.status='completed' AND ${validDate("m.created_at")}
      AND julianday(m.created_at)>=julianday(r.created_at) AND julianday(m.created_at)<=julianday(:end)
      AND ${validDate("i.created_at")} AND julianday(i.created_at)>=julianday(r.created_at)
      AND julianday(i.created_at)<=julianday(m.created_at)) AS shown_output,
    (${quiet("m")} AND m.direction='outbound' AND m.status='completed' AND m.imported=0
      AND m.context_only=0 AND m.kind='text' AND i.status='completed' AND ${validDate("m.created_at")}
      AND julianday(m.created_at)>=julianday(r.created_at) AND julianday(m.created_at)<=julianday(:end)
      AND ${validDate("i.created_at")} AND julianday(i.created_at)>=julianday(r.created_at)
      AND julianday(i.created_at)<=julianday(m.created_at)) AS quiet_output
  FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id
  JOIN conversations c ON c.id=r.conversation_id LEFT JOIN employee_profiles p ON p.id=c.profile_id
  LEFT JOIN messages m ON m.id=r.message_id AND m.conversation_id=r.conversation_id
  LEFT JOIN messages i ON i.id=m.reply_to_id AND i.conversation_id=r.conversation_id
    AND i.direction='inbound' AND i.channel='api' AND i.external_id='schedule:'||r.id AND i.imported=0 AND i.context_only=0
  WHERE ${profileExists} AND ${validDate("r.created_at")} AND ${validDate("r.scheduled_for")}
    AND julianday(r.created_at)<=julianday(:end) AND julianday(r.scheduled_for)<=julianday(:end)
)`;

function attention(store: Store, start: string, end: string, scheduler: boolean): ActivityInsight[] {
  const knownCodes = Object.keys(problemText).map(code => `'${code}'`).join(",");
  // Scheduled prompts and FAILED answers are hidden by the runtime, not by the owner.
  // A manually hidden private message does not become an insight again.
  const hiddenSchedule = scheduler ? `OR EXISTS (SELECT 1 FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id
    WHERE r.conversation_id=c.id AND r.status IN ('failed','uncertain')
      AND ${validDate("r.created_at")} AND julianday(r.created_at)<=julianday(issues.time)
      AND (r.message_id=m.id OR (m.direction='inbound' AND m.external_id='schedule:'||r.id)))` : "";
  const runSource = scheduler ? `OR EXISTS (SELECT 1 FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id
    WHERE r.id=issues.message_id AND r.conversation_id=c.id AND r.status IN ('failed','uncertain')
      AND ${validDate("r.created_at")} AND julianday(r.created_at)<=julianday(issues.time))` : "";
  const rows = store.db.prepare(`WITH documents AS (
      SELECT key,CASE WHEN json_valid(value) THEN value ELSE '{}' END AS doc FROM settings WHERE key GLOB 'runtime.issue.*'
    ), issues AS (
      SELECT key,json_extract(doc,'$.conversationId') AS conversation_id,json_extract(doc,'$.messageId') AS message_id,
        json_extract(doc,'$.code') AS code,json_extract(doc,'$.time') AS time
      FROM documents WHERE coalesce(json_extract(doc,'$.resolved'),0)<>1
        AND json_extract(doc,'$.resolvedAt') IS NULL AND coalesce(json_extract(doc,'$.status'),'')<>'resolved'
    )
    SELECT issues.key,issues.code,issues.time,c.id AS conversation_id,c.profile_id,p.name AS employee_name,
      CASE WHEN m.hidden=0 THEN m.id ELSE NULL END AS message_id
    FROM issues JOIN conversations c ON c.id=issues.conversation_id
    LEFT JOIN employee_profiles p ON p.id=c.profile_id
    LEFT JOIN messages m ON m.id=issues.message_id AND m.conversation_id=c.id
    WHERE issues.code IN (${knownCodes}) AND ${profileExists} AND ${validDate("issues.time")}
      AND julianday(issues.time) BETWEEN julianday(:start) AND julianday(:end)
      AND ((m.id IS NOT NULL AND m.imported=0 AND (m.hidden=0 ${hiddenSchedule})
        AND ${validDate("m.created_at")} AND julianday(m.created_at)<=julianday(issues.time)) ${runSource})
    ORDER BY issues.time DESC,issues.key DESC LIMIT ${limit}`).all({ start, end }) as Row[];
  return rows.map(row => ({
    id: "issue:" + createHash("sha256").update(String(row.key)).digest("hex").slice(0, 24), kind: "attention",
    title: "Требует внимания", text: problemText[row.code as ProblemCode], occurredAt: String(row.time),
    conversationId: String(row.conversation_id), profileId: row.profile_id == null ? null : String(row.profile_id),
    employeeName: excerpt(row.employee_name ?? "OpenStrudel", 200),
    messageId: row.message_id == null ? null : String(row.message_id), status: "unresolved",
  }));
}

/** Read retained receipts only. No delivery, business outcome or token usage is inferred.
 * Counters cover today and six preceding owner-local dates; highlights cover thirty.
 * First-request/automation are lifetime EXISTS facts; three-active-days uses this week's requests.
 * UTC is an explicit display fallback when the owner timezone is absent or invalid.
 */
export function readActivity(store: Store, owner: boolean, now = new Date()): Activity {
  if (owner !== true) throw new HomeError("Активность доступна владельцу.", 403);
  if (!Number.isFinite(now.getTime())) throw new HomeError("Некорректное время проверки.");
  const end = now.toISOString(), { timeZone, starts, insightStart } = calendar(store, now), start = starts[0]!;
  const buckets = starts.slice(1).map((_, i) => `WHEN completed_at<julianday(:d${i + 1}) THEN ${i}`).join(" ");
  const dates = Object.fromEntries(starts.slice(1).map((date, i) => ["d" + (i + 1), date]));
  const requests = store.db.prepare(`${requestReceipts} SELECT
    count(*) FILTER (WHERE completed_at>=julianday(:start)) AS completed_requests,
    count(DISTINCT CASE WHEN completed_at>=julianday(:start) THEN CASE ${buckets} ELSE 6 END END) AS active_days
    FROM requests`).get({ start, end, ...dates })!;
  const firstRequest = store.db.prepare(`${requestReceipts} SELECT EXISTS(SELECT 1 FROM requests LIMIT 1) AS reached`).get({ end })!.reached === 1;
  const tables = new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('schedules','schedule_runs')").all().map(row => row.name));
  const scheduler = tables.has("schedules") && tables.has("schedule_runs");
  let completedRuns = 0, quietRuns = 0, failedRuns = 0, firstAutomation = false;
  let insights: ActivityInsight[] = [];
  if (scheduler) {
    const totals = store.db.prepare(`${runReceipts} SELECT
      count(*) FILTER (WHERE status='completed' AND shown_output AND julianday(output_at)>=julianday(:start)) AS completed,
      count(*) FILTER (WHERE status='quiet' AND quiet_output AND julianday(output_at)>=julianday(:start)) AS quiet,
      count(*) FILTER (WHERE status='failed' AND julianday(created_at)>=julianday(:start)) AS failed
      FROM runs`).get({ start, end })!;
    completedRuns = Number(totals.completed); quietRuns = Number(totals.quiet); failedRuns = Number(totals.failed);
    firstAutomation = store.db.prepare(`${runReceipts} SELECT EXISTS(SELECT 1 FROM runs WHERE status='completed' AND shown_output LIMIT 1) AS reached`).get({ end })!.reached === 1;
    const rows = store.db.prepare(`${runReceipts} SELECT runs.id,name,substr(m.text,1,${textLimit}) AS output_text,output_at,
      runs.conversation_id,profile_id,employee_name,output_id
      FROM runs JOIN messages m ON m.id=runs.output_id
      WHERE runs.status='completed' AND shown_output AND julianday(output_at)>=julianday(:start)
      ORDER BY output_at DESC,runs.id DESC LIMIT ${limit}`).all({ start: insightStart, end }) as Row[];
    insights = rows.map(row => ({ id: "run:" + row.id, kind: "result", title: excerpt(row.name, 200),
      text: excerpt(row.output_text, textLimit), occurredAt: String(row.output_at), conversationId: String(row.conversation_id),
      profileId: row.profile_id == null ? null : String(row.profile_id), employeeName: excerpt(row.employee_name ?? "OpenStrudel", 200),
      messageId: String(row.output_id), status: "completed" }));
  }
  const activeSchedules = tables.has("schedules") ? Number(store.db.prepare(`SELECT count(*) AS n FROM schedules s
    JOIN conversations c ON c.id=s.conversation_id LEFT JOIN employee_profiles p ON p.id=c.profile_id
    WHERE s.enabled=1 AND ${profileExists}`).get()!.n) : 0;
  insights.push(...attention(store, insightStart, end, scheduler));
  insights.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
  const activeDays = Number(requests.active_days);
  return { checkedAt: end, period: { start, end, timeZone }, insights: insights.slice(0, limit), progress: {
    activeDays, completedRequests: Number(requests.completed_requests), completedRuns, quietRuns, failedRuns, activeSchedules,
    milestones: [
      { id: "first-request", reached: firstRequest },
      { id: "first-automation", reached: firstAutomation },
      { id: "three-active-days", reached: activeDays >= 3 },
    ],
  } };
}
