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
import { providerInfo } from "../src/providers.js";
afterEach(() => wire.request.mockReset());

function serve(catalog: any[] = []) {
  wire.request.mockImplementation(async (method: string, params: any) => {
    if (method === "configRequirements/read") return { requirements: null };
    if (method === "model/list") return { data: catalog };
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: "provider-thread" } };
    if (method === "thread/unsubscribe") return {};
    if (method === "turn/start") { queueMicrotask(() => wire.notify?.({ method: "turn/completed", params: { threadId: params.threadId, turn: { status: "completed" } } })); return { turn: { id: "turn" } }; }
    throw new Error(method);
  });
}
const calls = (method: string) => wire.request.mock.calls.filter(([m]) => m === method).map(([, params]) => params);

it("defines the key provider on every thread start and resume, without ChatGPT credentials, apps or web search", async () => {
  serve();
  let key = "xai-first";
  const engine = new CodexEngineAdapter({ provider: { info: providerInfo("xai")!, key: () => key } });
  try {
    // This provider declares no effort support; leave the vendor's default alone.
    expect((await engine.models()).map(m => [m.provider, m.id, m.isDefault, m.defaultReasoningEffort])).toEqual([["xai", "grok-4.7", true, undefined], ["xai", "grok-4.5", false, undefined]]);
    const employees: any[] = [{ id: "e", name: "Helper", instructions: "", capabilities: [], tokenLimit: null, createdAt: "", provider: "xai", model: "grok-4.5", serviceTier: "default" }];
    await engine.run("Hello", { model: "grok-4.7", serviceTier: "default", approvalMode: "ask", employees });
    const [start] = calls("thread/start");
    expect(start.modelProvider).toBe("openstrudel-xai");
    expect(start.model).toBe("grok-4.7");
    expect(start).not.toHaveProperty("serviceTier");
    expect(start.config["model_providers.openstrudel-xai"]).toEqual({ name: "xAI", base_url: "https://api.x.ai/v1", wire_api: "responses", experimental_bearer_token: "xai-first" });
    expect(start.config).toMatchObject({ "features.apps": false, web_search: "disabled", model_context_window: 500_000, model_auto_compact_token_limit: 450_000 });
    expect(start.config).not.toHaveProperty("model_reasoning_effort");
    expect(start.approvalsReviewer).toBe("user");
    // The employee answers and acts; Codex does not stop the turn with a question card.
    expect(start.config).not.toHaveProperty("features.default_mode_request_user_input");
    expect(start.developerInstructions).not.toContain("request_user_input");
    expect(start.developerInstructions).toContain("state the assumption in one short line");
    const [turn] = calls("turn/start");
    expect(turn).toMatchObject({ model: "grok-4.7" });
    expect(turn).not.toHaveProperty("effort");
    expect(turn).not.toHaveProperty("serviceTier");
    expect(wire.request.mock.calls.some(([m]) => ["account/login/start", "model/list", "configRequirements/read"].includes(m))).toBe(false);
    expect(JSON.stringify(calls("turn/start"))).not.toContain("xai-first");

    // A replaced key reaches the next turn: the loaded thread is reopened with it.
    key = "xai-second";
    await engine.run("Again", { threadId: "provider-thread", model: "grok-4.5", serviceTier: "default", employees });
    expect(calls("thread/unsubscribe")).toEqual([{ threadId: "provider-thread" }]);
    const [resume] = calls("thread/resume");
    expect(resume).toMatchObject({ threadId: "provider-thread", modelProvider: "openstrudel-xai", model: "grok-4.5" });
    expect(resume.config["model_providers.openstrudel-xai"].experimental_bearer_token).toBe("xai-second");
  } finally { engine.close(); }
});

it("uses Codex's own catalog, speeds and web search for the OpenAI API", async () => {
  serve([{ model: "gpt-api", isDefault: true, defaultReasoningEffort: "high", serviceTiers: [{ id: "priority", name: "Fast" }] }]);
  const engine = new CodexEngineAdapter({ provider: { info: providerInfo("openai")!, key: () => "sk-api" } });
  try {
    expect((await engine.models()).map(m => [m.provider, m.id])).toEqual([["openai", "gpt-api"]]);
    await engine.run("Hello", { model: null, serviceTier: "priority" });
    const [start] = calls("thread/start");
    expect(start).toMatchObject({ modelProvider: "openstrudel-openai", model: "gpt-api", serviceTier: "priority" });
    expect(start.config).toMatchObject({ "features.apps": false, web_search: "live", model_reasoning_effort: "high" });
    expect(start.config).not.toHaveProperty("model_context_window");
    expect(calls("turn/start")[0]).toMatchObject({ model: "gpt-api", effort: "high", serviceTier: "priority" });
  } finally { engine.close(); }
});
