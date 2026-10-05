import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { isIP, type AddressInfo } from "node:net";
import { MessageService } from "./messages.js";
import { Store } from "./store.js";
import { TelegramAdapter } from "./telegram.js";
import { CodexAccountService } from "./account.js";
import { safeURL } from "./interactions.js";
import { MobileAccess } from "./mobile.js";
import { MAX_FILE_BYTES } from "./files.js";
import {randomBytes} from "node:crypto";
import { AgentArchives, MAX_ARCHIVE_BYTES } from "./agent-archive.js";

const MAX_BODY_BYTES = 1_048_576;

/** Small HTTP transport shared by the native clients and Telegram setup. */
export class HttpApi {
  private server: Server | null = null;
  readonly mobile: MobileAccess;

  constructor(
    private readonly store: Store,
    private readonly messages: MessageService,
    private readonly telegram: TelegramAdapter,
    private readonly token: string | null | undefined = process.env.OPENSTRUDEL_API_TOKEN,
    private readonly account?: CodexAccountService,
    private readonly engine?: import("./types.js").CodexEngine,
  ) {
    if (this.token === undefined || this.token === "") {
      this.token=store.getSetting("api.local_token") ?? randomBytes(32).toString("hex");
      store.setSetting("api.local_token",this.token);
    }
    this.mobile = new MobileAccess(store, (request, response, owner) => { void this.handle(request, response, true, owner); }, {
      hostname:process.env.OPENSTRUDEL_PUBLIC_HOST ?? process.env.RAILWAY_TCP_PROXY_DOMAIN,
      advertisedPort:process.env.OPENSTRUDEL_PUBLIC_PORT || process.env.RAILWAY_TCP_PROXY_PORT ? Number(process.env.OPENSTRUDEL_PUBLIC_PORT ?? process.env.RAILWAY_TCP_PROXY_PORT) : undefined,
    });
  }

  localCredential(): string | null { return this.token ?? null; }

