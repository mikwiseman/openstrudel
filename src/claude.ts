import { createSdkMcpServer, query as sdkQuery, tool, type CanUseTool, type McpServerConfig, type PermissionResult, type SDKUserMessage, type EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { z } from "zod";
import { INSTRUCTIONS } from "./codex.js";
import { readToml, inheritedIntegrations } from "./extensions.js";
import { ProviderIncident, ProviderKeyError, exhaustedPlan, providerFailure, providerNotConnected, providerModels, type ProviderInfo } from "./providers.js";
import { modelReasoning, reasoningChoices, type ModelChoice } from "./model-settings.js";
import { contextPattern } from "./scopes.js";
import { telegramMcpConfig } from "./telegram-mcp.js";
import type { CodexEngine, CodexRunResult } from "./types.js";

export interface ClaudeEngineOptions {
  /** Home root; private state lives under `<root>/.data`. */
  root: string;
  /** A registry provider whose engine is "claude". */
  provider: ProviderInfo;
  /** Read at the start of every turn so a replaced key applies to the next turn. */
  key: () => string | null;
  /** Test seam for the SDK entry point. */
  query?: typeof sdkQuery;
}

type RunOptions = NonNullable<Parameters<CodexEngine["run"]>[1]>;

/** OpenStrudel's instructions for a vendor's own agent. */
export const agentInstructions = () => INSTRUCTIONS.replace("Use Codex's native tools, memory, skills and connectors.", "Use your native tools and connected services.")
  .replace("where the owner can add MCP services, SKILL.md skills and local Codex plugins", "where the owner can add MCP services")
  .replace("Follow Codex's native approval policy", "Follow the approval policy");
const instructions = agentInstructions();
/** The only host variables a vendor's CLI gets: no OpenStrudel keys or data, and no vendor key that would bill another account. */
export const hostEnvironment = (): Record<string, string> => Object.fromEntries(["PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME", "TERM"]
  .flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []));
// Claude Code sends background and helper work to Claude aliases; another vendor must only see its own model.
const aliases = ["ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"];
const edits = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

/** The Claude Agent SDK behind the same CodexEngine contract. One per provider;
 * each turn is one CLI process that resumes its session by id. */
