import { afterEach, expect, it, vi } from "vitest";
const wire = vi.hoisted(() => ({ request: vi.fn(), notify: undefined as undefined | ((message: any) => void) }));
vi.mock("../src/rpc.js", () => ({ CodexRpc: class {
  closed = false;
  exited = Promise.resolve();
  constructor(_home: unknown, notify: (message: any) => void) { wire.notify = notify; }
  initialize = async () => undefined;
  request = wire.request;
  close() { this.closed = true; }
} }));
import { CodexEngineAdapter } from "../src/codex.js";
import { MessageService } from "../src/messages.js";
import { Scheduler } from "../src/scheduler.js";
import { Store } from "../src/store.js";
import type { CodexEngine, EngineEvent } from "../src/types.js";
import { claudeUsage, engineBaseline, ensureUsageTable, openAICostTicks, recordTurnUsage, TICKS_PER_USD, type UsageReport } from "../src/usage.js";

const stores: Store[] = [];
afterEach(() => { wire.request.mockReset(); stores.splice(0).forEach(store => store.close()); });
const store = () => { const value = new Store(":memory:"); stores.push(value); return value; };
const usd = (ticks: number | undefined) => ticks === undefined ? undefined : ticks / TICKS_PER_USD;
const counts = (input: number, cached: number, output: number, reasoning = 0) => ({ inputTokens: input, cachedReadTokens: cached, cacheCreationTokens: 0, outputTokens: output, reasoningTokens: reasoning });

it("prices OpenAI tokens at the published standard and Fast rates, and leaves an unpublished price unknown", () => {
  // One million uncached input, one million cached, one million output on GPT-6-Astra: $10 + $1 + $50.
  expect(usd(openAICostTicks(counts(2_000_000, 1_000_000, 1_000_000), "gpt-6-astra", "default"))).toBe(61);
  expect(usd(openAICostTicks(counts(2_000_000, 1_000_000, 1_000_000), "gpt-6-astra", undefined))).toBe(61);
  expect(usd(openAICostTicks(counts(2_000_000, 1_000_000, 1_000_000), "gpt-6-astra", "priority"))).toBe(122);
  // Cache writes are input at their own price; reasoning is already inside output.
  expect(usd(openAICostTicks({ ...counts(1_000_000, 0, 0), cacheCreationTokens: 1_000_000 }, "gpt-6-sol", "default"))).toBe(2.5);
  expect(usd(openAICostTicks(counts(1_000_000, 0, 1_000_000, 900_000), "gpt-6-luna", "default"))).toBe(0.6);
  expect(openAICostTicks(counts(1_000, 0, 1_000), "gpt-6-astra", "ultrafast")).toBeUndefined();
  expect(openAICostTicks(counts(1_000, 0, 1_000), "gpt-7-nova", "default")).toBeUndefined();
  expect(openAICostTicks(counts(1_000, 0, 1_000), undefined, "default")).toBeUndefined();
});