  async listen(host = process.env.OPENSTRUDEL_HOST ?? "127.0.0.1", port = Number(process.env.OPENSTRUDEL_PORT ?? 7788)): Promise<AddressInfo> {
    if (this.server) throw new Error("API already started");
    this.server = createServer((request, response) => void this.handle(request, response));
    // A Codex turn may legitimately run for several minutes. Long work still
    // uses the same one request path; it is not turned into a second task
    // system just to accommodate a timeout.
    this.server.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server?.once("error", onError);
      this.server?.once("listening", onListening);
      this.server?.listen(port, host);
    });
    return this.server.address() as AddressInfo;
  }

  async close(): Promise<void> {
    await this.mobile.close();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  private async handle(request: IncomingMessage, response: ServerResponse, paired = false, owner = false): Promise<void> {
    response.setHeader("content-type", "application/json; charset=utf-8");
    const host = request.headers.host ?? "";
    const origin = request.headers.origin;
    let hostname = "";
    try { hostname = new URL("http://" + host).hostname.replace(/^\[|\]$/g, ""); } catch {}
    if ((!paired && !isIP(hostname) && hostname !== "localhost") || (origin && origin !== "http://" + host)) {
      this.send(response, 403, { error: "Запрос с постороннего сайта отклонён" }); return;
    }
    if (origin) response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-headers", "authorization, content-type");
    response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const messageLimit=Math.min(5000,Math.max(1,Number(url.searchParams.get("limit")) || 100));
    if (request.method === "GET" && path === "/") {
      await this.asset(response, "index.html", "text/html; charset=utf-8");
      return;
    }
    if (request.method === "GET" && path === "/manifest.webmanifest") {
      this.send(response, 200, { name: "OpenStrudel", short_name: "OpenStrudel", start_url: "/", display: "standalone", background_color: "#080a10", theme_color: "#080a10" });
      return;
    }
    try {
      if (!paired && !this.authorized(request)) {
        this.send(response, 401, { error: "unauthorized" });
        return;
      }
      const canManageAccount = !paired || owner;
      if (path.startsWith("/v1/agents/archive")) {
        if (!canManageAccount) { this.send(response, 403, { error: "Перенос команды доступен владельцу на основном Mac или устройстве, с которого настроили сервер." }); return; }
        response.setHeader("cache-control", "no-store");
        const archives = new AgentArchives(this.store, this.messages);
        if (request.method === "GET" && path === "/v1/agents/archive") {
          const archive = archives.export();
          response.setHeader("content-disposition", `attachment; filename="OpenStrudel-${archive.createdAt.slice(0,10)}.openstrudel"`);
          this.send(response, 200, archive); return;
        }
        if (request.method === "POST" && path === "/v1/agents/archive/preview") {
          this.send(response, 200, archives.preview(await this.archiveBody(request))); return;
        }
        if (request.method === "POST" && path === "/v1/agents/archive/import") {
          this.send(response, 200, archives.import(await this.archiveBody(request), url.searchParams.get("plan") ?? "")); return;
        }
      }
      if (path.startsWith("/v1/account/") && !canManageAccount) {
        this.send(response, 403, { error: "Восстановите вход в OpenAI на основном Mac или устройстве, с которого настроили сервер. На этом устройстве отдельный вход не нужен." });
        return;
      }
      if (path.startsWith("/v1/mobile")) {
        const address = request.socket.remoteAddress;
        if ((paired && !owner) || (!paired && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? ""))) {
          this.send(response, 403, { error: "Откройте настройки на Mac" }); return;
        }
        if (request.method === "POST" && path === "/v1/mobile/pairing") {
          const body=await this.body(request);
          this.send(response, 201, await this.mobile.invite(body.owner === true)); return;
        }
        if (request.method === "DELETE" && path === "/v1/mobile/pairing") {
          this.mobile.cancelInvite(); this.send(response, 200, { ok: true }); return;
        }
        if (request.method === "GET" && path === "/v1/mobile") {
          this.send(response, 200, this.mobile.status()); return;
        }
        if (request.method === "DELETE" && path === "/v1/mobile") {
          await this.mobile.revoke(); this.send(response, 200, { ok: true }); return;
        }
      }
      if (request.method === "GET" && path === "/health") {
        this.send(response, 200, { ok: true, service: "openstrudel", platform: process.platform, arch: process.arch, time: new Date().toISOString(), telegram: this.telegram.status(), agentArchiveVersion: 1 });
        return;
      }
      if (request.method === "GET" && path === "/v1/integrations") {
        this.send(response, 200, { telegram: this.telegram.status() });
        return;
      }
      if (request.method === "GET" && path === "/v1/account") {
        this.send(response, 200, { account: this.account ? await this.account.read(url.searchParams.get("refresh") === "true") : { connected: false, email: null, planType: null, managed: false }, canManage: canManageAccount, loginPending: this.account?.loginPending ?? false });
        return;
      }
      if (request.method === "POST" && path === "/v1/account/login") {
        if (!this.account) throw new Error("account service unavailable");
        const body = await this.body(request);
        const method = paired || body.method === "device" ? "device" : "browser";
        this.send(response, 201, await this.account.startLogin(method));
        return;
      }
      const loginMatch = path.match(/^\/v1\/account\/login\/([^/]+)$/);
      const cancelLoginMatch = path.match(/^\/v1\/account\/login\/([^/]+)\/cancel$/);
      if (loginMatch && request.method === "GET") {
        if (!this.account) throw new Error("account service unavailable");
        this.send(response, 200, await this.account.status(decodeURIComponent(loginMatch[1] ?? "")));
        return;
      }
      if (cancelLoginMatch && request.method === "POST") {
        if (!this.account) throw new Error("account service unavailable");
        this.send(response, 200, await this.account.cancel(decodeURIComponent(cancelLoginMatch[1] ?? "")));
        return;
      }
      if (request.method === "POST" && path === "/v1/account/logout") {
        if (!this.account) throw new Error("account service unavailable");
        await this.account.logout();
        this.send(response, 200, { account: await this.account.read() });
        return;
      }
      if (request.method === "GET" && path === "/v1/conversation") {
        const conversation = this.store.primaryConversation();
        this.send(response, 200, { conversation, messages: this.store.listMessages(conversation.id, messageLimit), interactions: this.messages.interactions.list(conversation.id) });
        return;
      }
      const agentConversationMatch = path.match(/^\/v1\/agents\/([^/]+)\/conversation$/);
      if (request.method === "GET" && agentConversationMatch) {
        const profile = this.store.getProfile(decodeURIComponent(agentConversationMatch[1] ?? ""));
        if (!profile) {
          this.send(response, 404, { error: "employee not found" });
          return;
        }
        const conversation = this.store.profileConversation(profile.id);
        this.send(response, 200, { conversation, messages: this.store.listMessages(conversation.id, messageLimit), interactions: this.messages.interactions.list(conversation.id) });
        return;
      }
      if (request.method === "GET" && path === "/v1/conversations") {
        this.send(response, 200, { conversations: this.store.listConversations() });
        return;
      }
      const filesMatch = path.match(/^\/v1\/conversations\/([^/]+)\/files$/);
      if (request.method === "POST" && filesMatch) {
        const b = await this.body(request,Math.ceil(MAX_FILE_BYTES*4/3)+4096);
        const conversationId = filesMatch[1]!;
        const attachment = this.messages.files.put(conversationId,this.messages.contextFor(conversationId),{id:b.id == null ? undefined : String(b.id),name:String(b.name ?? ""),mimeType:b.mimeType == null ? undefined : String(b.mimeType),contentBase64:String(b.contentBase64 ?? "")});
        this.send(response,201,{attachment}); return;
      }
      const fileMatch = path.match(/^\/v1\/files\/([^/]+)$/);
      if (request.method === "GET" && fileMatch) {
        const file = this.messages.files.get(fileMatch[1]!);
        if (!file) throw new Error("Файл не найден");
        response.writeHead(200,{"content-type":file.mimeType,"content-disposition":"attachment; filename*=UTF-8''" + encodeURIComponent(file.name),"cache-control":"no-store"}).end(await readFile(file.path));return;
      }
      const conversationMatch = path.match(/^\/v1\/conversations\/([^/]+)\/messages$/);
      if (request.method === "GET" && conversationMatch) {
        this.send(response, 200, { messages: this.store.listMessages(decodeURIComponent(conversationMatch[1] ?? "")) });
        return;
      }
      if (request.method === "GET" && path === "/v1/profiles") {
        this.send(response, 200, { profiles: this.store.listProfiles(), importedConversations: this.store.listConversations().filter(c => c.externalId?.startsWith("import::")).map(c => ({ id: c.id, title: c.title ?? "Импортированный чат", profileId: c.profileId })) });
        return;
      }
      if (request.method === "POST" && path === "/v1/profiles") {
        const body = await this.body(request);
        const creationId = body.creationId == null ? null : String(body.creationId);
        if (creationId && !/^[a-f0-9-]{36}$/i.test(creationId)) throw new Error("Некорректное создание сотрудника");
        const previousId = creationId && this.store.getSetting("employee.creation." + creationId);
        const previous = previousId && this.store.getProfile(previousId);
        if (previous) { this.send(response, 200, { profile: previous }); return; }
        const name = String(body.name ?? "").trim();
        const instructions = String(body.instructions ?? "").trim();

        const tokenLimit = body.tokenLimit == null ? undefined : Number(body.tokenLimit);
        if (tokenLimit !== undefined && (!Number.isFinite(tokenLimit) || tokenLimit <= 0)) throw new Error("tokenLimit must be a positive number");
        const profile = this.store.createProfile({
          name,
          instructions,
          capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((item): item is string => typeof item === "string") : [],
          model: body.model == null ? undefined : String(body.model),
          tokenLimit,
          domain: body.domain == null ? undefined : body.domain as import("./types.js").EmployeeProfile["domain"],
          purpose: body.purpose == null ? undefined : String(body.purpose),
        });
        if (creationId) this.store.setSetting("employee.creation." + creationId,profile.id);
        this.send(response, 201, { profile });
        return;
      }
      const profileMatch = path.match(/^\/v1\/profiles\/([^/]+)$/);
      if (request.method === "PATCH" && profileMatch) {
        const body = await this.body(request);
        const name = String(body.name ?? "").trim();
        const instructions = String(body.instructions ?? "").trim();
        const profile = this.store.updateProfile(decodeURIComponent(profileMatch[1] ?? ""), { name, instructions, purpose: body.purpose == null ? undefined : String(body.purpose) });
        this.send(response, 200, { profile });
        return;
      }
      if (request.method === "POST" && path === "/v1/integrations/telegram") {
        const body = await this.body(request);
        this.send(response, 200, { telegram: await this.telegram.configure(String(body.token ?? "")) });
        return;
      }
      if (request.method === "POST" && path === "/v1/integrations/telegram/link") {
        const body=await this.body(request);
        this.send(response, 201, this.telegram.createLink(body.profileId ? String(body.profileId) : undefined));
        return;
      }
      const bindingMatch=path.match(/^\/v1\/integrations\/telegram\/chats\/(-?\d+)$/);
      if(request.method==="PATCH" && bindingMatch) {
        const body=await this.body(request);
        this.store.bindTelegramChat(bindingMatch[1]!,body.profileId == null ? null : String(body.profileId));
        this.send(response,200,{telegram:this.telegram.status()}); return;
      }
      const historyMatch=path.match(/^\/v1\/conversations\/([^/]+)\/history$/);
      if(request.method==="POST" && historyMatch) {
        const body=await this.body(request);
        if(!Array.isArray(body.entries)) throw new Error("Ожидается массив сообщений");
        this.send(response,200,{imported:this.store.importHistory(historyMatch[1]!,body.entries)});return;
      }
      const scheduleMatch=path.match(/^\/v1\/conversations\/([^/]+)\/schedules(?:\/([^/]+))?$/);
      if(scheduleMatch && this.messages.scheduler) {
        const conversationId=scheduleMatch[1]!; const scheduler=this.messages.scheduler;
        if(request.method==="GET") {this.send(response,200,{schedules:scheduler.list(conversationId),runs:scheduler.runs(conversationId)});return;}
        if(request.method==="DELETE" && scheduleMatch[2]) {scheduler.remove(scheduleMatch[2],conversationId);this.send(response,200,{ok:true});return;}
        if(request.method==="POST") {
          const b=await this.body(request);
          const existing = b.id ? scheduler.list(conversationId).find(s => s.id === String(b.id)) : undefined;
          const schedule=scheduler.save({conversationId,id:b.id ? String(b.id):undefined,name:String(b.name ?? ""),prompt:String(b.prompt ?? ""),cron:String(b.cron ?? ""),timezone:String(b.timezone ?? ""),enabled:b.enabled!==false,telegramChatId:b.telegramChatId ? String(b.telegramChatId):null,delivery:b.delivery === "app" || b.delivery === "telegram" ? b.delivery : existing?.delivery,backupOf:existing?.backupOf});
          this.send(response,201,{schedule});return;
        }
      }
      const singleConversation=path.match(/^\/v1\/conversations\/([^/]+)$/);
      if(request.method==="GET" && singleConversation) {
        const conversation=this.store.getConversation(singleConversation[1]!);
        if(!conversation) throw new Error("Чат не найден");
        this.send(response,200,{conversation,messages:this.store.listMessages(conversation.id,messageLimit),interactions:this.messages.interactions.list(conversation.id)});return;
      }
      if (request.method === "DELETE" && path === "/v1/integrations/telegram") {
        this.send(response, 200, { telegram: this.telegram.disconnect() });
        return;
      }
      if (request.method === "GET" && path === "/v1/connections") {
        const conversationId=url.searchParams.get("conversationId");
        if (conversationId && !this.store.getConversation(conversationId)) throw new Error("Чат не найден");
        const engine=conversationId ? this.engine?.forContext?.(this.messages.contextFor(conversationId)) ?? this.engine : this.engine;
        const connections = await engine?.connections?.(url.searchParams.get("refresh") === "true") ?? [];
        this.send(response, 200, { connections, notice: engine?.connectionNotice }); return;
      }
      if (request.method === "POST" && path === "/v1/connections/connect") {
        const body = await this.body(request);
        const conversationId=typeof body.conversationId === "string" ? body.conversationId : null;
        if (conversationId && !this.store.getConversation(conversationId)) throw new Error("Чат не найден");
        const engine=conversationId ? this.engine?.forContext?.(this.messages.contextFor(conversationId)) ?? this.engine : this.engine;
        if (!engine?.connect) throw new Error("Подключения Codex недоступны");
        const link = await engine.connect(String(body.id ?? ""));
        this.send(response, 200, { url: link.url ? safeURL(link.url) : null }); return;
      }
      const answerMatch = path.match(/^\/v1\/interactions\/([^/]+)$/);
      if (request.method === "POST" && answerMatch) {
        const body = await this.body(request);
        if (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers)) throw new Error("Проверьте ответы");
        await this.messages.interactions.answer(answerMatch[1]!, String(body.conversationId ?? ""), body.answers as Record<string, string>);
        this.send(response, 200, { ok: true }); return;
      }
      if (request.method === "POST" && path === "/v1/messages") {
        const body = await this.body(request);
        const submission = await this.messages.submit({
          channel: body.channel === "telegram" ? "telegram" : "api",
          text: String(body.text ?? ""),
          externalId: body.externalId == null ? undefined : String(body.externalId),
          externalChatId: body.externalChatId == null ? "home" : String(body.externalChatId),
          title: body.title == null ? undefined : String(body.title),
          conversationId: body.conversationId == null ? undefined : String(body.conversationId),
          profile: body.profile == null ? undefined : String(body.profile),
          attachments: body.attachments as string[] | undefined,
        });
        this.send(response, url.searchParams.get("async") === "true" ? 202 : 200, url.searchParams.get("async") === "true" ? submission.receipt : await submission.completion);
        return;
      }
      this.send(response, 404, { error: "not_found" });
    } catch (error) {
      this.send(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private authorized(request: IncomingMessage): boolean {
    if (!this.token) return true;
    return request.headers.authorization === `Bearer ${this.token}`;
  }

  private async archiveBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    try { return await this.body(request, MAX_ARCHIVE_BYTES); }
    catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && error.message === "JSON object expected")) {
        throw new Error("Не удалось прочитать файл. Выберите целый файл экспорта команды OpenStrudel.");
      }
      throw error;
    }
  }

  private async body(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > limit) throw new Error("Слишком большой файл или сообщение");
      chunks.push(buffer);
    }
    if (!chunks.length) return {};
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object expected");
    return parsed as Record<string, unknown>;
  }

  private send(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status).end(JSON.stringify(value));
  }

  private async asset(response: ServerResponse, name: string, contentType: string): Promise<void> {
    try {
      const content = await readFile(new URL("../public/" + name, import.meta.url));
      response.writeHead(200, { "content-type": contentType }).end(content);
    } catch {
      response.writeHead(404).end("not found");
    }
  }
}
