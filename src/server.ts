import { deleteEmployee } from "./employee-delete.js";
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
import { AgentArchives, MAX_TRANSFER_BYTES, encodeArchive, decodeArchive } from "./agent-archive.js";
import { Home, HomeError, digest, encryptBackup, decryptBackup, type WireResponse } from "./home.js";
import { HomeLink } from "./home-link.js";
import { LocalAgentMoves, assertAgentWritable } from "./agent-move.js";
import { HomeApi, isPeerRoute, readBody } from "./home-api.js";
import { homeRequest } from "./home-transport.js";
import { WebAccess, sameOrigin } from "./web-access.js";
import type { Accounts } from "./accounts.js";
import { hostingOrigin } from "./hosting-origin.js";
import { previewExtension } from "./extensions.js";
import { approvalSetting, isApprovalMode, readApprovalMode } from "./approval-mode.js";

const MAX_BODY_BYTES = 1_048_576;

/** Small HTTP transport shared by the native clients and Telegram setup. */
export class HttpApi {
  private server: Server | null = null;
  readonly mobile: MobileAccess;
  readonly home: Home;
  readonly homeLink: HomeLink;
  private readonly agentMoves: LocalAgentMoves;
  private readonly homeApi: HomeApi;
  private readonly executorKey = randomBytes(32).toString("hex");
  private localURL?: string;
  private activeWrites = 0;
  readonly web: WebAccess;

