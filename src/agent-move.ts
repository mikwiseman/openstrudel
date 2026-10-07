import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { AgentArchives, validateArchive, type AgentArchive, type MoveMetadata } from "./agent-archive.js";
import { Home, HomeError, digest, identifier, object, type WireRequest, type WireResponse } from "./home.js";
import { requestJSON, resultJSON, wireJSON } from "./home-transport.js";
import type { MessageService } from "./messages.js";
import type { Store } from "./store.js";

const lockKey = (agent: string) => "agent.transfer." + agent;
const operationKey = (id: string) => "agent.move." + id;
export const agentTransfer = (store: Store, agent: string): any => JSON.parse(store.getSetting(lockKey(agent)) ?? "null");
export const hiddenAgent = (store: Store, agent: string) => ["moved", "staged"].includes(agentTransfer(store, agent)?.phase);
export function assertAgentWritable(store: Store, agent: string) {
  if (store.getSetting("employee.deleted." + agent)) throw new HomeError("Сотрудник удалён.", 410);
  const lock = agentTransfer(store, agent);
  if (lock) throw new HomeError(lock.phase === "moved" ? "Агент перенесён на другое устройство. Обновите подключение к главному." : "Агент переносится. Новое поручение можно отправить после завершения.", 423);
}

type Bundle = { format: "openstrudel.agent-move"; version: 1; id: string; sourceAgent: string; agentId: string; archive: AgentArchive; metadata: MoveMetadata };
function validateBundle(input: unknown): Bundle {
  const b = object(input);
  if (b.format !== "openstrudel.agent-move" || b.version !== 1) throw new HomeError("Обновите OpenStrudel на обоих устройствах.");
  identifier(b.id); identifier(b.sourceAgent); identifier(b.agentId);
  const archive = validateArchive(b.archive), m = object(b.metadata);
  if (archive.id !== b.id || archive.profiles.length !== 1 || archive.profiles[0]!.id !== b.agentId || b.agentId === "main") throw new HomeError("Копия агента не соответствует переносу.");
  if (!Array.isArray(m.messages) || m.messages.length !== archive.messages.length || !Array.isArray(m.schedules) || m.schedules.length !== archive.schedules.length) throw new HomeError("Копия квитанций неполная.");
  const messageIds = new Set(archive.messages.map(r => r.id)), scheduleIds = new Set(archive.schedules.map(r => r.id));
  const messages = m.messages.map((r: any) => {
    if (!messageIds.has(r.id) || !["api", "telegram"].includes(r.channel) || typeof r.imported !== "boolean" || r.externalId !== null && (typeof r.externalId !== "string" || r.externalId.length > 1024)) throw new HomeError("Копия квитанций повреждена.");
    return { id: r.id, channel: r.channel, externalId: r.externalId, imported: r.imported };
  });
  const schedules = m.schedules.map((r: any) => {
    if (!scheduleIds.has(r.id) || typeof r.nextRunAt !== "string" || !Number.isFinite(Date.parse(r.nextRunAt))) throw new HomeError("Копия расписаний повреждена.");
    return { id: r.id, nextRunAt: r.nextRunAt };
  });
  if (new Set(messages.map(r => r.id)).size !== messages.length || new Set(schedules.map(r => r.id)).size !== schedules.length || archive.messages.some(r => ["queued", "running"].includes(r.status)) || archive.runs.some(r => ["running", "ready"].includes(r.status))) throw new HomeError("Сначала дождитесь завершения действий агента.", 409);
  return { format: "openstrudel.agent-move", version: 1, id: b.id, sourceAgent: b.sourceAgent, agentId: b.agentId, archive, metadata: { messages, schedules } };
}

