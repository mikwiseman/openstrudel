import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import { hostname } from "node:os";
import type { Store } from "./store.js";

export const HOME_PROTOCOL = 1;
export type Endpoint = { url: string; pin?: string };
export type NodeInfo = { id: string; name: string; platform: string; protocol: number; endpoint?: Endpoint; seenAt: number };
export type HomeState = {
  id: string; nodeId: string; name: string; role: "primary" | "executor" | "retired";
  epoch: number; primaryId: string; mainNodeId: string; mainAgentId?: string;
  upstream?: Endpoint & { token: string; homeId: string; primaryId: string; epoch: number };
  moved?: Endpoint & { homeId: string; primaryId: string; epoch: number };
};
export type Inventory = { profiles: Record<string, any>[]; conversations: Record<string, any>[]; files: string[] };
export type WireRequest = { method: string; path: string; body?: string; contentType?: string; owner: boolean };
export type WireResponse = { status: number; body: string; contentType: string; etag?: string };
export type Command = { id: string; request: WireRequest };
type Row = Record<string, any>;
export class HomeError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function endpoint(input: unknown): Endpoint {
  const value = input as Partial<Endpoint>;
  if (!value || typeof value.url !== "string") throw new HomeError("Укажите адрес главного устройства.");
  let url: URL;
  try { url = new URL(value.url); } catch { throw new HomeError("Проверьте адрес устройства."); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" && url.pathname !== "") throw new HomeError("Нужен адрес устройства без пути и пароля.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) throw new HomeError("Для удалённого устройства нужен HTTPS.");
  if (value.pin !== undefined && !/^[a-f0-9]{64}$/i.test(value.pin)) throw new HomeError("Проверьте отпечаток устройства.");
  return { url: url.origin, ...(value.pin ? { pin: value.pin.toLowerCase() } : {}) };
}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HomeError("Нужен объект JSON.");
  return value as Record<string, any>;
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(value)) throw new HomeError("Некорректный идентификатор.");
  return value;
}
const now = () => Date.now();

