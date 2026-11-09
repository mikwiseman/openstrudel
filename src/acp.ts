import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { stringify } from "smol-toml";
import { stdioBridge, toolBridge } from "./acp-mcp.js";
import { agentInstructions, contextServers, hostEnvironment, imageType, insideWorkspace, physical } from "./claude.js";
import { HomeError } from "./home.js";
import { modelReasoning, reasoningChoices, type ModelChoice } from "./model-settings.js";
import { ProviderIncident, providerFailure, type ProviderInfo } from "./providers.js";
import { contextPattern } from "./scopes.js";
import type { CodexEngine, CodexRunResult } from "./types.js";

export type GrokCommand = { bin: string; args: string[]; env?: Record<string, string> };
export interface AcpEngineOptions {
  /** Home root; private state lives under `<root>/.data`. */
  root: string;
  /** The `grok` subscription provider. */
  provider: ProviderInfo;
  /** Test seam for the pinned CLI. */
  command?: () => GrokCommand;
  /** The agent's model catalog, from every session it opens. */
  onModels?: (models: ModelChoice[]) => void;
}
type RunOptions = NonNullable<Parameters<CodexEngine["run"]>[1]>;

/** `bin/grok` sits beside `dist` in the Mac app's Runtime, the Docker image and a source checkout (scripts/extract-grok.mjs). */
const runtime = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The pinned Grok Build, unmodified, with its own update checks off. */
export const grokCommand = (): GrokCommand => ({ bin: resolve(runtime, "bin/grok"), args: ["--no-auto-update"] });

/** Grok's own home on this Home device: it signs in, keeps its token, sessions and memory there,
 * and reads no ~/.grok, ~/.claude or ~/.codex of the owner. Its `sandbox.toml` holds the profile every turn runs under. */
export function grokHome(root: string): string {
  const dir = resolve(root, ".data/providers/grok/home");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const home = realpathSync(dir);
  // Grok's own kernel sandbox, as the Claude engine's: the workspace, system paths and installed tools are readable, never the
  // Home's keys and data, other workspaces or the owner's files. Its home stays writable for its sign-in, sessions and memory,
  // and Grok keeps this file read-only. A custom profile Grok cannot apply stops it instead of running unprotected.
  writeFileSync(resolve(home, "sandbox.toml"), stringify({ profiles: { openstrudel: { extends: "strict", restrict_network: false, read_write: [home],
    read_only: ["/opt/homebrew", "/usr/local"].filter(tools => existsSync(tools)) } } }), { mode: 0o600 });
  return home;
}

/** One `grok` process in its own process group, so nothing it starts outlives it. Its environment is the host allowlist,
 * so no XAI_API_KEY bills another account. Grok's cross-session memory is off (GROK_MEMORY=0 outranks Grok's own and remote
 * settings): its notes steered the employee unseen, and it wrote them outside the workspace, which a schedule cannot approve. */
export function launchGrok(command: GrokCommand, args: string[], cwd: string, home: string) {
  const child = spawn(command.bin, [...command.args, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true,
    env: { ...hostEnvironment(), ...command.env, HOME: home, GROK_HOME: home, GROK_DISABLE_AUTOUPDATER: "1", GROK_MEMORY: "0" } });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8192); });
  child.stdin!.on("error", () => {});
  const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} };
  const closed = new Promise<void>(done => { child.once("close", () => { kill(); done(); }); child.once("error", () => done()); });
  return { child, kill, closed, diagnostics: () => stderr, stderr: () => stderr.split("\n").map(line => line.trim()).filter(Boolean).pop() ?? "" };
}

/** Grok lost its sign-in (`-32000`). The owner signs in again in Accounts. */
export class ProviderSignInError extends ProviderIncident {
  constructor(readonly provider: ProviderInfo) { super(`Войдите в ${provider.name} снова в настройках аккаунтов.`, 409, "auth:" + provider.id); }
}
/** Grok no longer knows the saved session, or it started with other rules; the route starts a new one seeded with the chat. */
export class AcpSessionLost extends Error {}
/** Grok ended the turn after a refused tool call. Its words carry the tool's title and the path the model chose, so they are the
 * Home's own: never read as a limit or an account problem. */
export class AcpRefusal extends HomeError {}

const instructions = agentInstructions();
const stopped = () => new Error("Ответ остановлен");
/** -32000 is Grok's "authentication required"; one caused by an unreachable sign-in server is an outage, not a lost sign-in. */
const signedOut = (error: unknown) => error instanceof acp.RequestError && error.code === -32000 && !/error sending request|timed out/i.test(error.message);
const defined = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, v]) => v != null)) as Partial<T>;

