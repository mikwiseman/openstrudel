import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.js";
import { digest, HomeError } from "./home.js";
import { jsonBody } from "./home-api.js";

type Session = { hash: string; csrf: string; owner: boolean; expiresAt: number; id: string };
type Invitation = { hash: string; owner: boolean; expiresAt: number };
export function sameOrigin(request: IncomingMessage): boolean {
  const scheme = (request.socket as any).encrypted ? "https" : "http";
  return !request.headers.origin || request.headers.origin === scheme + "://" + request.headers.host;
}
export class WebAccess {
  constructor(private readonly store: Store) {}
  private sessions(): Session[] { return (JSON.parse(this.store.getSetting("web.sessions") ?? "[]") as Session[]).filter(s => s.expiresAt > Date.now()); }
  private invitations(): Invitation[] { return (JSON.parse(this.store.getSetting("web.invites") ?? "[]") as Invitation[]).filter(i => i.expiresAt > Date.now()); }
  invite(owner: boolean) {
    const key = randomBytes(32).toString("hex"), expiresAt = Date.now() + 300_000;
    this.store.setSetting("web.invites", JSON.stringify([...this.invitations().slice(-9), { hash: digest(key), owner, expiresAt }]));
    return { key, expiresAt: new Date(expiresAt).toISOString() };
  }
  authenticate(request: IncomingMessage): Session | undefined {
    if (!sameOrigin(request) || request.headers["sec-fetch-site"] === "cross-site") return undefined;
    const token = request.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith("openstrudel_session="))?.slice("openstrudel_session=".length);
    if (!token || token.length > 128) return undefined;
    const session = this.sessions().find(s => s.hash === digest(token));
    if (!session) return undefined;
    if (!["GET", "HEAD"].includes(request.method ?? "GET") && request.headers["x-openstrudel-csrf"] !== session.csrf) throw new HomeError("Обновите страницу и повторите действие.", 403);
    return session;
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (!path.startsWith("/auth/")) return false;
    if (!sameOrigin(request) || request.headers["sec-fetch-site"] === "cross-site") throw new HomeError("Запрос с другого сайта отклонён.", 403);
    response.setHeader("cache-control", "no-store");
    if (path === "/auth/session" && request.method === "POST") {
      if (!request.headers["content-type"]?.startsWith("application/json")) throw new HomeError("Нужен запрос JSON.", 415);
      const value = await jsonBody(request);
      const hash = digest(String(value.key ?? "")), invites = this.invitations();
      const invite = invites.find(i => i.hash === hash);
      if (!invite) throw new HomeError("Приглашение истекло. Откройте новое приглашение на главном устройстве.", 401);
      const token = randomBytes(32).toString("hex");
      const session: Session = { hash: digest(token), csrf: randomBytes(24).toString("hex"), owner: invite.owner, expiresAt: Date.now() + 7 * 86400_000, id: randomBytes(12).toString("hex") };
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        this.store.setSetting("web.invites", JSON.stringify(invites.filter(i => i !== invite)));
        this.store.setSetting("web.sessions", JSON.stringify([...this.sessions().slice(-49), session]));
        this.store.db.exec("COMMIT");
      } catch (e) { this.store.db.exec("ROLLBACK"); throw e; }
      response.setHeader("set-cookie", `openstrudel_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${(request.socket as any).encrypted ? "; Secure" : ""}`);
      response.end(JSON.stringify({ csrf: session.csrf, owner: session.owner })); return true;
    }
    const session = this.authenticate(request);
    if (!session) throw new HomeError("Откройте приглашение для входа в свою команду.", 401);
    if (path === "/auth/session" && request.method === "GET") { response.end(JSON.stringify({ csrf: session.csrf, owner: session.owner })); return true; }
    if (path === "/auth/logout" && request.method === "POST") {
      this.store.setSetting("web.sessions", JSON.stringify(this.sessions().filter(s => s.id !== session.id)));
      response.setHeader("set-cookie", "openstrudel_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"); response.end('{"ok":true}'); return true;
    }
    throw new HomeError("Страница не найдена.", 404);
  }
  list() { return this.sessions().map(({ id, owner, expiresAt }) => ({ id, owner, expiresAt })); }
  revoke(id: string) { this.store.setSetting("web.sessions", JSON.stringify(this.sessions().filter(s => s.id !== id))); }
}
