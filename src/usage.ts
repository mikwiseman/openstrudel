import type { Store } from "./store.js";

/** Cost in Grok's unit: 1e10 ticks are $1. Integer sums stay exact. */
export const TICKS_PER_USD = 1e10;

/** One turn's spend in the shape Grok reports it (`_meta.usage`); the Codex and Claude engines report the same fields.
 * Input includes cached and cache-write tokens; output includes reasoning. */
export interface UsageCounts {
  inputTokens: number;
  cachedReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  modelCalls?: number;
  /** Absent when the model and speed have no published API price. */
  costUsdTicks?: number;
}

/** The `turn.usage` event an engine sends when a turn ends, a failed or stopped one included. */
export interface UsageReport {
  usage: UsageCounts & { modelUsage?: Record<string, UsageCounts> };
  /** What actually ran, as the engine resolved it. */
  model?: string;
  serviceTier?: string;
  reasoningEffort?: string;
  /** Added by the account router. */
  provider?: string;
  /** Grok's subscription pool after a scheduled run. */
  billing?: unknown;
  /** The engine's thread and its running counters after this turn: the next turn on that thread is measured from them. */
  engine?: { thread: string; totals: unknown };
}

const zero = (): UsageCounts => ({ inputTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 });
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

/** Adds what several model calls or engines spent; a cost stays known only while every part has one. */
export function addUsage(a: UsageCounts, b: UsageCounts): UsageCounts {
  const sum: UsageCounts = { inputTokens: a.inputTokens + b.inputTokens, cachedReadTokens: a.cachedReadTokens + b.cachedReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens, outputTokens: a.outputTokens + b.outputTokens, reasoningTokens: a.reasoningTokens + b.reasoningTokens };
  if (a.modelCalls !== undefined || b.modelCalls !== undefined) sum.modelCalls = (a.modelCalls ?? 0) + (b.modelCalls ?? 0);
  if (a.costUsdTicks !== undefined && b.costUsdTicks !== undefined) sum.costUsdTicks = a.costUsdTicks + b.costUsdTicks;
  return sum;
}

/** OpenAI's published standard prices, USD per million tokens: input, cached input, 30-minute cache write, output.
 * developers.openai.com/api/docs/pricing, read on 8 November 2026. The Fast tier (`priority`) costs twice as much.
 * Codex models have a 272K context, so long-context prices never apply. A model or speed not listed has no cost. */
const OPENAI_PRICES: Record<string, [number, number, number, number]> = {
  "gpt-6-astra": [10, 1, 12.5, 50],
  "gpt-6-sol": [2, 0.2, 2.5, 10],
  "gpt-6-luna": [0.1, 0.01, 0.125, 0.5],
  "gpt-5.6-sol": [4, 0.4, 5, 20],
  "gpt-5.6-terra": [2, 0.2, 2.5, 12],
  "gpt-5.6-luna": [0.2, 0.02, 0.25, 1.2],
};

/** What these OpenAI tokens cost at API prices, in ticks; undefined without a published price. */
export function openAICostTicks(usage: UsageCounts, model: string | undefined, serviceTier: string | undefined): number | undefined {
  const price = model ? OPENAI_PRICES[model] : undefined;
  const multiplier = !serviceTier || serviceTier === "default" ? 1 : serviceTier === "priority" ? 2 : undefined;
  if (!price || multiplier === undefined) return undefined;
  const [input, cached, write, output] = price;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedReadTokens - usage.cacheCreationTokens);
  const usd = (uncached * input + usage.cachedReadTokens * cached + usage.cacheCreationTokens * write + usage.outputTokens * output) * multiplier / 1e6;
  return Math.round(usd * TICKS_PER_USD);
}

/** Reads a reported usage defensively: engines and older Homes may leave fields out. */
export function usageCounts(value: unknown): UsageCounts | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const counts: UsageCounts = { inputTokens: count(v.inputTokens), cachedReadTokens: count(v.cachedReadTokens), cacheCreationTokens: count(v.cacheCreationTokens),
    outputTokens: count(v.outputTokens), reasoningTokens: count(v.reasoningTokens) };
  if (typeof v.modelCalls === "number") counts.modelCalls = count(v.modelCalls);
  if (typeof v.costUsdTicks === "number" && Number.isFinite(v.costUsdTicks) && v.costUsdTicks >= 0) counts.costUsdTicks = Math.round(v.costUsdTicks);
  return counts;
}

