import { computerUseReadPaths } from "./computer-use.js";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { CodexEngineAdapter, type CodexEngineOptions } from "./codex.js";
import type { CodexEngine } from "./types.js";
import type { CodexAuthTokens } from "./account.js";
import { readTelegramMcpServers } from "./telegram-mcp.js";
import { extensionConfig, readToml, atomicText, inheritedIntegrations } from "./extensions.js";
import { parse, stringify } from "smol-toml";
import { HomeError } from "./home.js";

/** Context names become path segments under `.data`; every engine accepts only these. */
export const contextPattern = /^(personal|work|group-[a-f0-9]{64}|(?:import|agent)-[a-f0-9]{32})$/;

/** One lazy Codex runtime per audience, never one always-on process per employee.
 * With a key provider there is no ChatGPT credential and no ChatGPT apps. */
/** Order-independent text of parsed configuration, for change detection. */
const stable = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v) ?? "";
/** Before build 55 an app grant could live only in one account's Codex home.
 * Copy such grants once into the chat's shared file, which then decides alone. */
function migrateAppGrants(home: string, shared: string) {
  const marker = resolve(home, "openstrudel-apps.migrated");
  if (existsSync(marker)) return;
  const old = Object.entries(readToml(resolve(home, "config.toml")).apps ?? {}).filter(([id, value]: [string, any]) => id !== "_default" && /^[a-zA-Z0-9_-]+$/.test(id) && value?.enabled === true).map(([id]) => id);
  const saved = existsSync(shared) ? readToml(shared) : extensionConfig(home);
  const missing = old.filter(id => saved.apps?.[id] === undefined);
  if (missing.length) atomicText(shared, stringify({ ...saved, apps: { ...saved.apps, ...Object.fromEntries(missing.map(id => [id, { enabled: true }])) } }));
  mkdirSync(home, { recursive: true, mode: 0o700 }); writeFileSync(marker, "");
}

