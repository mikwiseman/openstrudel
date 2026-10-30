import { automaticProvider, checkModelSelection, parseModelSelection, readModelSelection, readConversationModelSelection, recommendedModel, resolveModelSelection, saveModelSelection, saveConversationModelSelection, parseModelFallbacks, readModelFallbacks, directFast, fastChat, offersFast, turnSpeed, modelReasoning, parseRestrictedModel, readRestrictedModel } from "./model-settings.js";
import { connectProvider, disconnectProvider, providerInfo, providerSummaries } from "./providers.js";
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
import { approvalSetting, isApprovalMode, readApprovalMode } from "./approval-mode.js";
import { accessOwners, accessPeople } from "./telegram-tools.js";
import { authorizationSummary, onlyDisablesScopedAccess, preserveConnectorHeaders, telegramAuthorization, saveTelegramAuthorization } from "./authorization.js";
import { ownerTimezone, saveOwnerTimezone } from "./timezone.js";
import { notificationDestinations, receiveNotification } from "./notification-hook.js";
import { SERVICE_SIGN_IN_SECONDS } from "./service-oauth.js";
import { sharedWithAllChats, shareWithAllChats } from "./extensions.js";
import type { ServiceSignIn } from "./types.js";
import { MAX_SPEECH_BYTES, isSpeechFile, saveSpeechSettings, speechSettings, transcribeRecording } from "./speech.js";
import { diagnosticReport, recordDiagnostic, saveDiagnosticLevel } from "./diagnostics.js";
import { runtimeIssues } from "./operations.js";

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
  private readonly serviceSignIns = new Map<string, { oauth: NonNullable<ServiceSignIn["oauth"]>; client: string; web: boolean; authorized: () => boolean; timer: NodeJS.Timeout }>();
  private startingServiceSignIns = 0;

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
      return homeRequest({ url: this.localURL }, request.path, this.token ?? "", request, request.path.startsWith("/v1/speech/") ? 190_000 : 30_000, { "x-openstrudel-executor": this.executorKey, "x-openstrudel-owner": request.owner ? "1" : "0" });
    }, async () => {
      const deadline = Date.now() + 15_000;
      while (this.activeWrites) {
        if (Date.now() >= deadline) throw new HomeError("Ещё выполняются изменения. Дождитесь их завершения и повторите передачу.", 409);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    });
    this.homeApi = new HomeApi(this.home, this.homeLink, () => this.mobile.endpoint(), () => this.telegram.status());
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
    recordDiagnostic(this.store, "service.started");
    return address;
  }

  async close(): Promise<void> {
    for (const id of this.serviceSignIns.keys()) this.cancelServiceSignIn(id);
    await this.homeLink.stop();
    await this.mobile.close();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  private cancelServiceSignIn(id: string): void {
    const flow = this.serviceSignIns.get(id);
    if (!flow) return;
    this.serviceSignIns.delete(id); clearTimeout(flow.timer); flow.oauth.cancel();
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
    response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    let url = new URL(request.url ?? "/", "http://localhost");
    let path = url.pathname;
    // The provider's redirect has no bearer and may omit strict cookies. Only
    // an existing web login with its Codex state may use this callback route.
    const webCallback = path.match(/^\/oauth\/service\/([a-f0-9]{48})(?:\/[^/]+)?$/);
    if (request.method === "GET" && webCallback) {
      const flow = this.serviceSignIns.get(webCallback[1]!);
      response.setHeader("cache-control", "no-store");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
      response.setHeader("content-type", "text/plain; charset=utf-8");
      try {
        if (!flow?.web) throw new Error("Вход истёк");
        if (!flow.authorized()) { this.cancelServiceSignIn(webCallback[1]!); throw new Error("Подключение отозвано"); }
        const scheme = (request.socket as { encrypted?: boolean }).encrypted ? "https:" : "http:";
        await flow.oauth.complete(`${scheme}//${host}${request.url}`);
        this.cancelServiceSignIn(webCallback[1]!);
        response.writeHead(200).end("Сервис подключён. Вернитесь в OpenStrudel.");
      } catch { response.writeHead(400).end("Не удалось завершить вход. Вернитесь в OpenStrudel и попробуйте ещё раз."); }
      return;
    }
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
    if (request.method === "GET" && path === "/localization.js") { await this.asset(response, "localization.js", "text/javascript; charset=utf-8"); return; }
    if (request.method === "GET" && path === "/localizations.json") { await this.asset(response, "localizations.json", "application/json; charset=utf-8"); return; }
    if (request.method === "GET" && ["/strudel-cream.png", "/strudel-graphite.png"].includes(path)) { await this.asset(response, path.slice(1), "image/png"); return; }
    if (request.method === "GET" && path === "/agent-characters.js") { await this.asset(response, "agent-characters.js", "text/javascript; charset=utf-8"); return; }
    if (request.method === "GET" && path === "/markdown.js") { await this.asset(response, "markdown.js", "text/javascript; charset=utf-8"); return; }
    if (request.method === "GET" && /^\/characters\/(main|coil|fold|knot|curl|wave|pillow)\.png$/.test(path)) { await this.asset(response, path.slice(1), "image/png"); return; }
    let counted = false;
    try {
      if (path === "/hooks/telegram") {
        const chatIds = notificationDestinations(this.store, request.headers.authorization);
        if (request.method !== "POST") throw new HomeError("method_not_allowed", 405);
        if (this.store.getSetting("home.transfer")) throw new HomeError("Передаём управление. Повторите после завершения.", 409);
        this.activeWrites++; counted = true;
        const [status, receipt] = await receiveNotification(this.store, this.telegram, chatIds, request.headers["idempotency-key"], await this.body(request, 128 * 1024));
        this.send(response, status, receipt); return;
      }
      if (await this.web.handle(request, response)) return;
      const webSession = this.web.authenticate(request);
      if (!paired && !isPeerRoute(path) && !this.authorized(request) && !webSession) {
        this.send(response, 401, { error: "unauthorized" });
        return;
      }
      const localExecution = request.headers["x-openstrudel-executor"] === this.executorKey && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
      const canManageAccount = localExecution ? request.headers["x-openstrudel-owner"] === "1" : webSession ? webSession.owner : !paired || owner;
      if (path.startsWith("/v1/extensions") && request.method !== "GET" && !canManageAccount) throw new HomeError("Расширения подключает владелец устройства.",403);
      if (path.startsWith("/v1/connections/") && request.method !== "GET" && !canManageAccount) throw new HomeError("Сервисы подключает владелец устройства.",403);
      if ((["/v1/settings/approvals", "/v1/settings/models", "/v1/settings/timezone", "/v1/settings/speech", "/v1/settings/access"].includes(path) || /^\/v1\/conversations\/[^/]+\/model$/.test(path)) && request.method !== "GET" && !canManageAccount) throw new HomeError("Настройки меняет владелец устройства.",403);
      if (!localExecution && request.method !== "GET" && path !== "/v1/home/transfer" && path !== "/v1/home/poll") {
        if (this.home.state.role === "primary" && this.store.getSetting("home.transfer")) throw new HomeError("Передаём управление. Изменения будут доступны после завершения.", 409);
        this.activeWrites++; counted = true;
      }
      const homeResponse = await this.homeApi.handle(request, canManageAccount, localExecution);
      if (homeResponse) { this.sendWire(response, homeResponse); return; }
      url = new URL(request.url ?? "/", "http://localhost"); path = url.pathname;
      if (path === "/v1/settings/telegram-authorization") {
        if (!canManageAccount) throw new HomeError("Ограниченные права настраивает владелец устройства.", 403);
        if (request.method === "GET") { this.send(response, 200, authorizationSummary(telegramAuthorization(this.store))); return; }
        if (request.method !== "PUT") throw new HomeError("Метод недоступен.", 405);
        const body = await this.body(request);
        // GET redacts secrets; omitting headers on an unchanged connector preserves them.
        const current = telegramAuthorization(this.store);
        preserveConnectorHeaders(current, body);
        // Running turns recheck the policy before every step and before delivery, so
        // switching access off never waits for participants to stop writing.
        // Reading the HTTP body yields to incoming Telegram turns: decide only now.
        if (this.messages.hasActiveRuns && !onlyDisablesScopedAccess(current, body)) throw new HomeError("Дождитесь завершения текущих ответов, затем измените права.", 409);
        const saved = saveTelegramAuthorization(this.store, body);
        this.send(response, 200, authorizationSummary(saved)); return;
      }
      const employeeTransfer = path.match(/^\/v1\/employee-transfer\/(prepare|stage|release|activate|cancel|finish)$/);
      if (employeeTransfer) {
        if (!canManageAccount || request.method !== "POST") throw new HomeError("Переносить сотрудников может владелец устройства.", 403);
        const input = await this.body(request, 65 * 1024 * 1024);
        if (input.homeId !== this.home.state.id) throw new HomeError("Подключённое устройство изменилось. Проверьте подключение перед переносом.", 409);
        if (employeeTransfer[1] === "prepare" && (input.agent === "main" || input.agentId !== input.agent)) throw new HomeError("Выберите сотрудника для переноса.", 400);
        this.send(response, 200, await this.agentMoves.handle(employeeTransfer[1]!, input)); return;
      }
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
      // The paired client making this request, so its own connection is never listed as someone else's.
      const currentClient = paired && path.startsWith("/v1/mobile") ? digest(request.headers.authorization?.replace(/^Bearer /, "") ?? "").slice(0, 20) : undefined;
      const mobileClient = path.match(/^\/v1\/mobile\/clients\/([a-f0-9]{20})$/);
      if (mobileClient && request.method === "DELETE") {
        if (!canManageAccount) throw new HomeError("Управление доступом доступно владельцу.", 403);
        if (mobileClient[1] === currentClient) throw new HomeError("Это подключение используется сейчас. Отключите его на самом устройстве.", 409);
        if (!this.mobile.revokeClient(mobileClient[1]!)) throw new HomeError("Подключение не найдено.", 404);
        this.send(response, 200, this.mobile.status(currentClient)); return;
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
      // Who gets this Home's services and data in groups, besides its paired owners.
      if (path === "/v1/settings/access" && ["GET", "POST"].includes(request.method ?? "")) {
        if (request.method === "POST") {
          const { people } = await this.body(request);
          if (!Array.isArray(people) || people.length > 200 || people.some(id => typeof id !== "string" || !/^[1-9]\d{0,19}$/.test(id))) throw new HomeError("Укажите Telegram ID людей с доступом.");
          this.store.setSetting("access.people", JSON.stringify([...new Set(people)]));
        }
        this.send(response, 200, { people: accessPeople(this.store), owners: accessOwners(this.store) }); return;
      }
      const conversationModel = path.match(/^\/v1\/conversations\/([^/]+)\/model$/);
      if ((path === "/v1/settings/models" || conversationModel) && ["GET", "POST"].includes(request.method ?? "")) {
        const conversationId = conversationModel ? decodeURIComponent(conversationModel[1]!) : url.searchParams.get("conversationId") ?? undefined;
        if (conversationModel && url.searchParams.has("conversationId") && url.searchParams.get("conversationId") !== conversationId) throw new HomeError("Выберите один чат.",400);
        const conversation = conversationId ? this.store.getConversation(conversationId) : undefined;
        if (conversationId && !conversation) throw new HomeError("Чат не найден.",404);
        const requestedAgent = url.searchParams.get("agentId") ?? undefined;
        const agent = conversation ? conversation.profileId ?? "main" : requestedAgent;
        if (conversation && requestedAgent && requestedAgent !== agent) throw new HomeError("Этот чат принадлежит другому сотруднику.",409);
        if (agent && agent !== "main" && !this.store.getProfile(agent)) throw new HomeError("Сотрудник не найден.",404);
        const context = conversationId ? this.messages.contextFor(conversationId) : agent && agent !== "main" ? this.store.getSetting("employee.context." + agent) ?? this.store.getProfile(agent)?.domain ?? "personal" : "personal";
        const engine = this.engine?.forAgent?.(agent ?? "main",context,conversationId) ?? this.engine?.forContext?.(context) ?? this.engine;
        if (!engine?.models) throw new HomeError("Обновите OpenStrudel на устройстве сотрудника, чтобы выбирать модель.",501);
        const models = (await engine.models(url.searchParams.get("refresh") === "true")).filter(model => !conversationId || !context.startsWith("group-") || providerInfo(model.provider ?? "chatgpt")?.engine !== "acp");
        const automatic = automaticProvider(this.store);
        if (request.method === "POST") {
          const input = await this.body(request), selection = parseModelSelection(input,Boolean(agent));
          if (input.fallbacks !== undefined && agent) throw new HomeError('Порядок резервов задаётся в настройках устройства.');
          if (input.directFast !== undefined && (agent || typeof input.directFast !== 'boolean')) throw new HomeError('Скорость личных чатов задаётся в настройках устройства.');
          if (input.restricted !== undefined && agent) throw new HomeError('Модель чатов с ограниченным доступом задаётся в настройках устройства.');
          const restricted = input.restricted === undefined ? undefined : parseRestrictedModel(input.restricted);
          // The level must exist for the model these turns follow: the main assistant's own, else this device default.
          if (restricted?.reasoningEffort) {
            const main = readModelSelection(this.store,'main');
            const device = main.model ? main : selection.model ? selection : resolveModelSelection(this.store,undefined,models);
            const model = models.find(m => m.id === device.model && (m.provider ?? 'chatgpt') === (device.provider ?? 'chatgpt'));
            if (model) modelReasoning(model,restricted.reasoningEffort);
          }
          const fallbacks = input.fallbacks === undefined ? undefined : parseModelFallbacks(input.fallbacks,selection.model ? selection : {...selection,provider:automatic,model:recommendedModel(models.filter(m=>m.provider === automatic)).id},this.store,models);
          if (agent) assertAgentWritable(this.store,agent);
          // A chat inherits its employee; an employee inherits the device.
          checkModelSelection(this.store,agent && !selection.model ? resolveModelSelection(this.store,conversationId ? agent : undefined,models) : selection,models);
          if (conversationId) saveConversationModelSelection(this.store,conversationId,selection);
          else saveModelSelection(this.store,selection,agent);
          if (fallbacks) this.store.setSetting('models.fallbacks',JSON.stringify(fallbacks));
          if (input.directFast !== undefined) this.store.setSetting('models.directFast',String(input.directFast));
          if (restricted === null) this.store.deleteSetting('models.restricted');
          else if (restricted) this.store.setSetting('models.restricted',JSON.stringify(restricted));
        }
        // A direct chat shows the speed its turns run at.
        const effective = resolveModelSelection(this.store,agent,models,conversationId);
        if (conversationId && fastChat(this.store,agent!,conversationId,context.startsWith("group-")))
          effective.serviceTier = turnSpeed(offersFast(models.find(m => m.id === effective.model && (m.provider ?? "chatgpt") === effective.provider)),effective.serviceTier);
        this.send(response,200,{models,fallbacks:readModelFallbacks(this.store),directFast:directFast(this.store),restricted:readRestrictedModel(this.store),providers:providerSummaries(this.store).filter(p=>p.connected),recommended:{...recommendedModel(models.filter(m=>m.provider === automatic)),provider:automatic},
          selection:conversationId ? readConversationModelSelection(this.store,conversationId) : readModelSelection(this.store,agent),defaults:resolveModelSelection(this.store,conversationId ? agent : undefined,models),effective,canManage:canManageAccount}); return;
      }
      if (path === "/v1/settings/speech" && ["GET", "POST"].includes(request.method ?? "")) {
        const settings = request.method === "POST" ? await saveSpeechSettings(this.store, await this.body(request)) : speechSettings(this.store);
        this.send(response, 200, { ...settings, canManage: canManageAccount }); return;
      }
      if (path === "/v1/diagnostics" && ["GET", "POST"].includes(request.method ?? "")) {
        if (!canManageAccount) throw new HomeError("Диагностика доступна владельцу устройства.", 403);
        if (request.method === "POST") saveDiagnosticLevel(this.store, (await this.body(request)).level);
        const { provider, connected, transcription } = speechSettings(this.store);
        this.send(response, 200, { ...diagnosticReport(this.store), issues:runtimeIssues(this.store), speech: { provider, connected, transcription }, telegram: { running: this.telegram.status().running, lastCheckedAt: this.telegram.status().lastCheckedAt } }); return;
      }
      if (path === "/v1/speech/transcribe" && request.method === "POST") {
        const input = await this.body(request, Math.ceil(MAX_SPEECH_BYTES * 4 / 3) + 4096);
        if (typeof input.name !== "string" || !isSpeechFile(input.name) || typeof input.contentBase64 !== "string") throw new HomeError("Выберите аудио или видео для распознавания.");
        const controller = new AbortController();
        const disconnected = () => { if (!response.writableEnded) controller.abort(); };
        response.once("close", disconnected);
        try {
          const text = await transcribeRecording(this.store, Buffer.from(input.contentBase64, "base64"), input.name, controller.signal);
          this.send(response, 200, { text });
        } finally { response.off("close", disconnected); }
        return;
      }
      if (path === "/v1/providers" && request.method === "GET") { this.send(response, 200, { providers: providerSummaries(this.store), canManage: canManageAccount }); return; }
      const providerAction = path.match(/^\/v1\/providers\/([^/]+)$/);
      if (providerAction && ["PUT", "DELETE"].includes(request.method ?? "")) {
        if (!canManageAccount) throw new HomeError("Подключать аккаунты может владелец устройства.", 403);
        const id = decodeURIComponent(providerAction[1]!);
        // A running turn would write its old-key thread back after the reset.
        this.accounts?.assertIdle("provider-" + id);
        if (request.method === "PUT") this.send(response, 200, { provider: await connectProvider(this.store, id, (await this.body(request)).key) });
        // A subscription signs out through its own CLI, which removes the token; forgetting it here would leave the token behind.
        else if (providerInfo(id)?.auth === "signin") throw new HomeError("Провайдер не найден.", 404);
        else this.send(response, 200, { ok: true, reset: disconnectProvider(this.store, id) });
        return;
      }
      // Grok signs in inside its own CLI on the device that runs the employees, with a device code.
      const grok = path.match(/^\/v1\/providers\/([^/]+)\/(login|logout)(?:\/([^/]+))?$/);
      if (grok && this.accounts) {
        if (!canManageAccount) throw new HomeError("Подключать аккаунты может владелец устройства.", 403);
        if (decodeURIComponent(grok[1]!) !== "grok") throw new HomeError("Провайдер не найден.", 404);
        const loginId = grok[3] && decodeURIComponent(grok[3]), login = this.accounts.grok;
        if (grok[2] === "login" && request.method === "POST" && !loginId) { this.send(response, 201, await login.start()); return; }
        if (grok[2] === "login" && request.method === "GET" && loginId) { this.send(response, 200, login.status(loginId)); return; }
        if (grok[2] === "login" && request.method === "DELETE" && loginId) { this.send(response, 200, login.cancel(loginId)); return; }
        if (grok[2] === "logout" && request.method === "POST" && !loginId) { this.accounts.assertIdle("provider-grok"); this.send(response, 200, { ok: true, reset: await login.logout() }); return; }
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
        const id = decodeURIComponent(accountAction[1]!), action = accountAction[2];
        if (action === "login" && request.method === "GET" && accountAction[3]) { this.send(response, 200, await this.accounts.loginStatus(id, decodeURIComponent(accountAction[3]))); return; }
        const service = this.accounts.get(id);
        if (!action && request.method === "POST") { this.accounts.rename(id, String((await this.body(request)).name ?? "")); this.send(response, 200, { ok: true }); return; }
        if (!action && request.method === "DELETE") { await this.accounts.remove(id); this.send(response, 200, { ok: true }); return; }
        if (action === "priority" && request.method === "POST") { this.accounts.prioritize(id); this.send(response, 200, { ok: true }); return; }
        if (action === "usage" && request.method === "GET") { this.send(response, 200, await service.usage(url.searchParams.get("refresh") === "true")); return; }
        if (action === "login" && request.method === "POST" && !accountAction[3]) { this.send(response, 201, await this.accounts.withIdle(id, () => service.startLogin("device"))); return; }
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
          this.send(response, 201, await this.mobile.invite(body.owner === true, typeof body.label === "string" ? body.label : undefined)); return;
        }
        const invitation = path.match(/^\/v1\/mobile\/pairing(?:\/([a-f0-9]{20}))?$/);
        if (request.method === "DELETE" && invitation) {
          this.mobile.cancelInvite(invitation[1]); this.send(response, 200, { ok: true }); return;
        }
        if (request.method === "GET" && path === "/v1/mobile") {
          this.send(response, 200, {...this.mobile.status(currentClient), timezoneVersion:1, timezone:this.store.getSetting('owner.timezone')}); return;
        }
        if (request.method === "DELETE" && path === "/v1/mobile") {
          // A remote owner's own credential is one of these, as on servers set up from the app.
          if (paired) throw new HomeError("Отключайте подключения по одному, чтобы не потерять доступ к этому устройству.", 409);
          await this.mobile.revoke(); this.send(response, 200, { ok: true }); return;
        }
      }
      if (path === '/v1/settings/timezone' && ['GET','POST'].includes(request.method ?? '')) {
        if (request.method === 'POST') {
          const body = await this.body(request);
          saveOwnerTimezone(this.store,body.timezone,body.initialize === true);
        }
        this.send(response,200,{timezone:ownerTimezone(this.store),configured:Boolean(this.store.getSetting('owner.timezone'))}); return;
      }
      if (request.method === "GET" && path === "/health") {
        this.send(response, 200, { ok: true, service: "openstrudel", platform: process.platform, arch: process.arch, time: new Date().toISOString(), telegram: this.telegram.status(), employeeTimelineVersion: 1, turnControlVersion: 1, speechVersion: 1, diagnosticsVersion: 1, modelFallbacksVersion: 1, conversationModelsVersion: 1, queueControlVersion: 1, agentArchiveVersion: 1, agentArchiveEncryption: true, employeeTransferVersion: 1, agentAppearanceVersion: 1, deviceLogoutVersion: 1, employeeRenameKeepsInstructions: 1, deviceRenameVersion: 1, colleagueInvitesVersion: 1, ownerInvitesVersion: 1, subscriptionsVersion: 1, telegramPrivateChoiceVersion: 1, providers: 1, homeProtocol: 1, homeId: this.home.state.id, primaryId: this.home.state.primaryId, nodeId: this.home.state.nodeId, hostingOrigin: hostingOrigin(process.env.OPENSTRUDEL_HOSTING_ORIGIN) });
        return;
      }
      if (request.method === "GET" && path === "/v1/integrations") {
        this.send(response, 200, { telegram: this.telegram.status() });
        return;
      }
      if (request.method === "GET" && path === "/v1/account") {
        if (this.accounts) {
          const conversationId = url.searchParams.get("conversationId") ?? undefined;
          const conversation = conversationId ? this.store.getConversation(conversationId) : undefined;
          if (conversationId && !conversation) throw new HomeError("Чат не найден.",404);
          this.send(response, 200, { ...await this.accounts.statusFor(conversation ? conversation.profileId ?? "main" : url.searchParams.get("agentId") ?? "main", url.searchParams.get("refresh") === "true", conversationId), canManage: canManageAccount }); return;
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
        const loginId = decodeURIComponent(loginMatch[1] ?? "");
        this.send(response, 200, await (this.accounts ? this.accounts.loginStatus("default", loginId) : this.account.status(loginId)));
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
        if (url.searchParams.get("timeline") === "true") { this.send(response, 200, this.employeeTimeline(conversation, url.searchParams)); return; }
        this.send(response, 200, { conversation: this.modelConversation(conversation), ...(url.searchParams.get("page") === "true" ? this.store.messagePage(conversation.id, url.searchParams) : { messages: this.store.listMessages(conversation.id, messageLimit) }), interactions: this.messages.interactions.list(conversation.id), queuedMessages: this.messages.queuedMessages(conversation.id) });
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
        if (url.searchParams.get("timeline") === "true") { this.send(response, 200, this.employeeTimeline(conversation, url.searchParams)); return; }
        this.send(response, 200, { conversation: this.modelConversation(conversation), ...(url.searchParams.get("page") === "true" ? this.store.messagePage(conversation.id, url.searchParams) : { messages: this.store.listMessages(conversation.id, messageLimit) }), interactions: this.messages.interactions.list(conversation.id), queuedMessages: this.messages.queuedMessages(conversation.id) });
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
        this.send(response, 200, { profiles: this.store.listProfiles(), telegram: this.telegram.status(), importedConversations: this.store.listConversations().filter(c => c.externalId?.startsWith("import::")).map(c => ({ id: c.id, title: c.title ?? "Импортированный чат", profileId: c.profileId })) });
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
        // A model chosen at creation is the same owner-only choice as in the model settings.
        const choice = body.provider == null && body.model == null ? null : parseModelSelection({ provider: body.provider, model: body.model ?? null, serviceTier: body.serviceTier ?? "default" }, true);
        if (choice) {
          if (!canManageAccount) throw new HomeError("Настройки меняет владелец устройства.", 403);
          const engine = this.engine?.forAgent?.("main", "personal") ?? this.engine?.forContext?.("personal") ?? this.engine;
          checkModelSelection(this.store, choice, await engine?.models?.() ?? []);
        }
        this.store.db.exec("SAVEPOINT create_profile");
        let profile;
        try {
          profile = this.store.createProfile({
            name,
            defaultName: typeof body.defaultName === "string" ? body.defaultName : undefined,
            instructions,
            capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((item): item is string => typeof item === "string") : [],
            provider: choice?.provider ?? undefined,
            model: choice?.model ?? undefined,
            serviceTier: choice?.serviceTier ?? undefined,
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
        const id = decodeURIComponent(profileMatch[1] ?? "");
        const current = this.store.getProfile(id);
        if (!current) throw new HomeError("Сотрудник не найден.", 404);
        const name = body.name === undefined ? current.name : String(body.name).trim();
        // keepInstructions marks instructions sent only for older Homes that require the field.
        const instructions = body.instructions === undefined || body.keepInstructions === true ? current.instructions : String(body.instructions).trim();
        const profile = this.store.updateProfile(id, { name, instructions, purpose: body.purpose == null ? undefined : String(body.purpose), appearance: body.appearance as import("./agent-appearance.js").AgentAppearance | undefined });
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
          // Only the owner sends a schedule's results to another Telegram chat.
          if(b.telegramChatId && !canManageAccount && this.store.getTelegramChat(String(b.telegramChatId))?.conversationId !== conversationId) throw new HomeError("Доставку в другой Telegram-чат настраивает владелец устройства.",403);
          const existing = b.id ? scheduler.list(conversationId).find(s => s.id === String(b.id)) : undefined;
          const schedule=scheduler.save({conversationId,id:b.id ? String(b.id):undefined,name:String(b.name ?? ""),prompt:String(b.prompt ?? ""),cron:String(b.cron ?? ""),timezone:String(b.timezone ?? ""),enabled:b.enabled!==false,telegramChatId:b.telegramChatId ? String(b.telegramChatId):null,delivery:b.delivery === "app" || b.delivery === "telegram" ? b.delivery : existing?.delivery,backupOf:existing?.backupOf});
          this.send(response,201,{schedule});return;
        }
      }
      const telegramReply = path.match(/^\/v1\/conversations\/([^/]+)\/telegram-reply$/);
      if (request.method === "POST" && telegramReply) {
        if (!canManageAccount) throw new HomeError("Отправить ответ в Telegram может владелец устройства.", 403);
        const body = await this.body(request);
        const receipt = await this.telegram.replyFromApp({ conversationId: telegramReply[1]!, replyToId: String(body.replyToId ?? ""),
          text: String(body.text ?? ""), externalId: String(body.externalId ?? ""), attachments: body.attachments as string[] | undefined });
        this.send(response, 200, receipt); return;
      }
      const singleConversation=path.match(/^\/v1\/conversations\/([^/]+)$/);
      if(request.method==="GET" && singleConversation) {
        const conversation=this.store.getConversation(singleConversation[1]!);
        if(!conversation) throw new Error("Чат не найден");
        this.send(response,200,{conversation:this.modelConversation(conversation),...(url.searchParams.get("page") === "true" ? this.store.messagePage(conversation.id, url.searchParams) : { messages: this.store.listMessages(conversation.id, messageLimit) }),interactions:this.messages.interactions.list(conversation.id),queuedMessages:this.messages.queuedMessages(conversation.id)});return;
      }
      if (request.method === "DELETE" && path === "/v1/integrations/telegram") {
        this.send(response, 200, { telegram: this.telegram.disconnect() });
        return;
      }
      if (path === "/v1/extensions" || path.startsWith("/v1/extensions/")) {
        const body = request.method === "POST" ? await this.body(request, 15 * 1024 * 1024) : {};
        if (path === "/v1/extensions/all-chats") {
          // The owner's choice: services of the main chat also work in every other chat on this Home.
          if (!this.accounts) throw new HomeError("Обновите OpenStrudel на этом устройстве.",501);
          if (request.method === "POST") {
            if (typeof body.enabled !== "boolean") throw new HomeError("Укажите, делиться ли сервисами.");
            shareWithAllChats(this.accounts.root, body.enabled);
          } else if (request.method !== "GET") throw new HomeError("Действие не найдено.",404);
          this.send(response,200,{enabled:sharedWithAllChats(this.accounts.root)}); return;
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
        const engine = this.engine?.forAgent?.(conversation.profileId ?? "main",this.messages.contextFor(conversationId), conversationId) ?? this.engine?.forContext?.(this.messages.contextFor(conversationId)) ?? this.engine;
        const extensions = await engine?.extensions?.();
        if (!extensions) throw new HomeError("Обновите OpenStrudel на устройстве сотрудника, чтобы добавлять расширения.",501);
        if (request.method === "POST" && path === "/v1/extensions/preview") this.send(response,200,extensions.preview(body.files));
        else if (request.method === "GET" && path === "/v1/extensions/computer") this.send(response,200,extensions.computerUse());
        else if (request.method === "POST" && path === "/v1/extensions/computer") this.send(response,200,await extensions.connectComputerUse());
        else if (request.method === "DELETE" && path === "/v1/extensions/computer") this.send(response,200,await extensions.removeMcp("cua_repl"));
        else if (request.method === "GET" && path === "/v1/extensions") {
          // A context's skills and plugins stay listed for every route, but the Claude and Grok engines load only their MCP services
          // and a key provider's Codex loads no plugins.
          const provider = providerInfo(resolveModelSelection(this.store,conversation.profileId ?? "main",undefined,conversationId).provider ?? "");
          const state = await extensions.list();
          this.send(response,200,!provider ? state : {...state,notice:provider.engine !== "codex" ? `С ${provider.name} сотрудник использует только сервисы MCP. Навыки работают с ChatGPT, OpenAI API и xAI, плагины — только с ChatGPT.`
            : `С ${provider.name} сотрудник не использует плагины: они работают только с ChatGPT.`});
        }
        else if (request.method === "POST" && path === "/v1/extensions/install") this.send(response,200,await extensions.install(body.files,String(body.digest ?? ""),body.replaces == null ? undefined : String(body.replaces)));
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
        const engine=conversationId ? this.engine?.forAgent?.(this.store.getConversation(conversationId)?.profileId ?? "main", this.messages.contextFor(conversationId), conversationId) ?? this.engine?.forContext?.(this.messages.contextFor(conversationId)) ?? this.engine : this.engine;
        const connections = await engine?.connections?.(url.searchParams.get("refresh") === "true") ?? [];
        this.send(response, 200, { connections, notice: engine?.connectionNotice }); return;
      }
      if (request.method === "POST" && path === "/v1/connections/connect") {
        const body = await this.body(request);
        const conversationId=typeof body.conversationId === "string" ? body.conversationId : null;
        if (conversationId && !this.store.getConversation(conversationId)) throw new Error("Чат не найден");
        const engine=conversationId ? this.engine?.forAgent?.(this.store.getConversation(conversationId)?.profileId ?? "main", this.messages.contextFor(conversationId), conversationId) ?? this.engine?.forContext?.(this.messages.contextFor(conversationId)) ?? this.engine : this.engine;
        if (!engine?.connect) throw new Error("Подключения Codex недоступны");
        if (body.callback !== undefined && body.callback !== "app" && body.callback !== "web") throw new HomeError("Проверьте способ входа.");
        const signInId = randomBytes(24).toString("hex");
        const scheme = (request.socket as { encrypted?: boolean }).encrypted ? "https:" : "http:";
        const callbackURL = body.callback === "app" ? `openstrudel://oauth/service/${signInId}`
          : body.callback === "web" ? `${scheme}//${host}/oauth/service/${signInId}` : undefined;
        if (callbackURL && this.serviceSignIns.size + this.startingServiceSignIns >= 8) throw new HomeError("Завершите открытый вход и попробуйте ещё раз.",429);
        if (body.callback === "web" && localExecution) throw new HomeError("Для этого устройства подключите сервис в приложении.",409);
        let link: ServiceSignIn;
        this.startingServiceSignIns++;
        try { link = await engine.connect(String(body.id ?? ""), callbackURL ? { callbackURL } : undefined); }
        finally { this.startingServiceSignIns--; }
        if (response.destroyed) { link.oauth?.cancel(); return; }
        if (link.oauth) {
          const timer = setTimeout(() => this.cancelServiceSignIn(signInId), SERVICE_SIGN_IN_SECONDS * 1000); timer.unref();
          const sessionID = webSession?.id;
          const mobileID = paired ? digest(request.headers.authorization?.replace(/^Bearer /, "") ?? "").slice(0, 20) : undefined;
          const authorized = sessionID ? () => this.web.list().some(s => s.id === sessionID && s.owner)
            : mobileID ? () => this.mobile.status().clients.some(c => c.id === mobileID && c.role === "owner") : () => true;
          this.serviceSignIns.set(signInId, { oauth: link.oauth, authorized, client: digest(webSession?.id ?? request.headers.authorization ?? ""), web: body.callback === "web", timer });
        }
        this.send(response, 200, { url: link.url ? safeURL(link.url) : null, ...(link.oauth ? { signInId } : {}) }); return;
      }
      const serviceCallback = path.match(/^\/v1\/connections\/oauth\/([a-f0-9]{48})$/);
      if (serviceCallback && ["POST", "DELETE"].includes(request.method ?? "")) {
        const id = serviceCallback[1]!, flow = this.serviceSignIns.get(id);
        if (!flow || flow.client !== digest(webSession?.id ?? request.headers.authorization ?? "")) throw new HomeError("Вход истёк. Подключите сервис ещё раз.",404);
        if (request.method === "POST") {
          const body = await this.body(request, 20_000);
          if (typeof body.url !== "string") throw new HomeError("Проверьте ответ сервиса.");
          await flow.oauth.complete(body.url);
        }
        this.cancelServiceSignIn(id);
        this.send(response, 200, { ok: true }); return;
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
          byOwner: canManageAccount,
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

  private modelConversation(conversation: import("./types.js").Conversation) {
    const agent = conversation.profileId ?? "main", effectiveModel = resolveModelSelection(this.store,agent,undefined,conversation.id);
    // Clients refresh the chat's model control when this changes. Without the catalog: only OpenAI providers have speeds.
    if (fastChat(this.store,agent,conversation.id,this.messages.contextFor(conversation.id).startsWith("group-")))
      effectiveModel.serviceTier = turnSpeed(["chatgpt","openai"].includes(effectiveModel.provider ?? ""),effectiveModel.serviceTier);
    return {...conversation,effectiveModel};
  }

  private employeeTimeline(conversation: import("./types.js").Conversation, query: URLSearchParams) {
    const profileId = conversation.profileId ?? null;
    const interactions = this.store.listConversations().filter(c => (c.profileId ?? null) === profileId)
      .flatMap(c => this.messages.interactions.list(c.id).map(i => ({ ...i, sourceTitle: c.channel === "telegram" ? c.title : undefined })));
    return { conversation: this.modelConversation(conversation), timeline: true, ...this.store.employeeMessagePage(profileId, query), interactions, queuedMessages: this.messages.queuedMessages(conversation.id) };
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