  constructor(
    private readonly store: Store,
    private readonly messages: MessageService,
    private readonly telegram: TelegramAdapter,
    private readonly token: string | null | undefined = process.env.OPENSTRUDEL_API_TOKEN,
    private readonly account?: CodexAccountService,
    private readonly engine?: import("./types.js").CodexEngine,
    options: { mobileDirectory?: string; mobilePort?: number } = {},
    private readonly accounts?: Accounts,
  ) {
    if (this.token === undefined || this.token === "") {
      this.token=store.getSetting("api.local_token") ?? randomBytes(32).toString("hex");
      store.setSetting("api.local_token",this.token);
    }
    this.web = new WebAccess(store);
    this.mobile = new MobileAccess(store, (request, response, owner) => { void this.handle(request, response, true, owner); }, {
      directory: options.mobileDirectory, port: options.mobilePort,
      hostname:process.env.OPENSTRUDEL_PUBLIC_HOST ?? process.env.RAILWAY_TCP_PROXY_DOMAIN,
      advertisedPort:process.env.OPENSTRUDEL_PUBLIC_PORT || process.env.RAILWAY_TCP_PROXY_PORT ? Number(process.env.OPENSTRUDEL_PUBLIC_PORT ?? process.env.RAILWAY_TCP_PROXY_PORT) : undefined,
    });
    this.mobile.web = this.web;
    this.home = new Home(store);
    this.agentMoves = new LocalAgentMoves(this.home, this.messages);
    if (this.token) store.setSetting("home.local_client_hash", digest(this.token));
    this.homeLink = new HomeLink(this.home, async request => {
      if (!this.localURL) throw new HomeError("Устройство ещё запускается.", 503);
      return homeRequest({ url: this.localURL }, request.path, this.token ?? "", request, 30_000, { "x-openstrudel-executor": this.executorKey, "x-openstrudel-owner": request.owner ? "1" : "0" });
    }, async () => {
      const deadline = Date.now() + 15_000;
      while (this.activeWrites) {
        if (Date.now() >= deadline) throw new HomeError("Ещё выполняются изменения. Дождитесь их завершения и повторите передачу.", 409);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    });
    this.homeApi = new HomeApi(this.home, this.homeLink, () => this.mobile.endpoint());
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
    const address = this.server.address() as AddressInfo;
    this.localURL = `http://127.0.0.1:${address.port}`;
    this.homeLink.start();
    return address;
  }

  async close(): Promise<void> {
    await this.homeLink.stop();
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
    if ((!paired && !isIP(hostname) && hostname !== "localhost") || !sameOrigin(request)) {
      this.send(response, 403, { error: "Запрос с постороннего сайта отклонён" }); return;
    }
    if (origin) response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-headers", "authorization, content-type");
    response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    let url = new URL(request.url ?? "/", "http://localhost");
    let path = url.pathname;
    const messageLimit=Math.min(5000,Math.max(1,Number(url.searchParams.get("limit")) || 100));
    if (request.method === "GET" && path === "/") {
      await this.asset(response, "index.html", "text/html; charset=utf-8");
      return;
    }
    if (request.method === "GET" && path === "/manifest.webmanifest") {
      this.send(response, 200, { name: "OpenStrudel", short_name: "OpenStrudel", start_url: "/", display: "standalone", background_color: "#242424", theme_color: "#242424", icons: [{ src: "/strudel-cream.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }] });
      return;
    }
    if (request.method === "GET" && path === "/favicon.ico") { response.writeHead(204).end(); return; }
    if (request.method === "GET" && path === "/home-settings.js") { await this.asset(response, "home-settings.js", "text/javascript; charset=utf-8"); return; }
    if (request.method === "GET" && ["/strudel-cream.png", "/strudel-graphite.png"].includes(path)) { await this.asset(response, path.slice(1), "image/png"); return; }
    if (request.method === "GET" && path === "/agent-characters.js") { await this.asset(response, "agent-characters.js", "text/javascript; charset=utf-8"); return; }
    if (request.method === "GET" && /^\/characters\/(coil|fold|knot|curl|wave|pillow)\.png$/.test(path)) { await this.asset(response, path.slice(1), "image/png"); return; }
    let counted = false;
    try {
      if (await this.web.handle(request, response)) return;
      const webSession = this.web.authenticate(request);
      if (!paired && !isPeerRoute(path) && !this.authorized(request) && !webSession) {
        this.send(response, 401, { error: "unauthorized" });
        return;
      }
      const localExecution = request.headers["x-openstrudel-executor"] === this.executorKey && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
      const canManageAccount = localExecution ? request.headers["x-openstrudel-owner"] === "1" : webSession ? webSession.owner : !paired || owner;
      if (path.startsWith("/v1/extensions") && request.method !== "GET" && !canManageAccount) throw new HomeError("Расширения подключает владелец устройства.",403);
      if (path === "/v1/settings/approvals" && request.method !== "GET" && !canManageAccount) throw new HomeError("Режим действий меняет владелец устройства.",403);
      if (!localExecution && request.method !== "GET" && path !== "/v1/home/transfer" && path !== "/v1/home/poll") {
        if (this.home.state.role === "primary" && this.store.getSetting("home.transfer")) throw new HomeError("Передаём управление. Изменения будут доступны после завершения.", 409);
        this.activeWrites++; counted = true;
      }
      const homeResponse = await this.homeApi.handle(request, canManageAccount, localExecution);
      if (homeResponse) { this.sendWire(response, homeResponse); return; }
      url = new URL(request.url ?? "/", "http://localhost"); path = url.pathname;
      const moveAction = path.match(/^\/v1\/agent-transfer\/(prepare|stage|release|activate|cancel|finish)$/);
      if (moveAction) {
        if (!localExecution || !canManageAccount || request.method !== "POST") throw new HomeError("Этапы переноса доступны только устройствам команды.", 403);
        this.send(response, 200, await this.agentMoves.handle(moveAction[1]!, await this.body(request, 280 * 1024 * 1024))); return;
      }
      if (request.method !== "GET") {
        const profile = path.match(/^\/v1\/(?:agents|profiles)\/([^/]+)(?:\/|$)/)?.[1];
        const chat = path.match(/^\/v1\/conversations\/([^/]+)(?:\/|$)/)?.[1] ?? url.searchParams.get("conversationId");
        if (profile && profile !== "archive") assertAgentWritable(this.store, decodeURIComponent(profile));
        if (chat) assertAgentWritable(this.store, this.store.getConversation(chat)?.profileId ?? "main");
      }
      if (path.startsWith("/v1/web/") && !canManageAccount) throw new HomeError("Управление доступом доступно владельцу.", 403);
      if (path === "/v1/web/invitation" && request.method === "POST") {
        const input = await this.body(request);
        const invitation = this.web.invite(input.owner !== false);
        const address = input.local === true && !paired ? this.localURL! : (await this.mobile.endpoint()).url;
        this.send(response, 201, { url: address + "/#invite=" + invitation.key, expiresAt: invitation.expiresAt }); return;
      }
      if (path === "/v1/web/sessions" && request.method === "GET") { this.send(response, 200, { sessions: this.web.list() }); return; }
      const webRevoke = path.match(/^\/v1\/web\/sessions\/([a-f0-9]+)$/);
      if (webRevoke && request.method === "DELETE") { this.web.revoke(webRevoke[1]!); this.send(response, 200, { ok: true }); return; }
      const mobileClient = path.match(/^\/v1\/mobile\/clients\/([a-f0-9]{20})$/);
      if (mobileClient && request.method === "DELETE") {
        if (!canManageAccount) throw new HomeError("Управление доступом доступно владельцу.", 403);
        this.mobile.revokeClient(mobileClient[1]!); this.send(response, 200, this.mobile.status()); return;
      }
      if (path === "/v1/settings/approvals" && ["GET", "POST"].includes(request.method ?? "")) {
        if (request.method === "POST") {
          const input = await this.body(request);
          if (!isApprovalMode(input.mode)) throw new HomeError("Выберите режим действий.");
          if (input.mode === "approve_all" && readApprovalMode(this.store.getSetting(approvalSetting)) !== "approve_all" && input.confirm !== true)
            throw new HomeError("Подтвердите выполнение действий без дополнительных разрешений.",409);
          this.store.setSetting(approvalSetting, input.mode);
        }
        this.send(response,200,{mode:readApprovalMode(this.store.getSetting(approvalSetting)),canManage:canManageAccount}); return;
      }
      if (path === "/v1/accounts" && request.method === "GET") {
        this.send(response, 200, { accounts: await this.accounts?.list(url.searchParams.get("refresh") === "true") ?? [], canManage: canManageAccount }); return;
      }
      if (path.startsWith("/v1/accounts") && !canManageAccount) throw new HomeError("Подключать аккаунты может владелец устройства.", 403);
      if (path === "/v1/accounts" && request.method === "POST") {
        if (!this.accounts) throw new HomeError("Обновите Home.");
        this.send(response, 201, this.accounts.add(String((await this.body(request)).name ?? ""))); return;
      }
      const accountAction = path.match(/^\/v1\/accounts\/([^/]+)(?:\/(priority|login|logout|usage)(?:\/([^/]+))?)?$/);
      if (accountAction && this.accounts) {
        const id = decodeURIComponent(accountAction[1]!), service = this.accounts.get(id), action = accountAction[2];
        if (!action && request.method === "DELETE") { await this.accounts.remove(id); this.send(response, 200, { ok: true }); return; }
        if (action === "priority" && request.method === "POST") { this.accounts.prioritize(id); this.send(response, 200, { ok: true }); return; }
        if (action === "usage" && request.method === "GET") { this.send(response, 200, await service.usage(url.searchParams.get("refresh") === "true")); return; }
        if (action === "login" && request.method === "POST" && !accountAction[3]) { this.send(response, 201, await this.accounts.withIdle(id, () => service.startLogin("device"))); return; }
        if (action === "login" && request.method === "GET" && accountAction[3]) { this.send(response, 200, await service.status(decodeURIComponent(accountAction[3]))); return; }
        if (action === "login" && request.method === "DELETE" && accountAction[3]) { this.send(response, 200, await service.cancel(decodeURIComponent(accountAction[3]))); return; }
        if (action === "logout" && request.method === "POST") { await this.accounts.withIdle(id, () => service.logout()); this.send(response, 200, { ok: true }); return; }
      }
      const accountPolicy = path.match(/^\/v1\/agents\/([^/]+)\/accounts$/);
      if (accountPolicy && this.accounts) {
        const agent = decodeURIComponent(accountPolicy[1]!);
        if (request.method === "GET") { this.send(response, 200, { accountIds: this.accounts.policy(agent) }); return; }
        if (request.method === "POST") {
          if (!canManageAccount) throw new HomeError("Выбор аккаунтов доступен владельцу.", 403);
          this.accounts.setPolicy(agent, (await this.body(request)).accountIds ?? null); this.send(response, 200, { ok: true }); return;
        }
      }
      if (path.startsWith("/v1/agents/archive")) {
        if (!canManageAccount) { this.send(response, 403, { error: "Резервные копии доступны владельцу устройства." }); return; }
        response.setHeader("cache-control", "no-store");
        const archives = new AgentArchives(this.store, this.messages);
        if (["GET", "POST"].includes(request.method ?? "") && path === "/v1/agents/archive") {
          const password = request.method === "POST" ? String((await this.body(request)).password ?? "") : undefined;
          if (password !== undefined && (password.length < 12 || password.length > 1024)) throw new HomeError("Для копии нужен пароль от 12 символов.");
          const archive = archives.export();
          const compressed = encodeArchive(archive);
          const encoded = password === undefined ? compressed : Buffer.from(encryptBackup({ format: "openstrudel.team.protected", version: 1, archive: compressed.toString("base64") }, password));
          // Protected imports include a base64 envelope and a password. Never
          // offer a backup that exceeds the same endpoint's restore limit.
          const uploadBytes = password === undefined ? encoded.length : Math.ceil(encoded.length / 3) * 4 + 8192;
          if (uploadBytes > MAX_TRANSFER_BYTES) throw new HomeError("Копия слишком большая для одного файла.");
          response.setHeader("content-disposition", `attachment; filename="OpenStrudel-${archive.createdAt.slice(0,10)}.openstrudel"`);
          response.setHeader("content-type", password === undefined ? "application/vnd.openstrudel.team+gzip" : "application/vnd.openstrudel.team+json");
          response.setHeader("content-length", encoded.length);
          response.writeHead(200).end(encoded); return;
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
        this.send(response, 200, { ok: true, service: "openstrudel", platform: process.platform, arch: process.arch, time: new Date().toISOString(), telegram: this.telegram.status(), turnControlVersion: 1, queueControlVersion: 1, agentArchiveVersion: 1, agentArchiveEncryption: true, agentAppearanceVersion: 1, deviceLogoutVersion: 1, homeProtocol: 1, homeId: this.home.state.id, primaryId: this.home.state.primaryId, nodeId: this.home.state.nodeId, hostingOrigin: hostingOrigin(process.env.OPENSTRUDEL_HOSTING_ORIGIN) });
        return;
      }
      if (request.method === "GET" && path === "/v1/integrations") {
        this.send(response, 200, { telegram: this.telegram.status() });
        return;
      }
      if (request.method === "GET" && path === "/v1/account") {
        if (url.searchParams.has("agentId") && this.accounts) {
          this.send(response, 200, { ...await this.accounts.statusFor(url.searchParams.get("agentId")!, url.searchParams.get("refresh") === "true"), canManage: canManageAccount }); return;
        }
        this.send(response, 200, { account: this.account ? await this.account.read(url.searchParams.get("refresh") === "true") : { connected: false, email: null, planType: null, managed: false }, canManage: canManageAccount, loginPending: this.account?.loginPending ?? false });
        return;
      }
      if (request.method === "POST" && path === "/v1/account/login") {
        if (!this.account) throw new Error("account service unavailable");
        this.accounts?.assertIdle("default");
        const body = await this.body(request);
        const method = paired || body.method === "device" ? "device" : "browser";
        this.send(response, 201, await (this.accounts ? this.accounts.withIdle("default", () => this.account!.startLogin(method)) : this.account.startLogin(method)));
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
        this.accounts?.assertIdle("default");
        if (this.accounts) await this.accounts.withIdle("default", () => this.account!.logout()); else await this.account.logout();
        this.send(response, 200, { account: await this.account.read() });
        return;
      }
      if (request.method === "GET" && path === "/v1/conversation") {
        const conversation = this.store.primaryConversation();
        this.send(response, 200, { conversation, ...(url.searchParams.get("page") === "true" ? this.store.messagePage(conversation.id, url.searchParams) : { messages: this.store.listMessages(conversation.id, messageLimit) }), interactions: this.messages.interactions.list(conversation.id), queuedMessages: this.messages.queuedMessages(conversation.id) });
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
        this.send(response, 200, { conversation, ...(url.searchParams.get("page") === "true" ? this.store.messagePage(conversation.id, url.searchParams) : { messages: this.store.listMessages(conversation.id, messageLimit) }), interactions: this.messages.interactions.list(conversation.id), queuedMessages: this.messages.queuedMessages(conversation.id) });
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
        this.store.db.exec("SAVEPOINT create_profile");
        let profile;
        try {
          profile = this.store.createProfile({
            name,
            instructions,
            capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((item): item is string => typeof item === "string") : [],
            model: body.model == null ? undefined : String(body.model),
            tokenLimit,
            domain: body.domain == null ? undefined : body.domain as import("./types.js").EmployeeProfile["domain"],
            purpose: body.purpose == null ? undefined : String(body.purpose),
            appearance: body.appearance as import("./agent-appearance.js").AgentAppearance | undefined,
          });
          if (creationId) this.store.setSetting("employee.creation." + creationId,profile.id);
          this.store.db.exec("RELEASE create_profile");
        } catch (error) {
          this.store.db.exec("ROLLBACK TO create_profile; RELEASE create_profile"); throw error;
        }
        this.send(response, 201, { profile });
        return;
      }
      const profileMatch = path.match(/^\/v1\/profiles\/([^/]+)$/);
      if (request.method === "DELETE" && profileMatch) {
        if (!canManageAccount) throw new HomeError("Удалить сотрудника может владелец устройства.", 403);
        deleteEmployee(this.store, decodeURIComponent(profileMatch[1]!));
        this.send(response, 200, { ok: true }); return;
      }
      if (request.method === "PATCH" && profileMatch) {
        const body = await this.body(request);
        const name = String(body.name ?? "").trim();
        const instructions = String(body.instructions ?? "").trim();
        const profile = this.store.updateProfile(decodeURIComponent(profileMatch[1] ?? ""), { name, instructions, purpose: body.purpose == null ? undefined : String(body.purpose), appearance: body.appearance as import("./agent-appearance.js").AgentAppearance | undefined });
        this.send(response, 200, { profile });
        return;
      }
      if (path.startsWith("/v1/integrations/telegram") && request.method !== "GET" && !canManageAccount) throw new HomeError("Настраивать Telegram может владелец устройства.", 403);
      if (request.method === "POST" && path === "/v1/integrations/telegram") {
        const body = await this.body(request);
        this.send(response, 200, { telegram: await this.telegram.configure(String(body.token ?? "")) });
        return;
      }
      if (request.method === "POST" && path === "/v1/integrations/telegram/check") {
        if (!canManageAccount) throw new HomeError("Проверить подключение бота может владелец устройства.", 403);
        this.send(response, 200, { telegram: await this.telegram.checkConnection() });
        return;
      }
      if (request.method === "POST" && path === "/v1/integrations/telegram/link") {
        const body=await this.body(request);
        this.send(response, 201, this.telegram.createLink(body.profileId ? String(body.profileId) : undefined, body.kind === "group" ? "group" : "private"));
        return;
      }
      if (request.method === "POST" && path === "/v1/integrations/telegram/link/status") {
        const body = await this.body(request);
        this.send(response, 200, this.telegram.linkStatus(String(body.code ?? ""))); return;
      }
      const bindingMatch=path.match(/^\/v1\/integrations\/telegram\/chats\/(-?\d+)$/);
      if(request.method==="PATCH" && bindingMatch) {
        const body=await this.body(request);
        if (typeof body.enabled === "boolean") this.telegram.setGroupEnabled(bindingMatch[1]!, body.enabled);
        else this.telegram.bindChat(bindingMatch[1]!,body.profileId == null ? null : String(body.profileId));
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
        this.send(response,200,{conversation,...(url.searchParams.get("page") === "true" ? this.store.messagePage(conversation.id, url.searchParams) : { messages: this.store.listMessages(conversation.id, messageLimit) }),interactions:this.messages.interactions.list(conversation.id),queuedMessages:this.messages.queuedMessages(conversation.id)});return;
      }
      if (request.method === "DELETE" && path === "/v1/integrations/telegram") {
        this.send(response, 200, { telegram: this.telegram.disconnect() });
        return;
      }
      if (path === "/v1/extensions" || path.startsWith("/v1/extensions/")) {
        const body = request.method === "POST" ? await this.body(request, 15 * 1024 * 1024) : {};
        if (request.method === "POST" && path === "/v1/extensions/preview") {
          this.send(response,200,previewExtension(body.files)); return;
        }
        const conversationId = String(body.conversationId ?? url.searchParams.get("conversationId") ?? "");
        const conversation = this.store.getConversation(conversationId);
        if (!conversation) throw new HomeError("Откройте чат сотрудника, для которого добавляете расширение.",404);
        if (request.method === "GET" && path === "/v1/extensions/contexts") {
          const context=this.messages.contextFor(conversationId);
          const peers=new Set(this.store.listConversations().filter(c=>this.messages.contextFor(c.id)===context).map(c=>c.profileId ?? "main"));
          const sharedNotice=peers.size>1 ? "Общие подключения: " + peers.size + " сотрудников. Изменения будут доступны каждому из них." : undefined;
          const contexts = [{id:conversation.id,title:context.startsWith("group-") ? conversation.title ?? "Группа Telegram" : "В приложении",isGroup:context.startsWith("group-"),sharedNotice}];
          for (const chat of this.store.telegramChats()) if (Number(chat.chatId)<0 && chat.profileId===conversation.profileId && chat.conversationId && !contexts.some(c=>c.id===chat.conversationId)) contexts.push({id:chat.conversationId,title:chat.title,isGroup:true,sharedNotice:undefined});
          this.send(response,200,{contexts}); return;
        }
        const engine = this.engine?.forAgent?.(conversation.profileId ?? "main",this.messages.contextFor(conversationId)) ?? this.engine?.forContext?.(this.messages.contextFor(conversationId)) ?? this.engine;
        const extensions = await engine?.extensions?.();
        if (!extensions) throw new HomeError("Обновите OpenStrudel на устройстве сотрудника, чтобы добавлять расширения.",501);
        if (request.method === "GET" && path === "/v1/extensions") this.send(response,200,await extensions.list());
        else if (request.method === "POST" && path === "/v1/extensions/install") this.send(response,200,await extensions.install(body.files,String(body.digest ?? "")));
        else if (request.method === "POST" && path === "/v1/extensions/mcp") this.send(response,200,await extensions.addMcp(body));
        else if (request.method === "POST" && path === "/v1/extensions/mcp/remove") this.send(response,200,await extensions.removeMcp(String(body.name ?? "")));
        else if (request.method === "POST" && path === "/v1/extensions/change") {
          if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new HomeError("Проверьте состояние расширения.");
          this.send(response,200,await extensions.change(String(body.id ?? ""),body.enabled as boolean|undefined));
        } else throw new HomeError("Действие не найдено.",404);
        return;
      }
      if (request.method === "GET" && path === "/v1/connections") {
        const conversationId=url.searchParams.get("conversationId");
        if (conversationId && !this.store.getConversation(conversationId)) throw new Error("Чат не найден");
        const engine=conversationId ? this.engine?.forAgent?.(this.store.getConversation(conversationId)?.profileId ?? "main", this.messages.contextFor(conversationId)) ?? this.engine?.forContext?.(this.messages.contextFor(conversationId)) ?? this.engine : this.engine;
        const connections = await engine?.connections?.(url.searchParams.get("refresh") === "true") ?? [];
        this.send(response, 200, { connections, notice: engine?.connectionNotice }); return;
      }
      if (request.method === "POST" && path === "/v1/connections/connect") {
        const body = await this.body(request);
        const conversationId=typeof body.conversationId === "string" ? body.conversationId : null;
        if (conversationId && !this.store.getConversation(conversationId)) throw new Error("Чат не найден");
        const engine=conversationId ? this.engine?.forAgent?.(this.store.getConversation(conversationId)?.profileId ?? "main", this.messages.contextFor(conversationId)) ?? this.engine?.forContext?.(this.messages.contextFor(conversationId)) ?? this.engine : this.engine;
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
        if (body.mode !== undefined && body.mode !== "steer" && body.mode !== "queue") throw new HomeError("Выберите: уточнить сейчас или отправить после ответа.");
        const submission = await this.messages.submit({
          mode: body.mode,
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
      const queuedMessage = path.match(/^\/v1\/conversations\/([^/]+)\/messages\/([^/]+)\/edit$/);
      if (request.method === "POST" && queuedMessage) {
        const body = await this.body(request);
        if (typeof body.text !== "string" || typeof body.expectedText !== "string") throw new HomeError("Проверьте текст сообщения.");
        this.messages.editQueuedMessage(queuedMessage[1]!, queuedMessage[2]!, body.text, body.expectedText);
        this.send(response, 200, { queuedMessages: this.messages.queuedMessages(queuedMessage[1]!) }); return;
      }
      const queueOrder = path.match(/^\/v1\/conversations\/([^/]+)\/queue$/);
      if (request.method === "POST" && queueOrder) {
        const body = await this.body(request);
        if (!Array.isArray(body.messageIds) || !Array.isArray(body.expectedMessageIds) || [...body.messageIds, ...body.expectedMessageIds].some(id => typeof id !== "string")) throw new HomeError("Проверьте сообщения в очереди.");
        this.messages.reorderQueuedMessages(queueOrder[1]!, body.messageIds, body.expectedMessageIds);
        this.send(response, 200, { queuedMessages: this.messages.queuedMessages(queueOrder[1]!) }); return;
      }
      const cancelMessage = path.match(/^\/v1\/conversations\/([^/]+)\/messages\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMessage) {
        this.messages.cancel(cancelMessage[1]!, cancelMessage[2]!);
        this.send(response, 200, { ok: true }); return;
      }
      this.send(response, 404, { error: "not_found" });
    } catch (error) {
      this.send(response, error instanceof HomeError ? error.status : 400, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (counted) this.activeWrites--;
    }
  }

  private authorized(request: IncomingMessage): boolean {
    if (!this.token) return true;
    return request.headers.authorization === `Bearer ${this.token}`;
  }

  private async archiveBody(request: IncomingMessage): Promise<unknown> {
    const bytes = await readBody(request, MAX_TRANSFER_BYTES);
    if (bytes[0] === 123) {
      let upload: any;
      try { upload = JSON.parse(bytes.toString()); } catch { /* decodeArchive reports damaged files. */ }
      if (typeof upload?.protectedArchive === "string") {
        const value = decryptBackup(Buffer.from(upload.protectedArchive, "base64").toString(), String(upload.password ?? "")) as any;
        if (value?.format !== "openstrudel.team.protected" || value?.version !== 1 || typeof value?.archive !== "string") {
          throw new HomeError("Этот файл содержит подключения устройств, а не сотрудников. Выберите резервную копию сотрудников.");
        }
        return decodeArchive(Buffer.from(value.archive, "base64"));
      }
    }
    return decodeArchive(bytes);
  }

  private async body(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
    const bytes = await readBody(request, limit);
    if (!bytes.length) return {};
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object expected");
    return parsed as Record<string, unknown>;
  }

  private send(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status).end(JSON.stringify(value));
  }
  private sendWire(response: ServerResponse, value: WireResponse) {
    const body = Buffer.from(value.body, "base64");
    response.writeHead(value.status, { "content-type": value.contentType, ...(value.status === 304 ? {} : { "content-length": body.length }), "cache-control": "no-store", ...(value.etag ? { etag: value.etag } : {}) }).end(body);
  }

  private async asset(response: ServerResponse, name: string, contentType: string): Promise<void> {
    try {
      let content: Buffer | string = await readFile(new URL("../public/" + name, import.meta.url));
      if (name === "index.html") {
        const nonce = randomBytes(18).toString("base64");
        content = content.toString().replaceAll("<script>", `<script nonce="${nonce}">`);
        response.setHeader("content-security-policy", `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
        response.setHeader("referrer-policy", "no-referrer");
        response.setHeader("x-content-type-options", "nosniff");
        response.setHeader("cache-control", "no-store");
      }
      response.writeHead(200, { "content-type": contentType }).end(content);
    } catch {
      response.writeHead(404).end("not found");
    }
  }
}