/** Grok Build over ACP, as Zed runs it: the agent owns its sign-in, permissions and memory. OpenStrudel runs it
 * under Grok's own sandbox in the employee's workspace, passes the employee tools and services as MCP, answers its permission requests once at a
 * time from its own approvals, and resumes its session. One process per turn. */
export class AcpEngine implements CodexEngine {
  private readonly running = new Set<() => void>();
  constructor(readonly options: AcpEngineOptions) {}
  forContext(context: string): CodexEngine {
    if (!contextPattern.test(context)) throw new Error("Область не найдена");
    return { run: (input, options) => this.turn(context, input, options) };
  }
  run: CodexEngine["run"] = (input, options) => this.forContext("personal").run(input, options);
  close(): void { for (const end of this.running) end(); }

  /** The agent's own catalog for the picker until a turn reports one, from a scratch session that sends no prompt. */
  async models(): Promise<ModelChoice[]> {
    const { root, provider } = this.options, agent = this.launch(resolve(root, ".data/providers", provider.id, "scratch")), timer = setTimeout(agent.kill, 60_000);
    try {
      return await acp.client({ name: "openstrudel" }).connectWith(agent.stream, async ctx => {
        await open(ctx);
        return catalog(provider, (await ctx.request("session/new", { cwd: agent.cwd, mcpServers: [] })).configOptions);
      });
    } finally { clearTimeout(timer); agent.child.stdin!.end(); const grace = setTimeout(agent.kill, 5000); await agent.closed; clearTimeout(grace); }
  }

  private launch(workspace: string) {
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const cwd = realpathSync(workspace), agent = launchGrok((this.options.command ?? grokCommand)(), ["--sandbox", "openstrudel", "agent", "stdio"], cwd, grokHome(this.options.root));
    return { ...agent, cwd, stream: acp.ndJsonStream(Writable.toWeb(agent.child.stdin!), Readable.toWeb(agent.child.stdout!) as ReadableStream<Uint8Array>) };
  }

