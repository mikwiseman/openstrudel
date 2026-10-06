import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, access, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { hostname } from "node:os";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Store } from "./store.js";
import { isPeerRoute } from "./home-api.js";
import { publicKeyPin } from "./home-transport.js";
import { sameOrigin, type WebAccess } from "./web-access.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Options = { directory?: string; port?: number; host?: string; hostname?: string; advertisedPort?: number; now?: () => number };

/** The same Home API over pinned TLS, opened only by a local pairing action. */
export class MobileAccess {
  private server?: Server;
  private starting?: Promise<void>;
  private invitation?: { hash: string; expires: number; owner: boolean };
  private fingerprint = "";
  private keyFingerprint = "";
  private readonly directory: string;
  private readonly now: () => number;
  port?: number;
  web?: WebAccess;
  private certificateTimer?: ReturnType<typeof setInterval>;
  private certificateBytes?: Buffer;

  constructor(private readonly store: Store, private readonly handle: (req: IncomingMessage, res: ServerResponse, owner?: boolean) => void, private readonly options: Options = {}) {
    this.directory = options.directory ?? resolve(".data/mobile");
    this.now = options.now ?? Date.now;
    const saved = JSON.parse(store.getSetting("mobile.invitation") ?? "null");
    if (saved?.expires > this.now()) this.invitation = saved;
  }

  status() { return { connections: this.tokens().length, clients: this.tokens().map((token, index) => ({ id: token.slice(0, 20), name: "Устройство " + (index + 1), owner: (JSON.parse(this.store.getSetting("mobile.owners") ?? "[]") as string[]).includes(token) })) }; }

  async restore() { if (this.tokens().length || this.invitation || this.store.getSetting("home.endpoint") || this.store.getSetting("web.sessions")) await this.start(); }
  async endpoint() {
    await this.start();
    const name = hostname();
    const host = this.options.hostname ?? (name.endsWith(".local") ? name : name + ".local");
    return { url: `https://${host.includes(":") ? `[${host}]` : host}:${this.options.advertisedPort ?? this.port}`, pin: this.keyFingerprint };
  }

  async invite(owner = false) {
    await this.start();
    const key = randomBytes(32).toString("hex");
    const expires = this.now() + 300_000;
    this.invitation = { hash: hash(key), expires, owner };
    this.store.setSetting("mobile.invitation", JSON.stringify(this.invitation));
    this.store.deleteSetting("mobile.pair_receipt");
    const name = hostname();
    const host = this.options.hostname ?? (name.endsWith(".local") ? name : name + ".local");
    const query = new URLSearchParams({ host, port: String(this.options.advertisedPort ?? this.port), name, key, pin: this.fingerprint, keyPin: this.keyFingerprint });
    return { url: "openstrudel://connect?" + query, expiresAt: new Date(expires).toISOString() };
  }

  cancelInvite() { this.invitation = undefined; this.store.deleteSetting("mobile.invitation"); this.store.deleteSetting("mobile.pair_receipt"); }

  async revoke() {
    this.store.deleteSetting("mobile.tokens");
    this.store.deleteSetting("mobile.owners");
    this.cancelInvite();
    if (!this.store.getSetting("home.endpoint") && !this.store.getSetting("web.sessions")) await this.close();
  }
  revokeClient(id: string) {
    const removed = this.tokens().filter(token => token.slice(0, 20) === id);
    this.store.setSetting("mobile.tokens", JSON.stringify(this.tokens().filter(token => !removed.includes(token))));
    this.store.setSetting("mobile.owners", JSON.stringify((JSON.parse(this.store.getSetting("mobile.owners") ?? "[]") as string[]).filter(token => !removed.includes(token))));
  }

