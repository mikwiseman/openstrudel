import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { CodexEngineAdapter, type CodexEngineOptions } from "./codex.js";
import type { CodexEngine } from "./types.js";
import type { CodexAuthTokens } from "./account.js";

/** One lazy Codex runtime per audience, never one always-on process per employee. */
export class ScopedCodexEngine implements CodexEngine {
  private readonly contexts = new Map<string, CodexEngineAdapter>();
  constructor(private readonly root: string, private sourceHome?: string,
    private readonly authTokens?: (refresh?: boolean) => Promise<CodexAuthTokens>, private readonly contextsRoot?: string) {}
  setCodexHome(home?: string): void { this.close(); this.sourceHome = home; }
  close(): void { for (const engine of this.contexts.values()) engine.close(); this.contexts.clear(); }
  forContext(context: string): CodexEngine {
    if (!/^(personal|work|group-[a-f0-9]{64}|(?:import|agent)-[a-f0-9]{32})$/.test(context)) throw new Error("Область не найдена");
    if (!this.sourceHome) throw new Error("Войдите в OpenAI в приложении OpenStrudel.");
    const current = this.contexts.get(context);
    if (current) return current;
    const cwd = resolve(this.root, ".data/workspace",context);
    const home = resolve(this.contextsRoot ?? resolve(this.root, ".data/contexts"), context);
    mkdirSync(cwd,{recursive:true,mode:0o700}); mkdirSync(home,{recursive:true,mode:0o700});
    const source = resolve(this.sourceHome,"auth.json");
    if (!this.authTokens && existsSync(source)) { copyFileSync(source,resolve(home,"auth.json")); chmodSync(resolve(home,"auth.json"),0o600); }
    const connections = resolve(this.root,".data/connections",context + ".toml");
    const configPath=resolve(home,"config.toml");
    const granted = existsSync(configPath) ? [...readFileSync(configPath,"utf8").matchAll(/\[apps\.([a-zA-Z0-9_-]+)\]\s*enabled\s*=\s*true/g)].map(m=>m[1]!).filter(id=>id!=="_default") : [];
    // Nothing from a broad account config is silently inherited. Scoped MCPs
    // are provisioned by the installer; subscriptions still use native OAuth.
    // Linux executes the sandbox helper through a CODEX_HOME/tmp alias into
    // the platform Codex package. Both must remain readable inside the sandbox;
    // granting the entire Codex home would also expose credentials and history.
    const binaries = dirname(dirname(createRequire(import.meta.url).resolve("@openai/codex/package.json")));
    const helpers = process.platform === "linux" ? `${JSON.stringify(resolve(home, "tmp"))} = "read"\n${JSON.stringify(binaries)} = "read"\n` : "";
    const authStorage = this.authTokens ? 'cli_auth_credentials_store = "ephemeral"\n' : "";
    const settings = `${authStorage}default_permissions = "openstrudel"\n[permissions.openstrudel.filesystem]\n":minimal" = "read"\n${JSON.stringify(cwd)} = "write"\n${helpers}[permissions.openstrudel.network]\nenabled = true\n[apps._default]\nenabled = false\n`;
    writeFileSync(configPath,settings + granted.map(id=>`\n[apps.${id}]\nenabled = true\n`).join("") + (existsSync(connections) ? "\n" + readFileSync(connections,"utf8") : ""),{mode:0o600});
    const options: CodexEngineOptions = { workingDirectory:cwd,codexHome:home,scoped:true,authTokens:this.authTokens };
    const engine = new CodexEngineAdapter(options);
    this.contexts.set(context,engine);
    return engine;
  }
  run: CodexEngine["run"] = (input,options) => this.forContext("personal").run(input,options);
  connections: NonNullable<CodexEngine["connections"]> = refresh => this.forContext("personal").connections!(refresh);
  isConnected: NonNullable<CodexEngine["isConnected"]> = id => this.forContext("personal").isConnected!(id);
  connect: NonNullable<CodexEngine["connect"]> = id => this.forContext("personal").connect!(id);
}