export class ClaudeEngine implements CodexEngine {
  private readonly running = new Set<AbortController>();
  private modelCache?: { until:number; value:ModelChoice[] };
  private modelReading?: Promise<ModelChoice[]>;
  constructor(readonly options: ClaudeEngineOptions) {}
  /** Read the CLI's catalog without submitting a prompt. Other vendors cannot inherit Claude's capabilities. */
  async models(refresh = false): Promise<ModelChoice[]> {
    const { provider, root } = this.options;
    if (provider.id !== 'anthropic') return providerModels(provider);
    if (!refresh && this.modelCache && this.modelCache.until > Date.now()) return this.modelCache.value;
    if (!this.modelReading) this.modelReading = (async () => {
      const cwd = resolve(root,'.data/providers',provider.id,'catalog'), home = resolve(cwd,'home');
      mkdirSync(home,{recursive:true,mode:0o700});
      const abort = new AbortController();
      let finish!: () => void;
      const wait = new Promise<void>(r => { finish = r; });
      const session = (this.options.query ?? sdkQuery)({prompt:(async function* () { await wait; })(),options:{
        cwd,settingSources:[],strictMcpConfig:true,abortController:abort,
        env:{...hostEnvironment(),HOME:home,CLAUDE_CONFIG_DIR:cwd,ANTHROPIC_BASE_URL:provider.baseUrl,ANTHROPIC_API_KEY:this.options.key() ?? '',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1'},
      }});
      this.running.add(abort);
      const timer = setTimeout(() => abort.abort(),15_000);
      try {
        const rows = await session.supportedModels();
        const value = providerModels(provider).map(model => {
          const row = rows.find(r => (r.resolvedModel ?? r.value) === model.id);
          return {...model,reasoningEfforts:reasoningChoices(row?.supportsEffort ? (row.supportedEffortLevels ?? []).map(reasoningEffort=>({reasoningEffort})) : [])};
        });
        this.modelCache = {until:Date.now()+60_000,value}; return value;
      } finally { clearTimeout(timer);this.running.delete(abort);finish();session.close(); }
    })().finally(() => { this.modelReading = undefined; });
    return this.modelReading;
  }
  forContext(context: string): CodexEngine {
    if (!contextPattern.test(context)) throw new Error("Область не найдена");
    return { run: (input, options) => this.turn(context, input, options) };
  }
  run: CodexEngine["run"] = (input, options) => this.forContext("personal").run(input, options);
  close(): void { for (const turn of this.running) turn.abort(); }

  private async turn(context: string, input: string, options: RunOptions = {}): Promise<CodexRunResult> {
    const { root, provider } = this.options, key = this.options.key();
    if (!key) throw providerNotConnected(provider.id);
    const config = resolve(root, ".data/providers", provider.id, "claude", context), home = resolve(config, "home"), cwd = resolve(root, ".data/workspace", context);
    for (const dir of [home, cwd]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const data = realpathSync(resolve(root, ".data")), workspace = realpathSync(cwd), owner = realpathSync(homedir());
    const model = options.model ?? (provider.models.find(m => m.recommended) ?? provider.models[0])!.id;
    const effort = options.reasoningEffort == null ? undefined : modelReasoning((await this.models()).find(m=>m.id===model),options.reasoningEffort) as EffortLevel;
    const env: Record<string, string> = hostEnvironment();
    Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: provider.baseUrl,
      ...provider.auth === "bearer" ? { ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: "" } : { ANTHROPIC_API_KEY: key },
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
      // Commands and MCP servers inherit the CLI environment; the key must not reach them.
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1", ...provider.env });
    if (provider.id !== "anthropic") for (const name of aliases) env[name] = model;

    const servers = contextServers(root, context, options);
    // Codex's per-service tool lists. The CLI has no such setting: hide what is turned off and refuse anything outside the lists.
    const hidden = Object.entries(servers).flatMap(([name, s]) => (s.toolLists?.disabled ?? []).map(tool => `mcp__${name}__${tool}`));
    const offered = (name: string, server = name.split("__")[1] ?? "") => {
      const lists = servers[server]?.toolLists, tool = name.slice(`mcp__${server}__`.length);
      return !lists || (!lists.enabled || lists.enabled.includes(tool)) && !lists.disabled?.includes(tool);
    };
    // A group's live turns, like approve-all and Codex's group policy, must stay in the sandbox: commands run only inside it and
    // change nothing beyond the group's workspace. The owner's schedule in a group runs its saved work like the owner's own chat.
    const mode = options.approvalMode ?? "ask", group = options.groupContext === true && options.scheduled !== true, ask = options.onRequest;
    const sandboxed = mode === "approve_all" || group;
    const canUseTool: CanUseTool = async (name, input, { mcpServer }) => {
      options.onEvent?.({type:"turn.progress",payload:{}});
      const allow: PermissionResult = { behavior: "allow", updatedInput: input }, deny = (message: string): PermissionResult => ({ behavior: "deny", message });
      const path = input.file_path ?? input.notebook_path, edit = edits.includes(name);
      const accepted = (answer: any) => answer?.decision === "accept" ? allow : deny("The user declined this action.");
      try {
        if (mcpServer?.source === "sdk" || ["WebFetch", "WebSearch", "SandboxNetworkAccess"].includes(name)) return allow;
        if (name.startsWith("mcp__") && !offered(name, mcpServer?.name)) return deny("This tool is turned off for this chat.");
        if (name === "AskUserQuestion") {
          if (!ask) return deny("No user is available to answer.");
          const questions = (input.questions as any[]).map((q, i) => ({ id: String(i), header: q.header, question: q.question, options: q.options }));
          const { answers } = await ask("item/tool/requestUserInput", { questions }) as { answers: Record<string, { answers: string[] }> };
          return { behavior: "allow", updatedInput: { ...input, answers: Object.fromEntries(questions.map(q => [q.question, answers[q.id]?.answers.join(", ") ?? ""])) } };
        }
        // Codex's profile: the workspace is readable and writable without asking, and nothing beyond it is readable.
        // Changes beyond it need the owner. Approve-all runs only sandboxed commands and services by itself.
        if ((edit || name === "Read") && insideWorkspace(workspace, path)) return allow;
        if (sandboxed && (name === "Bash" || edit)) return name === "Bash" ? allow : deny("Only files inside the workspace can be changed.");
        if (mode === "approve_all") return name.startsWith("mcp__") ? allow : deny("This action is not available.");
        if (!ask) return deny("No user is available to approve this action.");
        if (name === "Bash") return accepted(await ask("item/commandExecution/requestApproval", { command: input.command, cwd, reason: input.description }));
        if (edit) { const target = physical(resolve(cwd, String(path))); return accepted(await ask("item/fileChange/requestApproval", { reason: `${name} ${target}`, grantRoot: dirname(target) })); }
        if (name.startsWith("mcp__") && mcpServer) {
          const answer = await ask("mcpServer/elicitation/request", { mode: "form", serverName: mcpServer.name,
            message: `Allow the ${mcpServer.name} MCP server to run tool "${name.slice(`mcp__${mcpServer.name}__`.length)}"?`,
            requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", tool_params: input } }) as { action?: string };
          return answer?.action === "accept" ? allow : deny("The user declined this action.");
        }
        return deny("This action is not available.");
      } catch (error) { return deny(error instanceof Error ? error.message : String(error)); }
    };

    const sdkServers: Record<string, McpServerConfig> = {}, tools = options.tools;
    if (tools) sdkServers.openstrudel = createSdkMcpServer({ name: "openstrudel", alwaysLoad: true, tools: tools.definitions.map(d =>
      tool(d.name, d.description, (z.fromJSONSchema(d.inputSchema as any) as z.ZodObject).shape, async args => {
        try { return { content: [{ type: "text", text: JSON.stringify(await tools.call(d.name, args)) }] }; }
        catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
      })) });
    const images = provider.models.find(m => m.id === model)?.images ? (options.images ?? []).flatMap(path => {
      const data = readFileSync(path), media = imageType(data);
      return media ? [{ type: "image" as const, source: { type: "base64" as const, media_type: media, data: data.toString("base64") } }] : [];
    }) : [];
    const message: SDKUserMessage = { type: "user", message: { role: "user", content: [{ type: "text", text: input }, ...images] }, parent_tool_use_id: null };

    // Inline --mcp-config JSON would show the services' tokens in the process list.
    const mcpConfig = resolve(config, `mcp-${randomUUID()}.json`);
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(servers).map(([name, { toolLists: _, ...s }]) => [name, s])) }), { mode: 0o600, flag: "wx" });
    const abort = new AbortController();
    this.running.add(abort);
    let threadId = "", response: string | undefined, rejected = false, stopped = false, failure: string | undefined, limit: ProviderIncident | undefined, stop = () => {};
    try {
      const turn = (this.options.query ?? sdkQuery)({ prompt: (async function* () { yield message; })(), options: {
        cwd, env, model, ...(effort ? {effort} : {}), abortController: abort, resume: options.threadId ?? undefined, permissionMode: "default", canUseTool, mcpServers: sdkServers, extraArgs: { "mcp-config": mcpConfig },
        ...(options.outputSchema ? { outputFormat: { type: "json_schema" as const, schema: options.outputSchema } } : {}),
        // Nothing from ~/.claude, the workspace's .mcp.json or CLAUDE.md. User text never runs CLI slash commands or @file mentions.
        settingSources: [], strictMcpConfig: true, verbatimPrompts: true,
        // Not recorded in the session, so a changed SOUL applies on resume.
        systemPrompt: { type: "preset", preset: "claude_code", append: instructions + (options.profile ? `\n\nCurrent employee SOUL (authoritative):\n${options.profile}` : ""), snapshot: false },
        // Schedules live in OpenStrudel; the CLI's own cron dies with this per-turn process.
        disallowedTools: ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup", ...provider.webSearch ? [] : ["WebSearch"], ...hidden],
        // Commands read like Codex's profile: never the owner's files or the Home's private data beyond this workspace.
        sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: !sandboxed, failIfUnavailable: sandboxed,
          filesystem: { denyRead: [data, owner], allowRead: [workspace] } },
      } });
      // An interrupt, unlike an abort, ends the turn only after the CLI has written its transcript and exited,
      // so the next turn never resumes a session another process is still writing. close() still kills.
      stop = () => { if (!stopped) { stopped = true; turn.interrupt().catch(() => abort.abort()); } };
      options.signal?.addEventListener("abort", stop, { once: true });
      if (options.signal?.aborted) stop();
      for await (const m of turn) {
        if (!threadId && "session_id" in m && m.session_id) { threadId = m.session_id; options.onEvent?.({ type: "thread.started", payload: { threadId } }); }
        if (m.type === "assistant" && !m.error) options.onEvent?.({type:"turn.progress",payload:{}});
        // A quota refusal belongs to the Home's reserve policy, not the CLI's minute-long retry loop.
        const refusal = m.type === "system" && m.subtype === "api_retry" ? `${m.error_status} ${m.error}`
          : m.type === "assistant" && m.error ? JSON.stringify(m.message.content) : undefined;
        const incident = refusal && providerFailure(provider,new Error(refusal));
        if (incident instanceof ProviderIncident && incident.reason.startsWith("limits:")) { limit=incident;stop(); }
        // The CLI retries a rejected key for minutes; the owner has to replace it instead.
        else if (m.type === "system" && m.subtype === "api_retry" && (m.error_status === 401 || m.error_status === 403)
          || m.type === "assistant" && m.error === "authentication_failed" && !exhaustedPlan(JSON.stringify(m.message.content))) { rejected = true; stop(); }
        if (m.type === "result") {
          // A structured answer is the SDK's validated object, not the prose around it.
          if (m.subtype === "success" && !m.is_error) response = options.outputSchema && m.structured_output !== undefined ? JSON.stringify(m.structured_output) : m.result;
          else if (m.subtype === "success" && (m.api_error_status === 401 || m.api_error_status === 403) && !exhaustedPlan(m.result)) rejected = true;
          else failure = (m.subtype === "success" ? m.result : m.errors.join("\n")) || m.subtype;
        }
      }
    } catch (error) { if (!stopped && !abort.signal.aborted) failure = error instanceof Error ? error.message : String(error); }
    finally { options.signal?.removeEventListener("abort", stop); this.running.delete(abort); rmSync(mcpConfig, { force: true }); }
    if (limit) throw limit;
    if (rejected) throw new ProviderKeyError(provider);
    if (response === undefined && (stopped || abort.signal.aborted)) throw new Error("Ответ остановлен");
    if (failure !== undefined) throw new Error(`${provider.name} не завершил ответ: ${failure.replace(/^API Error:\s*/, "").split("\n")[0]!.slice(0, 300)}`);
    return { threadId, response: response || "Готово.", events: [] };
  }
}