it("measures a Claude turn from the session's running totals, without counting earlier turns again", () => {
  const opus = (input: number, read: number, output: number, cost: number) => ({ inputTokens: input, cacheReadInputTokens: read, cacheCreationInputTokens: 0, outputTokens: output, costUSD: cost });
  // A new session: the totals are this turn's own.
  expect(claudeUsage({ "claude-opus-5-5": opus(100, 1_000, 50, 0.25) }, undefined, undefined, false, "claude-opus-5-5"))
    .toMatchObject({ inputTokens: 1_100, cachedReadTokens: 1_000, outputTokens: 50, costUsdTicks: 0.25 * TICKS_PER_USD });
  // A resumed session continues from the totals saved after its previous turn.
  const before = { modelUsage: { "claude-opus-5-5": opus(100, 1_000, 50, 0.25) } };
  const resumed = claudeUsage({ "claude-opus-5-5": opus(160, 2_500, 80, 0.4), "claude-haiku-5-5": opus(30, 0, 5, 0.01) }, undefined, before, true, "claude-opus-5-5");
  expect(resumed).toMatchObject({ inputTokens: 1_560 + 30, cachedReadTokens: 1_500, outputTokens: 35, costUsdTicks: Math.round(0.16 * TICKS_PER_USD) });
  expect(Object.keys(resumed.modelUsage!)).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
  // Counters that went down started again, so they are this turn's own.
  expect(claudeUsage({ "claude-opus-5-5": opus(10, 0, 5, 0.01) }, undefined, before, true, "claude-opus-5-5")).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsdTicks: 0.01 * TICKS_PER_USD });
  // A session older than recording: only the main loop's own tokens of this turn, and no cost.
  const older = claudeUsage({ "claude-opus-5-5": opus(9_000, 90_000, 4_000, 12) }, { input_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 60, output_tokens: 20 }, undefined, true, "claude-opus-5-5");
  expect(older).toMatchObject({ inputTokens: 1_000, cachedReadTokens: 900, cacheCreationTokens: 60, outputTokens: 20 });
  expect(older.costUsdTicks).toBeUndefined();
  // Another vendor's model has no list price in the CLI, so its guess is dropped.
  expect(claudeUsage({ "kimi-k3": { ...opus(100, 0, 10, 3), costBasis: "unknown" } }, undefined, undefined, false, "kimi-k3").costUsdTicks).toBeUndefined();
});

function serve(catalog: any[]) {
  wire.request.mockImplementation(async (method: string, params: any) => {
    if (method === "configRequirements/read") return { requirements: null };
    if (method === "model/list") return { data: catalog };
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: params.threadId ?? "main-thread" } };
    if (method === "thread/unsubscribe") return {};
    if (method === "turn/start") return { turn: { id: "turn-" + Math.random() } };
    throw new Error(method);
  });
}
const breakdown = (input: number, cached: number, output: number) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: 0 });
const reading = (threadId: string, total: ReturnType<typeof breakdown>, last: ReturnType<typeof breakdown>) => ({ method: "thread/tokenUsage/updated", params: { threadId, turnId: "t", tokenUsage: { total, last } } });
/** Runs one turn, feeding the app-server notifications after the turn starts. */
async function turn(engine: CodexEngineAdapter, notifications: Array<{ method: string; params: any }>, options: Record<string, unknown> = {}) {
  const events: EngineEvent[] = [];
  const started = new Promise<void>(resolve => {
    const original = wire.request.getMockImplementation()!;
    wire.request.mockImplementation(async (method: string, params: any) => {
      const result = await original(method, params);
      if (method === "turn/start") queueMicrotask(() => { resolve(); });
      return result;
    });
  });
  const run = engine.run("Hello", { model: "gpt-6-astra", serviceTier: "default", onEvent: event => events.push(event), ...options });
  await started;
  const thread = String((options.threadId as string | undefined) ?? "main-thread");
  for (const message of notifications) wire.notify?.(message);
  wire.notify?.({ method: "turn/completed", params: { threadId: thread, turn: { status: "completed" } } });
  await run;
  return events.filter(event => event.type === "turn.usage").map(event => event.payload as UsageReport);
}

