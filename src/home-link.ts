import { randomBytes, randomUUID } from "node:crypto";
import { Home, HOME_PROTOCOL, HomeError, digest, endpoint, identifier, object, encryptBackup, decryptBackup, type Command, type Endpoint, type Inventory, type NodeInfo, type WireRequest, type WireResponse } from "./home.js";
import { homeRequest, requestJSON, resultJSON, wireJSON } from "./home-transport.js";
import { validateSnapshot } from "./home-snapshot.js";
import { AgentMoves } from "./agent-move.js";

/** An executor only makes outbound requests. Agent work never runs in this control loop. */
export class HomeLink {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private polling?: Promise<void>;
  private running = new Map<string, Promise<WireResponse>>();
  private lastError?: string;
  private initialized = false;
  readonly agentMoves: AgentMoves;
  constructor(readonly home: Home, private readonly dispatch: (request: WireRequest) => Promise<WireResponse>, private readonly drain: () => Promise<void> = async () => {}) { this.agentMoves = new AgentMoves(home); }
  private recoverPreparation() {
    const home = this.home;
    const id = home.store.getSetting("home.transfer"), interrupted = id && home.operation(id);
    // Before retirement no activation has been issued. Abort preparation after a
    // crash; after retirement the durable activation command must keep retrying.
    if (interrupted?.phase === "preparing" && home.state.role === "primary") {
      home.saveOperation({ ...this.publicTransfer(interrupted), phase: "canceled", error: "Подготовка прервана перезапуском. Прежнее главное продолжает работу." });
      home.store.db.prepare("UPDATE home_commands SET canceled=1 WHERE id=?").run(id + ":stage");
      home.store.deleteSetting("home.transfer");
    }
  }
  start() { if (!this.stopped) return; if (!this.initialized) { this.recoverPreparation(); this.initialized = true; } this.stopped = false; this.schedule(0); }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.polling; await Promise.allSettled(this.running.values()); }
  status() { return { ...this.home.state, upstream: this.home.state.upstream ? { ...this.home.state.upstream, token: undefined } : undefined, issue: this.lastError }; }
  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.polling = this.pollOnce().catch(e => { this.lastError = e instanceof Error ? e.message : "Нет связи с главным устройством"; }).finally(() => { this.polling = undefined; this.schedule(this.lastError ? 3000 : 500); }); }, delay);
    this.timer.unref();
  }
  async join(invite: unknown) {
    const value = object(invite);
    if (value.format !== "openstrudel.device" || value.version !== HOME_PROTOCOL || typeof value.key !== "string" || value.expiresAt <= Date.now()) throw new HomeError("Приглашение истекло или не подходит. Создайте новое на главном устройстве.");
    const state = this.home.state;
    if (this.home.store.getSetting("home.join_complete") === digest(value.key) && state.id === value.homeId && state.role !== "primary") return this.status();
    const reconnect = value.reconnectId === state.nodeId && value.homeId === state.id;
    if (!reconnect && (state.role !== "primary" || this.home.nodes().length > 1 || this.home.pending().length)) throw new HomeError("Устройство уже участвует в команде.", 409);
    const address = endpoint(value.endpoint);
    const previous = JSON.parse(this.home.store.getSetting("home.join_attempt") ?? "null");
    const node = previous?.hash === digest(value.key) ? previous.node : this.home.self();
    this.home.store.setSetting("home.join_attempt", JSON.stringify({ hash: digest(value.key), node }));
    const result = resultJSON(await homeRequest(address, "/v1/home/pair", value.key, { method: "POST", body: requestJSON({ node }) }));
    if (result.homeId !== value.homeId || typeof result.token !== "string" || !Number.isSafeInteger(result.epoch)) throw new HomeError("Приглашение ведёт к другой команде.");
    this.home.join({ ...address, ...result });
    this.home.store.setSetting("home.join_complete", digest(value.key)); this.home.store.deleteSetting("home.join_attempt");
    this.start();
    return this.status();
  }
  async pollOnce() {
    this.home.prune();
    this.agentMoves.tick();
    const state = this.home.state;
    if (state.role === "primary") {
      for (const command of this.home.dispatch(state.nodeId)) {
        if (this.running.has(command.id)) continue;
        const job = this.execute(command).then(response => { this.home.finish(state.nodeId, command.id, response); this.home.acknowledge([command.id]); this.agentMoves.tick(); return response; });
        this.running.set(command.id, job); void job.finally(() => this.running.delete(command.id)).catch(() => undefined);
      }
    }
    const activationAck = JSON.parse(this.home.store.getSetting("home.activation_ack") ?? "null");
    const upstream = state.role === "primary" ? activationAck?.upstream : state.upstream;
    if (!upstream) return;
    const results: Array<{ id: string; response: WireResponse }> = [];
    for (const row of this.home.store.db.prepare("SELECT id,response FROM home_receipts WHERE response IS NOT NULL AND acknowledged=0").all() as any[]) {
      results.push({ id: row.id, response: JSON.parse(row.response) });
      if (results.length === 8) break;
    }
    const reply = resultJSON(await homeRequest(upstream, "/v1/home/poll", upstream.token, { method: "POST", body: requestJSON({ node: this.home.self(), inventory: this.home.inventory(), results, epoch: upstream.epoch }) }));
    if (reply.homeId !== state.id) throw new HomeError("Ответ получен от другой команды.", 409);
    this.home.acknowledge((reply.acknowledged ?? []).filter((id: string) => results.some(r => r.id === id)));
    if (state.role === "primary") {
      if ((reply.acknowledged ?? []).includes(activationAck.id)) this.home.store.deleteSetting("home.activation_ack");
      return;
    }
    if (reply.moved) {
      const moved = object(reply.moved);
      if (moved.homeId !== state.id || !Number.isSafeInteger(moved.epoch) || moved.epoch <= upstream.epoch) throw new HomeError("Неверная передача управления.", 409);
      this.home.save({ ...state, primaryId: identifier(moved.primaryId), epoch: moved.epoch, upstream: { ...upstream, ...endpoint(moved), primaryId: moved.primaryId, epoch: moved.epoch } });
      return;
    }
    if (reply.epoch !== upstream.epoch) throw new HomeError("Обновите подключение к главному устройству.", 409);
    this.lastError = undefined;
    for (const command of (reply.commands ?? []) as Command[]) {
      identifier(command.id);
      if (this.running.has(command.id)) continue;
      const job = this.execute(command);
      this.running.set(command.id, job);
      void job.finally(() => this.running.delete(command.id)).catch(() => undefined);
    }
  }
  async acceptPoll(nodeId: string, payload: any) {
    const state = this.home.state;
    const acknowledged: string[] = [];
    if (state.role === "retired") {
      const transfer = this.home.operation(this.home.store.getSetting("home.transfer") ?? "");
      if (nodeId === transfer?.target && payload.epoch === transfer.epoch - 1) {
        for (const result of payload.results ?? []) if (result.id === transfer.activation) {
          this.home.finish(nodeId, result.id, result.response); acknowledged.push(result.id);
          let active = false; try { const value = resultJSON(result.response); active = value.active === true && value.epoch === transfer.epoch; } catch {}
          this.home.saveOperation({ ...transfer, phase: active ? "completed" : "activation_failed", ...(!active ? { error: "Новое главное не подтвердило включение. Прежнее остаётся остановленным; проверьте состояние нового устройства." } : {}) });
        }
        return { homeId: state.id, epoch: transfer.epoch - 1, acknowledged, commands: this.home.dispatch(nodeId), ...(acknowledged.length ? { moved: state.moved } : {}) };
      }
      return { homeId: state.id, acknowledged: [], moved: state.moved };
    }
    this.home.assertPrimary();
    if (payload.epoch !== state.epoch) throw new HomeError("Обновите подключение к главному устройству.", 409);
    const info = object(payload.node) as NodeInfo;
    this.home.touch(nodeId, info);
    if (!Array.isArray(payload.results) || payload.results.length > 8) throw new HomeError("Некорректные квитанции.");
    for (const result of payload.results) {
      // A receipt whose response was already delivered can be acknowledged after handover too.
      if (this.home.command(identifier(result.id))?.node_id === nodeId) { this.home.finish(nodeId, result.id, result.response); acknowledged.push(result.id); }
    }
    this.agentMoves.tick();
    this.home.updateInventory(nodeId, payload.inventory as Inventory);
    return { homeId: state.id, epoch: state.epoch, acknowledged, commands: this.home.dispatch(nodeId) };
  }
  async execute(command: Command): Promise<WireResponse> {
    const receipt = this.home.receipt(command);
    if (receipt && receipt !== "started") return receipt;
    const request = command.request;
    if (!request || typeof request.path !== "string" || !request.path.startsWith("/v1/") || request.path.startsWith("//")) throw new HomeError("Некорректное поручение.");
    if (!receipt) this.home.begin(command);
    let response: WireResponse;
    try {
      if (request.path === "/v1/home/stage") response = wireJSON(this.stage(JSON.parse(Buffer.from(request.body ?? "", "base64").toString())));
      else if (request.path === "/v1/home/activate") {
        response = wireJSON(this.activate(JSON.parse(Buffer.from(request.body ?? "", "base64").toString()), command));
      }
      else if (request.path.startsWith("/v1/home") || request.path.startsWith("/v1/devices") || request.path.startsWith("/v1/mobile")) throw new HomeError("Эта операция выполняется на главном устройстве.", 403);
      else if (/^\/v1\/agent-transfer\/(prepare|stage|release|activate|cancel|finish)$/.test(request.path) && request.method === "POST" && request.owner) response = await this.dispatch(request);
      else if (!request.owner && /^\/v1\/(account|accounts|agents\/archive|integrations)/.test(request.path) && request.method !== "GET") throw new HomeError("Нужно разрешение владельца.", 403);
      else if (receipt === "started" && request.method !== "GET" && !request.path.startsWith("/v1/messages")) response = wireJSON({ error: "Устройство перезапустилось во время операции. Проверьте результат перед повтором.", uncertain: true }, 409);
      else response = await this.dispatch(request);
    } catch (e) { response = wireJSON({ error: e instanceof Error ? e.message : "Не удалось выполнить поручение." }, e instanceof HomeError ? e.status : 400); }
    this.home.complete(command, response);
    return response;
  }
  async call(nodeId: string, request: WireRequest, id?: string, timeout = 12_000): Promise<WireResponse> {
    const commandId = this.home.enqueue(nodeId, request, id);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const row = this.home.command(commandId);
      if (row?.response) return JSON.parse(row.response);
      if (row?.canceled) throw new HomeError("Поручение отменено.", 409);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    if (request.method === "GET") { this.home.store.db.prepare("UPDATE home_commands SET canceled=1 WHERE id=? AND response IS NULL").run(commandId); throw new HomeError("Устройство пока не на связи.", 503); }
    return wireJSON({ operationId: commandId, status: "queued", message: "Ждёт подключения устройства" }, 202);
  }
  async transfer(targetId: string, operationId: string, password: string) {
    const previous = this.home.operation(operationId);
    if (previous) return this.publicTransfer(previous);
    this.home.assertPrimary(); identifier(operationId);
    if (this.agentMoves.active().length) throw new HomeError("Сначала завершите перенос агента.", 409);
    const active = this.home.store.getSetting("home.transfer");
    if (active && this.home.operation(active)?.phase !== "canceled") throw new HomeError("Передача главного уже начата.", 409);
    const target = this.home.nodes().find(n => n.id === targetId);
    if (!target || target.primary || !target.online || !target.endpoint) throw new HomeError("Новое главное должно быть подключено и иметь проверяемый адрес.", 409);
    // Validate the backup password before reserving the transfer.
    encryptBackup({}, password);
    const token = randomBytes(32).toString("hex"), proof = randomBytes(32).toString("hex");
    const operation = { id: operationId, target: targetId, phase: "preparing", epoch: this.home.state.epoch + 1, endpoint: target.endpoint, proof, token, backup: "", createdAt: new Date().toISOString() };
    this.home.saveOperation(operation); this.home.store.setSetting("home.transfer", operationId);
    try {
      // Reserve this operation before the first await, excluding competing transfers.
      await this.drain();
      this.home.updateInventory(this.home.state.nodeId, this.home.inventory());
      const snapshot = this.home.snapshot();
      operation.backup = encryptBackup(snapshot, password);
      this.home.saveOperation(operation);
      const check = resultJSON(await homeRequest(target.endpoint, "/v1/home/identity", ""));
      if (check.nodeId !== target.id || check.protocol !== HOME_PROTOCOL) throw new HomeError("По этому адресу находится другое устройство.", 409);
      const bundle = { ...snapshot, source: this.home.self(), newTokenHash: digest(token), operationId, proof, epoch: operation.epoch };
      const staged = resultJSON(await this.call(targetId, { method: "POST", path: "/v1/home/stage", owner: true, body: requestJSON(bundle) }, operationId + ":stage", 20_000));
      if (!staged.ready || staged.digest !== digest(JSON.stringify(bundle))) throw new HomeError("Новое устройство не подтвердило подготовку.", 409);
      // The activation command and retirement commit together. A poll can never observe only one.
      this.home.transaction(() => {
        const activation = this.home.enqueue(targetId, { method: "POST", path: "/v1/home/activate", owner: true, body: requestJSON({ operationId, proof, digest: staged.digest }) }, operationId + ":activate");
        this.home.saveOperation({ ...this.publicTransfer(operation), phase: "transferred", activation });
        const current = this.home.state;
        this.home.save({ ...current, role: "retired", epoch: operation.epoch, primaryId: targetId,
          moved: { ...target.endpoint!, homeId: current.id, primaryId: targetId, epoch: operation.epoch },
          upstream: { ...target.endpoint!, token, homeId: current.id, primaryId: targetId, epoch: operation.epoch } });
        this.home.store.db.exec("DELETE FROM home_resources");
      });
      this.start();
      return this.publicTransfer(this.home.operation(operationId));
    } catch (e) {
      if (this.home.state.role === "primary") {
        this.home.saveOperation({ ...this.publicTransfer(operation), phase: "canceled", error: e instanceof Error ? e.message : String(e) });
        this.home.store.deleteSetting("home.transfer");
        this.home.store.db.prepare("UPDATE home_commands SET canceled=1 WHERE id=?").run(operationId + ":stage");
      }
      throw e;
    }
  }
  publicTransfer(value: any) { const { token, proof, proofHash, bundle, ...visible } = value; return visible; }
  private stage(bundle: any) {
    validateSnapshot(bundle);
    if (bundle.format !== "openstrudel.home" || bundle.version !== HOME_PROTOCOL || bundle.state.id !== this.home.state.id || bundle.state.primaryId !== this.home.state.primaryId || bundle.epoch !== this.home.state.epoch + 1) throw new HomeError("Копия управления не соответствует команде.", 409);
    const id = identifier(bundle.operationId), hash = digest(JSON.stringify(bundle));
    const old = this.home.operation(id);
    if (old && old.digest !== hash) throw new HomeError("Передача с таким идентификатором уже существует.", 409);
    if (!Array.isArray(bundle.nodes) || !bundle.nodes.some((n: any) => n.id === this.home.state.nodeId)) throw new HomeError("В копии нет этого устройства.");
    this.home.saveOperation({ id, phase: "staged", digest: hash, bundle });
    return { ready: true, digest: hash };
  }
  private activate(input: any, command?: Command) {
    const operation = this.home.operation(identifier(input.operationId));
    if (!operation || typeof input.proof !== "string" || operation.digest !== input.digest || (operation.phase === "active" ? operation.proofHash !== digest(input.proof) : operation.bundle.proof !== input.proof)) throw new HomeError("Передача управления не подтверждена.", 409);
    if (operation.phase === "active") return { active: true, epoch: this.home.state.epoch };
    if (operation.phase !== "staged" || this.home.state.role === "primary") throw new HomeError("Устройство уже управляет другой командой.", 409);
    const bundle = operation.bundle, self = this.home.state;
    this.home.transaction(() => {
      this.home.clearCatalogue();
      for (const row of bundle.nodes) this.home.store.db.prepare("INSERT INTO home_nodes(id,info,token_hash) VALUES(?,?,?)").run(row.id, row.info, row.id === bundle.source.id ? bundle.newTokenHash : row.token_hash);
      for (const row of bundle.resources) this.home.store.db.prepare("INSERT INTO home_resources(kind,id,node_id,data) VALUES(?,?,?,?)").run(row.kind, row.id, row.node_id, row.data);
      for (const row of bundle.commands) this.home.store.db.prepare("INSERT INTO home_commands(id,node_id,request,response,created_at,canceled,request_hash,finished_at,dispatched) VALUES(?,?,?,?,?,?,?,?,?)").run(row.id, row.node_id, row.request, row.response, row.created_at, row.canceled, row.request_hash ?? digest(row.request), row.finished_at ?? null, row.dispatched ?? 0);
      for (const row of bundle.access) this.home.store.setSetting(row.key, row.value);
      this.home.save({ ...self, id: bundle.state.id, role: "primary", primaryId: self.nodeId, mainNodeId: bundle.state.mainNodeId, mainAgentId: bundle.state.mainAgentId, epoch: bundle.epoch, upstream: undefined, moved: undefined });
      this.home.saveOperation({ id: operation.id, digest: operation.digest, proofHash: digest(input.proof), phase: "active", epoch: bundle.epoch });
      if (command && self.upstream) {
        this.home.store.setSetting("home.activation_ack", JSON.stringify({ id: command.id, upstream: self.upstream }));
        this.home.complete(command, wireJSON({ active: true, epoch: bundle.epoch }));
      }
    });
    return { active: true, epoch: bundle.epoch };
  }
  restore(archive: string, password: string, isolated: boolean) {
    if (!isolated) throw new HomeError("Сначала остановите или изолируйте прежнее главное устройство.", 409);
    const value = validateSnapshot(decryptBackup(archive, password));
    if (this.home.nodes().length > 1 || this.home.store.listProfiles().length || this.home.store.listConversations().some(c => this.home.store.listMessages(c.id, 1).length)) throw new HomeError("Восстановите управление на чистом устройстве.", 409);
    const state = this.home.state;
    const id = randomUUID(), proof = randomBytes(32).toString("hex");
    // Restoration is explicit and keeps agent placement. Clients and executors reconnect by a new invitation.
    const bundle: any = { ...value, source: this.home.self(), newTokenHash: null, operationId: id, proof, epoch: value.state.epoch + 1 };
    bundle.nodes = [...bundle.nodes.filter((n: any) => n.id !== state.nodeId), { id: state.nodeId, info: JSON.stringify(this.home.self()), token_hash: null }];
    bundle.access = []; // New client sessions are issued explicitly after recovery.
    validateSnapshot(bundle);
    try {
      this.home.save({ ...state, id: value.state.id, primaryId: value.state.primaryId, epoch: value.state.epoch, role: "executor" });
      const staged = this.stage(bundle);
      return this.activate({ operationId: id, proof, digest: staged.digest });
    } catch (e) { this.home.save(state); throw e; }
  }
}
