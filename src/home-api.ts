import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { Home, HomeError, endpoint, encryptBackup, identifier, object, type WireRequest, type WireResponse } from "./home.js";
import { HomeLink } from "./home-link.js";
import { requestJSON, wireJSON } from "./home-transport.js";

const bodies = new WeakMap<IncomingMessage, Promise<Buffer>>();
export async function readBody(request: IncomingMessage, limit = 1_048_576): Promise<Buffer> {
  if (!bodies.has(request)) bodies.set(request, (async () => {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) throw new HomeError("Слишком большой файл или сообщение.", 413);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  })());
  const result = await bodies.get(request)!;
  if (result.length > limit) throw new HomeError("Слишком большой файл или сообщение.", 413);
  return result;
}
export async function jsonBody(request: IncomingMessage, limit?: number) { const b = await readBody(request, limit); return b.length ? object(JSON.parse(b.toString())) : {}; }
export const isPeerRoute = (path: string) => ["/v1/home/identity", "/v1/home/pair", "/v1/home/poll"].includes(path);

export class HomeApi {
  constructor(readonly home: Home, readonly link: HomeLink, private readonly address: () => Promise<{ url: string; pin?: string }>) {}
  async handle(request: IncomingMessage, owner: boolean, localExecution: boolean): Promise<WireResponse | undefined> {
    if (localExecution) return;
    const url = new URL(request.url ?? "/", "http://localhost");
    let path = url.pathname; const method = request.method ?? "GET";
    const auth = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (path.startsWith("/v1/agent-transfer/")) throw new HomeError("Этапы переноса доступны только устройствам команды.", 403);
    if (path === "/v1/home/identity" && method === "GET") return wireJSON({ protocol: 1, nodeId: this.home.state.nodeId, homeId: this.home.state.id, role: this.home.state.role, epoch: this.home.state.epoch });
    if (path === "/v1/home/pair" && method === "POST") return wireJSON(this.home.pair(auth, object((await jsonBody(request)).node) as any));
    if (path === "/v1/home/poll" && method === "POST") {
      const nodeId = this.home.authorize(auth);
      if (!nodeId) throw new HomeError("Подключение устройства отозвано.", 401);
      return wireJSON(await this.link.acceptPoll(nodeId, await jsonBody(request, 300 * 1024 * 1024)));
    }
    if (path === "/v1/home" && method === "GET") return wireJSON({ home: this.link.status(), devices: this.home.nodes(), operations: this.link.agentMoves.active().map(o => this.link.agentMoves.public(o)) });
    if ((path.startsWith("/v1/home/") || path.startsWith("/v1/devices")) && !(method === "GET" && (path.startsWith("/v1/home/requests/") || path === "/v1/devices")) && !owner) throw new HomeError("Управление устройствами доступно владельцу.", 403);
    if (path === "/v1/home" && method === "PATCH") {
      if (!owner) throw new HomeError("Управление устройствами доступно владельцу.", 403);
      const input = await jsonBody(request);
      if (input.name !== undefined) {
        const name = String(input.name).trim();
        if (!name || name.length > 120) throw new HomeError("Введите название до 120 символов.");
        this.home.save({ ...this.home.state, name });
      }
      if (input.endpoint) this.home.setEndpoint(endpoint(input.endpoint));
      return wireJSON({ home: this.link.status() });
    }
    if (path === "/v1/home/join" && method === "POST") {
      if (!this.home.self().endpoint) this.home.setEndpoint(await this.address());
      return wireJSON(await this.link.join((await jsonBody(request)).invitation));
    }
    const operation = path.match(/^\/v1\/home\/operations\/([^/]+)$/);
    if (operation && method === "GET") {
      const value = this.home.operation(decodeURIComponent(operation[1]!));
      if (!value) throw new HomeError("Передача не найдена.", 404);
      return wireJSON(this.link.publicTransfer(value));
    }
    const retry = path.match(/^\/v1\/home\/operations\/([^/]+)\/retry$/);
    if (retry && method === "POST") return wireJSON(this.link.agentMoves.retry(decodeURIComponent(retry[1]!)), 202);
    if (path === "/v1/home/restore" && method === "POST") {
      const input = await jsonBody(request, 300 * 1024 * 1024);
      return wireJSON(this.link.restore(String(input.archive ?? ""), String(input.password ?? ""), input.previousPrimaryIsolated === true));
    }
    if (this.home.state.role !== "primary") {
      if (path.startsWith("/v1/") || path === "/health") return wireJSON({ error: "Управление находится на главном устройстве.", moved: this.home.state.moved ?? (this.home.state.upstream && { ...this.home.state.upstream, token: undefined }) }, 409);
      return;
    }
    const transferId = this.home.store.getSetting("home.transfer");
    if (transferId && method !== "GET" && path !== "/v1/home/transfer") throw new HomeError("Передаём управление. Новые изменения будут доступны после завершения.", 409);
    this.home.updateInventory(this.home.state.nodeId, this.home.inventory());
    if (path === "/v1/devices" && method === "GET") return wireJSON({ devices: this.home.nodes(), primaryId: this.home.state.primaryId });
    if (path === "/v1/devices/invitation" && method === "POST") {
      const input = await jsonBody(request);
      const address = input.endpoint ? endpoint(input.endpoint) : await this.address();
      this.home.setEndpoint(address);
      return wireJSON(this.home.invite(address, input.reconnectId ? identifier(input.reconnectId) : undefined), 201);
    }
    const remove = path.match(/^\/v1\/devices\/([^/]+)$/);
    if (remove && method === "DELETE") { this.home.removeNode(decodeURIComponent(remove[1]!)); return wireJSON({ ok: true }); }
    if (path === "/v1/home/backup" && method === "POST") {
      if (this.link.agentMoves.active().length) throw new HomeError("Дождитесь завершения переноса агента, затем сохраните копию управления.", 409);
      const input = await jsonBody(request);
      return wireJSON({ archive: encryptBackup(this.home.snapshot(), String(input.password ?? "")), createdAt: new Date().toISOString(), includesAgentFiles: false });
    }
    if (path === "/v1/home/transfer" && method === "POST") {
      const input = await jsonBody(request);
      return wireJSON(await this.link.transfer(identifier(input.deviceId), identifier(input.operationId), String(input.backupPassword ?? "")));
    }
    const move = path.match(/^\/v1\/agents\/([^/]+)\/move$/);
    if (move && method === "POST") {
      if (!owner) throw new HomeError("Перемещать агентов может владелец.", 403);
      const input = await jsonBody(request);
      return wireJSON(this.link.agentMoves.start(decodeURIComponent(move[1]!), identifier(input.deviceId), identifier(input.operationId)), 202);
    }
    const receipt = path.match(/^\/v1\/home\/requests\/([^/]+)$/);
    if (receipt && method === "DELETE") { this.home.cancel(decodeURIComponent(receipt[1]!)); return wireJSON({ canceled: true }); }
    if (receipt && method === "GET") {
      const row = this.home.command(decodeURIComponent(receipt[1]!));
      if (!row) throw new HomeError("Поручение не найдено.", 404);
      if (!owner && JSON.parse(row.request).owner) throw new HomeError("Результат этого действия доступен владельцу.", 403);
      return wireJSON({ id: row.id, status: row.canceled ? "canceled" : row.response ? "delivered" : row.dispatched ? "sent" : "queued", response: row.response ? JSON.parse(row.response) : null });
    }
    if (path === "/v1/profiles" && method === "GET") {
      return wireJSON({ profiles: this.home.resources("profile").filter(p => p.id !== this.home.state.mainAgentId), importedConversations: this.home.resources("conversation").filter(c => c.externalId?.startsWith("import::")).map(c => ({ id: c.id, title: c.title ?? "Импортированный чат", profileId: c.profileId, deviceId: c.deviceId })) });
    }
    if (path === "/v1/conversations" && method === "GET") return wireJSON({ conversations: this.home.resources("conversation") });
    let nodeId = url.searchParams.get("deviceId") ?? undefined;
    let body: Record<string, any> | undefined;
    if (method === "POST" && (["/v1/messages", "/v1/profiles", "/v1/connections/connect"].includes(path) || path.startsWith("/v1/extensions/") || path.startsWith("/v1/interactions/"))) {
      body = await jsonBody(request,path.startsWith("/v1/extensions/") ? 15 * 1024 * 1024 : undefined);
      nodeId ??= body.deviceId;
    }
    if (path === "/v1/messages" && body) {
      if (!body.profile && !body.conversationId) {
        const matches = this.home.resources("profile").filter(p => typeof body!.text === "string" && body!.text.toLocaleLowerCase().startsWith("@" + p.name.toLocaleLowerCase() + " "));
        if (matches.length > 1) throw new HomeError("Есть несколько агентов с таким именем. Откройте нужного агента и отправьте сообщение в его чате.", 409);
        const target = matches[0];
        if (target) body.profile = target.id;
      }
      if (!body.profile && !body.conversationId && this.home.state.mainAgentId) body.profile = this.home.state.mainAgentId;
      nodeId ??= body.profile ? this.home.nodeFor("profile", String(body.profile)) : body.conversationId ? this.home.nodeFor("conversation", String(body.conversationId)) : this.home.state.mainNodeId;
    }
    const mainAgent = this.home.state.mainAgentId;
    if (mainAgent) {
      if (path === "/v1/conversation") url.pathname = path = `/v1/agents/${mainAgent}/conversation`;
      if (path.startsWith("/v1/agents/main/")) url.pathname = path = path.replace("/v1/agents/main/", `/v1/agents/${mainAgent}/`);
      if ((path === "/v1/account" || path.startsWith("/v1/account/")) && (!url.searchParams.get("agentId") || url.searchParams.get("agentId") === "main")) url.searchParams.set("agentId", mainAgent);
    }
    if (path === "/v1/conversation") nodeId ??= this.home.state.mainNodeId;
    if (path === "/v1/account" || path.startsWith("/v1/account/")) nodeId ??= url.searchParams.get("agentId") && url.searchParams.get("agentId") !== "main" ? this.home.nodeFor("profile", url.searchParams.get("agentId")!) : this.home.state.mainNodeId;
    const agent = path.match(/^\/v1\/(?:agents|profiles)\/([^/]+)(?:\/|$)/);
    if (agent && agent[1] !== "archive") nodeId ??= agent[1] === "main" ? this.home.state.mainNodeId : this.home.nodeFor("profile", decodeURIComponent(agent[1]!));
    const conversation = path.match(/^\/v1\/conversations\/([^/]+)(?:\/|$)/);
    if (conversation) nodeId ??= this.home.nodeFor("conversation", decodeURIComponent(conversation[1]!));
    const file = path.match(/^\/v1\/files\/([^/]+)$/);
    if (file) nodeId ??= this.home.nodeFor("file", decodeURIComponent(file[1]!));
    const conversationId = body?.conversationId ?? url.searchParams.get("conversationId");
    if (conversationId) nodeId ??= this.home.nodeFor("conversation", String(conversationId));
    if (method !== "GET") {
      const chat = conversationId ?? conversation?.[1];
      const profile = body?.profile ?? agent?.[1] ?? (chat ? this.home.resources("conversation").find(c => c.id === chat)?.profileId ?? "main" : path === "/v1/messages" ? "main" : undefined);
      if (profile && this.link.agentMoves.busy(String(profile))) throw new HomeError("Агент переносится. Новое поручение можно отправить после завершения.", 423);
    }
    if (!nodeId || nodeId === this.home.state.nodeId) {
      request.url = url.pathname + url.search;
      if (body) bodies.set(request, Promise.resolve(Buffer.from(JSON.stringify(body))));
      return;
    }
    const node = this.home.nodes().find(n => n.id === nodeId);
    if (!node) throw new HomeError("Устройство не найдено.", 404);
    if (method === "GET" && !node.online) throw new HomeError(`«${node.name}» пока не на связи. Подключимся автоматически.`, 503);
    url.searchParams.delete("deviceId");
    if (body) delete body.deviceId;
    if (body && path === "/v1/messages") { body.externalId ??= randomUUID(); url.searchParams.set("async", "true"); }
    const forwarded: WireRequest = { method, path: url.pathname + url.search, owner, contentType: String(request.headers["content-type"] ?? "application/json"), ...(method !== "GET" ? { body: body ? requestJSON(body) : (await readBody(request, 192 * 1024 * 1024)).toString("base64") } : {}) };
    const key = request.headers["idempotency-key"];
    const commandId = typeof key === "string" ? "client:" + identifier(key) : body?.externalId && path === "/v1/messages" ? "message:" + identifier(String(body.externalId)) : undefined;
    if (path === "/v1/messages" && body) {
      const id = this.home.enqueue(nodeId, forwarded, commandId);
      const existing = this.home.command(id)!;
      if (existing.canceled) throw new HomeError("Поручение отменено до передачи устройству.", 409);
      if (existing.response) return JSON.parse(existing.response);
      const c = this.home.resources("conversation", nodeId).find(c => body!.conversationId ? c.id === body!.conversationId : body!.profile ? c.profileId === body!.profile && c.channel === "api" : c.externalId === "home");
      if (!c) return wireJSON({ operationId: id, status: "queued", text: "", profileId: body.profile }, 202);
      return wireJSON({ conversationId: c.id, messageId: id, text: "", profileId: body.profile, operationId: id, deliveryState: node.online ? "queued" : "waiting_for_device" }, 202);
    }
    return this.link.call(nodeId, forwarded, commandId);
  }
}
