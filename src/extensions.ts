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
export type ExtensionPreview = { kind: "skill" | "plugin"; name: string; description: string; files: number; bytes: number; digest: string; services: string[]; hasHooks: boolean; };
type Options = { home: string; cwd: string; sharedConfigPath?: string; reservedServers?: string[]; client: () => Promise<CodexRpc>; changed: () => Promise<void>; idle: () => boolean; };
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
function safeFiles(input: unknown): Map<string, Buffer> {
  if (!Array.isArray(input) || !input.length || input.length > 300) throw new HomeError("Выберите SKILL.md или папку навыка/плагина (до 300 файлов).");
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
    // The official CLI owns cache layout and validation.
    const config=readToml(this.configPath);
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
    const servers = Object.fromEntries(Object.entries(config.mcp_servers ?? {}).filter(([name]) => !this.options.reservedServers?.includes(name)));
    if (Object.keys(servers).length) saved.mcp_servers = servers;
    atomicText(resolve(this.options.home, "openstrudel-extensions.toml"), stringify(saved));
    if (this.options.sharedConfigPath) atomicText(this.options.sharedConfigPath,stringify(saved));
  }
  private async mutate<T>(operation: (transaction: { undo: Array<() => void>; commit: Array<() => void> }) => Promise<T>): Promise<T> {
    const scope=this.options.sharedConfigPath ?? this.configPath;
    if (this.busy || changingScopes.has(scope) || runningScopes.has(scope) || !this.options.idle()) throw new HomeError("Дождитесь завершения текущего ответа или обновления и повторите.", 409);
    if (this.options.sharedConfigPath && existsSync(scope) && JSON.stringify(readToml(scope)) !== JSON.stringify(extensionConfig(this.options.home))) throw new HomeError("Список изменился. Обновите его и повторите.",409);
    const before = readFileSync(this.configPath, "utf8"), transaction = {undo:[] as Array<()=>void>,commit:[] as Array<()=>void>};
    this.busy = true;
    changingScopes.add(scope);
    try { const result = await operation(transaction); this.persist(); await this.options.changed(); for(const finish of transaction.commit) finish(); return result; }
    catch (error) { for(const undo of transaction.undo.reverse()) undo(); atomicText(this.configPath, before); this.persist(); await this.options.changed().catch(() => undefined); throw error; }
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
  async addMcp(input: Record<string, any>) {
    const name = slug(input.name);
    if (this.options.reservedServers?.includes(name)) throw new HomeError("Это подключение управляется настройками устройства. Выберите другое название.");
    const value: Record<string, any> = { enabled:true, default_tools_approval_mode:"prompt" };
    if (input.url) {
      let url: URL; try { url = new URL(input.url); } catch { throw new HomeError("Введите полный адрес сервиса, начиная с https://."); }
      if (url.username || url.password) throw new HomeError("Уберите логин и пароль из адреса. Ключ сервиса можно указать в отдельном поле.");
      if (url.hash) throw new HomeError("Уберите из адреса знак # и всё после него.");
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname))) throw new HomeError("Вставьте адрес сервиса, начинающийся с https://.");
      value.url = url.toString();
      if (input.token) { if (typeof input.token !== "string" || /[\r\n]/.test(input.token) || input.token.length > 16000) throw new HomeError("Проверьте ключ сервиса."); value.http_headers={Authorization:"Bearer "+input.token}; }
    } else {
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
      const config=readToml(this.configPath); delete config.mcp_servers[name]; atomicText(this.configPath,stringify(config)); return {removed:true};
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
  async install(input: unknown, expectedDigest: string) {
    const preview=previewExtension(input);
    if (preview.digest!==expectedDigest) throw new HomeError("Пакет изменился. Откройте предварительный просмотр ещё раз.",409);
    await this.options.client();
    return this.mutate(async(transaction)=>{
      const destination=resolve(preview.kind==="skill"?this.skillRoot:resolve(this.packageRoot,"plugins"),preview.name);
      if (existsSync(destination)) throw new HomeError("Такое расширение уже установлено. Сначала удалите прежнюю версию.",409);
      const stage=destination+".install-"+randomUUID(); mkdirSync(stage,{recursive:true,mode:0o700});
      let installed=false;
      try {
        for(const [path,data] of safeFiles(input)){const file=resolve(stage,path);mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,data,{mode:(input as ExtensionFile[]).find(f=>f.path===path)?.executable ? 0o700 : 0o600,flag:"wx"});}
        atomicText(resolve(stage,".openstrudel-package.json"),JSON.stringify(preview)); renameSync(stage,destination); installed=true;
        transaction.undo.push(()=>{rmSync(destination,{recursive:true,force:true});this.catalog();});
        if(preview.kind==="plugin"){
          this.catalog(); await this.pluginCLI(["marketplace","add",this.packageRoot]); await this.pluginCLI(["add",preview.name+"@openstrudel-local"]);
        }else{
          const result=await (await this.options.client()).request("skills/list",{cwds:[this.options.cwd],forceReload:true});
          if (!(result.data ?? []).some((r:any)=>(r.skills ?? []).some((s:any)=>s.path===resolve(destination,"SKILL.md")))) throw new HomeError("Codex не смог загрузить навык. Проверьте заголовок SKILL.md.");
          await (await this.options.client()).request("skills/config/write",{path:resolve(destination,"SKILL.md"),enabled:true});
        }
        return preview;
      }catch(error){if(installed)rmSync(destination,{recursive:true,force:true});this.catalog();throw error;}
      finally{if(existsSync(stage))rmSync(stage,{recursive:true,force:true});}
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
