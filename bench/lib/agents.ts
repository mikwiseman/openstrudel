import Module from "node:module";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClaudeEngine } from "../../src/claude.js";
import { ScopedCodexEngine } from "../../src/scopes.js";
import type { ProviderInfo } from "../../src/providers.js";
import type { CodexEngine, CodexRunResult } from "../../src/types.js";
import type { Memory } from "./memory.js";

type RunOptions = NonNullable<Parameters<CodexEngine["run"]>[1]>;

/** The models a run can name. Built-in agents are scripts: they prove what the graders let through. */
export const CODEX_MODELS = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
export const CLAUDE_MODELS = ["claude-opus-5-5", "claude-fable-5-2", "claude-fable-5-1"];
export const BUILTIN = ["null", "refuse", "ask", "reference"] as const;
export type Builtin = typeof BUILTIN[number];
export const engineOf = (model: string): "builtin" | "codex" | "claude" =>
  (BUILTIN as readonly string[]).includes(model) ? "builtin" : model.startsWith("claude-") ? "claude" : "codex";

/** Where the signed-in accounts live. Nothing from them is copied, printed or written back. */
export const CODEX_HOME = process.env.STRUDELBENCH_CODEX_HOME ?? resolve(homedir(), ".openaccs/codex/64466aec9b5a0f59/Home");
export const CLAUDE_CONFIG_DIR = process.env.STRUDELBENCH_CLAUDE_CONFIG_DIR ?? resolve(homedir(), "Library/Application Support/OpenAccs/Claude Code/cli-5321A974-C8C3-4CE8-825D-862BAF2462AC");
/** The Codex release that knows the newest models. The repository's pinned release (`pinned`) does not offer gpt-6.1-sol to a ChatGPT account. */
export const CODEX_BIN = process.env.STRUDELBENCH_CODEX_BIN ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";

export interface ToolCall { turn: number; tool: string; args: unknown; ok: boolean; result: string; ms: number }
export interface Turn { n: number; context: string; scheduled: boolean; input: string; response?: string; error?: string; seconds: number;
  /** Input includes cached tokens and output includes reasoning, as the Home's own `turn.usage` counts them. */
  tokens: { input: number; cached: number; output: number }; native: Record<string, number> }
export interface AgentLog { turns: Turn[]; calls: ToolCall[]; modelRan?: string; notes: string[] }
export interface ReferenceTools { call(name: string, args: Record<string, unknown>): Promise<any>; recall(question: string): Promise<any>; options: RunOptions }
export type ReferenceStep = (tools: ReferenceTools, input: string) => Promise<string>;
export interface Agent { engine: CodexEngine; log: AgentLog; version: string; bind(memory: Memory): void; close(): Promise<void> }

const clip = (text: string, max = 4_000) => text.length > max ? text.slice(0, max) + `… (${text.length} characters)` : text;

/** The chosen Codex release answers where the repository's code looks for its pinned one: a small launcher in its place.
 * The engine code is the repository's own and is not changed. */
