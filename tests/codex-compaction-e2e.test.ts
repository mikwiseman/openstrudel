import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CodexEngineAdapter } from "../src/codex.js";
import { OpenStrudelRuntime } from "../src/runtime.js";

/** A model endpoint whose every reply reports 75% of the window used. A compaction request is answered with a summary, held
 * for `hold` ms when that is set, and dropped when Codex cancels it. */
async function model() {
  const requests: Array<{ at: number; compaction: boolean; input: string }> = [];
  let hold = 0;
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", chunk => { text += chunk; });
    request.on("end", () => {
      if (request.method !== "POST" || !/\/responses$/.test(request.url!)) { response.writeHead(404).end("{}"); return; }
      const body = JSON.parse(text), compaction = text.includes("CONTEXT CHECKPOINT COMPACTION");
      requests.push({ at: Date.now(), compaction, input: JSON.stringify(body.input) });
      const reply = compaction ? "Summary: the team asked about payroll." : "ok", id = "resp_" + requests.length;
      const item = { type: "message", id: "msg_" + requests.length, role: "assistant", status: "completed", content: [{ type: "output_text", text: reply, annotations: [] }] };
      const send = () => {
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [type, data] of [
          ["response.created", { response: { id, status: "in_progress", output: [] } }],
          ["response.output_item.added", { output_index: 0, item: { ...item, content: [] } }],
          ["response.output_text.delta", { output_index: 0, content_index: 0, item_id: item.id, delta: reply }],
          ["response.output_item.done", { output_index: 0, item }],
          ["response.completed", { response: { id, status: "completed", output: [item], usage: { input_tokens: 195_000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 195_005 } } }],
        ] as const) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        response.end();
      };
      if (compaction && hold) setTimeout(send, hold); else send();
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, requests, hold: (ms: number) => { hold = ms; },
    close: () => { server.closeAllConnections(); return new Promise<void>(done => server.close(() => done())); } };
}

const until = async (check: () => boolean, ms = 15_000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise(done => setTimeout(done, 20)); } };

it("compacts a large thread between turns on the real Codex app-server, and a message never waits for it", async () => {
  const provider = await model();
  const notes: Array<{ method: string; turn?: string; item?: string; status?: string }> = [];
  const notify = (CodexEngineAdapter.prototype as any).notification;
  vi.spyOn(CodexEngineAdapter.prototype as any, "notification").mockImplementation(function (this: unknown, message: any) {
    const p = message.params ?? {};
    if (/^(turn|item)\/(started|completed)$/.test(message.method)) notes.push({ method: message.method, turn: p.turn?.id ?? p.turnId, item: p.item?.type, status: p.turn?.status });
    return notify.call(this, message);
  });
  // The ten seconds of silence before a compaction, shortened for the test.
  const plan = (CodexEngineAdapter.prototype as any).compactBetweenTurns, timeout = globalThis.setTimeout;
  vi.spyOn(CodexEngineAdapter.prototype as any, "compactBetweenTurns").mockImplementation(function (this: unknown, ...args: unknown[]) {
    globalThis.setTimeout = ((run: () => void, ms?: number) => timeout(run, ms === 10_000 ? 300 : ms)) as typeof setTimeout;
    try { return plan.apply(this, args); } finally { globalThis.setTimeout = timeout; }
  });
  const root = mkdtempSync(join(tmpdir(), "openstrudel-compaction-e2e-"));
  vi.stubEnv("OPENSTRUDEL_CODEX_MODE", "");
  vi.stubEnv("OPENSTRUDEL_PROVIDER_XAI_BASE_URL", provider.url);
  const runtime = new OpenStrudelRuntime({ rootDirectory: root, dbPath: join(root, ".data/openstrudel.sqlite"), startTelegram: false, apiToken: "e2e" });
  const send = (text: string) => runtime.messages.handle({ channel: "api", text, externalChatId: "home" });
  const compactions = () => provider.requests.filter(request => request.compaction);
  try {
    runtime.store.setSetting("providers.xai.key", "xai-e2e-key");
    expect((await send("Сколько зп у Бориса?")).text).toBe("ok");
    // The resumed thread ends at 75% of its window: no compaction inside this turn, one after it once the chat is silent.
    expect((await send("А у Алины?")).text).toBe("ok");
    expect(compactions()).toHaveLength(0);
    await until(() => notes.some(note => note.method === "turn/completed" && notes.some(other => other.item === "contextCompaction" && other.turn === note.turn)));
    const compactTurn = notes.find(note => note.item === "contextCompaction")!.turn;
    expect(notes.filter(note => note.turn === compactTurn).map(note => [note.method, note.item ?? note.status])).toEqual([
      ["turn/started", "inProgress"], ["item/started", "contextCompaction"], ["item/completed", "contextCompaction"], ["turn/completed", "completed"],
    ]);
    expect(compactions()).toHaveLength(1);
    // The next message starts at once on the compacted history, with no compaction of its own.
    const asked = Date.now();
    expect((await send("Спасибо")).text).toBe("ok");
    const answered = provider.requests.at(-1)!;
    expect(answered.compaction).toBe(false);
    expect(answered.at - asked).toBeLessThan(3_000);
    expect(answered.input).toContain("Summary: the team asked about payroll.");
    expect(compactions()).toHaveLength(1);

    // A slow compaction is running when someone writes: it is interrupted and the message is answered right away.
    provider.hold(30_000);
    await until(() => compactions().length === 2);
    const writes = Date.now();
    expect((await send("И у Веры?")).text).toBe("ok");
    expect(Date.now() - writes).toBeLessThan(8_000);
    const second = notes.filter(note => note.method === "turn/completed" && note.turn === notes.filter(n => n.item === "contextCompaction").at(-1)!.turn);
    expect(second.map(note => note.status)).toEqual(["interrupted"]);
    // The thread kept its history: the interrupted compaction changed nothing.
    expect(provider.requests.at(-1)!.input).toContain("Спасибо");
  } finally {
    vi.restoreAllMocks(); await runtime.stop(); await provider.close(); vi.unstubAllEnvs();
    // A stopped Codex releases its thread-writer lock a moment later.
    for (let attempt = 0; attempt < 20 && existsSync(root); attempt++) { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); await new Promise(done => setTimeout(done, 300)); }
  }
}, 120_000);
