import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { wire.request.mockReset(); vi.useRealTimers(); });
const WINDOW = 258_400;
const calls: string[] = [];
function serve(compact: () => Promise<unknown> = async () => ({})) {
  calls.length = 0;
  wire.request.mockImplementation(async (method: string, params: any) => {
    if (!["configRequirements/read", "model/list"].includes(method)) calls.push(method);
    if (method === "configRequirements/read") return { requirements: null };
    if (method === "model/list") return { data: [{ model: "gpt-6-astra", displayName: "GPT-6-Astra", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] }] };
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: params.threadId ?? "group-thread" } };
    if (method === "thread/unsubscribe" || method === "thread/inject_items" || method === "turn/interrupt") return {};
    if (method === "turn/start") { const id = "turn-" + calls.length; queueMicrotask(() => wire.notify?.({ method: "turn/started", params: { threadId: params.threadId, turn: { id } } })); return { turn: { id } }; }
    if (method === "thread/compact/start") return compact();
    throw new Error(method);
  });
}
/** One turn whose last model call carried `input` tokens of the model's window. */
async function turn(engine: CodexEngineAdapter, input: number, options: Record<string, unknown> = {}) {
  const started = new Promise<void>(resolve => {
    const original = wire.request.getMockImplementation()!;
    wire.request.mockImplementation(async (method: string, params: any) => {
      const result = await original(method, params);
      if (method === "turn/start") queueMicrotask(resolve);
      return result;
    });
  });
  const run = engine.run("зп Бориса", { model: "gpt-6-astra", serviceTier: "default", ...options });
  await started;
  const thread = String(options.threadId ?? "group-thread");
  const usage = { totalTokens: input + 100, inputTokens: input, cachedInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 };
  wire.notify?.({ method: "thread/tokenUsage/updated", params: { threadId: thread, turnId: "t", tokenUsage: { total: usage, last: usage, modelContextWindow: WINDOW } } });
  wire.notify?.({ method: "turn/completed", params: { threadId: thread, turn: { status: "completed" } } });
  return run;
}
/** What the real app-server (Codex 0.156.1) sends for `thread/compact/start`: a turn of its own around a contextCompaction item. */
function compactionTurn(id: string, status = "completed") {
  wire.notify?.({ method: "turn/started", params: { threadId: "group-thread", turn: { id, status: "inProgress" } } });
  wire.notify?.({ method: "item/started", params: { threadId: "group-thread", turnId: id, item: { type: "contextCompaction", id: "c" } } });
  return () => {
    wire.notify?.({ method: "item/completed", params: { threadId: "group-thread", turnId: id, item: { type: "contextCompaction", id: "c" } } });
    wire.notify?.({ method: "turn/completed", params: { threadId: "group-thread", turn: { id, status } } });
  };
}
const silence = () => vi.advanceTimersByTimeAsync(10_000);

it("compacts a thread near its context limit once it falls silent, so the next person does not wait for it", async () => {
  serve();
  const engine = new CodexEngineAdapter({});
  await turn(engine, 50_000);
  // A resumed thread that ended past 70% of its window is compacted after ten seconds without a turn.
  await turn(engine, 190_000, { threadId: "group-thread" });
  await vi.advanceTimersByTimeAsync(9_000);
  expect(calls).not.toContain("thread/compact/start");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(wire.request).toHaveBeenLastCalledWith("thread/compact/start", { threadId: "group-thread" });
  const finish = compactionTurn("compact-1");
  finish();
  // The next message starts at once, with nothing to interrupt.
  calls.length = 0;
  await turn(engine, 60_000, { threadId: "group-thread" });
  expect(calls).toContain("turn/start");
  expect(calls).not.toContain("turn/interrupt");
  expect(calls).not.toContain("thread/compact/start");
});