  private async turn(context: string, input: string, options: RunOptions = {}): Promise<CodexRunResult> {
    if (options.signal?.aborted) throw stopped();
    // ACP has no structured final answer; an app must not receive prose it would read as data.
    if (options.outputSchema) throw new Error("Grok не умеет отвечать приложению по схеме. Выберите для этого чата модель ChatGPT, OpenAI или Claude.");
    // Grok applies the rules only when a session starts, so the saved thread is the session with a hash of its rules.
    const rules = instructions + (options.profile ? `\n\nCurrent employee SOUL (authoritative):\n${options.profile}` : "");
    const signed = "#" + createHash("sha256").update(rules).digest("hex").slice(0, 16);
    if (options.threadId && !options.threadId.endsWith(signed)) throw new AcpSessionLost("The employee's rules changed.");
    const { root, provider } = this.options, approveAll = options.approvalMode === "approve_all";
    const agent = this.launch(resolve(root, ".data/workspace", context)), cwd = agent.cwd, calls = new Map<string, acp.ToolCallUpdate>();
    let sessionId = options.threadId?.slice(0, -signed.length) ?? "", response = "", afterTool = false, prompting = false, halted = false, timer: NodeJS.Timeout | undefined;
    // The scratch files this turn created, the last call it was refused, and what it spent.
    const created = new Set<string>(), temp = scratchDirectories(), home = realpathSync(root);
    let refused: string | undefined, usage: unknown, billing: unknown;
    let ctx: acp.ClientContext | undefined, bridge: Awaited<ReturnType<typeof toolBridge>> | undefined;
    const bridges: Array<Awaited<ReturnType<typeof stdioBridge>>> = [];
    // Grok gets session/cancel and its pending questions answer "cancelled"; one that ignores it is killed after 5 s.
    let halt!: (error: Error) => void;
    const halting = new Promise<never>((_, reject) => { halt = reject; });
    halting.catch(() => {});
    const ask = options.onRequest && ((method: string, params: Record<string, any>) => Promise.race([options.onRequest!(method, params), halting]) as Promise<any>);
    const stop = () => { if (halted) return; halted = true; halt(stopped()); if (prompting) void ctx?.notify("session/cancel", { sessionId }).catch(() => {}); timer = setTimeout(agent.kill, 5000); };
    const end = () => { halted = true; agent.kill(); };
    this.running.add(end);
    options.signal?.addEventListener("abort", stop, { once: true });

    /** As with the Claude engine, the workspace is readable and writable without asking and nothing beyond it is readable.
     * Changes beyond it need the owner. Approve-all runs sandboxed commands and services by itself. Fetches stay with Grok.
     * Grok also keeps scratch files in the OS temp directory, never a path into this Home. Approve-all commands already read and
     * write there, so under approve-all it is open like the workspace. Otherwise a turn may create new files there and use the
     * ones it created, never another turn's. Paths count once normalized and with links followed. */
    const temporary = (target: string) => temp.some(dir => within(dir, target)) && !within(home, target);
    const scratch = (path: string) => { const target = physical(resolve(cwd, path)); return !existsSync(target) && temporary(target); };
    const ours = (path: string) => { const target = physical(resolve(cwd, path)); return insideWorkspace(cwd, path) || created.has(target) || approveAll && temporary(target); };
    const allowed = async (update: acp.ToolCallUpdate): Promise<boolean> => {
      const call = { ...calls.get(update.toolCallId), ...defined(update) }, title = call.title ?? "", input = (call.rawInput ?? {}) as Record<string, any>;
      const locations = (call.locations ?? []).map(l => l.path), inside = locations.every(ours);
      if (call.kind === "read" || call.kind === "search") return inside;
      if (call.kind === "fetch" || call.kind === "think") return true;
      const change = call.kind === "edit" || call.kind === "delete" || call.kind === "move";
      if (change && locations.length && locations.every(path => ours(path) || scratch(path))) {
        for (const path of locations) if (!insideWorkspace(cwd, path)) created.add(physical(resolve(cwd, path)));
        return true;
      }
      // Grok names an MCP tool `<server>__<tool>`; the kind decides first, so a command named like one is still a command.
      const service = call.kind === "execute" || change ? null : /^(?:mcp__)?([\w-]+?)__(\S+)$/.exec(call.name ?? title);
      if (service?.[1] === "openstrudel") return true;
      if (approveAll) return !change;
      if (!ask) return false;
      if (call.kind === "execute") return (await ask("item/commandExecution/requestApproval", { command: input.command ?? title, cwd, reason: title }))?.decision === "accept";
      if (change) return (await ask("item/fileChange/requestApproval", { reason: [title, ...(call.locations ?? []).map(l => l.path)].join(" ") }))?.decision === "accept";
      if (!service) return false;
      return (await ask("mcpServer/elicitation/request", { mode: "form", serverName: service[1], message: `Allow the ${service[1]} MCP server to run tool "${service[2]}"?`,
        requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", tool_params: input } }))?.action === "accept";
    };

    let result: acp.PromptResponse | undefined, failure: unknown;
    try {
      result = await acp.client({ name: "openstrudel" })
        .onNotification("session/update", ({ params: { sessionId: id, update } }) => {
          // A loaded session replays its history before the prompt.
          if (!prompting || id !== sessionId) return;
          if (["tool_call","tool_call_update","agent_message_chunk"].includes(update.sessionUpdate)) options.onEvent?.({type:"turn.progress",payload:{}});
          if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") { afterTool = true; calls.set(update.toolCallId, { ...calls.get(update.toolCallId), ...defined(update) } as acp.ToolCallUpdate); }
          // The reply is the agent's last stretch of text; commentary before its tool calls is dropped.
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") { if (afterTool) response = ""; afterTool = false; response += update.content.text; }
        })
        // Only one-time answers: "allow always" would let Grok skip later questions.
        .onRequest("session/request_permission", async ({ params }) => {
          const pick = (kind: acp.PermissionOptionKind) => params.options.find(o => o.kind === kind);
          let allow = false;
          try { allow = await allowed(params.toolCall); } catch {}
          if (!allow) refused = refusal({ ...calls.get(params.toolCall.toolCallId), ...defined(params.toolCall) });
          const option = pick(allow ? "allow_once" : "reject_once");
          return { outcome: halted || !option ? { outcome: "cancelled" as const } : { outcome: "selected" as const, optionId: option.optionId } };
        })
        .onRequest("x.ai/ask_user_question", params => params as { questions?: Array<{ question: string; header?: string; options?: unknown[] }> }, async ({ params }) => {
          const questions = (params.questions ?? []).map((q, i) => ({ id: String(i), header: q.header, question: q.question, options: q.options ?? [] }));
          try {
            if (!ask || halted) throw stopped();
            const { answers } = await ask("item/tool/requestUserInput", { questions }) as { answers: Record<string, { answers: string[] }> };
            return { outcome: "accepted", answers: Object.fromEntries(questions.map(q => [q.question, answers[q.id]?.answers.join(", ") ?? ""])) };
          } catch { return { outcome: "cancelled" }; }
        })
        .connectWith(agent.stream, async client => {
          ctx = client;
          const init = await open(client);
          bridge = options.tools ? await toolBridge(options.tools) : undefined;
          const mcpServers = [...bridge ? [http("openstrudel", bridge.url, { Authorization: "Bearer " + bridge.token })] : [], ...await services(root, context, options, cwd, bridges)];
          let configOptions: acp.SessionConfigOption[] | null | undefined;
          if (sessionId) {
            try { ({ configOptions } = await client.request("session/load", { sessionId, cwd, mcpServers })); }
            catch (error) { throw error instanceof acp.RequestError && error.code === -32000 ? error : new AcpSessionLost(error instanceof Error ? error.message : String(error)); }
          } else {
            ({ sessionId, configOptions } = await client.request("session/new", { cwd, mcpServers, _meta: { rules } }));
            options.onEvent?.({ type: "thread.started", payload: { threadId: sessionId + signed } });
          }
          const models = catalog(provider, configOptions), model = configOptions?.find(o => o.category === "model");
          if (models.length) this.options.onModels?.(models);
          if (options.model && model?.type === "select" && model.currentValue !== options.model) {
            ({configOptions} = await client.request("session/set_config_option", { sessionId, configId: model.id, value: options.model }));
          }
          // Switching models may change the available levels; validate the new native catalog before applying.
          if (options.reasoningEffort != null) {
            const choices = catalog(provider,configOptions), chosen = choices.find(m=>m.id === options.model) ?? choices.find(m=>m.isDefault);
            modelReasoning(chosen,options.reasoningEffort);
            const thinking = configOptions?.find(o=>o.category === "thought_level");
            if (thinking?.type === "select" && thinking.currentValue !== options.reasoningEffort) await client.request("session/set_config_option",{sessionId,configId:thinking.id,value:options.reasoningEffort});
          }
          const images = init.agentCapabilities?.promptCapabilities?.image ? (options.images ?? []).flatMap(path => {
            const data = readFileSync(path), mimeType = imageType(data);
            return mimeType ? [{ type: "image" as const, data: data.toString("base64"), mimeType }] : [];
          }) : [];
          if (halted) return undefined;
          prompting = true;
          try {
            const reply: acp.PromptResponse = await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: input }, ...images] });
            usage = reply._meta?.usage;
            return reply;
          } finally { if (options.scheduled && !halted) billing = await allowance(client); }
        });
    } catch (error) { failure = error; }
    finally {
      options.signal?.removeEventListener("abort", stop);
      agent.child.stdin!.end();
      const grace = setTimeout(agent.kill, 5000);
      await agent.closed;
      clearTimeout(grace); clearTimeout(timer);
      this.running.delete(end);
      await Promise.all([bridge, ...bridges].map(b => b?.close()));
    }
    // Grok's own count of the turn: tokens, model calls and, when its bill is complete, the cost (1e10 ticks = $1).
    const spent = defined({ usage, billing });
    if (Object.keys(spent).length) options.onEvent?.({ type: "turn.usage", payload: { ...spent, ...defined({ model: options.model ?? (usage as { primaryModelId?: string } | undefined)?.primaryModelId,
      reasoningEffort: options.reasoningEffort ?? undefined }) } });
    if (failure instanceof AcpSessionLost) throw failure;
    if (signedOut(failure)) throw new ProviderSignInError(provider);
    if (result?.stopReason === "end_turn") return { threadId: sessionId + signed, response: response || "Готово.", events: [] };
    if (halted) throw stopped();
    // Grok ends the whole turn when a permission is refused, and nobody can approve one in a schedule.
    if (result?.stopReason === "cancelled") throw refused ? new AcpRefusal(`${provider.name} прервал ответ: не разрешено ${refused}`) : stopped();
    // ACP can return only "Internal error" while the CLI reports a specific quota failure on stderr.
    // Classify the bounded diagnostic internally; never expose raw provider logs or credentials.
    // A status in Grok's failed request decides first (providerFailure reads it from the cause): its log may quote a story or a page.
    const stated = failure instanceof acp.RequestError && typeof (failure.data as { http_status?: unknown } | null | undefined)?.http_status === "number";
    const diagnostic = stated ? undefined : providerFailure(provider, new Error(agent.diagnostics()));
    if(diagnostic instanceof ProviderIncident)throw diagnostic;
    const detail = failure instanceof acp.RequestError ? cause(failure) : agent.stderr() || (failure instanceof Error ? failure.message : result?.stopReason) || "no reply";
    throw new Error(`${provider.name} не завершил ответ: ${detail.split("\n")[0]!.slice(0, 300)}`, { cause: failure });
  }
}