/** Runs only through the authenticated executor channel. Each step can be replayed after a crash. */
export class LocalAgentMoves {
  constructor(private readonly home: Home, private readonly messages: MessageService) {}
  private get store() { return this.home.store; }
  private saved(id: string): any { return JSON.parse(this.store.getSetting(operationKey(id)) ?? "null"); }
  private save(value: any) { this.store.setSetting(operationKey(value.id), JSON.stringify(value)); }
  private checked(input: any) {
    identifier(input.id);
    if (typeof input.proof !== "string" || !/^[a-f0-9]{64}$/.test(input.proof)) throw new HomeError("Перенос не подтверждён.", 403);
    const previous = this.saved(input.id);
    if (previous && previous.proofHash !== digest(input.proof)) throw new HomeError("Перенос не подтверждён.", 403);
    return previous;
  }
  async handle(action: string, input: any) {
    const previous = this.checked(input);
    if (action === "prepare") return this.prepare(input, previous);
    if (action === "stage") return this.stage(input, previous);
    if (!previous) {
      if (action === "cancel") { this.save({ id: input.id, proofHash: digest(input.proof), phase: "canceled" }); return { canceled: true }; }
      throw new HomeError("Перенос не найден.", 404);
    }
    if (action === "release") {
      if (previous.phase !== "prepared" && previous.phase !== "moved") throw new HomeError("Источник не готов к передаче.", 409);
      this.home.transaction(() => { this.save({ ...previous, phase: "moved" }); this.store.setSetting(lockKey(previous.agent), JSON.stringify({ id: input.id, phase: "moved" })); });
      return { released: true, digest: previous.digest };
    }
    if (action === "activate") {
      if (!["staged", "active"].includes(previous.phase) || input.digest !== previous.digest) throw new HomeError("Копия не подтверждена.", 409);
      if (previous.phase === "active") return { active: true, warnings: previous.warnings };
      const bundle = validateBundle(previous.bundle), warnings: string[] = [];
      const connections = bundle.archive.workspaces.flatMap(w => w.connections);
      if (connections.length) warnings.push("Подключите заново: " + [...new Set(connections)].join(", ") + ". Расписания пока на паузе.");
      if (bundle.archive.schedules.some(s => s.delivery !== "app")) warnings.push("Восстановите доставку в Telegram, затем включите нужные расписания.");
      const nextRuns = new Map(bundle.metadata.schedules.map(s => [s.id, s.nextRunAt]));
      this.home.transaction(() => {
        for (const schedule of bundle.archive.schedules) {
          const safe = !connections.length && schedule.delivery === "app";
          this.store.db.prepare("UPDATE schedules SET enabled=?,next_run_at=? WHERE id=?").run(safe && schedule.enabled ? 1 : 0, nextRuns.get(schedule.id)!, schedule.id);
          if (safe) this.store.deleteSetting("schedule.import." + schedule.id);
        }
        this.store.deleteSetting(lockKey(previous.agent));
        this.save({ ...previous, bundle: undefined, phase: "active", warnings });
      });
      return { active: true, warnings };
    }
    if (action === "cancel") {
      if (["moved", "active"].includes(previous.phase)) throw new HomeError("Передача уже состоялась. Отмена не включит прежнюю копию.", 409);
      if (previous.phase === "staged") this.discardInactive(previous.agent, true);
      this.home.transaction(() => {
        if (agentTransfer(this.store, previous.agent)?.id === input.id) this.store.deleteSetting(lockKey(previous.agent));
        this.save({ id: input.id, proofHash: previous.proofHash, phase: "canceled" });
      });
      return { canceled: true };
    }
    if (action === "finish") {
      if (!["active", "moved"].includes(previous.phase)) throw new HomeError("Передача ещё не завершена.", 409);
      this.save({ ...previous, bundle: undefined }); return { ok: true };
    }
    throw new HomeError("Неизвестный этап переноса.", 404);
  }
  private async prepare(input: any, previous: any) {
    if (previous?.phase === "canceled") throw new HomeError("Перенос отменён.", 409);
    if (previous?.bundle) return { ready: true, digest: previous.digest, bundle: previous.bundle };
    if (previous?.phase === "moved") throw new HomeError("Агент уже передан.", 409);
    const agent = identifier(input.agent), agentId = identifier(input.agentId);
    if (agent !== "main" && !this.store.getProfile(agent)) throw new HomeError("Агент не найден.", 404);
    const old = agentTransfer(this.store, agent);
    if (old && old.id !== input.id) throw new HomeError("Агент уже переносится.", 409);
    const chats = this.store.listConversations().filter(c => (c.profileId ?? "main") === agent);
    const contexts = new Set(chats.map(c => this.messages.contextFor(c.id)));
    contexts.add(agent === "main" ? "personal" : this.store.getSetting("employee.context." + agent) ?? this.store.getProfile(agent)?.domain ?? "personal");
    const shared = this.store.listProfiles().some(p => p.id !== agent && !hiddenAgent(this.store, p.id) && contexts.has(this.store.getSetting("employee.context." + p.id) ?? p.domain ?? "personal"))
      || agent !== "main" && !hiddenAgent(this.store, "main") && contexts.has("personal")
      || this.store.listConversations().some(c => (c.profileId ?? "main") !== agent && !hiddenAgent(this.store, c.profileId ?? "main") && contexts.has(this.messages.contextFor(c.id)));
    if (shared) throw new HomeError("У агента общая рабочая папка с другими агентами. Сначала сделайте отдельное пространство; перенос общей папки одним агентом изменит доступы остальных.", 409);
    const operation = { id: input.id, proofHash: digest(input.proof), agent, phase: "preparing" };
    this.home.transaction(() => { this.save(operation); this.store.setSetting(lockKey(agent), JSON.stringify({ id: input.id, phase: "preparing" })); });
    const deadline = Date.now() + 15_000;
    while (this.messages.hasActiveRuns || this.messages.scheduler?.hasActiveRuns) {
      if (Date.now() >= deadline) throw new HomeError("Ещё выполняется действие. Перенос отменится после подтверждения обоих устройств; повторите его после завершения работы.", 409);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (this.saved(input.id)?.phase === "canceled" || agentTransfer(this.store, agent)?.id !== input.id) throw new HomeError("Перенос отменён.", 409);
    // From here to the durable snapshot there are no awaits; local writers cannot interleave.
    const archive = new AgentArchives(this.store, this.messages).export(agent);
    archive.id = input.id;
    archive.profiles[0]!.id = agentId;
    for (const c of archive.conversations) c.profileId = agentId;
    const bundle = validateBundle({ format: "openstrudel.agent-move", version: 1, id: input.id, sourceAgent: agent, agentId, archive, metadata: {
      messages: archive.messages.map(m => {
        const row = this.store.db.prepare("SELECT channel,external_id,imported FROM messages WHERE id=?").get(m.id) as any;
        return { id: m.id, channel: row.channel, externalId: row.external_id, imported: row.imported === 1 };
      }),
      schedules: archive.schedules.map(s => ({ id: s.id, nextRunAt: (this.store.db.prepare("SELECT next_run_at FROM schedules WHERE id=?").get(s.id) as any).next_run_at })),
    } });
    const serialized = JSON.stringify(bundle);
    // The peer envelope adds base64 and JSON overhead. Bound a whole-copy move
    // before releasing the source; large streaming moves require a separate protocol.
    if (Buffer.byteLength(serialized) > 64 * 1024 * 1024) throw new HomeError("Копия агента больше 64 МБ. Прямой перенос пока не поддерживает такой объём. Агент останется на прежнем устройстве; сохраните его экспорт.", 413);
    const hash = digest(serialized);
    this.save({ ...operation, phase: "prepared", bundle, digest: hash });
    return { ready: true, digest: hash, bundle };
  }
  private stage(input: any, previous: any) {
    const bundle = validateBundle(input.bundle), hash = digest(JSON.stringify(bundle));
    if (bundle.id !== input.id || hash !== input.digest || previous && previous.digest !== hash) throw new HomeError("Копия изменилась во время передачи.", 409);
    if (previous) {
      if (!["staged", "active"].includes(previous.phase)) throw new HomeError("Перенос отменён.", 409);
      return { ready: true, digest: hash };
    }
    if (this.store.getProfile(bundle.agentId)) {
      if (agentTransfer(this.store, bundle.agentId)?.phase !== "moved") throw new HomeError("На устройстве уже есть агент с этим идентификатором.", 409);
      this.discardInactive(bundle.agentId, false);
    }
    const archive = bundle.archive, archives = new AgentArchives(this.store, this.messages);
    archives.import(archive, archives.preview(archive).planToken, { metadata: bundle.metadata, commit: () => {
      this.store.setSetting(lockKey(bundle.agentId), JSON.stringify({ id: input.id, phase: "staged" }));
      this.save({ id: input.id, proofHash: digest(input.proof), phase: "staged", agent: bundle.agentId, digest: hash, bundle });
    } });
    return { ready: true, digest: hash };
  }
  private discardInactive(agent: string, removeFiles: boolean) {
    if (!hiddenAgent(this.store, agent) || agent === "main") throw new HomeError("Работающий агент не может быть заменён.", 409);
    const chats = this.store.listConversations().filter(c => c.profileId === agent), contexts = new Set(chats.map(c => this.messages.contextFor(c.id)));
    const ownContext = this.store.getSetting("employee.context." + agent); if (ownContext) contexts.add(ownContext);
    this.home.transaction(() => {
      for (const c of chats) {
        this.store.db.prepare("UPDATE schedules SET backup_of=NULL WHERE conversation_id=?").run(c.id);
        for (const table of ["schedule_runs", "schedules", "conversation_files", "messages"]) this.store.db.prepare(`DELETE FROM ${table} WHERE conversation_id=?`).run(c.id);
        this.store.db.prepare("UPDATE telegram_chats SET conversation_id=NULL,profile_id=NULL WHERE conversation_id=?").run(c.id);
        this.store.db.prepare("DELETE FROM conversations WHERE id=?").run(c.id);
        this.store.deleteSetting("conversation.context." + c.id);
      }
      this.store.db.prepare("UPDATE telegram_chats SET profile_id=NULL WHERE profile_id=?").run(agent);
      this.store.db.prepare("DELETE FROM employee_profiles WHERE id=?").run(agent);
      this.store.deleteSetting("employee.context." + agent); this.store.deleteSetting("agent.accounts." + agent); this.store.deleteSetting(lockKey(agent));
    });
    // Only fresh staging directories created here are disposable. Retired source files remain recoverable.
    if (removeFiles) for (const context of contexts) if (/^import-[a-f0-9]{32}$/.test(context)) {
      const path = this.messages.files.workspace(context); if (existsSync(path)) rmSync(path, { recursive: true });
    }
  }
}

/** Durable control state; workers receive only one idempotent stage at a time. */
export class AgentMoves {
  constructor(private readonly home: Home) {}
  operations(): any[] { return (this.home.store.db.prepare("SELECT state FROM home_operations").all() as any[]).map(r => JSON.parse(r.state)).filter(r => r.kind === "agent-move"); }
  active() { return this.operations().filter(r => !["completed", "canceled"].includes(r.phase)); }
  public(value: any) { const { proof, bundle, ...rest } = value; return rest; }
  start(agent: string, target: string, id: string) {
    identifier(agent); identifier(target); identifier(id); this.home.assertPrimary();
    const previous = this.home.operation(id);
    if (previous) {
      if (previous.kind !== "agent-move" || previous.requestedAgent !== agent || previous.target !== target) throw new HomeError("Идентификатор уже использован другим переносом.", 409);
      return this.public(previous);
    }
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new HomeError("Для переноса нужен UUID операции.");
    if (this.home.store.getSetting("home.transfer") || this.active().length) throw new HomeError("Сначала завершите текущий перенос.", 409);
    const actual = agent === "main" ? this.home.state.mainAgentId ?? "main" : agent;
    const source = actual === "main" ? this.home.state.mainNodeId : this.home.nodeFor("profile", actual);
    const nodes = this.home.nodes();
    if (!source || source === target || !nodes.some(n => n.id === source && n.online) || !nodes.some(n => n.id === target && n.online)) throw new HomeError("Для переноса оба устройства должны быть на связи. Выберите другое устройство.", 409);
    const value = { id, kind: "agent-move", requestedAgent: agent, agent: actual, agentId: actual === "main" ? randomUUID() : actual, source, target, phase: "waiting", proof: randomBytes(32).toString("hex"), createdAt: new Date().toISOString() };
    this.home.saveOperation(value); return this.public(value);
  }
  busy(agent: string) { return this.active().some(o => o.agent === agent || o.requestedAgent === agent); }
  retry(id: string) {
    this.home.assertPrimary();
    const op = this.home.operation(identifier(id));
    if (!op || op.kind !== "agent-move") throw new HomeError("Перенос не найден.", 404);
    if (op.phase !== "attention") return this.public(op);
    if (!["releasing", "activating", "canceling"].includes(op.resumePhase)) throw new HomeError("Этот этап требует проверки сохранённой копии.", 409);
    this.home.transaction(() => {
      const retry = (commandId: string) => {
        const row = this.home.command(commandId);
        if (!row) throw new HomeError("Квитанция переноса не найдена.", 409);
        const response = row.response && JSON.parse(row.response);
        if (!response || response.status < 400) return commandId;
        // Only the intrinsically idempotent transfer step is repeated. Its
        // operation identity and proof stay the same, even if the reply was lost.
        const request = JSON.parse(row.request);
        if (!/^\/v1\/agent-transfer\/(release|activate|cancel)$/.test(request.path)) throw new HomeError("Этот запрос нельзя повторить автоматически.", 409);
        // Completed transport entries deliberately discard their payload. The
        // coordinator keeps the proof until both devices confirm completion.
        request.body = requestJSON({ id: op.id, proof: op.proof, ...(request.path.endsWith("/activate") ? { digest: op.digest } : {}) });
        return this.home.enqueue(row.node_id, request, commandId.split(":retry:")[0] + ":retry:" + randomUUID());
      };
      if (op.resumePhase === "canceling") { op.cancelSource = retry(op.cancelSource); op.cancelTarget = retry(op.cancelTarget); }
      else op.command = retry(op.command);
      op.phase = op.resumePhase; delete op.resumePhase; delete op.error;
      this.home.saveOperation(op);
    });
    this.tick(); return this.public(this.home.operation(id));
  }
  private enqueue(op: any, node: string, action: string, extra: any = {}) {
    return this.home.enqueue(node, { method: "POST", path: "/v1/agent-transfer/" + action, owner: true, body: requestJSON({ id: op.id, proof: op.proof, ...extra }) }, op.id + ":" + action + ":" + node);
  }
  private response(id: string | undefined): any {
    if (!id) return undefined;
    const row = this.home.command(id); return row?.response ? resultJSON(JSON.parse(row.response)) : undefined;
  }
  tick() {
    if (this.home.state.role !== "primary") return;
    // A crash may leave a completed command one step ahead of its coordinator.
    // Consume durable replies before accepting an executor's new inventory.
    for (let pass = 0; pass < 8; pass++) {
      const before = JSON.stringify(this.active()); this.advance();
      if (JSON.stringify(this.active()) === before) break;
    }
  }
  private advance() {
    for (const original of this.active()) {
      const op = { ...original };
      if (op.phase === "attention") continue;
      try {
        if (op.phase === "waiting") {
          if (this.home.pending(op.source).some(c => c.request.method !== "GET" && !c.id.startsWith(op.id + ":"))) continue;
          op.command = this.enqueue(op, op.source, "prepare", { agent: op.agent, agentId: op.agentId }); op.phase = "preparing";
        } else if (op.phase === "preparing") {
          const result = this.response(op.command); if (!result) continue;
          if (!result.ready) throw new HomeError("Источник не подтвердил копию.");
          const bundle = validateBundle(result.bundle);
          if (digest(JSON.stringify(bundle)) !== result.digest || bundle.id !== op.id || bundle.agentId !== op.agentId) throw new HomeError("Проверка копии не пройдена.");
          op.digest = result.digest;
          op.routes = { profiles: bundle.archive.profiles.map(p => ({ ...p, context: undefined })), conversations: bundle.archive.conversations.map(c => ({ ...c, channel: "api", externalId: c.primary ? "home::employee::" + op.agentId : "import::" + c.id })), files: bundle.archive.attachments.map(f => f.id) };
          op.command = this.enqueue(op, op.target, "stage", { bundle, digest: op.digest }); op.phase = "staging";
        } else if (op.phase === "staging") {
          const result = this.response(op.command); if (!result) continue;
          if (!result.ready || result.digest !== op.digest) throw new HomeError("Назначение не подтвердило копию.");
          op.command = this.enqueue(op, op.source, "release"); op.phase = "releasing";
        } else if (op.phase === "releasing") {
          const result = this.response(op.command); if (!result) continue;
          if (!result.released || result.digest !== op.digest) throw new HomeError("Источник не подтвердил остановку.");
          op.command = this.enqueue(op, op.target, "activate", { digest: op.digest }); op.phase = "activating";
        } else if (op.phase === "activating") {
          const result = this.response(op.command); if (!result) continue;
          if (!result.active) throw new HomeError("Назначение не подтвердило включение.");
          this.home.transaction(() => {
            for (const [kind, entries] of [["profile", op.routes.profiles], ["conversation", op.routes.conversations], ["file", op.routes.files.map((id: string) => ({ id }))]] as [string, any[]][]) {
              for (const entry of entries) this.home.store.db.prepare("INSERT INTO home_resources(kind,id,node_id,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET node_id=excluded.node_id,data=excluded.data").run(kind, entry.id, op.target, JSON.stringify(entry));
            }
            if (op.requestedAgent === "main" || op.agent === this.home.state.mainAgentId) this.home.save({ ...this.home.state, mainNodeId: op.target, mainAgentId: op.agentId });
            this.enqueue(op, op.source, "finish"); this.enqueue(op, op.target, "finish");
            this.home.saveOperation({ ...op, proof: undefined, routes: undefined, phase: "completed", warnings: result.warnings ?? [], completedAt: new Date().toISOString() });
          });
          continue;
        } else if (op.phase === "canceling") {
          const source = this.response(op.cancelSource), target = this.response(op.cancelTarget);
          if (!source?.canceled || !target?.canceled) continue;
          op.phase = "canceled"; delete op.proof;
        }
        this.home.saveOperation(op);
      } catch (error) {
        op.error = error instanceof Error ? error.message : String(error);
        if (["waiting", "preparing", "staging"].includes(op.phase)) {
          op.cancelSource = this.enqueue(op, op.source, "cancel"); op.cancelTarget = this.enqueue(op, op.target, "cancel"); op.phase = "canceling";
        } else { op.resumePhase = op.phase; op.phase = "attention"; }
        this.home.saveOperation(op);
      }
    }
  }
}