type Service = McpServerConfig & { toolLists?: { enabled?: string[]; disabled?: string[] } };
/** The same services as the Codex scope: the owner's when shared with every chat, then shared, installer-provisioned, and Telegram's for the verified sender only.
 * A sender without access gets only the services that check the sender themselves. Without `inherit`, the owner's are left out. */
export function contextServers(root: string, context: string, options: Pick<RunOptions, "telegramActor" | "conversationId" | "access">, inherit = true): Record<string, Service> {
  const own = { ...readToml(resolve(root, ".data/extensions", context, "config.toml")).mcp_servers, ...readToml(resolve(root, ".data/connections", context + ".toml")).mcp_servers };
  const telegram = resolve(root, ".data/connections", context + ".telegram.json");
  const verified = existsSync(telegram) ? JSON.parse(readFileSync(telegram, "utf8")) : undefined;
  const servers: Record<string, Service> = options.access === false ? {} : extensionServers({ ...inherit ? inheritedIntegrations(root, context, { servers: own, telegram: verified }).servers : {}, ...own });
  for (const [key, s] of Object.entries(telegramMcpConfig(verified, options.telegramActor, options.conversationId)) as Array<[string, any]>)
    if (s.enabled) servers[key.slice("mcp_servers.".length)] = { type: "http", url: s.url, headers: s.http_headers };
  return servers;
}

