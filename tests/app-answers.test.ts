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
import { request } from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query as sdkQuery, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AcpEngine } from "../src/acp.js";
import { ClaudeEngine } from "../src/claude.js";
import { CodexEngineAdapter } from "../src/codex.js";
import { MessageService } from "../src/messages.js";
import { providerInfo } from "../src/providers.js";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { answerSchema, appEffort } from "../src/server.js";
import { saveConversationModelSelection, saveModelSelection } from "../src/model-settings.js";
import { Store } from "../src/store.js";
import type { CodexEngine } from "../src/types.js";

const schema = { type: "object", additionalProperties: false, required: ["films"],
  properties: { films: { type: "array", items: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string" } } } } } };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { wire.request.mockReset(); for (const c of cleanups.splice(0).reverse()) await c(); });

function send(port: number, path: string, token: string, body: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: "POST", rejectUnauthorized: false,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on("error", reject); req.end(JSON.stringify(body));
  });
}

it("accepts only a bounded object schema", () => {
  expect(answerSchema(undefined)).toBeUndefined();
  expect(answerSchema(null)).toBeUndefined();
  expect(answerSchema(schema)).toBe(schema);
  for (const wrong of ["{}", [], { type: "array" }, { type: "object", description: "x".repeat(70_000) }]) expect(() => answerSchema(wrong)).toThrow("Схема ответа");
});

it("gives a paired app its own main-assistant chat and the engine's structured answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "strudel-app-answers-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const seen: Array<Parameters<CodexEngine["run"]>[1]> = [];
  const engine: CodexEngine = { async run(_input, options) { seen.push(options); return { threadId: "app-thread", response: JSON.stringify({ films: [{ title: "Arrival" }] }), events: [] }; } };
  const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", engine, rootDirectory: root, startTelegram: false, apiToken: "test-owner", mobilePort: 0 });
  Object.assign((runtime.api.mobile as any).options, { host: "127.0.0.1", hostname: "127.0.0.1" });
  const address = await runtime.api.listen("127.0.0.1", 0);
  cleanups.push(() => runtime.stop());
  const invitation = await (await fetch(`http://127.0.0.1:${address.port}/v1/mobile/pairing`, { method: "POST", headers: { authorization: "Bearer test-owner", "content-type": "application/json" }, body: JSON.stringify({ owner: true }) })).json() as { url: string };
  const port = runtime.api.mobile.port!;
  const token = (await send(port, "/pair", new URL(invitation.url).searchParams.get("key")!, { name: "Cinema" })).body.token as string;

  const question = { text: "Next films", externalChatId: "app:cinema", title: "Cinema", externalId: "1f0c6d38-5a3e-4bbf-9a51-7a1d1ef0a001", outputSchema: schema };
  const answer = await send(port, "/v1/messages", token, question);
  expect(answer.status).toBe(200);
  expect(JSON.parse(answer.body.text)).toEqual({ films: [{ title: "Arrival" }] });
  expect(seen[0]).toMatchObject({ outputSchema: schema, byOwner: true });
  // The app's chat is the main assistant's own conversation, apart from the owner's main chat.
  expect(runtime.store.listConversations().find(c => c.id === answer.body.conversationId)).toMatchObject({ externalId: "app:cinema", title: "Cinema", profileId: null });
  // A retry of the same request returns the saved answer without another turn.
  expect((await send(port, "/v1/messages", token, question)).body.text).toBe(answer.body.text);
  expect(seen).toHaveLength(1);
  expect(await send(port, "/v1/messages", token, { ...question, externalId: "1f0c6d38-5a3e-4bbf-9a51-7a1d1ef0a002", outputSchema: { type: "string" } })).toMatchObject({ status: 400 });
  expect(seen).toHaveLength(1);
});

it("never answers a structured request with the help text", async () => {
  const store = new Store(":memory:"), seen: unknown[] = [];
  const messages = new MessageService(store, { async run(_input, options) { seen.push(options?.outputSchema); return { threadId: "t", response: "{\"films\":[]}", events: [] }; } });
  try {
    expect((await messages.handle({ channel: "api", text: "/help", externalChatId: "app:cinema", byOwner: true, outputSchema: schema })).text).toBe("{\"films\":[]}");
    expect(seen).toEqual([schema]);
  } finally { await messages.close(); store.close(); }
});

