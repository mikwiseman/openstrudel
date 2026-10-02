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

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Options = { directory?: string; port?: number; host?: string; hostname?: string; advertisedPort?: number; now?: () => number };

/** The same Home API over pinned TLS, opened only by a local pairing action. */
export class MobileAccess {
  private server?: Server;
  private starting?: Promise<void>;
  private invitation?: { hash: string; expires: number; owner: boolean };
  private fingerprint = "";
  private readonly directory: string;
  private readonly now: () => number;
  port?: number;

  constructor(private readonly store: Store, private readonly handle: (req: IncomingMessage, res: ServerResponse, owner?: boolean) => void, private readonly options: Options = {}) {
    this.directory = options.directory ?? resolve(".data/mobile");
    this.now = options.now ?? Date.now;
  }

  status() { return { connections: this.tokens().length }; }

  async restore() { if (this.tokens().length) await this.start(); }

  async invite(owner = false) {
    await this.start();
    const key = randomBytes(32).toString("hex");
    const expires = this.now() + 300_000;
    this.invitation = { hash: hash(key), expires, owner };
    const name = hostname();
    const host = this.options.hostname ?? (name.endsWith(".local") ? name : name + ".local");
    const query = new URLSearchParams({ host, port: String(this.options.advertisedPort ?? this.port), name, key, pin: this.fingerprint });
    return { url: "openstrudel://connect?" + query, expiresAt: new Date(expires).toISOString() };
  }

  cancelInvite() { this.invitation = undefined; }

  async revoke() {
    this.store.deleteSetting("mobile.tokens");
    this.store.deleteSetting("mobile.owners");
    await this.close();
  }

  async close() {
    await this.starting;
    this.cancelInvite();
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
    const certPath = resolve(this.directory, "certificate.pem");
    const keyPath = resolve(this.directory, "private-key.pem");
    try { await access(certPath); await access(keyPath); }
    catch {
      // Apple's LibreSSL defaults to explicit EC parameters. TLS 1.3 clients
      // require named-curve encoding for ECDSA certificate verification.
      await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-days", "3650", "-subj", "/CN=OpenStrudel", "-keyout", keyPath, "-out", certPath]);
      await chmod(keyPath, 0o600);
    }
    const cert = await readFile(certPath);
    this.fingerprint = new X509Certificate(cert).fingerprint256.replaceAll(":", "").toLowerCase();
    const server = createServer({ cert, key: await readFile(keyPath), minVersion: "TLSv1.2" }, (req, res) => {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      if (req.headers.origin) { res.writeHead(403).end('{"error":"Native app required"}'); return; }
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (req.method === "POST" && req.url === "/pair") {
        const invitation = this.invitation;
        if (!invitation || this.now() >= invitation.expires || hash(token) !== invitation.hash) {
          res.writeHead(401).end('{"error":"QR истёк. Откройте новый код на Mac."}'); return;
        }
        this.cancelInvite();
        const credential = randomBytes(32).toString("hex");
        this.store.setSetting("mobile.tokens", JSON.stringify([...this.tokens(), hash(credential)]));
        if (invitation.owner) this.store.setSetting("mobile.owners",JSON.stringify([...JSON.parse(this.store.getSetting("mobile.owners") ?? "[]"),hash(credential)]));
        res.end(JSON.stringify({ token: credential })); return;
      }
      if (!token || !this.tokens().includes(hash(token))) {
        res.writeHead(401).end('{"error":"Подключите iPhone заново через QR на Mac."}'); return;
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
  }
}