it("counts a Codex turn once per model call, ignores repeated readings, and prices delegated employees on their own models", async () => {
  serve([{ model: "gpt-6-astra", displayName: "GPT-6-Astra", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] }]);
  const engine = new CodexEngineAdapter({});
  try {
    // Two calls; the first reading repeats when the rate limits change.
    const first = await turn(engine, [
      reading("main-thread", breakdown(1_000, 0, 100), breakdown(1_000, 0, 100)),
      reading("main-thread", breakdown(1_000, 0, 100), breakdown(1_000, 0, 100)),
      { method: "item/started", params: { threadId: "main-thread", item: { type: "subAgentActivity", agentThreadId: "helper-thread" } } },
      { method: "item/completed", params: { threadId: "main-thread", item: { type: "collabAgentToolCall", model: "gpt-6-luna", receiverThreadIds: ["helper-thread"] } } },
      reading("helper-thread", breakdown(400, 0, 40), breakdown(400, 0, 40)),
      reading("main-thread", breakdown(2_800, 900, 150), breakdown(1_800, 900, 50)),
    ]);
    expect(first).toHaveLength(1);
    const [report] = first;
    expect(report!.model).toBe("gpt-6-astra");
    expect(report!.serviceTier).toBe("default");
    expect(report!.usage.modelUsage!["gpt-6-astra"]).toMatchObject({ inputTokens: 2_800, cachedReadTokens: 900, outputTokens: 150 });
    expect(report!.usage.modelUsage!["gpt-6-luna"]).toMatchObject({ inputTokens: 400, outputTokens: 40 });
    expect(report!.usage).toMatchObject({ inputTokens: 3_200, cachedReadTokens: 900, outputTokens: 190 });
    // Astra: 1,900 × $10 + 900 × $1 + 150 × $50 per million; Luna: 400 × $0.1 + 40 × $0.5 per million.
    expect(report!.usage.costUsdTicks).toBe(Math.round((1_900 * 10 + 900 + 150 * 50 + 400 * 0.1 + 40 * 0.5) / 1e6 * TICKS_PER_USD));
    expect(report!.engine).toEqual({ thread: "main-thread", totals: { total: { ...breakdown(2_800, 900, 150), cacheWriteInputTokens: 0 } } });

    // The next turn starts with the previous reading repeated. The saved totals keep it from counting twice.
    const second = await turn(engine, [
      reading("main-thread", breakdown(2_800, 900, 150), breakdown(1_800, 900, 50)),
      reading("main-thread", breakdown(5_000, 2_500, 200), breakdown(2_200, 1_600, 50)),
    ], { threadId: "main-thread", usageBaseline: report!.engine!.totals });
    expect(second[0]!.usage).toMatchObject({ inputTokens: 2_200, cachedReadTokens: 1_600, outputTokens: 50 });
    // Without saved totals, the first reading is taken for this turn's own call.
    const unseeded = await turn(engine, [reading("main-thread", breakdown(5_600, 2_500, 230), breakdown(600, 0, 30))], { threadId: "main-thread" });
    expect(unseeded[0]!.usage).toMatchObject({ inputTokens: 600, outputTokens: 30 });
    // A turn that made no model call reports nothing.
    expect(await turn(engine, [], { threadId: "main-thread" })).toEqual([]);
  } finally { engine.close(); }
});

