import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, access, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { hostname } from "node:os";
import { defaultDeviceName, type HomeState } from "./home.js";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Store } from "./store.js";
import { isPeerRoute, readBody } from "./home-api.js";
import { publicKeyPin } from "./home-transport.js";
import { sameOrigin, type WebAccess } from "./web-access.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Every connection link, the owner's own and a colleague's, lasts a day. */
const INVITATION_LIFETIME = 86_400_000;
type Options = { directory?: string; port?: number; host?: string; hostname?: string; advertisedPort?: number; now?: () => number };
type Invitation = { id: string; hash: string; expires: number; owner: boolean; label?: string };
type Client = { id: string; label?: string; pairedAt: string };
/** A plain credential kept only to repeat a lost pairing response, by its invitation's key hash. */
type Receipt = { nonce: string; token: string; expires: number; owner: boolean };

/** The same Home API over pinned TLS, opened only by a local pairing action. */
export class MobileAccess {
  private server?: Server;
  private starting?: Promise<void>;
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
  }

  /** `current` is the requesting client's id, so it is never mistaken for another device. */
  status(current?: string) {
    const owners = this.owners(), clients = this.clients();
    return {
      connections: this.tokens().length,
      clients: this.tokens().map(token => {
        const id = token.slice(0, 20), saved = clients.find(c => c.id === id);
        return { id, label: saved?.label ?? null, role: owners.includes(token) ? "owner" : "colleague", pairedAt: saved?.pairedAt ?? null, current: id === current };
      }),
      invitations: this.invitations().map(i => ({ id: i.id, label: i.label ?? null, role: i.owner ? "owner" : "colleague", expiresAt: new Date(i.expires).toISOString() })),
    };
  }

  async restore() {
    this.store.deleteSetting("mobile.pair_receipt");
    this.dropReceipts();
    if (this.tokens().length || this.invitations().length || this.store.getSetting("home.endpoint") || this.store.getSetting("web.sessions")) await this.start();
  }
  async endpoint() {
    await this.start();
    const machine = hostname();
    const host = this.options.hostname ?? (machine.endsWith(".local") ? machine : machine + ".local");
    return { url: `https://${host.includes(":") ? `[${host}]` : host}:${this.options.advertisedPort ?? this.port}`, pin: this.keyFingerprint };
  }

  /** Each link connects one device within a day. The owner's own link replaces the previous one; colleague links coexist. */
  async invite(owner = false, label?: string) {
    await this.start();
    const key = randomBytes(32).toString("hex");
    const invitation: Invitation = { id: hash(key).slice(0, 20), hash: hash(key), expires: this.now() + INVITATION_LIFETIME, owner, ...(label?.trim() ? { label: label.trim().slice(0, 80) } : {}) };
    this.saveInvitations([...this.invitations().filter(i => !(owner && i.owner)), invitation].slice(-20));
    this.dropReceipts((_, receipt) => owner && receipt.owner);
    const machine = hostname();
    const name = (JSON.parse(this.store.getSetting("home.state") ?? "null") as HomeState | null)?.name ?? defaultDeviceName();
    const host = this.options.hostname ?? (machine.endsWith(".local") ? machine : machine + ".local");
    const query = new URLSearchParams({ host, port: String(this.options.advertisedPort ?? this.port), name, key, pin: this.fingerprint, keyPin: this.keyFingerprint });
    const url = "openstrudel://connect?" + query;
    return { id: invitation.id, url, shareUrl: "https://waiwai.is/openstrudel/connect.html#" + encodeURIComponent(url), expiresAt: new Date(invitation.expires).toISOString() };
  }

  /** Ends one waiting link by its id. Without an id, ends the owner's own link, as older apps do when its sheet closes. */
  cancelInvite(id?: string) {
    this.saveInvitations(this.invitations().filter(i => id ? i.id !== id : !i.owner));
    this.dropReceipts((keyHash, receipt) => id ? keyHash.slice(0, 20) === id : receipt.owner);
  }

  async revoke() {
    for (const key of ["mobile.tokens", "mobile.owners", "mobile.clients", "mobile.invitations", "mobile.pair_receipt", "mobile.pair_receipts"]) this.store.deleteSetting(key);
    if (!this.store.getSetting("home.endpoint") && !this.store.getSetting("web.sessions")) await this.close();
  }
  revokeClient(id: string): boolean {
    const removed = this.tokens().filter(token => token.slice(0, 20) === id);
    this.store.setSetting("mobile.tokens", JSON.stringify(this.tokens().filter(token => !removed.includes(token))));
    this.store.setSetting("mobile.owners", JSON.stringify(this.owners().filter(token => !removed.includes(token))));
    this.store.setSetting("mobile.clients", JSON.stringify(this.clients().filter(client => client.id !== id)));
    return removed.length > 0;
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
  private owners(): string[] { return JSON.parse(this.store.getSetting("mobile.owners") ?? "[]") as string[]; }
  private clients(): Client[] { return JSON.parse(this.store.getSetting("mobile.clients") ?? "[]") as Client[]; }
  private invitations(): Invitation[] { return (JSON.parse(this.store.getSetting("mobile.invitations") ?? "[]") as Invitation[]).filter(i => i.expires > this.now()); }
  private saveInvitations(invitations: Invitation[]) { this.store.setSetting("mobile.invitations", JSON.stringify(invitations)); }
  /** Drops expired receipts and those `drop` matches, and returns the rest. */
  private dropReceipts(drop: (keyHash: string, receipt: Receipt) => boolean = () => false): Record<string, Receipt> {
    const all = Object.entries(JSON.parse(this.store.getSetting("mobile.pair_receipts") ?? "{}") as Record<string, Receipt>);
    const kept = all.filter(([keyHash, receipt]) => receipt.expires > this.now() && !drop(keyHash, receipt));
    if (kept.length < all.length) {
      if (kept.length) this.store.setSetting("mobile.pair_receipts", JSON.stringify(Object.fromEntries(kept))); else this.store.deleteSetting("mobile.pair_receipts");
    }
    return Object.fromEntries(kept);
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
    const server = createServer({ cert, key: await readFile(keyPath), minVersion: "TLSv1.2" }, async (req, res) => {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      if (!sameOrigin(req)) { res.writeHead(403).end('{"error":"Запрос с другого сайта отклонён"}'); return; }
      const path = new URL(req.url ?? "/", "https://localhost").pathname;
      // The notification route verifies its own destination-scoped credential.
      if (path === "/hooks/telegram") { this.handle(req, res, false); return; }
      // The Mini App validates its own Telegram signature and participant scope, never a Home session.
      if (["/check-in", "/check-in/", "/check-in/app.js", "/check-in/style.css", "/check-in/api"].includes(path)) { this.handle(req, res, false); return; }
      if (req.method === "GET" && /^\/oauth\/service\/[a-f0-9]{48}(?:\/[^/]+)?$/.test(path)) { this.handle(req, res, false); return; }
      if (/^\/characters\/(coil|fold|knot|curl|wave|pillow)\.png$/.test(path) || ["/", "/agent-characters.js", "/home-settings.js", "/localization.js", "/localizations.json", "/manifest.webmanifest", "/strudel-cream.png", "/strudel-graphite.png", "/favicon.ico", "/auth/session", "/auth/logout"].includes(path)) { this.handle(req, res, false); return; }
      if (isPeerRoute(new URL(req.url ?? "/", "https://localhost").pathname)) { this.handle(req, res, false); return; }
      try { const session = this.web?.authenticate(req); if (session) { this.handle(req, res, session.owner); return; } }
      catch { res.writeHead(403).end('{"error":"Обновите страницу и повторите действие"}'); return; }
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (req.method === "POST" && req.url === "/pair") {
        const nonce = req.headers["x-openstrudel-pair-id"];
        // The device may send its own name for the owner's list of connections.
        let name: string | undefined;
        try { const value = JSON.parse((await readBody(req, 4096)).toString() || "{}"); if (typeof value.name === "string" && value.name.trim()) name = value.name.trim().slice(0, 80); }
        catch { res.writeHead(400).end('{"error":"Не удалось проверить подключение"}'); return; }
        if (nonce !== undefined && (typeof nonce !== "string" || !/^[a-zA-Z0-9-]{32,64}$/.test(nonce))) { res.writeHead(400).end('{"error":"Не удалось проверить подключение"}'); return; }
        const receipts = this.dropReceipts(), previous = receipts[hash(token)];
        if (nonce && previous?.nonce === nonce && this.tokens().includes(hash(previous.token))) { res.end(JSON.stringify({ token: previous.token })); return; }
        if (this.store.getSetting("home.transfer")) { res.writeHead(409).end('{"error":"Сейчас меняется главное устройство. Создайте приглашение после завершения."}'); return; }
        const invitation = this.invitations().find(i => i.hash === hash(token));
        if (!invitation) {
          res.writeHead(401).end('{"error":"Ссылка устарела или уже использована. Попросите новую."}'); return;
        }
        const credential = randomBytes(32).toString("hex");
        const label = invitation.label ?? name;
        this.store.db.exec("BEGIN IMMEDIATE");
        try {
          this.store.setSetting("mobile.tokens", JSON.stringify([...this.tokens(), hash(credential)]));
          if (invitation.owner) this.store.setSetting("mobile.owners", JSON.stringify([...this.owners(), hash(credential)]));
          this.store.setSetting("mobile.clients", JSON.stringify([...this.clients(), { id: hash(credential).slice(0, 20), ...(label ? { label } : {}), pairedAt: new Date(this.now()).toISOString() }]));
          this.saveInvitations(this.invitations().filter(i => i.id !== invitation.id));
          // The plain credential is kept only briefly, to repeat a lost response.
          if (nonce) this.store.setSetting("mobile.pair_receipts", JSON.stringify({ ...receipts, [hash(token)]: { nonce, token: credential, expires: Math.min(invitation.expires, this.now() + 300_000), owner: invitation.owner } }));
          this.store.db.exec("COMMIT");
        } catch { this.store.db.exec("ROLLBACK"); res.writeHead(503).end('{"error":"Не удалось сохранить подключение. Проверьте свободное место на устройстве."}'); return; }
        res.end(JSON.stringify({ token: credential })); return;
      }
      if (!token || !this.tokens().includes(hash(token))) {
        res.writeHead(401).end('{"error":"Это устройство отключено. Подключитесь заново по новой ссылке."}'); return;
      }
      // The device holds its credential now, so its lost-response copy is no longer needed.
      this.dropReceipts((_, receipt) => receipt.token === token);
      if (req.method === "POST" && path === "/auth/device/logout") {
        this.revokeClient(hash(token).slice(0, 20));
        res.end('{"ok":true}'); return;
      }
      // A phone cannot issue more invitations or revoke someone else's access.
      const owner = this.owners().includes(hash(token));
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
