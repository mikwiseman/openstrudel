import { findComputerUse, computerUseReadPaths } from "./computer-use.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, lstatSync, readdirSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { parse, stringify } from "smol-toml";
import type { CodexRpc } from "./rpc.js";
import { HomeError } from "./home.js";

export type ExtensionFile = { path: string; contentBase64: string; executable?: boolean };
export type ExtensionItem = { id: string; name: string; description: string; kind: "skill" | "plugin"; enabled: boolean; removable: boolean; };
export type ExtensionsState = { items: ExtensionItem[]; notice?: string; };
export type ExtensionPreview = { kind: "skill" | "plugin"; name: string; description: string; files: number; bytes: number; digest: string; services: string[]; hasHooks: boolean; replaces?: string; };
type Options = { home: string; cwd: string; sharedConfigPath?: string; reservedServers?: string[]; inheritedApps?: string[]; client: () => Promise<CodexRpc>; changed: () => Promise<void>; idle: () => boolean; };
const execute = promisify(execFile);
const changingScopes = new Set<string>();
const runningScopes = new Map<string, number>();
/** Config and files belong to an audience, even when it switches accounts. */
export function beginExtensionRun(scope?: string): () => void {
  if (!scope) return () => {};
  if (changingScopes.has(scope)) throw new HomeError("Обновляем сервисы и навыки. Повторите сообщение через несколько секунд.",409);
  runningScopes.set(scope,(runningScopes.get(scope) ?? 0)+1);
  return () => { const count=(runningScopes.get(scope) ?? 1)-1; if(count)runningScopes.set(scope,count);else runningScopes.delete(scope); };
}
const slug = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) || ["constructor", "prototype", "__proto__"].includes(value)) throw new HomeError("Название: латинские буквы, цифры и дефис, до 64 символов.");
  return value;
};
export function readToml(path: string): Record<string, any> {
  return existsSync(path) ? parse(readFileSync(path, "utf8"), { unsafeKeyBehaviour: "throw" }) : {};
}
export function atomicText(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID() + ".tmp";
  try { writeFileSync(temporary, text, { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) rmSync(temporary); }
}

/** Only user-selected capabilities persist across account/runtime restarts. */
export function extensionConfig(home: string): Record<string, any> { return readToml(resolve(home, "openstrudel-extensions.toml")); }

/** The owner's choice to use the main chat's services in every chat on this Home. */
const allChatsPath = (root: string) => resolve(root, ".data/extensions/all-chats.json");
const privateServerNames = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 100) throw new HomeError("Проверьте список личных сервисов.");
  return [...new Set(value.map(slug))];
};
function sharingConfig(root: string): { enabled: boolean; ownerOnlyServers: string[]; [key: string]: unknown } {
  const path = allChatsPath(root);
  if (!existsSync(path)) return { enabled: false, ownerOnlyServers: [] };
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (!saved || Array.isArray(saved) || typeof saved !== "object" || typeof saved.enabled !== "boolean") throw new Error();
    return { ...saved, ownerOnlyServers: privateServerNames(saved.ownerOnlyServers ?? []) };
  } catch { throw new HomeError("Настройки общего доступа к сервисам повреждены. Исправьте их перед изменением.", 409); }
}
export function sharedWithAllChats(root: string): boolean {
  try { return sharingConfig(root).enabled; } catch { return false; }
}
/** These owner connectors never flow into another audience, including future groups. */
export function ownerOnlyServers(root: string): string[] { return sharingConfig(root).ownerOnlyServers; }
export function shareWithAllChats(root: string, enabled: boolean, ownerOnly?: string[]) {
  if (typeof enabled !== "boolean") throw new HomeError("Укажите, делиться ли сервисами.");
  const saved = sharingConfig(root);
  atomicText(allChatsPath(root), JSON.stringify({ ...saved, enabled, ownerOnlyServers: ownerOnly === undefined ? saved.ownerOnlyServers : privateServerNames(ownerOnly) }) + "\n");
}
const endpoint = (url: unknown) => { try { const u = new URL(String(url)); return u.origin + u.pathname.replace(/\/+$/, ""); } catch { return undefined; } };
/** What another chat receives from the owner's main chat. The chat's own services,
 * and a group's verified-sender service for the same address, take precedence.
 * A service signed in through OAuth keeps its tokens in one Codex home, and
 * Computer Use belongs to one machine, so both stay where they were connected. */