/** The OS temp directories, where Grok keeps scratch files such as large tool inputs. */
const scratchDirectories = () => [...new Set([tmpdir(), "/tmp"].flatMap(dir => { try { return [realpathSync(dir)]; } catch { return []; } }))];
const within = (directory: string, path: string) => (path + sep).startsWith(directory + sep);

/** A refused tool call as the owner reads it: Grok's title, and its path when the title does not name it. */
function refusal(call: Partial<acp.ToolCallUpdate>): string {
  const title = call.title || call.kind || "tool", path = call.locations?.[0]?.path;
  return `«${title}»${path && !title.includes(path) ? ` (${path})` : ""}`;
}

/** A failed request in the agent's own words: JSON-RPC keeps the cause in `data`, as text or as {message, http_status}.
 * Grok Build sends HTTP 402, a spent allowance, as -32603 "Internal error" with the status there. */
function cause(error: acp.RequestError): string {
  const data = error.data as { message?: unknown; http_status?: unknown } | string | null | undefined;
  const said = typeof data === "string" ? data : typeof data?.message === "string" ? data.message : "";
  const status = typeof data === "object" && typeof data?.http_status === "number" ? ` (HTTP ${data.http_status})` : "";
  return error.message.split("\n")[0] + status + (said ? ": " + said.split("\n")[0] : "");
}

