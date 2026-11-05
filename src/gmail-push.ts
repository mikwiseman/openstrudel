import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { HomeError } from "./home.js";
import { correspondenceSource, type Correspondence } from "./correspondence.js";
import type { Store } from "./store.js";

const historyId = z.string().regex(/^[1-9]\d{0,29}$/);
// Gmail sends numbers in live Pub/Sub data, while its REST responses use strings.
// Reject rounded JSON numbers; large string IDs retain their exact value.
const notificationHistoryId = z.union([historyId, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
const configSchema = z.object({ sourceId: z.string().regex(/^[a-z0-9-]{1,64}$/), sourceToken: z.string().min(32), mailbox: z.email(),
  clientId: z.string().min(1), clientSecret: z.string().min(1), refreshToken: z.string().min(1),
  topic: z.string().regex(/^projects\/[^/]+\/topics\/[^/]+$/), subscription: z.string().regex(/^projects\/[^/]+\/subscriptions\/[^/]+$/),
  pushServiceAccount: z.string().endsWith(".iam.gserviceaccount.com"), audience: z.url().startsWith("https://") }).strict();
export type GmailPushConfig = z.infer<typeof configSchema>;
export interface GmailGateway {
  verify(token: string, audience: string): Promise<{ email?: string; email_verified?: boolean } | undefined>;
  request(path: string, body?: unknown): Promise<unknown>;
}
const reference = z.object({ id: z.string().min(1).max(128), threadId: z.string().min(1).max(128), labelIds: z.array(z.string()).optional() });
const change = z.object({ message: reference, labelIds: z.array(z.string()).optional() });
const historyPage = z.object({ historyId, nextPageToken: z.string().optional(), history: z.array(z.object({ id: historyId,
  messagesAdded: z.array(change).optional(), messagesDeleted: z.array(change).optional(),
  labelsAdded: z.array(change).optional(), labelsRemoved: z.array(change).optional() })).optional() });
type State = { identity: string; cursor?: string; target?: string; renewAt?: number; watchExpiresAt?: number;
  lastPushAt?: number; lastSyncAt?: number; lastError?: string | null; retryAt?: number; recoveryRequired?: boolean };
const later = (a: string | undefined, b: string) => !a || BigInt(b) > BigInt(a) ? b : a;
const statusCode = (e: unknown) => Number((e as { status?: number; response?: { status?: number } })?.status ?? (e as { response?: { status?: number } })?.response?.status);

function googleGateway(config: GmailPushConfig): GmailGateway {
  const oauth = new OAuth2Client({ clientId: config.clientId, clientSecret: config.clientSecret, transporterOptions: { timeout: 10_000, retry: false } });
  oauth.setCredentials({ refresh_token: config.refreshToken });
  return {
    verify: async (idToken, audience) => (await oauth.verifyIdToken({ idToken, audience })).getPayload(),
    request: async (path, body) => {
      try {
        return (await oauth.request({ url: "https://gmail.googleapis.com/gmail/v1/users/me/" + path,
          method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { data: body }), timeout: 15_000, retry: false })).data;
      } catch (e) { throw Object.assign(new Error("Gmail API request failed"), { status: statusCode(e) }); }
    },
  };
}

/** One metadata adapter, using the existing Home database and correspondence writer.
 * Pushes are durable before acknowledgement. Only renewal/recovery reads history without a push. */
export class GmailPush {
  private readonly key: string;
  private readonly identity: string;
  private readonly gateway: GmailGateway;
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = true;
  static fromEnvironment(store: Store, correspondence: Correspondence) {
    const file = process.env.OPENSTRUDEL_GMAIL_PUSH_CONFIG;
    return file ? new GmailPush(store, correspondence, JSON.parse(readFileSync(file, "utf8"))) : undefined;
  }
  constructor(private readonly store: Store, private readonly correspondence: Correspondence, readonly config: GmailPushConfig, gateway?: GmailGateway) {
    this.config = configSchema.parse(config);
    this.key = "gmail.push." + config.sourceId;
    this.identity = createHash("sha256").update(JSON.stringify([config.sourceId, config.mailbox, config.clientId, config.topic, config.subscription, config.pushServiceAccount, config.audience])).digest("hex");
    this.gateway = gateway ?? googleGateway(this.config);
    store.db.exec(`CREATE TABLE IF NOT EXISTS gmail_push_notifications (
      source_id TEXT NOT NULL, message_id TEXT NOT NULL, payload_hash TEXT NOT NULL, history_id TEXT NOT NULL,
      published_at TEXT NOT NULL, received_at INTEGER NOT NULL, processed_at INTEGER, PRIMARY KEY(source_id,message_id));`);
    this.state(); // Fail closed if a different mailbox/config is placed over an existing cursor.
  }
  private state(): State {
    const saved = this.store.getSetting(this.key);
    const value = saved ? JSON.parse(saved) as State : { identity: this.identity };
    if (value.identity !== this.identity) throw new HomeError("Gmail push identity changed; reconcile the existing cursor before reconfiguration.", 409);
    return value;
  }
  private save(update: Partial<State>) { this.store.setSetting(this.key, JSON.stringify({ ...this.state(), ...update })); }
  private source() {
    const source = correspondenceSource(this.store, this.config.sourceId, "Bearer " + this.config.sourceToken);
    if (source.provider !== "gmail" || source.accountId !== this.config.mailbox) throw new HomeError("Unapproved Gmail mailbox.", 403);
    return source;
  }
  status() {
    const { identity, ...state } = this.state();
    const pending = this.store.db.prepare("SELECT COUNT(*) AS count FROM gmail_push_notifications WHERE source_id=? AND processed_at IS NULL").get(this.config.sourceId)!;
    return { enabled: true, mailbox: this.config.mailbox, ...state, recoveryRequired: state.recoveryRequired ?? false, pendingNotifications: Number(pending.count) };
  }
  async receive(authorization: string | undefined, raw: Buffer) {
    this.source();
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) throw new HomeError("Invalid Google push identity.", 401);
    try {
      const claims = await this.gateway.verify(authorization.slice(7), this.config.audience);
      if (claims?.email !== this.config.pushServiceAccount || claims.email_verified !== true) throw new Error("identity");
    } catch { throw new HomeError("Invalid Google push identity.", 401); }
    if (raw.length > 8192) throw new HomeError("Gmail notification is too large.", 413);
    const envelope = z.object({ subscription: z.string(), message: z.object({ messageId: z.string().min(1).max(128),
      publishTime: z.iso.datetime({ offset: true }), data: z.string().min(1).max(4096) }) }).parse(JSON.parse(raw.toString("utf8")));
    if (envelope.subscription !== this.config.subscription) throw new HomeError("Unapproved Google push subscription.", 403);
    const notification = z.object({ emailAddress: z.email(), historyId: notificationHistoryId }).strict().parse(JSON.parse(Buffer.from(envelope.message.data, "base64").toString("utf8")));
    if (notification.emailAddress !== this.config.mailbox) throw new HomeError("Unapproved Gmail mailbox.", 403);
    this.source(); // Authorization may have changed during signature verification.
    const { messageId, publishTime } = envelope.message;
    const digest = createHash("sha256").update(JSON.stringify([notification, publishTime, envelope.subscription])).digest("hex");
    const prior = this.store.db.prepare("SELECT payload_hash FROM gmail_push_notifications WHERE source_id=? AND message_id=?").get(this.config.sourceId, messageId);
    if (prior && prior.payload_hash !== digest) throw new HomeError("Notification identity changed.", 409);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const cursor = this.state().cursor;
      this.store.db.prepare("INSERT OR IGNORE INTO gmail_push_notifications(source_id,message_id,payload_hash,history_id,published_at,received_at,processed_at) VALUES(?,?,?,?,?,?,?)")
        .run(this.config.sourceId, messageId, digest, notification.historyId, publishTime, Date.now(), cursor && BigInt(cursor) >= BigInt(notification.historyId) ? Date.now() : null);
      this.save({ target: later(this.state().target, notification.historyId), lastPushAt: Date.now() });
      this.store.db.exec("COMMIT");
    } catch (e) { this.store.db.exec("ROLLBACK"); throw e; }
    this.wake();
    return { accepted: true, duplicate: !!prior };
  }
  start() { if (!this.stopped) return; this.stopped = false; this.save({ renewAt: 0 }); this.wake(); }
  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; }
  async idle() { await this.active; }
  private wake() {
    if (this.stopped || this.active) return;
    clearTimeout(this.timer);
    const state = this.state(), pending = state.target && (!state.cursor || BigInt(state.target) > BigInt(state.cursor));
    const due = Math.max(state.retryAt ?? 0, pending && !state.recoveryRequired ? Date.now() : state.renewAt ?? 0);
    this.timer = setTimeout(() => { void this.maintain(); }, Math.max(0, due - Date.now())); this.timer.unref();
  }
  async maintain() {
    if (this.active) return this.active;
    this.active = this.cycle().finally(() => { this.active = undefined; this.wake(); });
    return this.active;
  }
  private async cycle() {
    try {
      this.source();
      if ((this.state().renewAt ?? 0) <= Date.now()) await this.renew();
      if (!this.state().recoveryRequired) await this.drain();
      this.save({ retryAt: 0, ...(this.state().recoveryRequired ? {} : { lastError: null }) });
    } catch (e) {
      // Never log provider errors/HTTP objects: they can contain OAuth credentials.
      this.save({ lastError: e instanceof HomeError ? e.message : `Gmail push failed${statusCode(e) ? " (HTTP " + statusCode(e) + ")" : ""}; retained cursor for retry.`, retryAt: Date.now() + 60_000 });
    }
  }
  private async renew() {
    const profile = z.object({ emailAddress: z.email(), historyId: historyId.optional() }).parse(await this.gateway.request("profile"));
    if (profile.emailAddress !== this.config.mailbox) throw new HomeError("Gmail OAuth mailbox does not match configuration.", 403);
    this.source();
    // Establish the starting cursor before watch: changes between these calls are recoverable.
    if (!this.state().cursor && profile.historyId) this.save({ cursor: profile.historyId });
    const watch = z.object({ historyId, expiration: z.string().regex(/^\d+$/) }).parse(await this.gateway.request("watch", { topicName: this.config.topic }));
    this.source();
    const expires = Number(watch.expiration);
    if (expires <= Date.now() + 60_000) throw new Error("Watch expires too soon");
    this.save({ cursor: this.state().cursor ?? watch.historyId, target: later(this.state().target, watch.historyId),
      watchExpiresAt: expires, renewAt: Math.min(Date.now() + 86400000, expires - 3600000) });
  }
  private async drain() {
    const state = this.state();
    if (!state.cursor || !state.target) return;
    if (BigInt(state.target) > BigInt(state.cursor)) {
      let pageToken: string | undefined;
      const seen = new Set<string>();
      do {
        const query = new URLSearchParams({ startHistoryId: state.cursor, maxResults: "500", ...(pageToken ? { pageToken } : {}) });
        let raw: unknown;
        try { raw = await this.gateway.request("history?" + query); }
        catch (e) {
          if (statusCode(e) === 404) { this.save({ recoveryRequired: true, lastError: "Gmail history expired. Cursor retained; explicit mailbox reconciliation required." }); return; }
          throw e;
        }
        const page = historyPage.parse(raw);
        for (const item of page.history ?? []) {
          for (const added of item.messagesAdded ?? []) await this.accept(item.id, "message.new", added.message);
          for (const deleted of item.messagesDeleted ?? []) await this.accept(item.id, "message.deleted", deleted.message);
          for (const changed of [...item.labelsAdded ?? [], ...item.labelsRemoved ?? []])
            if (changed.labelIds?.some(label => ["INBOX", "TRASH", "SPAM"].includes(label))) await this.accept(item.id, "message.updated", changed.message);
        }
        this.source();
        pageToken = page.nextPageToken;
        if (pageToken) { if (seen.has(pageToken)) throw new Error("Repeated history page"); seen.add(pageToken); }
        else {
          if (BigInt(page.historyId) < BigInt(state.target)) throw new Error("History has not caught up with the notification yet");
          this.save({ cursor: later(this.state().cursor, page.historyId), lastSyncAt: Date.now() });
        }
      } while (pageToken);
    }
    const cursor = this.state().cursor!;
    this.store.db.prepare("UPDATE gmail_push_notifications SET processed_at=? WHERE source_id=? AND processed_at IS NULL AND (length(history_id)<length(?) OR (length(history_id)=length(?) AND history_id<=?))")
      .run(Date.now(), this.config.sourceId, cursor, cursor, cursor);
  }
  private async accept(history: string, type: "message.new" | "message.updated" | "message.deleted", ref: z.infer<typeof reference>) {
    if (ref.labelIds?.includes("DRAFT")) return;
    const id = `gmail:${history}:${type}:${ref.id}`;
    const prior = this.store.db.prepare("SELECT payload FROM correspondence_events WHERE source_id=? AND event_id=?").get(this.config.sourceId, id);
    // A successful receipt is already durable even if the process died before the cursor checkpoint.
    if (prior) return;
    if (type === "message.deleted") {
      if (!this.store.db.prepare("SELECT 1 FROM correspondence_events WHERE source_id=? AND json_extract(payload,'$.messageId')=? LIMIT 1").get(this.config.sourceId, ref.id)) return;
    } else {
      let current: z.infer<typeof reference>;
      try { current = reference.parse(await this.gateway.request(`messages/${encodeURIComponent(ref.id)}?format=minimal&fields=id,threadId,labelIds`)); }
      catch (e) { if (statusCode(e) === 404) return; throw e; }
      if (current.id !== ref.id || current.threadId !== ref.threadId) throw new Error("Gmail reference changed");
      if (current.labelIds?.includes("DRAFT")) return;
      if (type === "message.new" && current.labelIds?.some(label => ["TRASH", "SPAM"].includes(label))) return;
    }
    this.correspondence.receive(this.source(), { id, threadId: ref.threadId, messageId: ref.id, type, occurredAt: new Date().toISOString() });
  }
}