it("lets a message that comes first go ahead: a planned compaction is dropped and a running one interrupted", async () => {
  serve();
  const engine = new CodexEngineAdapter({});
  await turn(engine, 50_000);
  // A queued run a second later: no compaction starts under it.
  await turn(engine, 190_000, { threadId: "group-thread" });
  await vi.advanceTimersByTimeAsync(1_000);
  calls.length = 0;
  await turn(engine, 195_000, { threadId: "group-thread" });
  expect(calls).toContain("turn/start");
  expect(calls).not.toContain("thread/compact/start");
  // Silence after that turn: the compaction starts; then someone writes while it runs.
  await silence();
  expect(calls.at(-1)).toBe("thread/compact/start");
  const finish = compactionTurn("compact-2", "interrupted");
  calls.length = 0;
  const next = engine.run("зп Бориса", { model: "gpt-6-astra", serviceTier: "default", threadId: "group-thread" });
  await vi.advanceTimersByTimeAsync(0);
  expect(wire.request).toHaveBeenLastCalledWith("turn/interrupt", { threadId: "group-thread", turnId: "compact-2" }, 5_000);
  expect(calls).not.toContain("turn/start");
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toContain("turn/start");
  // The compaction's end is not the answer's: the person's own turn still decides it.
  wire.notify?.({ method: "item/completed", params: { threadId: "group-thread", item: { type: "agentMessage", text: "Борису 120 000." } } });
  wire.notify?.({ method: "turn/completed", params: { threadId: "group-thread", turn: { status: "completed" } } });
  expect((await next).response).toBe("Борису 120 000.");
});

it("leaves a smaller thread, a new thread and an ephemeral run as they are, and goes on if compaction cannot start", async () => {
  serve(async () => { throw new Error("busy"); });
  const engine = new CodexEngineAdapter({});
  await turn(engine, 230_000);
  await turn(engine, 150_000, { threadId: "group-thread" });
  await turn(engine, 230_000, { threadId: "group-thread", ephemeral: true });
  await silence();
  expect(calls).not.toContain("thread/compact/start");
  await turn(engine, 230_000, { threadId: "group-thread" });
  await silence();
  expect(calls.at(-1)).toBe("thread/compact/start");
  // The refusal releases the thread at once.
  calls.length = 0;
  await turn(engine, 60_000, { threadId: "group-thread" });
  expect(calls).toContain("turn/start");
});

it("counts a compaction made between turns in the turn that follows it, as one made inside a turn is", async () => {
  serve();
  const engine = new CodexEngineAdapter({});
  const tokens = (input: number, output: number) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 });
  const reading = (total: ReturnType<typeof tokens>, last: ReturnType<typeof tokens>) => ({ method: "thread/tokenUsage/updated", params: { threadId: "group-thread", turnId: "t", tokenUsage: { total, last, modelContextWindow: WINDOW } } });
  await turn(engine, 50_000);
  const reports: any[] = [];
  const onEvent = (event: any) => { if (event.type === "turn.usage") reports.push(event.payload); };
  // The turn before: its last call carried 200,000 tokens, so the thread is compacted after it.
  const before = new Promise<void>(resolve => { const original = wire.request.getMockImplementation()!; wire.request.mockImplementation(async (m: string, p: any) => { const r = await original(m, p); if (m === "turn/start") queueMicrotask(resolve); return r; }); });
  const first = engine.run("Отчёт", { model: "gpt-6-astra", serviceTier: "default", threadId: "group-thread", onEvent });
  await before;
  wire.notify?.(reading(tokens(400_000, 1_000), tokens(200_000, 500)));
  wire.notify?.({ method: "turn/completed", params: { threadId: "group-thread", turn: { status: "completed" } } });
  await first;
  await silence();
  // The compaction's own model call, read while no turn runs.
  const finish = compactionTurn("compact-3");
  wire.notify?.(reading(tokens(600_000, 6_000), tokens(200_000, 5_000)));
  finish();
  // The next turn: Codex repeats the last reading, then one small call.
  const after = new Promise<void>(resolve => { const original = wire.request.getMockImplementation()!; wire.request.mockImplementation(async (m: string, p: any) => { const r = await original(m, p); if (m === "turn/start") queueMicrotask(resolve); return r; }); });
  const second = engine.run("зп Бориса", { model: "gpt-6-astra", serviceTier: "default", threadId: "group-thread", onEvent, usageBaseline: reports[0].engine.totals });
  await after;
  wire.notify?.(reading(tokens(600_000, 6_000), tokens(200_000, 5_000)));
  wire.notify?.({ method: "item/started", params: { threadId: "group-thread", item: { type: "agentMessage" } } });
  wire.notify?.(reading(tokens(630_000, 6_100), tokens(30_000, 100)));
  wire.notify?.({ method: "turn/completed", params: { threadId: "group-thread", turn: { status: "completed" } } });
  await second;
  expect(reports[1].usage).toMatchObject({ inputTokens: 230_000, outputTokens: 5_100 });
});