/** Only the primary owns these tables. Executors own their existing agent DB and receipts. */
export class Home {
  constructor(readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS home_nodes(id TEXT PRIMARY KEY, info TEXT NOT NULL, token_hash TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS home_resources(kind TEXT NOT NULL, id TEXT NOT NULL, node_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS home_commands(id TEXT PRIMARY KEY, node_id TEXT NOT NULL, request TEXT NOT NULL, response TEXT, created_at INTEGER NOT NULL, canceled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS home_receipts(id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response TEXT, started INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS home_operations(id TEXT PRIMARY KEY, state TEXT NOT NULL);
    `);
    for (const [table, column, declaration] of [
      ["home_commands", "request_hash", "TEXT"], ["home_commands", "finished_at", "INTEGER"],
      ["home_commands", "dispatched", "INTEGER NOT NULL DEFAULT 0"],
      ["home_receipts", "acknowledged", "INTEGER NOT NULL DEFAULT 0"],
      ["home_receipts", "finished_at", "INTEGER"],
    ]) {
      if (!(store.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some(r => r.name === column)) store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
    if (!store.getSetting("home.state")) {
      const nodeId = randomUUID();
      this.save({ id: randomUUID(), nodeId, name: hostname(), role: "primary", epoch: 1, primaryId: nodeId, mainNodeId: nodeId });
    }
    if (this.state.role === "primary") this.register(this.self());
  }
  get state(): HomeState { return JSON.parse(this.store.getSetting("home.state")!); }
  save(state: HomeState) { this.store.setSetting("home.state", JSON.stringify(state)); }
  self(): NodeInfo {
    const state = this.state;
    const saved = this.store.getSetting("home.endpoint");
    return { id: state.nodeId, name: state.name, platform: process.platform, protocol: HOME_PROTOCOL, seenAt: now(), ...(saved ? { endpoint: JSON.parse(saved) } : {}) };
  }
  setEndpoint(value: Endpoint) { this.store.setSetting("home.endpoint", JSON.stringify(endpoint(value))); if (this.state.role === "primary") this.register(this.self()); }
  assertPrimary() { if (this.state.role !== "primary") throw new HomeError("Управление находится на главном устройстве.", 409); }
  transaction<T>(f: () => T): T {
    this.store.db.exec("BEGIN IMMEDIATE");
    try { const result = f(); this.store.db.exec("COMMIT"); return result; }
    catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
  }
  register(info: NodeInfo, tokenHash?: string) {
    identifier(info.id);
    if (typeof info.name !== "string" || !info.name.trim() || info.name.length > 120 || typeof info.platform !== "string" || info.platform.length > 30 || info.protocol !== HOME_PROTOCOL) throw new HomeError("Обновите OpenStrudel на обоих устройствах.");
    info = { id: info.id, name: info.name.trim(), platform: info.platform, protocol: HOME_PROTOCOL, seenAt: now(), ...(info.endpoint ? { endpoint: endpoint(info.endpoint) } : {}) };
    this.store.db.prepare("INSERT INTO home_nodes(id,info,token_hash) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET info=excluded.info,token_hash=COALESCE(excluded.token_hash,home_nodes.token_hash)").run(info.id, JSON.stringify(info), tokenHash ?? null);
  }
  nodes(): Array<NodeInfo & { primary: boolean; online: boolean; agents: number }> {
    const state = this.state;
    return (this.store.db.prepare("SELECT * FROM home_nodes ORDER BY rowid").all() as Row[]).map(row => {
      const info: NodeInfo = JSON.parse(row.info);
      return { ...info, primary: info.id === state.primaryId, online: info.id === state.nodeId || now() - info.seenAt < 15_000, agents: this.resources("profile", info.id).length };
    });
  }
  authorize(token: string): string | undefined {
    if (!token || token.length > 512) return undefined;
    return (this.store.db.prepare("SELECT id FROM home_nodes WHERE token_hash=?").get(digest(token)) as Row | undefined)?.id;
  }
  invite(address: Endpoint, reconnectId?: string) {
    this.assertPrimary();
    if (reconnectId && (reconnectId === this.state.nodeId || !this.nodes().some(n => n.id === reconnectId))) throw new HomeError("Устройство не найдено.", 404);
    const key = randomBytes(32).toString("hex");
    const expiresAt = now() + 300_000;
    this.store.setSetting("home.invitation", JSON.stringify({ hash: digest(key), expiresAt, reconnectId }));
    this.store.deleteSetting("home.pair_receipt");
    return { format: "openstrudel.device", version: HOME_PROTOCOL, endpoint: endpoint(address), homeId: this.state.id, key, expiresAt, reconnectId };
  }
  pair(key: string, info: NodeInfo) {
    this.assertPrimary();
    const previous = JSON.parse(this.store.getSetting("home.pair_receipt") ?? "null");
    const infoHash = digest(JSON.stringify({ ...info, seenAt: 0 }));
    if (previous?.expiresAt > now() && previous.hash === digest(key) && previous.node === info.id && previous.infoHash === infoHash) return previous.result;
    const invitation = JSON.parse(this.store.getSetting("home.invitation") ?? "null");
    if (!invitation || invitation.expiresAt <= now() || invitation.hash !== digest(key)) throw new HomeError("Приглашение истекло. Создайте новое на главном устройстве.", 401);
    if (invitation.reconnectId && invitation.reconnectId !== info.id) throw new HomeError("Приглашение предназначено для другого устройства.", 403);
    if (this.store.db.prepare("SELECT id FROM home_nodes WHERE id=?").get(info.id) && invitation.reconnectId !== info.id) throw new HomeError("Это устройство уже подключено. Создайте приглашение для восстановления его связи.", 409);
    const token = randomBytes(32).toString("hex");
    const state = this.state;
    const result = { token, homeId: state.id, primaryId: state.primaryId, epoch: state.epoch };
    this.transaction(() => {
      this.register(info, digest(token)); this.store.deleteSetting("home.invitation");
      this.store.setSetting("home.pair_receipt", JSON.stringify({ hash: digest(key), node: info.id, infoHash, expiresAt: invitation.expiresAt, result }));
    });
    return result;
  }
  join(link: HomeState["upstream"]) {
    if (!link) throw new HomeError("Не получено подключение.");
    const state = this.state;
    if (state.role === "primary" ? this.nodes().length > 1 || this.pending().length : state.id !== link.homeId || link.epoch < state.epoch) throw new HomeError("Сначала завершите текущие подключения и поручения.", 409);
    this.transaction(() => {
      if (state.role === "primary") this.preserveLocalAssistant();
      this.clearCatalogue();
      this.save({ ...state, id: link.homeId, role: "executor", primaryId: link.primaryId, mainNodeId: link.primaryId, epoch: link.epoch, upstream: { ...link, ...endpoint(link) } });
    });
  }
  private preserveLocalAssistant() {
    const conversations = this.store.listConversations().filter(c => !c.profileId);
    const soul = this.store.getSetting("main.soul") ?? "";
    if (!soul && !conversations.some(c => this.store.listMessages(c.id, 1).length)) return;
    let name = ("Помощник · " + this.state.name).slice(0, 70);
    const base = name;
    for (let n = 2; this.store.getProfile(name); n++) name = `${base} ${n}`;
    const profile = this.store.createProfile({ name, instructions: soul });
    // Joining changes control, never the location or identity of existing chats.
    this.store.setSetting("employee.context." + profile.id, "personal");
    const policy = this.store.getSetting("agent.accounts.main");
    if (policy) this.store.setSetting("agent.accounts." + profile.id, policy);
    for (const c of conversations) {
      this.store.db.prepare("UPDATE conversations SET profile_id=?, external_id=CASE WHEN channel='api' AND external_id='home' THEN ? ELSE external_id END WHERE id=?")
        .run(profile.id, "home::employee::" + profile.id, c.id);
    }
  }
  clearCatalogue() { this.store.db.exec("DELETE FROM home_nodes; DELETE FROM home_resources; DELETE FROM home_commands;"); }
  inventory(): Inventory {
    const visible = (agent: string) => !["moved", "staged"].includes(JSON.parse(this.store.getSetting("agent.transfer." + agent) ?? "null")?.phase);
    if (visible("main")) this.store.primaryConversation();
    const profiles = this.store.listProfiles().filter(p => visible(p.id));
    for (const p of profiles) this.store.profileConversation(p.id);
    const conversations = this.store.listConversations().filter(c => visible(c.profileId ?? "main"));
    const chatIds = new Set(conversations.map(c => c.id));
    const files = this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_files'").get();
    return { profiles, conversations, files: files ? (this.store.db.prepare("SELECT id,conversation_id FROM conversation_files").all() as Row[]).filter(r => chatIds.has(r.conversation_id)).map(r => String(r.id)) : [] };
  }
  updateInventory(nodeId: string, value: Inventory) {
    if (!Array.isArray(value.profiles) || !Array.isArray(value.conversations) || !Array.isArray(value.files) || value.profiles.length > 1000 || value.conversations.length > 10000 || value.files.length > 20000) throw new HomeError("Слишком большой каталог устройства.");
    const entries: Array<[string, string, unknown]> = [
      ...value.profiles.map(p => ["profile", identifier(p.id), p] as [string, string, unknown]),
      ...value.conversations.map(c => ["conversation", identifier(c.id), c] as [string, string, unknown]),
      ...value.files.map(id => ["file", identifier(id), {}] as [string, string, unknown]),
    ];
    this.transaction(() => {
      for (const [kind, id, data] of entries) {
        const previous = this.nodeFor(kind, id);
        if (previous && previous !== nodeId) throw new HomeError("Идентификаторы устройств пересекаются. Подключение остановлено.", 409);
        this.store.db.prepare("INSERT INTO home_resources(kind,id,node_id,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data WHERE home_resources.data!=excluded.data").run(kind, id, nodeId, JSON.stringify(data));
      }
      const profiles = new Set(value.profiles.map(p => p.id));
      for (const old of this.store.db.prepare("SELECT id FROM home_resources WHERE kind='profile' AND node_id=?").all(nodeId) as Row[]) {
        if (!profiles.has(old.id)) this.store.db.prepare("DELETE FROM home_resources WHERE kind='profile' AND id=? AND node_id=?").run(old.id, nodeId);
      }
      // Keep old routes for in-flight requests, but never advertise deleted chats
      // or files as current inventory. A later request receives the owner's 404.
      for (const kind of ["conversation", "file"]) {
        const present = new Set(entries.filter(e => e[0] === kind).map(e => e[1]));
        for (const old of this.store.db.prepare("SELECT id FROM home_resources WHERE kind=? AND node_id=? AND data!='{\"deleted\":true}'").all(kind, nodeId) as Row[]) {
          if (!present.has(old.id)) this.store.db.prepare("UPDATE home_resources SET data='{\"deleted\":true}' WHERE kind=? AND id=? AND node_id=?").run(kind, old.id, nodeId);
        }
      }
    });
  }
  resources(kind: string, nodeId?: string): Record<string, any>[] {
    const rows = this.store.db.prepare("SELECT * FROM home_resources WHERE kind=?" + (nodeId ? " AND node_id=?" : ""));
    return (nodeId ? rows.all(kind, nodeId) : rows.all(kind) as Row[]).map((r: any) => ({ ...JSON.parse(r.data), deviceId: r.node_id })).filter(r => !r.deleted);
  }
  nodeFor(kind: string, id: string): string | undefined { return (this.store.db.prepare("SELECT node_id FROM home_resources WHERE kind=? AND id=?").get(kind, id) as Row | undefined)?.node_id; }
  touch(nodeId: string, info: NodeInfo) {
    const existing = this.store.db.prepare("SELECT id FROM home_nodes WHERE id=?").get(nodeId);
    if (!existing || info.id !== nodeId) throw new HomeError("Устройство не подключено.", 401);
    this.register({ ...info, id: nodeId, seenAt: now() });
  }
  enqueue(nodeId: string, request: WireRequest, id: string = randomUUID()): string {
    this.assertPrimary(); identifier(id);
    if (!this.store.db.prepare("SELECT id FROM home_nodes WHERE id=?").get(nodeId)) throw new HomeError("Устройство не найдено.", 404);
    const serialized = JSON.stringify(request);
    if (Buffer.byteLength(serialized) > 280 * 1024 * 1024) throw new HomeError("Запрос слишком большой.", 413);
    const previous = this.store.db.prepare("SELECT * FROM home_commands WHERE id=?").get(id) as Row | undefined;
    if (previous) { if (previous.node_id !== nodeId && !previous.response && !previous.canceled || (previous.request_hash ?? digest(previous.request)) !== digest(serialized)) throw new HomeError("Идентификатор запроса уже использован.", 409); return id; }
    if (this.pending().length >= 1000) throw new HomeError("Очередь устройства заполнена. Дождитесь подключения.", 429);
    this.store.db.prepare("INSERT INTO home_commands(id,node_id,request,request_hash,created_at) VALUES(?,?,?,?,?)").run(id, nodeId, serialized, digest(serialized), now());
    return id;
  }
  pending(nodeId?: string): Command[] {
    const query = this.store.db.prepare("SELECT id,request FROM home_commands WHERE response IS NULL AND canceled=0" + (nodeId ? " AND node_id=?" : "") + " ORDER BY created_at LIMIT 1000");
    return ((nodeId ? query.all(nodeId) : query.all()) as Row[]).map(r => ({ id: r.id, request: JSON.parse(r.request) }));
  }
  command(id: string) { return this.store.db.prepare("SELECT * FROM home_commands WHERE id=?").get(id) as Row | undefined; }
  dispatch(nodeId: string): Command[] {
    return this.transaction(() => {
      const commands = this.pending(nodeId).slice(0, 8);
      for (const command of commands) this.store.db.prepare("UPDATE home_commands SET dispatched=1 WHERE id=?").run(command.id);
      return commands;
    });
  }
  cancel(id: string) {
    const row = this.command(id);
    if (!row) throw new HomeError("Поручение не найдено.", 404);
    if (row.canceled) return;
    if (row.dispatched || row.response) throw new HomeError("Поручение уже передано устройству. Проверьте его состояние в чате: отмену доставки подтвердить нельзя.", 409);
    this.store.db.prepare("UPDATE home_commands SET canceled=1, request=?, finished_at=? WHERE id=?").run(JSON.stringify({ method: JSON.parse(row.request).method, path: JSON.parse(row.request).path, owner: JSON.parse(row.request).owner }), now(), id);
  }
  finish(nodeId: string, id: string, response: WireResponse) {
    const current = this.command(id);
    if (!current || current.node_id !== nodeId) throw new HomeError("Поручение не найдено.", 404);
    if (current.response) return;
    if (typeof response.body !== "string" || response.body.length > 280 * 1024 * 1024 || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new HomeError("Некорректный результат устройства.");
    const request = JSON.parse(current.request);
    this.store.db.prepare("UPDATE home_commands SET response=?,finished_at=?,request_hash=COALESCE(request_hash,?),request=? WHERE id=? AND response IS NULL")
      .run(JSON.stringify(response), now(), digest(current.request), JSON.stringify({ method: request.method, path: request.path, owner: request.owner }), id);
  }
  prune() {
    // Completed content is a short transport cache, never a second agent history.
    const expired = JSON.stringify({ status: 410, contentType: "application/json", body: Buffer.from(JSON.stringify({ delivered: true, error: "Результат уже доставлен. Откройте актуальное состояние агента." })).toString("base64") });
    const moves = (this.store.db.prepare("SELECT state FROM home_operations").all() as Row[]).map(r => JSON.parse(r.state)).filter(r => r.kind === "agent-move" && !["completed", "canceled"].includes(r.phase));
    for (const row of this.store.db.prepare("SELECT id,response FROM home_commands WHERE finished_at<? AND response<>? AND response IS NOT NULL").all(now() - 300_000, expired) as Row[]) {
      if (moves.some(move => row.id.startsWith(move.id + ":"))) continue;
      const response = JSON.parse(row.response);
      if (response.status < 400) this.store.db.prepare("UPDATE home_commands SET response=? WHERE id=?").run(expired, row.id);
      else {
        let error: any; try { error = JSON.parse(Buffer.from(response.body, "base64").toString()); } catch {}
        const compact = { status: response.status, contentType: "application/json", body: Buffer.from(JSON.stringify({ error: String(error?.error ?? "Устройство не подтвердило выполнение. Проверьте чат перед повтором.").slice(0, 500), uncertain: error?.uncertain === true })).toString("base64") };
        if (JSON.stringify(compact) !== row.response) this.store.db.prepare("UPDATE home_commands SET response=? WHERE id=?").run(JSON.stringify(compact), row.id);
      }
    }
    this.store.db.prepare("UPDATE home_receipts SET response=? WHERE acknowledged=1 AND finished_at<? AND response IS NOT NULL").run(expired, now() - 300_000);
    const receipt = JSON.parse(this.store.getSetting("home.pair_receipt") ?? "null");
    if (receipt && receipt.expiresAt <= now()) this.store.deleteSetting("home.pair_receipt");
  }
  acknowledge(ids: string[]) { for (const id of ids) this.store.db.prepare("UPDATE home_receipts SET acknowledged=1 WHERE id=?").run(id); }
  receipt(command: Command): WireResponse | "started" | undefined {
    const row = this.store.db.prepare("SELECT * FROM home_receipts WHERE id=?").get(command.id) as Row | undefined;
    if (!row) return undefined;
    if (row.request_hash !== digest(JSON.stringify(command.request))) throw new HomeError("Содержимое повторного поручения изменилось.", 409);
    return row.response ? JSON.parse(row.response) : "started";
  }
  begin(command: Command) { this.store.db.prepare("INSERT INTO home_receipts(id,request_hash,started) VALUES(?,?,1)").run(command.id, digest(JSON.stringify(command.request))); }
  complete(command: Command, response: WireResponse) { this.store.db.prepare("UPDATE home_receipts SET response=?,finished_at=? WHERE id=?").run(JSON.stringify(response), now(), command.id); }
  operation(id: string): any { const r = this.store.db.prepare("SELECT state FROM home_operations WHERE id=?").get(id) as Row | undefined; return r ? JSON.parse(r.state) : null; }
  saveOperation(value: any) { this.store.db.prepare("INSERT INTO home_operations(id,state) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state").run(identifier(value.id), JSON.stringify(value)); }
  removeNode(nodeId: string) {
    this.assertPrimary();
    if (nodeId === this.state.primaryId) throw new HomeError("Сначала выберите другое главное устройство.", 409);
    if (nodeId === this.state.mainNodeId) throw new HomeError("На устройстве находится главный помощник. Сначала перенесите его историю.", 409);
    if (this.resources("profile", nodeId).length || this.pending(nodeId).length) throw new HomeError("На устройстве есть агенты или поручения. Сначала перенесите их.", 409);
    this.store.db.prepare("DELETE FROM home_nodes WHERE id=?").run(nodeId);
    this.store.db.prepare("DELETE FROM home_resources WHERE node_id=?").run(nodeId);
  }
  snapshot() {
    this.assertPrimary();
    const access = this.store.db.prepare("SELECT * FROM settings WHERE key IN ('mobile.tokens','mobile.owners','mobile.clients')").all() as Row[];
    const local = this.store.getSetting("home.local_client_hash");
    if (local) for (const key of ["mobile.tokens", "mobile.owners"]) {
      const row = access.find(r => r.key === key);
      const values = [...new Set([...(JSON.parse(row?.value ?? "[]") as string[]), local])];
      if (row) row.value = JSON.stringify(values); else access.push({ key, value: JSON.stringify(values) });
    }
    return {
      format: "openstrudel.home", version: HOME_PROTOCOL, createdAt: new Date().toISOString(), state: this.state,
      nodes: this.store.db.prepare("SELECT * FROM home_nodes").all(), resources: this.store.db.prepare("SELECT * FROM home_resources").all(),
      commands: this.store.db.prepare("SELECT * FROM home_commands").all(),
      access,
    };
  }
}

/** Backups containing device access are always encrypted; agent export remains a separate format. */
export function encryptBackup(value: unknown, password: string): string {
  if (password.length < 12 || password.length > 1024) throw new HomeError("Для копии нужен пароль от 12 символов.");
  const salt = randomBytes(16), iv = randomBytes(12), key = scryptSync(password, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("openstrudel.home.backup:1"));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return JSON.stringify({ format: "openstrudel.home.backup", version: 1, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
}
export function decryptBackup(input: string, password: string): unknown {
  try {
    if (input.length > 300 * 1024 * 1024 || password.length > 1024) throw new Error();
    const value = JSON.parse(input);
    if (value.format !== "openstrudel.home.backup" || value.version !== 1) throw new Error();
    const salt = Buffer.from(value.salt, "base64"), iv = Buffer.from(value.iv, "base64"), tag = Buffer.from(value.tag, "base64");
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error();
    const cipher = createDecipheriv("aes-256-gcm", scryptSync(password, salt, 32), iv);
    cipher.setAAD(Buffer.from("openstrudel.home.backup:1")); cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, "base64")), cipher.final()]).toString());
  } catch { throw new HomeError("Не удалось открыть копию. Проверьте файл и пароль."); }
}