type ClaudeModelUsage = { inputTokens?: number; outputTokens?: number; thinkingTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number; costBasis?: string };
type ClaudeTurnTokens = { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
const claudeFields = ["inputTokens", "outputTokens", "thinkingTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "costUSD"] as const;

/** A Claude Agent SDK result carries the session's running totals per model, and a resumed session's first result
 * already includes its earlier turns. So the turn's share is the difference from the totals saved after the session's
 * previous recorded turn. Counters that went down started again: they are this turn's own. On a session that began
 * before recording, only the main loop's own tokens for this turn are known, without a cost. */
export function claudeUsage(totals: Record<string, ClaudeModelUsage>, turn: ClaudeTurnTokens | undefined, baseline: unknown, resumed: boolean, model: string): UsageReport["usage"] {
  const before = (baseline as { modelUsage?: Record<string, ClaudeModelUsage> } | undefined)?.modelUsage;
  if (resumed && !before) {
    const counts: UsageCounts = { inputTokens: count(turn?.input_tokens) + count(turn?.cache_read_input_tokens) + count(turn?.cache_creation_input_tokens),
      cachedReadTokens: count(turn?.cache_read_input_tokens), cacheCreationTokens: count(turn?.cache_creation_input_tokens), outputTokens: count(turn?.output_tokens), reasoningTokens: 0 };
    return { ...counts, modelUsage: { [model]: counts } };
  }
  const grew = resumed && Object.entries(totals).every(([name, now]) => claudeFields.every(f => (now[f] ?? 0) >= (before?.[name]?.[f] ?? 0)));
  const modelUsage: Record<string, UsageCounts> = {};
  for (const [name, now] of Object.entries(totals)) {
    const was = grew ? before?.[name] : undefined, spent = (f: typeof claudeFields[number]) => Math.max(0, (now[f] ?? 0) - (was?.[f] ?? 0));
    const counts: UsageCounts = { inputTokens: Math.round(spent("inputTokens") + spent("cacheReadInputTokens") + spent("cacheCreationInputTokens")),
      cachedReadTokens: Math.round(spent("cacheReadInputTokens")), cacheCreationTokens: Math.round(spent("cacheCreationInputTokens")),
      outputTokens: Math.round(spent("outputTokens")), reasoningTokens: Math.round(spent("thinkingTokens")) };
    // "unknown": the CLI found no price for this model and guessed one.
    if (now.costBasis !== "unknown") counts.costUsdTicks = Math.round(spent("costUSD") * TICKS_PER_USD);
    if (counts.inputTokens || counts.outputTokens) modelUsage[name] = counts;
  }
  const parts = Object.values(modelUsage);
  return { ...(parts.length ? parts.reduce(addUsage) : zero()), modelUsage };
}

/** One row per executed turn, keyed by the request it answered; the request itself keeps its chat, channel and outcome. */
export function ensureUsageTable(store: Store): void {
  const existed = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='turn_usage'").get();
  if (existed) return;
  store.db.exec(`CREATE TABLE turn_usage(
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      provider TEXT, model TEXT, service_tier TEXT, reasoning_effort TEXT,
      input_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cost_ticks INTEGER,
      engine_thread TEXT, engine_totals TEXT);
    CREATE INDEX turn_usage_thread_idx ON turn_usage(engine_thread) WHERE engine_thread IS NOT NULL;`);
  // Grok's scheduled runs have reported their usage since 7 November 2026, before this table existed.
  if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schedule_runs'").get()
    && (store.db.prepare("PRAGMA table_info(schedule_runs)").all() as Array<{ name: string }>).some(c => c.name === "usage_json")) {
    store.db.exec(`INSERT OR IGNORE INTO turn_usage(message_id,provider,model,input_tokens,cached_tokens,output_tokens,reasoning_tokens,cost_ticks)
      SELECT m.id,'grok',coalesce((SELECT p.model FROM conversations c JOIN employee_profiles p ON p.id=c.profile_id WHERE c.id=r.conversation_id AND p.provider='grok'),
          json_extract(r.usage_json,'$.usage.primaryModelId')),
        json_extract(r.usage_json,'$.usage.inputTokens'),json_extract(r.usage_json,'$.usage.cachedReadTokens'),
        json_extract(r.usage_json,'$.usage.outputTokens'),json_extract(r.usage_json,'$.usage.reasoningTokens'),json_extract(r.usage_json,'$.usage.costUsdTicks')
      FROM schedule_runs r JOIN messages m ON m.conversation_id=r.conversation_id AND m.channel='api' AND m.direction='inbound' AND m.external_id='schedule:'||r.id
      WHERE json_valid(r.usage_json) AND json_type(r.usage_json,'$.usage.inputTokens') IN ('integer','real')`);
  }
}

/** The running counters an engine reported for its thread after the latest recorded turn. */
export function engineBaseline(store: Store, thread: string | null | undefined): unknown {
  if (!thread) return undefined;
  try {
    const row = store.db.prepare("SELECT engine_totals FROM turn_usage WHERE engine_thread=? AND engine_totals IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(thread) as { engine_totals: string } | undefined;
    return row ? JSON.parse(row.engine_totals) : undefined;
  } catch { return undefined; }
}

export interface TurnRoute { provider?: string | null; model?: string | null; serviceTier?: string | null; reasoningEffort?: string | null }

/** Saves what a turn ran on and spent. A turn without a report keeps its route and no counts.
 * Statistics must never break a turn, so a failed write is dropped. */
export function recordTurnUsage(store: Store, messageId: string, route: TurnRoute, reports: UsageReport[]): void {
  const counted = reports.map(report => usageCounts(report.usage)).filter((u): u is UsageCounts => u !== undefined);
  const total = counted.length ? counted.reduce(addUsage) : undefined;
  const last = reports.at(-1);
  const engine = [...reports].reverse().find(report => report.engine?.thread)?.engine;
  try {
    store.db.prepare(`INSERT OR REPLACE INTO turn_usage(message_id,provider,model,service_tier,reasoning_effort,input_tokens,cached_tokens,output_tokens,reasoning_tokens,cost_ticks,engine_thread,engine_totals)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(messageId, last?.provider ?? route.provider ?? null, last?.model ?? route.model ?? null,
      last?.serviceTier ?? route.serviceTier ?? null, last?.reasoningEffort ?? route.reasoningEffort ?? null,
      total?.inputTokens ?? null, total?.cachedReadTokens ?? null, total?.outputTokens ?? null, total?.reasoningTokens ?? null, total?.costUsdTicks ?? null,
      engine?.thread ?? null, engine ? JSON.stringify(engine.totals) : null);
  } catch { /* The request was removed while it ran, or the database is read-only. */ }
}