export class ScopedCodexEngine implements CodexEngine {
  private readonly contexts = new Map<string, CodexEngineAdapter>();
  private readonly sources = new Map<string, string>();
  constructor(private readonly root: string, private sourceHome?: string,
    private readonly authTokens?: (refresh?: boolean) => Promise<CodexAuthTokens>, private readonly contextsRoot?: string, private readonly provider?: CodexEngineOptions["provider"]) {}
  setCodexHome(home?: string): void { this.close(); this.sourceHome = home; }
  close(): void { for (const engine of this.contexts.values()) engine.close(); this.contexts.clear(); }
  forContext(context: string): CodexEngine {
    if (!contextPattern.test(context)) throw new Error("Область не найдена");
    if (!this.sourceHome && !this.provider) throw new Error("Войдите в OpenAI в приложении OpenStrudel.");
    const cwd = resolve(this.root, ".data/workspace",context);
    const home = resolve(this.contextsRoot ?? resolve(this.root, ".data/contexts"), context);
    const sharedExtensionsPath=resolve(this.root,".data/extensions",context,"config.toml");
    const connections = resolve(this.root,".data/connections",context + ".toml");
    migrateAppGrants(home, sharedExtensionsPath);
    const extensions = existsSync(sharedExtensionsPath) ? readToml(sharedExtensionsPath) : extensionConfig(home);
    const legacy = readToml(connections);
    const telegramServers = readTelegramMcpServers(this.root, context);
    const inherited = inheritedIntegrations(this.root, context, { servers:{...extensions.mcp_servers,...legacy.mcp_servers}, apps:extensions.apps, telegram:telegramServers });
    // A runtime keeps its configuration while it works. Once idle, any change
    // to this chat's, the owner's or the installer's files starts a fresh one.
    const sources = stable({ legacy, telegramServers, inherited });
    const current = this.contexts.get(context);
    if (current) {
      if (current.busy || (stable(extensions) === stable(extensionConfig(home)) && this.sources.get(context) === sources)) {
        this.contexts.delete(context); this.contexts.set(context,current);
        return current;
      }
      current.close(); this.contexts.delete(context);
    }
    // Each native runtime owns several OS threads. Keeping every audience
    // loaded exhausted Home's process limit after browsing its service lists.
    // Retain four recent runtimes; active turns, requests and sign-ins stay.
    // Codex resumes evicted threads from disk, including history and memories.
    for (const [name,engine] of this.contexts) {
      if (this.contexts.size < 4) break;
      if (engine.busy) continue;
      engine.close(); this.contexts.delete(name);
    }
    mkdirSync(cwd,{recursive:true,mode:0o700}); mkdirSync(home,{recursive:true,mode:0o700});
    const source = this.sourceHome && resolve(this.sourceHome,"auth.json");
    if (!this.authTokens && source && existsSync(source)) { copyFileSync(source,resolve(home,"auth.json")); chmodSync(resolve(home,"auth.json"),0o600); }
    const configPath=resolve(home,"config.toml");
    const granted = [...new Set([...Object.entries(extensions.apps ?? {}).filter(([id,value])=>id!=="_default" && /^[a-zA-Z0-9_-]+$/.test(id) && (value as any)?.enabled === true).map(([id])=>id), ...inherited.apps])];
    // Nothing from a broad account config is silently inherited. Scoped MCPs
    // are provisioned by the installer, or come from the owner's main chat
    // when the owner shares it with every chat; subscriptions use native OAuth.
    // Linux executes the sandbox helper through a CODEX_HOME/tmp alias into
    // the platform Codex package. Both must remain readable inside the sandbox;
    // granting the entire Codex home would also expose credentials and history.
    const binaries = dirname(dirname(createRequire(import.meta.url).resolve("@openai/codex/package.json")));
    const helpers = process.platform === "linux" ? `${JSON.stringify(resolve(home, "tmp"))} = "read"\n${JSON.stringify(binaries)} = "read"\n` : "";
    const authStorage = this.authTokens ? 'cli_auth_credentials_store = "ephemeral"\n' : "";
    const settings = `${authStorage}default_permissions = "openstrudel"\n[features]\napps = true\n[permissions.openstrudel.filesystem]\n":minimal" = "read"\n${JSON.stringify(cwd)} = "write"\n${JSON.stringify(resolve(home,"plugins/cache"))} = "read"\n${JSON.stringify(resolve(home,"skills/.system"))} = "read"\n${helpers}[permissions.openstrudel.network]\nenabled = true\n[apps._default]\nenabled = false\n`;
    const base = parse(settings + granted.map(id=>`\n[apps.${id}]\nenabled = true\n`).join(""));
    // Native memories belong to this audience's Codex home, just like its
    // threads. Allow reading that recall store without exposing credentials,
    // other audiences or the account-wide history. Codex owns generation.
    if (!this.provider) (base as any).permissions.openstrudel.filesystem[resolve(home,"memories")] = "read";
    const computer = computerUseReadPaths(extensions.mcp_servers?.cua_repl);
    for (const path of computer) (base as any).permissions.openstrudel.filesystem[path] = "read";
    atomicText(resolve(home,"openstrudel-extensions.toml"),stringify(extensions));
    // Local plugins are explicit per audience. Never auto-import the owner's
    // account-wide remote plugin collection into a Telegram group. With plugins
    // on, Codex syncs OpenAI's catalog from chatgpt.com and GitHub at start, so
    // a key provider has none.
    atomicText(configPath, stringify({ ...extensions, ...base, features:{apps:!this.provider,plugins:!this.provider,remote_plugin:false,memories:!this.provider},
      ...(!this.provider ? {memories:{generate_memories:true,use_memories:true,disable_on_external_context:false,min_rate_limit_remaining_percent:0}} : {}),
      mcp_servers:{...inherited.servers,...extensions.mcp_servers,...legacy.mcp_servers} }));
    const options: CodexEngineOptions = { workingDirectory:cwd,codexHome:home,sharedExtensionsPath,scoped:true,authTokens:this.authTokens,telegramServers,
      reservedServers:[...Object.keys(legacy.mcp_servers ?? {}),...Object.keys(inherited.servers)],inheritedApps:inherited.apps,provider:this.provider,
      catalogPath:resolve(this.root,".data/app-catalog.json") };
    const engine = new CodexEngineAdapter(options);
    this.contexts.set(context,engine); this.sources.set(context,sources);
    return engine;
  }
  run: CodexEngine["run"] = (input,options) => this.forContext("personal").run(input,options);
  connections: NonNullable<CodexEngine["connections"]> = refresh => this.forContext("personal").connections!(refresh);
  isConnected: NonNullable<CodexEngine["isConnected"]> = id => this.forContext("personal").isConnected!(id);
  connect: NonNullable<CodexEngine["connect"]> = (id, options) => this.forContext("personal").connect!(id, options);
}
