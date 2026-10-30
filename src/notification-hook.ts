import { createHash, timingSafeEqual } from "node:crypto";
import { digest, HomeError } from "./home.js";
import { isEnabledScopedGroup, isProtectedTelegramAudience } from "./authorization.js";
import type { Store } from "./store.js";
import { telegramText } from "./telegram-format.js";
import type { TelegramAdapter } from "./telegram.js";

/** The original credential relays to every chat it lists; a narrow key relays to one chat of its own list per request. */
export type NotificationCaller =
  | { kind: "legacy"; chatIds: string[] }
  | { kind: "key"; id: string; chatIds: string[]; maxPerHour: number };

// The original credential keeps its own chat check; a key's chats are canonical Telegram ids.
const chatId = /^-?\d+$/, keyChat = /^-?[1-9]\d{0,19}$/, tokenHash = /^[a-f0-9]{64}$/, keyId = /^[a-z][a-z0-9-]{0,39}$/;
const unauthorized = () => new HomeError("unauthorized", 401);
const chats = (value: unknown, max: number, pattern = chatId): value is string[] => Array.isArray(value) && value.length >= 1 && value.length <= max
  && new Set(value).size === value.length && value.every(id => typeof id === "string" && pattern.test(id));

function hookSettings(store: Store): Record<string, unknown> {
  try {
    const value = JSON.parse(store.getSetting("telegram.notification_hook") ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** Malformed or ambiguous keys never authorize anything, and they leave the original credential as it was. */
function narrowKeys(settings: Record<string, unknown>): Array<{ id: string; tokenHash: string; chatIds: string[]; maxPerHour: number }> {
  const keys = settings.keys;
  if (!Array.isArray(keys) || !keys.length || keys.length > 20) return [];
  const valid = keys.filter((key): key is { id: string; tokenHash: string; chatIds: string[]; maxPerHour?: number } => Boolean(key) && typeof key === "object"
    // "legacy" names the original credential in the journal.
    && typeof key.id === "string" && keyId.test(key.id) && key.id !== "legacy" && typeof key.tokenHash === "string" && tokenHash.test(key.tokenHash) && chats(key.chatIds, 50, keyChat)
    && (key.maxPerHour === undefined || Number.isSafeInteger(key.maxPerHour) && key.maxPerHour >= 1 && key.maxPerHour <= 1000));
  const hashes = new Set(valid.map(key => key.tokenHash));
  if (valid.length !== keys.length || new Set(valid.map(key => key.id)).size !== valid.length || hashes.size !== valid.length || hashes.has(String(settings.tokenHash))) return [];
  return valid.map(key => ({ id: key.id, tokenHash: key.tokenHash, chatIds: key.chatIds, maxPerHour: key.maxPerHour ?? 30 }));
}

/** This credential can only relay text to its preconfigured, connected chats. */
export function notificationCaller(store: Store, authorization?: string): NotificationCaller {
  const settings = hookSettings(store);
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) throw unauthorized();
  const presented = Buffer.from(digest(token), "hex");
  const matches = (hash: unknown) => typeof hash === "string" && tokenHash.test(hash) && timingSafeEqual(presented, Buffer.from(hash, "hex"));
  const key = narrowKeys(settings).find(candidate => matches(candidate.tokenHash));
  if (key) return { kind: "key", id: key.id, chatIds: key.chatIds, maxPerHour: key.maxPerHour };
  const chatIds = settings.chatIds ?? [settings.chatId];
  if (!chats(chatIds, 10) || !matches(settings.tokenHash)) throw unauthorized();
  return { kind: "legacy", chatIds };
}

const UNCONFIRMED = "Доставка не подтверждена; проверьте Telegram перед новой отправкой.";
type Receipt = { sent: boolean; status: string; chatId: string; messageId?: string; telegramMessageIds?: string[]; error?: string };

/** One row per delivery identity: who sent what to which chat, and what Telegram confirmed. Text is kept only as its hash. */
function journal(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS notification_deliveries (
    external_id TEXT PRIMARY KEY, caller TEXT NOT NULL, chat_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, text_sha256 TEXT NOT NULL,
    status TEXT NOT NULL, message_id TEXT, telegram_message_ids TEXT NOT NULL DEFAULT '[]', error TEXT,
    attempts INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS notification_deliveries_caller_idx ON notification_deliveries(caller, created_at);`);
  return {
    known: (externalId: string) => Boolean(store.db.prepare("SELECT 1 FROM notification_deliveries WHERE external_id=?").get(externalId)),
    recent: (caller: string) => Number(store.db.prepare("SELECT count(*) AS n FROM notification_deliveries WHERE caller=? AND created_at>?")
      .get(caller, new Date(Date.now() - 3_600_000).toISOString())?.n ?? 0),
    attempt(caller: string, delivery: { chatId: string; externalId: string; text: string }, key: string) {
      const now = new Date().toISOString();
      store.db.prepare(`INSERT INTO notification_deliveries(external_id,caller,chat_id,idempotency_key,text_sha256,status,created_at,updated_at)
        VALUES(?,?,?,?,?,'sending',?,?) ON CONFLICT(external_id) DO UPDATE SET attempts=attempts+1, updated_at=excluded.updated_at`)
        .run(delivery.externalId, caller, delivery.chatId, key, createHash("sha256").update(delivery.text).digest("hex"), now, now);
    },
    result(externalId: string, receipt: Receipt) {
      store.db.prepare("UPDATE notification_deliveries SET status=?, message_id=?, telegram_message_ids=?, error=?, updated_at=? WHERE external_id=?")
        .run(receipt.status, receipt.messageId ?? null, JSON.stringify(receipt.telegramMessageIds ?? []), receipt.error ?? null, new Date().toISOString(), externalId);
    },
  };
}

function identity(key: string | string[] | undefined, body: Record<string, unknown>): { key: string; text: string } {
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new HomeError("Укажите Idempotency-Key.", 400);
  if (typeof body.text !== "string" || !body.text.trim()) throw new HomeError("Нужен текст сообщения.", 400);
  return { key, text: body.text.trim() };
}

/** Answers 200 only when every chat confirmed delivery, because the sender treats any other answer as a failure. */
export async function receiveNotification(store: Store, telegram: TelegramAdapter, chatIds: string[], key: string | string[] | undefined, body: Record<string, unknown>): Promise<[number, object]> {
  const { key: idempotencyKey, text } = identity(key, body);
  // Each chat keeps its own identity, so repeating the request never sends to the same chat twice.
  const deliveries = chatIds.map(chatId => ({ chatId, text, files: [], externalId: "notification:" + digest(chatId + "\0" + idempotencyKey) }));
  if (deliveries.some(({ externalId }) => (store.findMessageByExternal("telegram", externalId)?.text ?? text) !== text)) throw new HomeError("Содержимое уведомления изменилось.", 409);
  // Nothing is sent unless every chat can receive it.
  for (const { chatId, externalId } of deliveries) telegram.deliveryTarget(chatId, externalId);
  // The original credential keeps working even if its journal cannot be written.
  let log: ReturnType<typeof journal> | undefined;
  try { log = journal(store); } catch {}
  const receipts: Receipt[] = [];
  for (const delivery of deliveries) {
    try { log?.attempt("legacy", delivery, idempotencyKey); } catch {}
    try { receipts.push(await telegram.sendToChat(delivery)); } catch (error) {
      // A chat can stop being available while an earlier chat is sent. The earlier chat already has the text, so report both.
      const failed = { sent: false, status: "not_sent", chatId: delivery.chatId, error: error instanceof Error ? error.message : String(error) };
      try { log?.result(delivery.externalId, failed); } catch {}
      if (!receipts.length) throw error;
      receipts.push(failed);
      continue;
    }
    try { log?.result(delivery.externalId, receipts.at(-1)!); } catch {}
  }
  if (receipts.length === 1) return receipts[0]!.sent ? [200, receipts[0]!] : [502, { error: UNCONFIRMED }];
  const sent = receipts.every(r => r.sent), statuses = receipts.map(r => r.status);
  const status = sent ? "delivered" : ["unknown", "pending"].find(state => statuses.includes(state)) ?? (statuses.every(state => state === "not_sent") ? "not_sent" : "partial");
  const receipt = { sent, status, chatId: chatIds[0], deliveries: receipts };
  // With several chats, a failure still says which chats were reached.
  return sent ? [200, receipt] : [502, { error: UNCONFIRMED, ...receipt }];
}

/** A narrow key relays approved text to one chat of its own list. A protected group must be enabled in the access policy, and nothing runs a model. */
export async function receiveKeyedNotification(store: Store, telegram: TelegramAdapter, caller: Extract<NotificationCaller, { kind: "key" }>, key: string | string[] | undefined, body: Record<string, unknown>): Promise<[number, object]> {
  const { key: idempotencyKey, text } = identity(key, body);
  const target = body.chatId ?? (caller.chatIds.length === 1 ? caller.chatIds[0] : undefined);
  if (typeof target !== "string" || !keyChat.test(target)) throw new HomeError("Укажите chatId одного из чатов этого ключа.", 400);
  if (!caller.chatIds.includes(target)) throw new HomeError("Этот ключ не отправляет в этот чат.", 403);
  for (const option of ["linkPreview", "silent"] as const) if (body[option] !== undefined && typeof body[option] !== "boolean") throw new HomeError(`${option} — true или false.`, 400);
  // One request is one Telegram message, so the hourly cap counts what a chat actually receives.
  if (telegramText(text).length !== 1) throw new HomeError("Текст ключа — одно сообщение Telegram, до 4096 знаков.", 400);
  // The caller's name is part of the identity: another key never reuses or blocks this delivery.
  const delivery = { chatId: target, text, files: [], externalId: "notification:" + digest(caller.id + "\0" + target + "\0" + idempotencyKey),
    scopedGroup: true, ...(body.linkPreview === true ? { linkPreview: true } : {}), ...(body.silent === true ? { silent: true } : {}) };
  if ((store.findMessageByExternal("telegram", delivery.externalId)?.text ?? text) !== text) throw new HomeError("Содержимое уведомления изменилось.", 409);
  if (isProtectedTelegramAudience(store, target) && !isEnabledScopedGroup(store, target)) throw new HomeError("Этот чат сейчас закрыт для отправки.", 403);
  telegram.deliveryTarget(target, delivery.externalId, { scopedGroup: true });
  const log = journal(store);
  // A leaked key can repeat its earlier deliveries, but cannot flood its chats with new ones.
  if (!log.known(delivery.externalId) && log.recent(caller.id) >= caller.maxPerHour) throw new HomeError("Слишком много отправок по этому ключу. Повторите позже.", 429);
  log.attempt(caller.id, delivery, idempotencyKey);
  let receipt: Receipt;
  try { receipt = await telegram.sendToChat(delivery); } catch (error) {
    log.result(delivery.externalId, { sent: false, status: "not_sent", chatId: target, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  log.result(delivery.externalId, receipt);
  // The receipt says whether Telegram refused it (not_sent) or the text may have arrived (unknown, pending), so the
  // sender never resends what a family may already have.
  return receipt.sent ? [200, receipt] : [502, { ...receipt, error: UNCONFIRMED }];
}
