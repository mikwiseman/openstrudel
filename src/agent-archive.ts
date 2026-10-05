import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { CronExpressionParser } from "cron-parser";
import type { Store } from "./store.js";
import type { MessageService } from "./messages.js";
import type { EmployeeProfile } from "./types.js";

// A plain, versioned document: no executable installer, embedded credentials,
// database replacement, or extraction of arbitrary archive paths.
export const MAX_ARCHIVE_BYTES = 192 * 1024 * 1024;
const MAX_CONTENT_BYTES = 128 * 1024 * 1024;
type Row = Record<string, any>;
type Profile = Omit<EmployeeProfile, "preview"> & { context: string };
interface Workspace { id: string; sourcePath: string; connections: string[]; directories: string[]; files: { path: string; content: string; sha256: string; executable: boolean }[] }
interface Conversation { id: string; profileId: string; context: string; title: string; createdAt: string; updatedAt: string; primary: boolean; sourceChannel: string }
interface Message { id: string; conversationId: string; direction: string; replyToId: string | null; text: string; createdAt: string; status: string; error: string | null; kind: string; author: string | null; hidden: boolean; attachments: string[] }
interface Attachment { id: string; conversationId: string; name: string; mimeType: string; size: number; path: string }
interface Schedule { id: string; conversationId: string; name: string; prompt: string; cron: string; timezone: string; enabled: boolean; delivery: string; destination: string | null; backupOf: string | null }
interface Run { id: string; scheduleId: string; conversationId: string; scheduledFor: string; status: string; createdAt: string; messageId: string | null; error: string | null }
export interface AgentArchive {
  format: "openstrudel.team"; version: 1; id: string; createdAt: string;
  profiles: Profile[]; workspaces: Workspace[]; conversations: Conversation[];
  messages: Message[]; attachments: Attachment[]; schedules: Schedule[]; runs: Run[];
}
export interface ArchivePreview {
  archiveId: string; createdAt: string; planToken: string; alreadyImported: boolean;
  employees: { name: string; importedName: string }[];
  counts: { employees: number; conversations: number; messages: number; files: number; schedules: number };
  connections: string[];
}
interface Receipt { digest: string; profileIds: string[]; preview: ArchivePreview }

export class AgentArchives {
  constructor(private readonly store: Store, private readonly messages: MessageService) {}