  async close() {
    await this.starting;
    clearInterval(this.certificateTimer); this.certificateTimer = undefined;
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close(e => e ? reject(e) : done()));
    }
  }

  private tokens(): string[] {
    return JSON.parse(this.store.getSetting("mobile.tokens") ?? "[]") as string[];
  }

  private start(): Promise<void> {
    if (this.server) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.listen().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async listen() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const external = Boolean(process.env.OPENSTRUDEL_TLS_CERT || process.env.OPENSTRUDEL_TLS_KEY);
    if (external && (!process.env.OPENSTRUDEL_TLS_CERT || !process.env.OPENSTRUDEL_TLS_KEY)) throw new Error("Укажите оба файла: OPENSTRUDEL_TLS_CERT и OPENSTRUDEL_TLS_KEY.");
    const certPath = process.env.OPENSTRUDEL_TLS_CERT ?? resolve(this.directory, "certificate.pem");
    const keyPath = process.env.OPENSTRUDEL_TLS_KEY ?? resolve(this.directory, "private-key.pem");
    try { await access(certPath); await access(keyPath); }
    catch {
      if (external) throw new Error("Не удалось прочитать настроенные файлы TLS. Проверьте пути и права Home.");
      // Apple's LibreSSL defaults to explicit EC parameters. TLS 1.3 clients
      // require named-curve encoding for ECDSA certificate verification.
      await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-days", "3650", "-subj", "/CN=OpenStrudel", "-keyout", keyPath, "-out", certPath]);
      await chmod(keyPath, 0o600);
    }
    const cert = await readFile(certPath);
    const certificate = new X509Certificate(cert);
    if (Date.parse(certificate.validTo) <= this.now() || Date.parse(certificate.validFrom) > this.now()) throw new Error("Сертификат устройства ещё не действует или истёк. Обновите его перед подключением.");
    this.certificateBytes = cert;
    this.fingerprint = new X509Certificate(cert).fingerprint256.replaceAll(":", "").toLowerCase();
    this.keyFingerprint = publicKeyPin(new X509Certificate(cert));
    const server = createServer({ cert, key: await readFile(keyPath), minVersion: "TLSv1.2" }, (req, res) => {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      if (!sameOrigin(req)) { res.writeHead(403).end('{"error":"Запрос с другого сайта отклонён"}'); return; }
      const path = new URL(req.url ?? "/", "https://localhost").pathname;
      if (/^\/characters\/(coil|fold|knot|curl|wave|pillow)\.png$/.test(path) || ["/", "/agent-characters.js", "/home-settings.js", "/manifest.webmanifest", "/strudel-cream.png", "/strudel-graphite.png", "/favicon.ico", "/auth/session", "/auth/logout"].includes(path)) { this.handle(req, res, false); return; }
      if (isPeerRoute(new URL(req.url ?? "/", "https://localhost").pathname)) { this.handle(req, res, false); return; }
      try { const session = this.web?.authenticate(req); if (session) { this.handle(req, res, session.owner); return; } }
      catch { res.writeHead(403).end('{"error":"Обновите страницу и повторите действие"}'); return; }
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (req.method === "POST" && req.url === "/pair") {
        const nonce = req.headers["x-openstrudel-pair-id"];
        if (nonce !== undefined && (typeof nonce !== "string" || !/^[a-zA-Z0-9-]{32,64}$/.test(nonce))) { res.writeHead(400).end('{"error":"Не удалось проверить подключение"}'); return; }
        const previous = JSON.parse(this.store.getSetting("mobile.pair_receipt") ?? "null");
        if (nonce && previous?.expires > this.now() && previous.keyHash === hash(token) && previous.nonce === nonce && this.tokens().includes(hash(previous.token))) { res.end(JSON.stringify({ token: previous.token })); return; }
        if (previous && previous.expires <= this.now()) this.store.deleteSetting("mobile.pair_receipt");
        if (this.store.getSetting("home.transfer")) { res.writeHead(409).end('{"error":"Сейчас меняется главное устройство. Создайте приглашение после завершения."}'); return; }
        const invitation = this.invitation;
        if (!invitation || this.now() >= invitation.expires || hash(token) !== invitation.hash) {
          res.writeHead(401).end('{"error":"QR истёк. Откройте новый код на Mac."}'); return;
        }
        const credential = randomBytes(32).toString("hex");
        this.store.db.exec("BEGIN IMMEDIATE");
        try {
          this.store.setSetting("mobile.tokens", JSON.stringify([...this.tokens(), hash(credential)]));
          if (invitation.owner) this.store.setSetting("mobile.owners",JSON.stringify([...JSON.parse(this.store.getSetting("mobile.owners") ?? "[]"),hash(credential)]));
          this.store.deleteSetting("mobile.invitation");
          if (nonce) this.store.setSetting("mobile.pair_receipt", JSON.stringify({ keyHash: hash(token), nonce, token: credential, expires: invitation.expires }));
          this.store.db.exec("COMMIT");
          this.invitation = undefined;
        } catch { this.store.db.exec("ROLLBACK"); res.writeHead(503).end('{"error":"Не удалось сохранить подключение. Проверьте свободное место на устройстве."}'); return; }
        res.end(JSON.stringify({ token: credential })); return;
      }
      if (!token || !this.tokens().includes(hash(token))) {
        res.writeHead(401).end('{"error":"Подключите iPhone заново через QR на Mac."}'); return;
      }
      if (req.method === "POST" && path === "/auth/device/logout") {
        this.revokeClient(hash(token).slice(0, 20));
        res.end('{"ok":true}'); return;
      }
      // A phone cannot issue more invitations or revoke someone else's access.
      const owner=(JSON.parse(this.store.getSetting("mobile.owners") ?? "[]") as string[]).includes(hash(token));
      if (req.url?.startsWith("/v1/mobile") && !owner) { res.writeHead(403).end('{"error":"Откройте настройки на Mac"}'); return; }
      this.handle(req, res, owner);
    });
    server.requestTimeout = 0;
    server.headersTimeout = 15_000;
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(this.options.port ?? 7789, this.options.host ?? "0.0.0.0", () => { server.off("error", reject); done(); });
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    if (external) {
      this.certificateTimer = setInterval(() => { void this.reloadCertificate().catch(() => {
        // Keep the last verified context. No credentials or certificate contents in logs.
        console.error("[home] Новые файлы TLS не приняты. Проверьте сертификат и права доступа.");
      }); }, 60_000);
      this.certificateTimer.unref();
    }
  }

  async reloadCertificate() {
    if (!this.server || !process.env.OPENSTRUDEL_TLS_CERT || !process.env.OPENSTRUDEL_TLS_KEY) return;
    const cert = await readFile(process.env.OPENSTRUDEL_TLS_CERT);
    if (this.certificateBytes?.equals(cert)) return;
    const parsed = new X509Certificate(cert), keyPin = publicKeyPin(parsed);
    if (keyPin !== this.keyFingerprint || Date.parse(parsed.validTo) <= this.now() || Date.parse(parsed.validFrom) > this.now()) throw new Error("Сертификат не продлевает прежнюю идентичность устройства.");
    this.server.setSecureContext({ cert, key: await readFile(process.env.OPENSTRUDEL_TLS_KEY) });
    this.fingerprint = parsed.fingerprint256.replaceAll(":", "").toLowerCase(); this.certificateBytes = cert;
  }
}