/** Codex-style MCP services. Computer Use runs on Codex's own kernel and is left out. */
function extensionServers(table: Record<string, unknown>): Record<string, Service> {
  return Object.fromEntries(Object.entries(table).flatMap(([name, s]: [string, any]): Array<[string, Service]> => {
    // Like Codex, credentials named by environment variable are read from the Home's environment when the turn starts.
    const variable = (key: unknown) => typeof key === "string" ? process.env[key] : undefined, bearer = variable(s.bearer_token_env_var);
    const headers = { ...s.http_headers, ...Object.fromEntries(Object.entries(s.env_http_headers ?? {}).flatMap(([header, key]) => variable(key) ? [[header, variable(key)!]] : [])),
      ...bearer ? { Authorization: `Bearer ${bearer}` } : {} };
    const list = (value: unknown) => Array.isArray(value) ? value.map(String) : undefined;
    const toolLists = s.enabled_tools || s.disabled_tools ? { toolLists: { enabled: list(s.enabled_tools), disabled: list(s.disabled_tools) } } : {};
    return s.enabled === false || name === "cua_repl" ? [] : s.url ? [[name, { type: "http", url: s.url, headers: Object.keys(headers).length ? headers : undefined, ...toolLists }]]
      : s.command ? [[name, { type: "stdio", command: s.command, args: s.args ?? [], env: s.env, ...toolLists }]] : [];
  }));
}

/** Whether a tool's path, absolute or relative to the workspace (a real path), stays inside it once links are followed. */
export const insideWorkspace = (workspace: string, path: unknown) => typeof path === "string" && (physical(resolve(workspace, path)) + sep).startsWith(workspace + sep);

/** The path a tool touches once links are followed, also when the file or a link's target does not exist yet. */
export function physical(path: string, hops = 0): string {
  try { return realpathSync(path); } catch {}
  if (hops > 40) throw new Error("Too many symbolic links.");
  let link: string | undefined;
  try { link = readlinkSync(path); } catch {}
  const parent = physical(dirname(path), hops + 1);
  return link === undefined ? resolve(parent, basename(path)) : physical(link.startsWith(sep) ? link : parent + sep + link, hops + 1);
}

/** The API checks the bytes, not the uploaded name or declared type. */
export function imageType(data: Buffer): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | undefined {
  if (data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
}