  export(): AgentArchive {
    if (this.messages.hasActiveRuns) throw new Error("Сотрудники ещё работают. Дождитесь завершения их ответов и повторите экспорт.");
    const store = this.store;
    const conversations = store.listConversations();
    const profiles: Profile[] = store.listProfiles().map(({ preview: _, ...p }) => ({ ...p, context: store.getSetting("employee.context." + p.id) ?? p.domain ?? "personal" }));
    // The main assistant becomes an ordinary added employee on import. Never
    // overwrite the receiving Home's main personality or primary conversation.
    profiles.unshift({ id: "main", name: "OpenStrudel", instructions: store.getSetting("main.soul") ?? "", capabilities: [], model: null, tokenLimit: null, domain: "personal", purpose: "", createdAt: new Date().toISOString(), context: "personal" });
    const chats: Conversation[] = conversations.map(c => ({ id: c.id, profileId: c.profileId ?? "main", context: this.messages.contextFor(c.id), title: c.title ?? "Чат", createdAt: c.createdAt, updatedAt: c.updatedAt, sourceChannel: c.channel,
      primary: c.channel === "api" && c.externalId === (c.profileId ? "home::employee::" + c.profileId : "home") }));
    const contexts = [...new Set([...profiles.map(p => p.context), ...chats.map(c => c.context)])];
    let contentBytes = 0, fileCount = 0;
    const workspaces = contexts.map(id => {
      const root = this.messages.files.workspace(id);
      const files: Workspace["files"] = [];
      const directories: string[] = [];
      const visit = (directory: string) => {
        for (const entry of readdirSync(directory).sort()) {
          const path = resolve(directory, entry), stat = lstatSync(path), name = relative(root, path).split(sep).join("/");
          safePath(name);
          if (stat.isSymbolicLink()) throw new Error("В рабочих файлах есть символическая ссылка. Замените её копией файла перед экспортом: " + name);
          if (stat.isDirectory()) { directories.push(name); if (directories.length > 10000) throw new Error("В экспорте слишком много папок: максимум 10 000."); visit(path); continue; }
          if (!stat.isFile()) throw new Error("Не удалось сохранить рабочий файл: " + name);
          contentBytes += stat.size;
          if (++fileCount > 10000 || contentBytes > MAX_CONTENT_BYTES) throw new Error("Рабочие файлы превышают лимит экспорта: 128 МБ и 10 000 файлов. Уменьшите их объём и повторите.");
          const realRoot = realpathSync(root), parent = realpathSync(dirname(path));
          if (parent !== realRoot && !parent.startsWith(realRoot + sep)) throw new Error("Рабочая папка изменилась во время экспорта. Повторите после завершения работы сотрудников.");
          const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const bytes = readFileSync(fd), after = fstatSync(fd);
            if (stat.ino !== after.ino || stat.mtimeMs !== after.mtimeMs || stat.size !== bytes.length) throw new Error("Файлы меняются во время экспорта. Дождитесь завершения работы сотрудников и повторите.");
            files.push({ path: name, content: bytes.toString("base64"), sha256: hash(bytes), executable: (stat.mode & 0o111) !== 0 });
          } finally { closeSync(fd); }
        }
      };
      if (existsSync(root)) {
        checkWorkspacePath(root);
        visit(root);
      }
      const config = resolve(root, "../../contexts", id, "config.toml");
      const connections = existsSync(config) ? [...readFileSync(config, "utf8").matchAll(/^\[(?:apps|mcp_servers)\.([a-zA-Z0-9_-]+)\]/gm)].map(m => m[1]!).filter(n => n !== "_default") : [];
      const previous = store.getSetting("archive.connections." + id);
      return { id, sourcePath: root, connections: [...new Set([...connections, ...JSON.parse(previous ?? "[]")])], directories, files };
    });
    const all = (table: string): Row[] => store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) ? store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[] : [];
    const archive: AgentArchive = {
      format: "openstrudel.team", version: 1, id: randomUUID(), createdAt: new Date().toISOString(), profiles, workspaces, conversations: chats,
      messages: all("messages").map(m => ({ id: m.id, conversationId: m.conversation_id, direction: m.direction, replyToId: m.reply_to_id, text: m.text, createdAt: m.created_at, status: m.status, error: m.error, kind: m.kind, author: m.author, hidden: m.hidden === 1, attachments: JSON.parse(m.attachments_json).map((a: Row) => a.id) })),
      attachments: all("conversation_files").map(f => ({ id: f.id, conversationId: f.conversation_id, name: f.name, mimeType: f.mime_type, size: f.size, path: relative(this.messages.files.workspace(this.messages.contextFor(f.conversation_id)), f.path).split(sep).join("/") })),
      schedules: all("schedules").map(s => ({ id: s.id, conversationId: s.conversation_id, name: s.name, prompt: s.prompt, cron: s.cron, timezone: s.timezone, enabled: s.enabled === 1, delivery: s.delivery, destination: s.telegram_chat_id ? store.getTelegramChat(s.telegram_chat_id)?.title ?? "Telegram" : null, backupOf: s.backup_of })),
      runs: all("schedule_runs").map(r => ({ id: r.id, scheduleId: r.schedule_id, conversationId: r.conversation_id, scheduledFor: r.scheduled_for, status: r.status, createdAt: r.created_at, messageId: r.message_id, error: r.error })),
    };
    // Never offer a successful download that we cannot restore ourselves.
    return validateArchive(archive);
  }

  preview(input: unknown): ArchivePreview { return this.plan(validateArchive(input)).preview; }

  private plan(archive: AgentArchive): { preview: ArchivePreview; receipt: Receipt | null; digest: string } {
    const digest = hash(JSON.stringify(archive));
    const saved = this.store.getSetting("agents.import." + archive.id);
    const receipt: Receipt | null = saved ? JSON.parse(saved) : null;
    if (receipt) {
      if (receipt.digest !== digest) throw new Error("Содержимое уже импортированного файла изменено. Выберите исходный файл или сделайте новый экспорт.");
      return { digest, receipt, preview: { ...receipt.preview, alreadyImported: true } };
    }
    const names = new Set(["OpenStrudel", ...this.store.listProfiles().map(p => p.name)]);
    const employees = archive.profiles.map(p => {
      let name = p.name;
      for (let n = 1; names.has(name); n++) {
        const suffix = n === 1 ? " (импорт)" : ` (импорт ${n})`;
        name = p.name.slice(0, 80 - suffix.length) + suffix;
      }
      names.add(name);
      return { name: p.name, importedName: name };
    });
    return { digest, receipt, preview: { archiveId: archive.id, createdAt: archive.createdAt, alreadyImported: false, employees,
      planToken: hash(digest + JSON.stringify(employees)),
      counts: { employees: archive.profiles.length, conversations: archive.conversations.length, messages: archive.messages.length, files: archive.workspaces.reduce((n, w) => n + w.files.length, 0), schedules: archive.schedules.length },
      connections: [...new Set(archive.workspaces.flatMap(w => w.connections))] } };
  }

  import(input: unknown, planToken: string): { profileIds: string[]; preview: ArchivePreview } {
    const archive = validateArchive(input), { preview, receipt, digest } = this.plan(archive);
    if (receipt) return { profileIds: receipt.profileIds, preview };
    if (planToken !== preview.planToken) throw new Error("Состав команды изменился. Проверьте файл ещё раз перед добавлением сотрудников.");
    if (archive.schedules.length && !this.messages.scheduler) throw new Error("На этом Home недоступны расписания. Обновите OpenStrudel и повторите импорт.");
    const ids = <T extends { id: string }>(items: T[]) => new Map(items.map(item => [item.id, randomUUID()]));
    const profiles = ids(archive.profiles), conversations = ids(archive.conversations), messages = ids(archive.messages), attachments = ids(archive.attachments), schedules = ids(archive.schedules);
    const contexts = new Map(archive.workspaces.map(w => [w.id, w.id.startsWith("group-") ? "group-" + hash(randomUUID()) : "import-" + randomUUID().replaceAll("-", "")]));
    const written: string[] = [];
    const db = this.store.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      // All directories are fresh namespaces. Existing files can never be
      // overwritten, even by a malicious or repeated import.
      for (const w of archive.workspaces) {
        const root = this.messages.files.workspace(contexts.get(w.id)!);
        mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
        checkWorkspacePath(root);
        const stage = root + ".staging";
        mkdirSync(stage, { mode: 0o700 }); written.push(stage);
        for (const directory of w.directories) mkdirSync(resolve(stage, directory), { recursive: true, mode: 0o700 });
        for (const f of w.files) {
          const path = resolve(stage, f.path);
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          writeFileSync(path, Buffer.from(f.content, "base64"), { mode: f.executable ? 0o700 : 0o600, flag: "wx" });
        }
        if (existsSync(root)) throw new Error("Папка импорта уже существует. Повторите импорт.");
        renameSync(stage, root); written.push(root);
        this.store.setSetting("archive.connections." + contexts.get(w.id)!, JSON.stringify(w.connections));
        this.store.setSetting("archive.source." + contexts.get(w.id)!, w.sourcePath);
      }
      for (const [index, p] of archive.profiles.entries()) {
        db.prepare("INSERT INTO employee_profiles(id,name,instructions,capabilities_json,model,token_limit,created_at,domain,purpose) VALUES(?,?,?,?,?,?,?,?,?)")
          .run(profiles.get(p.id)!, preview.employees[index]!.importedName, p.instructions, JSON.stringify(p.capabilities), p.model, p.tokenLimit, p.createdAt, p.domain ?? "personal", p.purpose ?? "");
        this.store.setSetting("employee.context." + profiles.get(p.id)!, contexts.get(p.context)!);
      }
      for (const c of archive.conversations) {
        const id = conversations.get(c.id)!, profile = profiles.get(c.profileId)!;
        db.prepare("INSERT INTO conversations(id,channel,external_id,title,codex_thread_id,created_at,updated_at,profile_id) VALUES(?,'api',?,?,NULL,?,?,?)")
          .run(id, c.primary ? "home::employee::" + profile : "import::" + id, c.title, c.createdAt, c.updatedAt, profile);
        this.store.setSetting("conversation.context." + id, contexts.get(c.context)!);
      }
      const files = new Map<string, Row>();
      for (const a of archive.attachments) {
        const c = archive.conversations.find(c => c.id === a.conversationId)!;
        const id = attachments.get(a.id)!, conversationId = conversations.get(c.id)!;
        db.prepare("INSERT INTO conversation_files(id,conversation_id,name,mime_type,size,path) VALUES(?,?,?,?,?,?)")
          .run(id, conversationId, a.name, a.mimeType, a.size, resolve(this.messages.files.workspace(contexts.get(c.context)!), a.path));
        files.set(a.id, { id, conversationId, name: a.name, mimeType: a.mimeType, size: a.size });
      }
      for (const m of archive.messages) {
        const interrupted = ["queued", "running"].includes(m.status);
        db.prepare("INSERT INTO messages(id,conversation_id,channel,direction,reply_to_id,text,external_id,created_at,status,error,kind,author,imported,attachments_json,hidden) VALUES(?,?,'api',?,?,?,NULL,?,?,?,?,?,1,?,?)")
          .run(messages.get(m.id)!, conversations.get(m.conversationId)!, m.direction, m.replyToId ? messages.get(m.replyToId)! : null, m.text, m.createdAt, interrupted ? "failed" : m.status, interrupted ? "Не запущено после импорта." : m.error, m.kind, m.author, JSON.stringify(m.attachments.map(id => files.get(id)!)), m.hidden ? 1 : 0);
      }
      for (const s of archive.schedules) {
        // Insert primaries and backups before linking them; source row order
        // is not trusted. No imported schedule can run or send to Telegram.
        db.prepare("INSERT INTO schedules(id,conversation_id,name,prompt,cron,timezone,enabled,next_run_at,telegram_chat_id,delivery,backup_of) VALUES(?,?,?,?,?,?,0,?,NULL,'app',NULL)")
          .run(schedules.get(s.id)!, conversations.get(s.conversationId)!, s.name, s.prompt, s.cron, s.timezone, new Date().toISOString());
        this.store.setSetting("schedule.import." + schedules.get(s.id)!, JSON.stringify({ enabled: s.enabled, delivery: s.delivery, destination: s.destination }));
      }
      for (const s of archive.schedules) if (s.backupOf) db.prepare("UPDATE schedules SET backup_of=? WHERE id=?").run(schedules.get(s.backupOf)!, schedules.get(s.id)!);
      for (const r of archive.runs) {
        // Historic receipts are terminal: recovery must never deliver them.
        db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at,message_id,error) VALUES(?,?,?,?,?,?,?,?)")
          .run(randomUUID(), schedules.get(r.scheduleId)!, conversations.get(r.conversationId)!, r.scheduledFor, "imported", r.createdAt, r.messageId ? messages.get(r.messageId)! : null, r.error);
      }
      const result = { profileIds: [...profiles.values()], preview };
      this.store.setSetting("agents.import." + archive.id, JSON.stringify({ ...result, digest }));
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      for (const path of written.reverse()) rmSync(path, { recursive: true, force: true });
      throw error;
    }
  }
}

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function checkWorkspacePath(root: string): void {
  for (const path of [root, dirname(root), dirname(dirname(root))]) if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Рабочая папка должна находиться внутри OpenStrudel.");
}
function fail(): never { throw new Error("Файл повреждён или содержит несовместимые данные. Выберите другой экспорт OpenStrudel."); }
function object(value: unknown): Row { if (!value || typeof value !== "object" || Array.isArray(value)) fail(); return value as Row; }
function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) fail(); return value; }
function string(value: unknown, max = 1000): string { if (typeof value !== "string" || value.length > max || value.includes("\0")) fail(); return value; }
function optional(value: unknown, max = 1000): string | null { return value === null ? null : string(value, max); }
function bool(value: unknown): boolean { if (typeof value !== "boolean") fail(); return value; }
function number(value: unknown, max = Number.MAX_SAFE_INTEGER): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) fail(); return value; }
function date(value: unknown): string { const s = string(value, 40); if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || !Number.isFinite(Date.parse(s))) fail(); return s; }
function choice(value: unknown, choices: string[]): string { const s = string(value); if (!choices.includes(s)) fail(); return s; }
function identifier(value: unknown): string { const s = string(value, 100); if (!/^[a-zA-Z0-9_-]+$/.test(s)) fail(); return s; }
function safePath(value: unknown): string {
  const s = string(value, 1000);
  if (!s || s.includes("\\") || /[\u0000-\u001f\u007f:]/u.test(s) || s.split("/").some(p => !p || p === "." || p === "..")) fail();
  return s;
}
function unique<T extends { id: string }>(items: T[]): Map<string, T> { const map = new Map(items.map(x => [x.id, x])); if (map.size !== items.length) fail(); return map; }