export function inheritedIntegrations(root: string, context: string, own: { servers: Record<string, any>; apps?: Record<string, any>; telegram?: Record<string, { url: string }> }): { servers: Record<string, any>; apps: string[] } {
  if (context === "personal") return { servers: {}, apps: [] };
  // A corrupt policy must never turn a private connector into an inherited one.
  let sharing: ReturnType<typeof sharingConfig>;
  try { sharing = sharingConfig(root); } catch { return { servers: {}, apps: [] }; }
  if (!sharing.enabled) return { servers: {}, apps: [] };
  const privateServers = new Set(sharing.ownerOnlyServers);
  const owner = readToml(resolve(root, ".data/extensions/personal/config.toml"));
  // One service per address: the chat's own or verified-sender service replaces the owner's key.
  const taken = new Set([...Object.values(own.servers), ...Object.values(own.telegram ?? {})].map((s: any) => endpoint(s?.url)).filter(Boolean));
  const servers = Object.entries({ ...owner.mcp_servers, ...readToml(resolve(root, ".data/connections/personal.toml")).mcp_servers }).filter(([name, s]: [string, any]) =>
    !privateServers.has(name) && !(name in own.servers) && !(name in (own.telegram ?? {})) && name !== "cua_repl" && s?.enabled !== false
    && Boolean(s?.command || s?.http_headers || s?.env_http_headers || s?.bearer_token_env_var) && !(s?.url && taken.has(endpoint(s.url))));
  const apps = Object.entries(owner.apps ?? {}).filter(([id, value]: [string, any]) => id !== "_default" && /^[a-zA-Z0-9_-]+$/.test(id) && value?.enabled === true && own.apps?.[id]?.enabled !== false).map(([id]) => id);
  return { servers: Object.fromEntries(servers), apps };
}
function safeFiles(input: unknown): Map<string, Buffer> {
  if (!Array.isArray(input) || !input.length) throw new HomeError("Выберите SKILL.md или папку навыка/плагина.");
  const files = new Map<string, Buffer>(); let size = 0;
  for (const item of input) {
    const path = item?.path;
    if (typeof path !== "string" || path.length > 240 || path.startsWith("/") || path.includes("\\") || path.split("/").some(p => !p || p === "." || p === ".." || p === ".git" || p === ".openstrudel-package.json") || /[\x00-\x1f]/.test(path)) throw new HomeError("В пакете недопустимый путь.");
    if (item.executable !== undefined && typeof item.executable !== "boolean") throw new HomeError("Не удалось прочитать права файла.");
    if (files.has(path.toLocaleLowerCase())) throw new HomeError("В пакете повторяются имена файлов.");
    if (typeof item.contentBase64 !== "string") throw new HomeError("Не удалось прочитать файл пакета.");
    if (item.contentBase64.length > Math.ceil((10 * 1024 * 1024 - size) / 3) * 4) throw new HomeError("Пакет больше 10 МБ.");
    if (item.contentBase64.length % 4 || /[^A-Za-z0-9+/=]/.test(item.contentBase64)) throw new HomeError("Не удалось прочитать файл пакета.");
    const data = Buffer.from(item.contentBase64, "base64"); size += data.length;
    if (data.toString("base64") !== item.contentBase64) throw new HomeError("Не удалось прочитать файл пакета.");
    if (size > 10 * 1024 * 1024) throw new HomeError("Пакет больше 10 МБ.");
    files.set(path.toLocaleLowerCase(), data);
  }
  // Keep original casing; the lowercase pass above detects collisions on macOS.
  return new Map(input.map(item => [item.path, Buffer.from(item.contentBase64, "base64")]));
}
function skillInfo(text: string) {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!front) throw new HomeError("В SKILL.md нужны name и description между строками ---.");
  const field = (key: string) => front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "");
  const name = slug(field("name")); let description = field("description");
  if (description && /^[>|][-+]?$/.test(description)) {
    description = front.match(/^description:\s*[>|][-+]?\s*\n((?:[ \t]+[^\n]*(?:\n|$))+)/m)?.[1]?.trim().replace(/\s+/g," ");
  }
  if (!description || description.length > 2000) throw new HomeError("Укажите краткое description в заголовке SKILL.md.");
  return { name, description };
}
export function previewExtension(input: unknown): ExtensionPreview {
  const files = safeFiles(input); let kind: ExtensionPreview["kind"], name: string, description: string;
  const manifest = files.get("plugin.json") ?? files.get(".codex-plugin/plugin.json");
  const services: string[] = [];
  if (manifest) {
    let value: any; try { value = JSON.parse(manifest.toString("utf8")); } catch { throw new HomeError("Не удалось прочитать plugin.json."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HomeError("Не удалось прочитать plugin.json.");
    kind = "plugin"; name = slug(value.name); description = typeof value.description === "string" ? value.description.slice(0,2000) : "Набор навыков и подключений";
    const declared = [value, value.extensions?.["com.openai"]].filter(Boolean);
    const mcpFiles = new Set(["mcp.json", ".mcp.json"]), inlineMcp: any[] = [];
    for (const config of declared) for (const key of ["skills", "hooks", "mcpServers", "apps", "onboardingSkill"]) {
      const entries = Array.isArray(config[key]) ? config[key] : [config[key]];
      for (const entry of entries) {
        if (typeof entry === "string") {
          const path = entry.replace(/^\.\//, "").replace(/\/$/, "");
          if (!entry.startsWith("./") || !path || path.split("/").some(p=>!p || p===".." || p===".") || /[\\\x00-\x1f]/.test(path)) throw new HomeError("Пути в plugin.json должны оставаться внутри выбранной папки и начинаться с ./.");
          if (key === "mcpServers") {
            if (!files.has(path)) throw new HomeError("В пакете не найден файл настроек MCP.");
            mcpFiles.add(path);
          }
        } else if (key === "mcpServers" && entry && typeof entry === "object") inlineMcp.push({mcpServers:entry});
      }
    }
    for (const filename of mcpFiles) if (files.has(filename)) {
      try { inlineMcp.push(JSON.parse(files.get(filename)!.toString("utf8"))); } catch { throw new HomeError("Не удалось прочитать MCP-настройки плагина."); }
    }
    for (const mcp of inlineMcp) {
      for (const [id, server] of Object.entries(mcp.mcpServers ?? {})) {
        slug(id); const s = server as any;
        let host: string | undefined;
        if (typeof s.url === "string") { try { host = new URL(s.url).host; } catch { throw new HomeError("Проверьте адрес MCP в плагине."); } }
        const description=host ? `${id} · ${host}` : `${id} · программа на устройстве`;
        if (!services.includes(description)) services.push(description);
      }
    }
  } else {
    const skill = files.get("SKILL.md"); if (!skill) throw new HomeError("Выберите папку с SKILL.md или plugin.json.");
    kind = "skill"; ({ name, description } = skillInfo(skill.toString("utf8")));
  }
  const digest = createHash("sha256");
  for (const [path, data] of [...files].sort(([a],[b]) => a.localeCompare(b))) digest.update(path).update("\0").update(data).update("\0").update((input as ExtensionFile[]).find(f=>f.path===path)?.executable ? "x" : "-");
  return { kind, name, description, files: files.size, bytes: [...files.values()].reduce((n,b) => n+b.length,0), digest: digest.digest("hex"), services,
    hasHooks: [...files.keys()].some(p => p.startsWith("hooks/") || p === "hooks.json") || Boolean(manifest && /"hooks"\s*:/.test(manifest.toString("utf8"))) };
}

/** Standard Codex config, SKILL.md discovery and official plugin CLI. No agent loop. */
export class CodexExtensions {
  private busy = false;
  get updating() { return this.busy; }
  constructor(private readonly options: Options) {}
  private get configPath() { return resolve(this.options.home, "config.toml"); }
  private get skillRoot() { return resolve(this.options.cwd, ".agents/skills"); }
  private get packageRoot() { return resolve(this.options.sharedConfigPath ? dirname(this.options.sharedConfigPath) : this.options.home, "openstrudel-packages"); }
  pluginServers(): Record<string, string[]> {
    const config = readToml(this.configPath), result: Record<string, string[]> = {};
    for (const id of Object.keys(config.plugins ?? {})) {
      if (!id.endsWith("@openstrudel-local")) continue;
      const name = slug(id.split("@")[0]), record = resolve(this.packageRoot,"plugins",name,".openstrudel-package.json");
      if (existsSync(record)) result[id] = (JSON.parse(readFileSync(record,"utf8")).services ?? []).map((service: string) => slug(service.split(" · ")[0]));
    }
    return result;
  }
  async prepare() {
    // Codex keeps plugin caches per CODEX_HOME. Reinstall the same local,
    // owner-selected package when a different subscription opens this scope.
    // The official CLI owns cache layout and validation. A scope with plugins
    // off, such as a key provider's, loads none.
    const config=readToml(this.configPath);
    if(config.features?.plugins === false)return;
    for(const [id,value] of Object.entries(config.plugins ?? {})) {
      if(!(value as any)?.enabled || !id.endsWith("@openstrudel-local"))continue;
      const name=slug(id.split("@")[0]);
      if(!existsSync(resolve(this.packageRoot,"plugins",name,".openstrudel-package.json")))throw new HomeError("Не найден пакет плагина «"+name+"». Добавьте его снова.");
      await this.pluginCLI(["add",id]);
    }
  }
  private persist() {
    const config = readToml(this.configPath), saved: Record<string, any> = {};
    for (const key of ["plugins", "marketplaces", "skills"]) if (config[key]) saved[key] = config[key];
    // Apps from the owner's main chat are not this chat's own grants. Its own
    // "off" never reaches config.toml, so it is kept from the chat's own file.
    const own=extensionConfig(this.options.home).apps ?? {};
    const apps=Object.fromEntries([...Object.entries(own).filter(([,value])=>(value as any)?.enabled===false).map(([id])=>[id,{enabled:false}]),...Object.entries(config.apps ?? {}).filter(([id,value])=>id!=="_default" && /^[a-zA-Z0-9_-]+$/.test(id) && typeof (value as any)?.enabled==="boolean" && (!this.options.inheritedApps?.includes(id) || id in own)).map(([id,value])=>[id,{enabled:(value as any).enabled}])]);
    if(Object.keys(apps).length)saved.apps=apps;
    const servers = Object.fromEntries(Object.entries(config.mcp_servers ?? {}).filter(([name]) => !this.options.reservedServers?.includes(name)));
    if (Object.keys(servers).length) saved.mcp_servers = servers;
    atomicText(resolve(this.options.home, "openstrudel-extensions.toml"), stringify(saved));
    if (this.options.sharedConfigPath) atomicText(this.options.sharedConfigPath,stringify(saved));
  }
  /** Adding one app grant needs no reload, so the turn that asked for it may save it. */
  grantApp(id:string) {
    if(id==="_default" || !/^[a-zA-Z0-9_-]+$/.test(id))throw new HomeError("Сервис не найден в Codex");
    const scope=this.options.sharedConfigPath ?? this.configPath;
    if(changingScopes.has(scope))throw new HomeError("Обновляем сервисы и навыки. Повторите через несколько секунд.",409);
    const saved=this.options.sharedConfigPath && existsSync(this.options.sharedConfigPath) ? readToml(this.options.sharedConfigPath) : extensionConfig(this.options.home);
    if(saved.apps?.[id]?.enabled===true)return;
    saved.apps={...saved.apps,[id]:{enabled:true}};
    atomicText(resolve(this.options.home,"openstrudel-extensions.toml"),stringify(saved));
    if(this.options.sharedConfigPath)atomicText(this.options.sharedConfigPath,stringify(saved));
  }
  async enableApp(id:string) {
    if(id==="_default" || !/^[a-zA-Z0-9_-]+$/.test(id))throw new HomeError("Сервис не найден в Codex");
    await this.mutate(async()=>{
      const config=readToml(this.configPath);
      config.apps={...config.apps,[id]:{...config.apps?.[id],enabled:true}};
      atomicText(this.configPath,stringify(config));
    });
  }
  private async mutate<T>(operation: (transaction: { undo: Array<() => void | Promise<void>>; commit: Array<() => void> }) => Promise<T>): Promise<T> {
    const scope=this.options.sharedConfigPath ?? this.configPath;
    if (this.busy || changingScopes.has(scope) || runningScopes.has(scope) || !this.options.idle()) throw new HomeError("Дождитесь завершения текущего ответа или обновления и повторите.", 409);
    if (this.options.sharedConfigPath && existsSync(scope) && JSON.stringify(readToml(scope)) !== JSON.stringify(extensionConfig(this.options.home))) throw new HomeError("Список изменился. Обновите его и повторите.",409);
    const before = readFileSync(this.configPath, "utf8"), transaction = {undo:[] as Array<()=>void|Promise<void>>,commit:[] as Array<()=>void>};
    this.busy = true;
    changingScopes.add(scope);
    try { const result = await operation(transaction); this.persist(); await this.options.changed(); for(const finish of transaction.commit) finish(); return result; }
    catch (error) {
      try { for(const undo of transaction.undo.reverse()) await undo(); }
      finally { atomicText(this.configPath, before); this.persist(); await this.options.changed().catch(() => undefined); }
      throw error;
    }
    finally { this.busy = false; changingScopes.delete(scope); }
  }
  async list(): Promise<ExtensionsState> {
    const rpc = await this.options.client();
    const reply = await rpc.request("skills/list", { cwds: [this.options.cwd], forceReload: true }, 15_000);
    const items: ExtensionItem[] = (reply.data ?? []).flatMap((row: any) => (row.skills ?? []).filter((s:any)=>!s.pluginId && s.scope!=="system").map((s: any) => ({
      id: "skill:" + createHash("sha256").update(s.path).digest("hex"), name: s.name, description: s.shortDescription ?? s.description,
      kind: "skill", enabled: s.enabled !== false, removable: this.ownSkill(s.path),
    })));
    const config = readToml(this.configPath);
    if (existsSync(resolve(this.packageRoot, "plugins"))) for (const entry of readdirSync(resolve(this.packageRoot,"plugins"))) {
      const path = resolve(this.packageRoot,"plugins",entry), record = resolve(path,".openstrudel-package.json");
      if (!existsSync(record)) continue;
      const info = JSON.parse(readFileSync(record,"utf8"));
      const id = `${entry}@openstrudel-local`;
      items.push({id:"plugin:"+id,name:entry,description:info.description,kind:"plugin",enabled:config.plugins?.[id]?.enabled === true,removable:true});
    }
    const errors = (reply.data ?? []).flatMap((r:any)=>r.errors ?? []);
    return { items, ...(errors.length ? {notice:"Не все навыки удалось загрузить. Проверьте SKILL.md в добавленном пакете."} : {}) };
  }
  private ownSkill(path: string) {
    const local = relative(this.skillRoot,path);
    return !isAbsolute(local) && !local.startsWith("..") && local.split(/[\\/]/).length === 2 && local.endsWith("/SKILL.md")
      && existsSync(resolve(dirname(path),".openstrudel-package.json"));
  }
  computerUse() {
    const configured = readToml(this.configPath).mcp_servers?.cua_repl?.enabled === true;
    return { available:Boolean(findComputerUse()), configured, platform:process.platform };
  }
  async connectComputerUse() {
    const server = findComputerUse();
    if (!server) throw new HomeError("На Mac сотрудника откройте ChatGPT → плагины и включите Computer Use. Затем вернитесь сюда и повторите.",409);
    await this.options.client();
    return this.mutate(async()=>{
      const config = readToml(this.configPath);
      if (config.mcp_servers?.cua_repl) throw new HomeError("Computer Use уже добавлен. Обновите список подключений.",409);
      config.mcp_servers = {...config.mcp_servers,cua_repl:server};
      const filesystem = config.permissions?.openstrudel?.filesystem;
      if (filesystem) for (const path of computerUseReadPaths(server)) filesystem[path] = "read";
      atomicText(this.configPath,stringify(config));
      return {available:true,configured:true,platform:process.platform};
    });
  }
  async addMcp(input: Record<string, any>) {
    const name = slug(input.name);
    if (this.options.reservedServers?.includes(name)) throw new HomeError("Это подключение управляется настройками устройства. Выберите другое название.");
    const value: Record<string, any> = { enabled:true, default_tools_approval_mode:"prompt" };
    if (input.disabled_tools !== undefined) {
      if (!Array.isArray(input.disabled_tools) || input.disabled_tools.length > 100 || input.disabled_tools.some((name: unknown) => typeof name !== "string" || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(name))) throw new HomeError("Проверьте список отключённых инструментов.");
      value.disabled_tools = [...new Set(input.disabled_tools)];
    }
    if (input.url) {
      let url: URL; try { url = new URL(input.url); } catch { throw new HomeError("Введите полный адрес сервиса, начиная с https://."); }
      if (url.username || url.password) throw new HomeError("Уберите логин и пароль из адреса. Ключ сервиса можно указать в отдельном поле.");
      if (url.hash) throw new HomeError("Уберите из адреса знак # и всё после него.");
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname))) throw new HomeError("Вставьте адрес сервиса, начинающийся с https://.");
      value.url = url.toString();
      if (input.http_headers !== undefined) {
        const headers = input.http_headers;
        if (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.keys(headers).length > 32) throw new HomeError("Проверьте заголовки сервиса.");
        const seen = new Set<string>();
        for (const [key, header] of Object.entries(headers)) {
          const lower = key.toLowerCase();
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key) || /^(?:host|content-length|connection|transfer-encoding|upgrade|proxy-authorization|proxy-authenticate|te|trailer)$|^(?:mcp-|x-hermes-)/i.test(key)
            || seen.has(lower) || typeof header !== "string" || !header || header.length > 16000 || /[\x00-\x1f\x7f]/.test(header)) throw new HomeError("Проверьте заголовки сервиса.");
          seen.add(lower);
        }
        if (input.token && seen.has("authorization")) throw new HomeError("Укажите ключ или заголовок Authorization, не оба сразу.");
        value.http_headers = { ...headers };
      }
      if (input.token) { if (typeof input.token !== "string" || /[\r\n]/.test(input.token) || input.token.length > 16000) throw new HomeError("Проверьте ключ сервиса."); value.http_headers={...value.http_headers,Authorization:"Bearer "+input.token}; }
    } else {
      if (input.http_headers !== undefined) throw new HomeError("HTTP-заголовки требуют адреса сервиса.");
      if (typeof input.command !== "string" || !input.command.trim() || input.command.length > 1024 || /[\r\n\0]/.test(input.command)) throw new HomeError("Укажите адрес MCP или исполняемую программу.");
      if (!Array.isArray(input.args ?? []) || (input.args ?? []).some((a:any)=>typeof a!=="string" || a.length>8000)) throw new HomeError("Аргументы программы должны быть списком строк.");
      value.command=input.command; value.args=input.args ?? [];
      if (input.env) {
        if (typeof input.env !== "object" || Array.isArray(input.env) || Object.entries(input.env).some(([k,v])=> !/^[A-Z_][A-Z0-9_]*$/.test(k) || typeof v!=="string" || v.length>16000)) throw new HomeError("Проверьте переменные окружения MCP.");
        value.env=input.env;
      }
    }
    await this.options.client();
    return this.mutate(async()=>{
      const config=readToml(this.configPath);
      if (config.mcp_servers?.[name]) throw new HomeError("Подключение с таким названием уже есть.",409);
      config.mcp_servers={...config.mcp_servers,[name]:value}; atomicText(this.configPath,stringify(config));
      return { id:"mcp:"+name, saved:true };
    });
  }
  async removeMcp(name: string) {
    slug(name); await this.options.client();
    return this.mutate(async()=>{
      if (!extensionConfig(this.options.home).mcp_servers?.[name]) throw new HomeError("Это подключение не было добавлено здесь.");
      const config=readToml(this.configPath);
      if (name === "cua_repl" && config.permissions?.openstrudel?.filesystem) for (const path of computerUseReadPaths(config.mcp_servers[name])) delete config.permissions.openstrudel.filesystem[path];
      delete config.mcp_servers[name]; atomicText(this.configPath,stringify(config)); return {removed:true};
    });
  }
  private async pluginCLI(args: string[]) {
    const binary=resolve(dirname(createRequire(import.meta.url).resolve("@openai/codex/package.json")),"bin/codex.js");
    const env:NodeJS.ProcessEnv={HOME:this.options.cwd,CODEX_HOME:this.options.home,GIT_TERMINAL_PROMPT:"0"};
    for (const key of ["PATH","TMPDIR","LANG","LC_ALL","SYSTEMROOT"]) if(process.env[key])env[key]=process.env[key];
    try { const result=await execute(process.execPath,[binary,"plugin",...args,"--json"],{env,cwd:this.options.cwd,timeout:45_000,maxBuffer:2*1024*1024}); return JSON.parse(result.stdout); }
    catch { throw new HomeError("Codex не смог установить этот плагин. Проверьте формат пакета и попробуйте ещё раз."); }
  }
  private catalog() {
    const dir=resolve(this.packageRoot,"plugins");
    const plugins=existsSync(dir)?readdirSync(dir).filter(name=>existsSync(resolve(dir,name,".openstrudel-package.json"))).map(name=>({name,source:{source:"local",path:"./plugins/"+name},policy:{installation:"AVAILABLE",authentication:"ON_INSTALL"},category:"Productivity"})):[];
    atomicText(resolve(this.packageRoot,".agents/plugins/marketplace.json"),JSON.stringify({name:"openstrudel-local",plugins}));
  }
  private packagePath(preview: ExtensionPreview) { return resolve(preview.kind==="skill"?this.skillRoot:resolve(this.packageRoot,"plugins"),preview.name); }
  preview(input: unknown): ExtensionPreview {
    const preview=previewExtension(input), destination=this.packagePath(preview);
    if (!existsSync(destination)) return preview;
    const record=resolve(destination,".openstrudel-package.json");
    if (lstatSync(destination).isSymbolicLink() || !existsSync(record) || lstatSync(record).isSymbolicLink()) throw new HomeError("Здесь уже есть папка с таким именем. Выберите другое название пакета.",409);
    const installed=JSON.parse(readFileSync(record,"utf8"));
    if(installed.name!==preview.name || installed.kind!==preview.kind || !/^[a-f0-9]{64}$/.test(installed.digest)) throw new HomeError("Этот пакет управляется вне OpenStrudel. Его файлы сохранены.",409);
    return {...preview,replaces:installed.digest};
  }
  async install(input: unknown, expectedDigest: string, replaces?: string) {
    const preview=this.preview(input);
    if (preview.digest!==expectedDigest) throw new HomeError("Пакет изменился. Откройте предварительный просмотр ещё раз.",409);
    await this.options.client();
    return this.mutate(async(transaction)=>{
      if (this.preview(input).replaces!==replaces) throw new HomeError("Установленная версия изменилась. Откройте предварительный просмотр ещё раз.",409);
      const destination=this.packagePath(preview), plugin=preview.name+"@openstrudel-local";
      const previousConfig=readToml(this.configPath);
      const previousEnabled=preview.kind==="plugin" ? previousConfig.plugins?.[plugin]?.enabled !== false
        : (previousConfig.skills?.config ?? []).find((s:any)=>s.path===resolve(destination,"SKILL.md"))?.enabled !== false;
      const stage=destination+".install-"+randomUUID(); mkdirSync(stage,{recursive:true,mode:0o700});
      try {
        for(const [path,data] of safeFiles(input)){const file=resolve(stage,path);mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,data,{mode:(input as ExtensionFile[]).find(f=>f.path===path)?.executable ? 0o700 : 0o600,flag:"wx"});}
        const {replaces:_,...record}=preview;
        atomicText(resolve(stage,".openstrudel-package.json"),JSON.stringify(record));
        const backup=replaces ? resolve(this.packageRoot,"rollback-"+randomUUID()) : undefined;
        if(backup) {
          mkdirSync(dirname(backup),{recursive:true,mode:0o700}); renameSync(destination,backup);
          transaction.undo.push(async()=>{
            renameSync(backup,destination); this.catalog();
            if(preview.kind==="plugin") await this.pluginCLI(["add",plugin]);
          });
          transaction.commit.push(()=>rmSync(backup,{recursive:true,force:true}));
        }
        renameSync(stage,destination);
        transaction.undo.push(()=>{rmSync(destination,{recursive:true,force:true});this.catalog();});
        if(preview.kind==="plugin"){
          this.catalog(); await this.pluginCLI(["marketplace","add",this.packageRoot]); await this.pluginCLI(["add",plugin]);
          if(!previousEnabled) { const config=readToml(this.configPath); config.plugins[plugin].enabled=false; atomicText(this.configPath,stringify(config)); }
        }else{
          const result=await (await this.options.client()).request("skills/list",{cwds:[this.options.cwd],forceReload:true});
          if (!(result.data ?? []).some((r:any)=>(r.skills ?? []).some((s:any)=>s.path===resolve(destination,"SKILL.md")))) throw new HomeError("Codex не смог загрузить навык. Проверьте заголовок SKILL.md.");
          await (await this.options.client()).request("skills/config/write",{path:resolve(destination,"SKILL.md"),enabled:previousEnabled});
        }
        return preview;
      }finally{if(existsSync(stage))rmSync(stage,{recursive:true,force:true});}
    });
  }
  async change(id: string, enabled?: boolean) {
    await this.options.client();
    return this.mutate(async(transaction)=>{
      const remove = (directory: string) => {
        const staged=resolve(this.options.home,"openstrudel-removing-"+randomUUID());
        renameSync(directory,staged);
        transaction.undo.push(()=>{renameSync(staged,directory);this.catalog();});
        transaction.commit.push(()=>rmSync(staged,{recursive:true,force:true}));
      };
      if(id.startsWith("plugin:")){
        const plugin=id.slice(7),name=slug(plugin.split("@")[0]);
        if(plugin!==name+"@openstrudel-local" || !existsSync(resolve(this.packageRoot,"plugins",name,".openstrudel-package.json"))) throw new HomeError("Плагин не найден.");
        if(enabled===undefined){await this.pluginCLI(["remove",plugin]);remove(resolve(this.packageRoot,"plugins",name));this.catalog();}
        else {if(enabled)await this.pluginCLI(["add",plugin]);const config=readToml(this.configPath);config.plugins={...config.plugins,[plugin]:{...config.plugins?.[plugin],enabled}};atomicText(this.configPath,stringify(config));}
      }else{
        const rpc=await this.options.client(), data=await rpc.request("skills/list",{cwds:[this.options.cwd],forceReload:true});
        const skill=(data.data ?? []).flatMap((r:any)=>r.skills ?? []).find((s:any)=>"skill:"+createHash("sha256").update(s.path).digest("hex")===id);
        if(!skill || !this.ownSkill(skill.path))throw new HomeError("Этот навык управляется его плагином.");
        if(enabled===undefined)remove(dirname(skill.path));
        else await rpc.request("skills/config/write",{path:skill.path,enabled});
      }
      return {ok:true};
    });
  }
}