let launcher: string | undefined;
function useCodexRelease(binary: string): void {
  if (binary === "pinned" || launcher) return;
  if (!existsSync(binary)) throw new Error(`Codex is not at ${binary}. Set STRUDELBENCH_CODEX_BIN, or "pinned" for the repository's own release.`);
  launcher = join(tmpdir(), "strudelbench-codex-" + process.pid);
  mkdirSync(join(launcher, "bin"), { recursive: true });
  writeFileSync(join(launcher, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.0.0-strudelbench", type: "module" }));
  writeFileSync(join(launcher, "bin/codex.js"), `import { spawn } from "node:child_process";
const child = spawn(${JSON.stringify(binary)}, process.argv.slice(2), { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
child.on("error", () => process.exit(127));
`);
  const original = (Module as any)._resolveFilename;
  (Module as any)._resolveFilename = function (request: string, ...rest: unknown[]) {
    return request === "@openai/codex/package.json" ? join(launcher!, "package.json") : original.call(this, request, ...rest);
  };
}

/** The account's current access token, read when a run starts and held in memory. The harness never refreshes it, so the
 * signed-in home is never written and its refresh token never rotates; an expired token is the owner's own app's to renew. */
export async function codexTokens() {
  const saved = JSON.parse(readFileSync(resolve(CODEX_HOME, "auth.json"), "utf8"));
  const accessToken = saved.tokens?.access_token, chatgptAccountId = saved.tokens?.account_id;
  if (typeof accessToken !== "string" || typeof chatgptAccountId !== "string") throw new Error("The Codex home is not signed in with ChatGPT.");
  const claims = JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64url").toString());
  if (claims.exp * 1000 < Date.now() + 60_000) throw new Error("The Codex access token has expired. Open Codex with that account once, then run again.");
  return { accessToken, chatgptAccountId, chatgptPlanType: claims["https://api.openai.com/auth"]?.chatgpt_plan_type as string | undefined };
}

function codexEngine(root: string, binary: string): { engine: CodexEngine; version: string } {
  useCodexRelease(binary);
  // No live web inside a trial.
  process.env.OPENSTRUDEL_WEB_SEARCH_MODE = "disabled";
  const scoped = new ScopedCodexEngine(root, join(root, ".data/codex"), () => codexTokens());
  let version = "pinned";
  try { if (binary !== "pinned") version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(); } catch { /* The run itself will say what is wrong. */ }
  return { version, engine: { forContext: context => scoped.forContext(context), run: (input, options) => scoped.forContext("personal").run(input, options), close: () => scoped.close() } };
}

const CLAUDE: ProviderInfo = { id: "anthropic", name: "Anthropic", engine: "claude", baseUrl: "https://api.anthropic.com", auth: "x-api-key", keysUrl: "", webSearch: false,
  models: CLAUDE_MODELS.map(id => ({ id, name: id, contextWindow: 1_000_000, images: true })) };

function claudeEngine(root: string): { engine: CodexEngine; version: string } {
  // The repository's engine starts the CLI with a key and its own profile folder. Its test seam swaps the environment for the
  // signed-in subscription profile; everything else (instructions, tools, sandbox, permissions) stays the engine's own.
  const query = ((input: any) => {
    const env = { ...input.options.env, CLAUDE_CONFIG_DIR, HOME: homedir() };
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete env[name];
    return sdkQuery({ ...input, options: { ...input.options, env, disallowedTools: [...input.options.disallowedTools ?? [], "WebFetch", "WebSearch"] } });
  }) as typeof sdkQuery;
  const engine = new ClaudeEngine({ root, provider: CLAUDE, key: () => "subscription", query });
  // A model the CLI's catalog does not list yet still takes the usual levels.
  const catalog = engine.models.bind(engine), levels = ["low", "medium", "high", "xhigh", "max"].map(id => ({ id, name: id, description: "" }));
  engine.models = async refresh => (await catalog(refresh).catch(() => CLAUDE.models.map(model => ({ ...model, description: "", provider: "anthropic", speeds: [], reasoningEfforts: [] }) as any)))
    .map(model => model.reasoningEfforts?.length ? model : { ...model, reasoningEfforts: levels });
  return { version: "claude-agent-sdk", engine: { forContext: context => engine.forContext(context), run: (input, options) => engine.run(input, options), close: () => engine.close() } };
}

const SCRIPTS: Record<Exclude<Builtin, "reference">, string> = {
  /** Answers nothing and calls no tool. */
  null: "",
  refuse: "I can't do that.",
  ask: "Could you tell me a bit more about what exactly you need?",
};

/** One agent for one trial. Every turn the Home starts passes through here: its input, its tool calls, what it spent. */
export function makeAgent(model: string, effort: string, directory: string, reference: ReferenceStep[] = [], options: { codexBin?: string } = {}): Agent {
  const root = join(directory, "home"), kind = engineOf(model), log: AgentLog = { turns: [], calls: [], notes: [] };
  let memory: Memory | undefined, running = model;
  const real = kind === "codex" ? codexEngine(root, options.codexBin ?? CODEX_BIN) : kind === "claude" ? claudeEngine(root) : undefined;

  const scripted = async (input: string, options: RunOptions, turn: number): Promise<CodexRunResult> => {
    options.onEvent?.({ type: "thread.started", payload: { threadId: "scripted" } });
    const step = model === "reference" ? reference[turn] : undefined;
    const response = model === "reference"
      ? step ? await step({ options, call: (name, args) => options.tools!.call(name, args), recall: question => memory!.ask(question) }, input) : "NO_REPLY"
      : SCRIPTS[model as Exclude<Builtin, "reference">];
    return { threadId: "scripted", response, events: [] };
  };

  const run = async (context: string, input: string, options: RunOptions = {}): Promise<CodexRunResult> => {
    const n = log.turns.length, started = Date.now();
    const turn: Turn = { n, context, scheduled: options.scheduled === true, input, seconds: 0, tokens: { input: 0, cached: 0, output: 0 }, native: {} };
    log.turns.push(turn);
    const tools = options.tools && { definitions: options.tools.definitions, call: async (name: string, args: Record<string, unknown>) => {
      const at = Date.now();
      try { const result = await options.tools!.call(name, args); log.calls.push({ turn: n, tool: name, args, ok: true, result: clip(JSON.stringify(result) ?? ""), ms: Date.now() - at }); return result; }
      catch (error) { log.calls.push({ turn: n, tool: name, args, ok: false, result: clip(error instanceof Error ? error.message : String(error)), ms: Date.now() - at }); throw error; }
    } };
    const onEvent: RunOptions["onEvent"] = event => {
      if (event.type === "turn.usage") {
        const report = event.payload as any;
        turn.tokens.input += report.usage?.inputTokens ?? 0; turn.tokens.cached += report.usage?.cachedReadTokens ?? 0; turn.tokens.output += report.usage?.outputTokens ?? 0;
        log.modelRan = Object.keys(report.usage?.modelUsage ?? {}).join("+") || report.model || log.modelRan;
      }
      // Codex names each thing it did; the Claude engine reports only that it is working.
      const item = event.type === "item/completed" ? (event.payload as any)?.item?.type : undefined;
      if (item && !["userMessage", "agentMessage", "reasoning"].includes(item)) turn.native[item] = (turn.native[item] ?? 0) + 1;
      options.onEvent?.(event);
    };
    const attempt = () => real
      // The trial's model and level replace the Home's own choice, at the ordinary speed, on every turn.
      ? (real.engine.forContext?.(context) ?? real.engine).run(input, { ...options, provider: kind === "claude" ? "anthropic" : "chatgpt", model: running, reasoningEffort: effort, serviceTier: null, fast: false, tools, onEvent })
      : scripted(input, { ...options, tools }, n);
    try {
      let result: CodexRunResult;
      try { result = await attempt(); }
      catch (error) {
        // A newer Claude the CLI refuses falls back once to the one before it, before anything was done; the result says which ran.
        const refused = running === "claude-fable-5-2" && !log.calls.some(call => call.turn === n) && /model|not.?found|404|invalid|unknown|unavailable|access/i.test(String(error));
        if (!refused) throw error;
        log.notes.push(`claude-fable-5-2 was refused (${String(error).slice(0, 160)}); ran claude-fable-5-1.`);
        running = "claude-fable-5-1";
        result = await attempt();
      }
      turn.response = result.response;
      return result;
    } catch (error) { turn.error = error instanceof Error ? error.message : String(error); throw error; }
    finally { turn.seconds = (Date.now() - started) / 1000; }
  };

  return { log, version: real?.version ?? "script", bind(found) { memory = found; },
    engine: { forContext: context => ({ run: (input, options) => run(context, input, options) }), run: (input, options) => run("personal", input, options), close: () => real?.engine.close?.() },
    async close() { real?.engine.close?.(); } };
}