export function validateArchive(input: unknown): AgentArchive {
  const a = object(input);
  if (a.format !== "openstrudel.team") throw new Error("Это не файл экспорта команды OpenStrudel.");
  if (a.version !== 1) throw new Error("Этот файл создан другой версией OpenStrudel. Обновите приложение и Home, затем повторите импорт.");
  if (Buffer.byteLength(JSON.stringify(a)) > MAX_ARCHIVE_BYTES) throw new Error("Файл экспорта больше 192 МБ.");
  const id = identifier(a.id);
  if (!/^[a-f0-9-]{36}$/.test(id)) fail();
  const profiles: Profile[] = array(a.profiles, 1000).map(v => {
    const p = object(v), name = string(p.name, 80);
    if (!name.trim() || name !== name.trim()) fail();
    return { id: identifier(p.id), context: identifier(p.context), name, instructions: string(p.instructions, 12000), capabilities: array(p.capabilities, 100).map(c => string(c, 200)), model: optional(p.model, 200), tokenLimit: p.tokenLimit === null ? null : number(p.tokenLimit), createdAt: date(p.createdAt), domain: choice(p.domain ?? "personal", ["personal", "work"]) as "personal" | "work", purpose: string(p.purpose ?? "", 240) };
  });
  if (!profiles.length) fail();
  const people = unique(profiles);
  let bytes = 0, fileCount = 0;
  const workspaces: Workspace[] = array(a.workspaces, 10000).map(v => {
    const w = object(v), paths = new Set<string>();
    const files = array(w.files, 10000).map(value => {
      const f = object(value), path = safePath(f.path), key = path.normalize("NFC").toLocaleLowerCase("en-US");
      if (paths.has(key) || ++fileCount > 10000) fail();
      paths.add(key);
      const content = string(f.content, MAX_ARCHIVE_BYTES);
      if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) fail();
      const data = Buffer.from(content, "base64"); bytes += data.length;
      if (bytes > MAX_CONTENT_BYTES || data.toString("base64") !== content || hash(data) !== f.sha256) fail();
      return { path, content, sha256: string(f.sha256, 64), executable: bool(f.executable) };
    });
    for (const path of paths) {
      const parts = path.split("/"); parts.pop();
      while (parts.length) { if (paths.has(parts.join("/"))) fail(); parts.pop(); }
    }
    const directories = array(w.directories, 10000).map(safePath);
    const spellings = new Map<string, string>();
    for (const path of [...files.map(f => f.path), ...directories]) {
      const parts = path.split("/");
      while (parts.length) {
        const name = parts.join("/").normalize("NFC"), key = name.toLocaleLowerCase("en-US"), previous = spellings.get(key);
        if (previous && previous !== name) fail();
        spellings.set(key, name); parts.pop();
      }
    }
    for (const directory of directories) {
      const parts = directory.split("/");
      while (parts.length) { if (paths.has(parts.join("/").normalize("NFC").toLocaleLowerCase("en-US"))) fail(); parts.pop(); }
    }
    return { id: identifier(w.id), sourcePath: string(w.sourcePath, 2000), connections: array(w.connections, 500).map(c => identifier(c)), directories, files };
  });
  const spaces = unique(workspaces);
  for (const p of profiles) if (!spaces.has(p.context)) fail();
  const primary = new Set<string>();
  const conversations: Conversation[] = array(a.conversations, 10000).map(v => {
    const c = object(v);
    const item = { id: identifier(c.id), profileId: identifier(c.profileId), context: identifier(c.context), title: string(c.title, 2000), createdAt: date(c.createdAt), updatedAt: date(c.updatedAt), primary: bool(c.primary), sourceChannel: choice(c.sourceChannel, ["api", "telegram"]) };
    if (!people.has(item.profileId) || !spaces.has(item.context)) fail();
    if (item.primary) { if (primary.has(item.profileId) || item.context !== people.get(item.profileId)!.context) fail(); primary.add(item.profileId); }
    return item;
  });
  const chats = unique(conversations);
  const attachments: Attachment[] = array(a.attachments, 10000).map(v => {
    const f = object(v), c = chats.get(identifier(f.conversationId)); if (!c) fail();
    const path = safePath(f.path), file = spaces.get(c.context)!.files.find(f => f.path === path), size = number(f.size, MAX_CONTENT_BYTES);
    if (!file || Buffer.from(file.content, "base64").length !== size) fail();
    return { id: identifier(f.id), conversationId: c.id, name: string(f.name, 1000), mimeType: string(f.mimeType, 300), size, path };
  });
  const files = unique(attachments);
  const messages: Message[] = array(a.messages, 100000).map(v => {
    const m = object(v), conversationId = identifier(m.conversationId); if (!chats.has(conversationId)) fail();
    const attached = array(m.attachments, 100).map(identifier); for (const id of attached) if (files.get(id)?.conversationId !== conversationId) fail();
    return { id: identifier(m.id), conversationId, direction: choice(m.direction, ["inbound", "outbound"]), replyToId: optional(m.replyToId, 100), text: string(m.text, 8 * 1024 * 1024), createdAt: date(m.createdAt), status: choice(m.status, ["queued", "running", "completed", "failed"]), error: optional(m.error, 12000), kind: choice(m.kind, ["text", "notice"]), author: optional(m.author, 2000), hidden: bool(m.hidden), attachments: attached };
  });
  const history = unique(messages);
  for (const m of messages) if (m.replyToId && history.get(m.replyToId)?.conversationId !== m.conversationId) fail();
  const schedules: Schedule[] = array(a.schedules, 10000).map(v => {
    const s = object(v), conversationId = identifier(s.conversationId); if (!chats.has(conversationId)) fail();
    const cron = string(s.cron, 200), timezone = string(s.timezone, 100), name = string(s.name, 120), prompt = string(s.prompt, 12000);
    if (cron.trim().split(/\s+/).length !== 5 || !name.trim() || !prompt.trim()) fail();
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }); CronExpressionParser.parse(cron, { tz: timezone }).next(); } catch { fail(); }
    return { id: identifier(s.id), conversationId, name, prompt, cron, timezone, enabled: bool(s.enabled), delivery: choice(s.delivery, ["app", "telegram", "bound"]), destination: optional(s.destination, 2000), backupOf: optional(s.backupOf, 100) };
  });
  const clocks = unique(schedules);
  for (const s of schedules) if (s.backupOf) { const p = clocks.get(s.backupOf); if (!p || p.backupOf || p.id === s.id || p.conversationId !== s.conversationId) fail(); }
  const runs: Run[] = array(a.runs, 100000).map(v => {
    const r = object(v), schedule = clocks.get(identifier(r.scheduleId)); if (!schedule || r.conversationId !== schedule.conversationId) fail();
    const messageId = optional(r.messageId, 100); if (messageId && history.get(messageId)?.conversationId !== r.conversationId) fail();
    return { id: identifier(r.id), scheduleId: schedule.id, conversationId: schedule.conversationId, scheduledFor: date(r.scheduledFor), status: string(r.status, 100), createdAt: date(r.createdAt), messageId, error: optional(r.error, 12000) };
  });
  unique(runs);
  if (new Set(runs.map(r => r.scheduleId + ":" + r.scheduledFor)).size !== runs.length) fail();
  return { format: "openstrudel.team", version: 1, id, createdAt: date(a.createdAt), profiles, workspaces, conversations, messages, attachments, schedules, runs };
}