it("records each turn's route and spend, keeps a failed turn's spend, and measures the next turn from the saved totals", async () => {
  const home = store();
  const reports: Array<UsageReport | Error> = [
    { usage: { ...counts(1_000, 200, 50), costUsdTicks: 7 }, model: "gpt-6-astra", serviceTier: "priority", provider: "chatgpt", engine: { thread: "thread-a", totals: { total: { totalTokens: 1_050 } } } },
    new Error("Codex не завершил ответ"),
  ];
  const engine: CodexEngine = {
    async run(_input, options = {}) {
      const next = reports.shift()!;
      if (next instanceof Error) {
        options.onEvent?.({ type: "turn.usage", payload: { usage: counts(300, 0, 10), model: "gpt-6-astra", provider: "chatgpt" } satisfies UsageReport });
        throw next;
      }
      options.onEvent?.({ type: "turn.usage", payload: next });
      return { threadId: "thread-a", response: "Готово.", events: [] };
    },
  };
  const messages = new MessageService(home, engine);
  const conversationId = home.primaryConversation().id;
  const done = await messages.handle({ channel: "api", conversationId, text: "First" });
  await expect(messages.handle({ channel: "api", conversationId, text: "Second" })).rejects.toThrow();
  const rows = home.db.prepare(`SELECT i.text,u.provider,u.model,u.service_tier,u.input_tokens,u.cached_tokens,u.output_tokens,u.cost_ticks,u.engine_thread
    FROM turn_usage u JOIN messages i ON i.id=u.message_id ORDER BY i.rowid`).all();
  expect(rows).toEqual([
    { text: "First", provider: "chatgpt", model: "gpt-6-astra", service_tier: "priority", input_tokens: 1_000, cached_tokens: 200, output_tokens: 50, cost_ticks: 7, engine_thread: "thread-a" },
    // The engine named no speed, so the chat's own is kept.
    { text: "Second", provider: "chatgpt", model: "gpt-6-astra", service_tier: "default", input_tokens: 300, cached_tokens: 0, output_tokens: 10, cost_ticks: null, engine_thread: null },
  ]);
  expect(done.text).toBe("Готово.");
  expect(engineBaseline(home, "thread-a")).toEqual({ total: { totalTokens: 1_050 } });
  expect(engineBaseline(home, "other")).toBeUndefined();
  // /help runs no model: its row has the chat's route and no counts.
  await messages.handle({ channel: "api", conversationId, text: "/help" });
  expect(home.db.prepare("SELECT u.provider,u.input_tokens FROM turn_usage u JOIN messages i ON i.id=u.message_id WHERE i.text='/help'").get()).toEqual({ provider: "chatgpt", input_tokens: null });
  // A request removed while it ran is not recorded.
  recordTurnUsage(home, "missing-message", { provider: "chatgpt" }, []);
  expect(home.db.prepare("SELECT count(*) AS n FROM turn_usage WHERE message_id='missing-message'").get()).toEqual({ n: 0 });
});

it("takes over the usage Grok's scheduled runs reported before the table existed, once", () => {
  const home = store();
  new Scheduler(home, {} as MessageService);
  const conversationId = home.primaryConversation().id;
  home.db.prepare("INSERT INTO employee_profiles(id,name,instructions,model,provider,created_at) VALUES('news','News','', 'grok-4.7','grok','2026-11-01T00:00:00.000Z')").run();
  home.db.prepare("UPDATE conversations SET profile_id='news' WHERE id=?").run(conversationId);
  home.db.prepare("INSERT INTO schedules(id,conversation_id,name,prompt,cron,timezone,next_run_at) VALUES('radar',?,'Радар','Check','5 * * * *','UTC','2026-11-08T00:00:00.000Z')").run(conversationId);
  const usage = { inputTokens: 1_051_097, outputTokens: 13_670, cachedReadTokens: 946_688, cacheCreationTokens: 0, reasoningTokens: 11_623, modelCalls: 13, costUsdTicks: 12_174_040_000, primaryModelId: "grok-4.7-build" };
  home.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at,usage_json) VALUES('run-1','radar',?,'2026-11-08T10:05:00.000Z','quiet','2026-11-08T10:05:00.000Z',?)").run(conversationId, JSON.stringify({ usage, billing: { config: { creditUsagePercent: 71 } } }));
  home.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at,usage_json) VALUES('run-2','radar',?,'2026-11-08T11:05:00.000Z','failed','2026-11-08T11:05:00.000Z','not json')").run(conversationId);
  for (const run of ["run-1", "run-2"]) home.addMessage({ conversationId, channel: "api", direction: "inbound", externalId: "schedule:" + run, text: "Scheduled request" });
  ensureUsageTable(home);
  expect(home.db.prepare("SELECT provider,model,input_tokens,cached_tokens,output_tokens,reasoning_tokens,cost_ticks FROM turn_usage").all())
    .toEqual([{ provider: "grok", model: "grok-4.7", input_tokens: 1_051_097, cached_tokens: 946_688, output_tokens: 13_670, reasoning_tokens: 11_623, cost_ticks: 12_174_040_000 }]);
  home.db.prepare("DELETE FROM turn_usage").run();
  ensureUsageTable(home);
  expect(home.db.prepare("SELECT count(*) AS n FROM turn_usage").get()).toEqual({ n: 0 });
});