it("sends the schema with Codex's turn and only with that turn", async () => {
  const turns: any[] = [];
  wire.request.mockImplementation(async (method: string, params: any) => {
    if (method === "configRequirements/read") return { requirements: null };
    if (method === "model/list") return { data: [] };
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: "app-thread" } };
    if (method === "turn/start") {
      turns.push(params);
      queueMicrotask(() => {
        wire.notify?.({ method: "item/completed", params: { threadId: params.threadId, item: { type: "agentMessage", text: "{\"films\":[]}" } } });
        wire.notify?.({ method: "turn/completed", params: { threadId: params.threadId, turn: { status: "completed" } } });
      });
      return { turn: { id: "turn-" + turns.length } };
    }
    throw new Error(method);
  });
  const engine = new CodexEngineAdapter();
  try {
    await expect(engine.run("Next films", { outputSchema: schema })).resolves.toMatchObject({ response: "{\"films\":[]}" });
    await engine.run("An ordinary question", { threadId: "app-thread" });
    expect(turns[0].outputSchema).toEqual(schema);
    expect(turns[1]).not.toHaveProperty("outputSchema");
  } finally { engine.close(); }
});

it("asks Claude for the same JSON and returns its validated object", async () => {
  const root = mkdtempSync(join(tmpdir(), "strudel-app-claude-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const calls: Options[] = [];
  const query = (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Object.assign((async function* () {
    for await (const _ of prompt) { /* the turn's one message */ }
    calls.push(options);
    yield { type: "system", subtype: "init", session_id: "s-1" };
    yield { type: "result", subtype: "success", is_error: false, result: "Here are the films.", structured_output: { films: [{ title: "Arrival" }] }, session_id: "s-1" };
  })(), { interrupt: async () => {}, supportedModels: async () => [], close: () => {} })) as unknown as typeof sdkQuery;
  const engine = new ClaudeEngine({ root, provider: providerInfo("anthropic")!, key: () => "sk-test-key", query });
  expect((await engine.run("Next films", { outputSchema: schema })).response).toBe(JSON.stringify({ films: [{ title: "Arrival" }] }));
  expect(calls[0]!.outputFormat).toEqual({ type: "json_schema", schema });
  expect((await engine.run("Hi")).response).toBe("Here are the films.");
  expect(calls[1]!.outputFormat).toBeUndefined();
});

it("refuses a structured request on Grok instead of returning prose", async () => {
  const root = mkdtempSync(join(tmpdir(), "strudel-app-grok-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const engine = new AcpEngine({ root, provider: providerInfo("grok")!, command: () => { throw new Error("must not start"); } });
  await expect(engine.run("Next films", { outputSchema: schema })).rejects.toThrow("по схеме");
});

it("lets an app's chat think lighter until the owner chooses its model", async () => {
  expect(appEffort(undefined)).toBeUndefined();
  expect(appEffort("medium")).toBe("medium");
  for (const wrong of ["", "Medium", 3, "x".repeat(41)]) expect(() => appEffort(wrong)).toThrow("уровень");
  const store = new Store(":memory:"), seen: Array<string | null | undefined> = [];
  const messages = new MessageService(store, { async run(_input, options) { seen.push(options?.reasoningEffort); return { threadId: "t", response: "{}", events: [] }; } });
  try {
    saveModelSelection(store, { provider: "chatgpt", model: "gpt-6-astra", serviceTier: "default", reasoningEffort: "xhigh" });
    const app = { channel: "api" as const, externalChatId: "app:cinema", byOwner: true, outputSchema: schema };
    const first = await messages.handle({ ...app, text: "Next films", reasoningEffort: "medium" });
    await messages.handle({ ...app, text: "Next films without a level" });
    saveConversationModelSelection(store, first.conversationId, { provider: "chatgpt", model: "gpt-6-astra", serviceTier: "default", reasoningEffort: "high" });
    await messages.handle({ ...app, text: "Next films after the owner chose", reasoningEffort: "medium" });
    await messages.handle({ channel: "api", externalChatId: "home", byOwner: true, text: "The main chat keeps the device level" });
    expect(seen).toEqual(["medium", "xhigh", "high", "xhigh"]);
  } finally { await messages.close(); store.close(); }
});