/** One reading of the subscription's allowance from Grok's own `x.ai/billing`, which, as every ACP extension method, travels
 * with a leading underscore. It needs Grok's grok.com sign-in; a failed reading is noted and never fails the turn. */
async function allowance(ctx: acp.ClientContext): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([ctx.request("_x.ai/billing", {}), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("no answer in 20 s")), 20_000); })]); }
  catch (error) { return { error: error instanceof acp.RequestError ? cause(error) : error instanceof Error ? error.message : String(error) }; }
  finally { clearTimeout(timer); }
}

/** Grok signs in headless from the token its own login cached. */
async function open(ctx: acp.ClientContext): Promise<acp.InitializeResponse> {
  const init = await ctx.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "openstrudel", version: "1" } });
  await ctx.request("authenticate", { methodId: "cached_token" });
  return init;
}

/** The context's MCP services in ACP's shape; "openstrudel" is the employee tools' name. A stdio service runs outside Grok's sandbox
 * behind a loopback endpoint of this turn (stdioBridge), kept in `bridges` to stop with the turn. A schedule starts only its
 * workspace's own services: the owner's, shared with every chat, start in his own turns. */
async function services(root: string, context: string, options: RunOptions, cwd: string, bridges: Array<Awaited<ReturnType<typeof stdioBridge>>>): Promise<acp.McpServer[]> {
  return Promise.all(Object.entries(contextServers(root, context, options, !options.scheduled)).filter(([name]) => name !== "openstrudel").map(async ([name, s]: [string, any]) => {
    if (s.type === "http") return http(name, s.url, s.headers);
    const bridge = await stdioBridge({ command: s.command, args: s.args, env: Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, String(v)])) }, cwd);
    bridges.push(bridge);
    return http(name, bridge.url, { Authorization: "Bearer " + bridge.token });
  }));
}

const http = (name: string, url: string, headers: Record<string, string> = {}): acp.McpServer =>
  ({ type: "http", name, url, headers: Object.entries(headers).map(([name, value]) => ({ name, value })) });

/** The agent's `model` option as model choices; its current value is the agent's own default. */
function catalog(provider: ProviderInfo, configOptions: acp.SessionConfigOption[] | null | undefined): ModelChoice[] {
  const option = configOptions?.find(o => o.category === "model");
  if (option?.type !== "select") return [];
  const thinking = configOptions?.find(o => o.category === "thought_level");
  const levels = thinking?.type === "select" ? reasoningChoices(thinking.options.flatMap(o => "group" in o ? o.options : [o]).map(o=>({reasoningEffort:o.value,description:o.description ?? undefined}))) : [];
  return option.options.flatMap(o => "group" in o ? o.options : [o]).map(o => ({ id: o.value, name: o.name, description: o.description ?? "",
    isDefault: o.value === option.currentValue, reasoningEfforts:o.value === option.currentValue ? levels : [],
    ...(o.value === option.currentValue && thinking?.type === 'select' ? {defaultReasoningEffort:thinking.currentValue} : {}),
    speeds: [{ id: "default", name: "Обычная", description: "" }], provider: provider.id }));
}
