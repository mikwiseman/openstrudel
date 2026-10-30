import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import type { MessageInput } from "./types.js";
import { HomeError } from "./home.js";

export const authorizationSetting = "authorization.telegram.v1";
export interface ScopedConnector { url: string; headers: Record<string, string> }
export interface ScopedTool { name: string; capability: string }
export interface ScopedPolicy { connectorId: string; tools: ScopedTool[] }
export interface ScopedSubject { enabled: boolean; capabilities: string[]; privatePolicyId: string }
export interface ScopedChat { enabled: boolean; policyId: string; defaultCapabilities: string[]; members: Record<string, string[]> }
export interface TelegramAuthorization {
  version: 1; revision: number;
  connectors: Record<string, ScopedConnector>;
  policies: Record<string, ScopedPolicy>;
  subjects: Record<string, ScopedSubject>;
  chats: Record<string, ScopedChat>;
}
export interface ScopedAuthorization {
  fingerprint: string;
  actor: { userId: string; chatId: string; messageId: string };
  connector: ScopedConnector;
  tools: ScopedTool[];
}
const empty = (): TelegramAuthorization => ({ version: 1, revision: 0, connectors: {}, policies: {}, subjects: {}, chats: {} });
const name = /^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/;
const user = /^[1-9][0-9]{0,19}$/;
const group = /^-[1-9][0-9]{0,19}$/;
const denied = () => new HomeError("Для этого участника или чата действие недоступно.", 403);
const invalid = () => new HomeError("Проверьте конфигурацию ограниченного доступа.", 400);
const record = (x: unknown): x is Record<string, any> => Boolean(x && typeof x === "object" && !Array.isArray(x));
const capabilities = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 100 && x.every(v => typeof v === "string" && name.test(v)) && new Set(x).size === x.length;

/** Server-owned configuration. Missing means legacy; malformed must never mean legacy. */
export function telegramAuthorization(store: Store): TelegramAuthorization {
  const saved = store.getSetting(authorizationSetting);
  if (!saved) return empty();
  try { return validateTelegramAuthorization(JSON.parse(saved)); } catch { throw denied(); }
}

export function validateTelegramAuthorization(value: unknown): TelegramAuthorization {
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) throw invalid();
  if (![value.connectors, value.policies, value.subjects, value.chats].every(record)) throw invalid();
  for (const collection of [value.connectors, value.policies, value.subjects, value.chats]) if (Object.keys(collection).length > 1000) throw invalid();
  for (const [id, c] of Object.entries(value.connectors) as Array<[string, any]>) {
    if (!name.test(id) || !record(c) || typeof c.url !== "string" || !record(c.headers)) throw invalid();
    let url: URL; try { url = new URL(c.url); } catch { throw invalid(); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw invalid();
    if (Object.entries(c.headers).some(([key, val]) => !/^[a-zA-Z0-9-]+$/.test(key) || /^x-hermes-|^host$|^content-length$|^connection$/i.test(key) || typeof val !== "string" || /[\r\n]/.test(val))) throw invalid();
  }
  for (const [id, p] of Object.entries(value.policies) as Array<[string, any]>) {
    if (!name.test(id) || !record(p) || !Object.hasOwn(value.connectors, p.connectorId) || !Array.isArray(p.tools) || p.tools.length > 100) throw invalid();
    if (p.tools.some((t: any) => !record(t) || !name.test(t.name) || !name.test(t.capability)) || new Set(p.tools.map((t: ScopedTool) => t.name)).size !== p.tools.length) throw invalid();
  }
  for (const [id, s] of Object.entries(value.subjects) as Array<[string, any]>) {
    if (!user.test(id) || !record(s) || typeof s.enabled !== "boolean" || !capabilities(s.capabilities) || !Object.hasOwn(value.policies, s.privatePolicyId)) throw invalid();
  }
  for (const [id, c] of Object.entries(value.chats) as Array<[string, any]>) {
    if (!group.test(id) || !record(c) || typeof c.enabled !== "boolean" || !Object.hasOwn(value.policies, c.policyId) || !capabilities(c.defaultCapabilities) || !record(c.members)) throw invalid();
    if (Object.entries(c.members).some(([member, caps]) => !user.test(member) || !capabilities(caps))) throw invalid();
  }
  return structuredClone(value) as TelegramAuthorization;
}

/** Removing a restriction must not silently restore legacy owner privileges. */
export function saveTelegramAuthorization(store: Store, input: unknown): TelegramAuthorization {
  const current = telegramAuthorization(store);
  const next = validateTelegramAuthorization(input);
  if (next.revision !== current.revision) throw new HomeError("Права уже изменились. Обновите конфигурацию.", 409);
  for (const id of Object.keys(current.subjects)) if (!Object.hasOwn(next.subjects, id)) throw new HomeError("Отозванного участника сохраните с enabled:false.", 400);
  for (const id of Object.keys(current.chats)) if (!Object.hasOwn(next.chats, id)) throw new HomeError("Отозванный чат сохраните с enabled:false.", 400);
  next.revision++;
  // Commit the policy and its legacy deny transport together. Old Homes ignore
  // the policy, but still reject approved chats with no allowed senders.
  store.db.exec("SAVEPOINT scoped_telegram_authorization");
  try {
    store.setSetting(authorizationSetting, JSON.stringify(next));
    for (const id of [...Object.keys(next.subjects), ...Object.keys(next.chats)]) {
      if (!store.getTelegramChat(id)) store.linkTelegramChat({ chatId: id, title: `Telegram ${id}`, allowedSenders: [] });
      protectScopedTelegramTransport(store, id);
      if (Object.hasOwn(next.chats, id)) store.connectTelegramGroup(id);
    }
    store.db.exec("RELEASE scoped_telegram_authorization");
  } catch (error) {
    store.db.exec("ROLLBACK TO scoped_telegram_authorization; RELEASE scoped_telegram_authorization");
    throw error;
  }
  return next;
}

/** Keep older runtimes' admission predicate closed, including revoked records.
 * Call before ordinary discovery/link/bind writes that could restore grants. */
export function protectScopedTelegramTransport(store: Store, chatId: string): boolean {
  const config = telegramAuthorization(store);
  if (!Object.hasOwn(config.subjects, chatId) && !Object.hasOwn(config.chats, chatId)) return false;
  // A protected group answers only an explicit mention or a reply to the bot.
  store.db.prepare("UPDATE telegram_chats SET allowed_senders_json='[]',access='approved',replies=CASE WHEN chat_id LIKE '-%' THEN 'mentions' ELSE replies END WHERE chat_id=?").run(chatId);
  return true;
}

export function isRestrictedSubject(store: Store, userId?: string): boolean {
  return Boolean(userId && Object.hasOwn(telegramAuthorization(store).subjects, userId));
}
export function isRestrictedChat(store: Store, chatId?: string): boolean {
  return Boolean(chatId && Object.hasOwn(telegramAuthorization(store).chats, chatId));
}
/** A protected group or a limited participant's private chat, enabled or not. */
export function isProtectedTelegramAudience(store: Store, chatId?: string | number): boolean {
  const id = chatId === undefined ? undefined : String(chatId);
  return isRestrictedChat(store, id) || isRestrictedSubject(store, id);
}

export function assertNativeAccess(store: Store, conversationId: string, userId?: string): void {
  const conversation = store.getConversation(conversationId);
  const chatId = store.telegramChats().find(c => c.conversationId === conversationId)?.chatId
    ?? (conversation?.channel === "telegram" ? conversation.externalId?.split("::")[0] : undefined);
  if (isRestrictedSubject(store, userId) || isRestrictedSubject(store, chatId) || isRestrictedChat(store, chatId)) throw denied();
}

/** Returns true when the protected policy and registry migration were handled
 * together. A missing old registry row must still close a discovered target. */
export function migrateScopedChat(store: Store, oldId: string, newId: string): boolean {
  if (!/^-[1-9]\d*$/.test(oldId) || !/^-[1-9]\d*$/.test(newId) || oldId === newId) return false;
  const config = telegramAuthorization(store);
  const previous = config.chats[oldId];
  if (!previous) return false;
  // The business service must bind the new address before it can be enabled.
  config.chats[oldId] = { ...previous, enabled: false };
  config.chats[newId] = { ...previous, enabled: false };
  config.revision++;
  store.db.exec("SAVEPOINT scoped_telegram_migration");
  try {
    store.setSetting(authorizationSetting, JSON.stringify(config));
    protectScopedTelegramTransport(store, oldId);
    protectScopedTelegramTransport(store, newId);
    store.migrateTelegramGroup(oldId, newId);
    store.db.exec("RELEASE scoped_telegram_migration");
  } catch (error) {
    store.db.exec("ROLLBACK TO scoped_telegram_migration; RELEASE scoped_telegram_migration");
    throw error;
  }
  return true;
}

/** Authenticated Telegram metadata only. A protected audience cannot be entered through the app or scheduler. */
export function resolveScopedAuthorization(store: Store, input: MessageInput): ScopedAuthorization | null {
  const config = telegramAuthorization(store);
  const conversation = input.conversationId ? store.getConversation(input.conversationId) : null;
  const bound = conversation ? store.telegramChats().find(c => c.conversationId === conversation.id) : undefined;
  const storedChat = bound?.chatId ?? (conversation?.channel === "telegram" ? conversation.externalId?.split("::")[0] : undefined);
  const chatId = input.externalChatId ?? input.scheduleTelegramChatId ?? storedChat;
  const subject = input.telegramSenderId ? config.subjects[input.telegramSenderId] : undefined;
  const chat = chatId ? config.chats[chatId] : undefined;
  // A private conversation of a limited subject is protected even without actor metadata.
  const privateSubject = chatId && user.test(chatId) ? config.subjects[chatId] : undefined;
  const protectedStored = storedChat && (config.chats[storedChat] || config.subjects[storedChat]);
  // A Telegram message id names its chat. No other client may claim a protected
  // chat's numbering, its replay slot or its approval cards.
  const claimedChat = input.externalId?.split(":")[0];
  const protectedClaim = claimedChat && (Object.hasOwn(config.chats, claimedChat) || Object.hasOwn(config.subjects, claimedChat));
  if (!subject && !chat && !privateSubject && !protectedStored && !protectedClaim) return null;
  if (input.channel !== "telegram" || input.scheduled || !input.telegramSenderId || !user.test(input.telegramSenderId) || !chatId || !input.externalId) throw denied();
  if (storedChat && storedChat !== chatId) throw denied();
  if (!new RegExp(`^${chatId}:[1-9][0-9]*$`).test(input.externalId)) throw denied();
  if (subject?.enabled === false || chat?.enabled === false || privateSubject?.enabled === false) throw denied();
  let policy: ScopedPolicy | undefined;
  let allowed: string[];
  if (user.test(chatId)) {
    if (chatId !== input.telegramSenderId || !subject) throw denied();
    policy = config.policies[subject.privatePolicyId]; allowed = subject.capabilities;
  } else {
    // Restricted subjects must never inherit an unconfigured group's corporate tools or private report tools.
    if (!chat) throw denied();
    policy = config.policies[chat.policyId];
    allowed = chat.members[input.telegramSenderId] ?? chat.defaultCapabilities;
    if (subject) allowed = allowed.filter(capability => subject.capabilities.includes(capability));
  }
  if (!policy) throw denied();
  const connector = config.connectors[policy.connectorId];
  if (!connector) throw denied();
  const tools = policy.tools.filter(tool => allowed.includes(tool.capability));
  const fingerprint = createHash("sha256").update(JSON.stringify([config.revision, input.telegramSenderId, chatId, connector, tools])).digest("hex");
  return { fingerprint, actor: { userId: input.telegramSenderId, chatId, messageId: input.externalId }, connector, tools };
}

export function assertScopedAuthorization(store: Store, input: MessageInput, expected: ScopedAuthorization): void {
  const current = resolveScopedAuthorization(store, input);
  if (!current || current.fingerprint !== expected.fingerprint) throw denied();
}

/** GET redacts credentials, so a PUT may omit headers for an unchanged connector.
 * A new address never inherits the old address's credentials. */
export function preserveConnectorHeaders(current: TelegramAuthorization, body: unknown): void {
  if (!record(body) || !record(body.connectors)) return;
  for (const [id, value] of Object.entries(body.connectors)) {
    if (!record(value) || "headers" in value || !Object.hasOwn(current.connectors, id)) continue;
    if (value.url !== current.connectors[id]!.url) throw new HomeError("Для нового адреса подключения укажите headers.", 400);
    value.headers = current.connectors[id]!.headers;
  }
}

/** Revocation must stay possible while participants keep the Home busy: a change
 * that only switches existing subjects or chats off may be saved during turns. */
export function onlyDisablesScopedAccess(current: TelegramAuthorization, body: unknown): boolean {
  let next: TelegramAuthorization;
  try { next = validateTelegramAuthorization(body); } catch { return false; }
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => record(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
  const connectors = (config: TelegramAuthorization) => Object.fromEntries(Object.entries(config.connectors).map(([id, c]) => [id, { url: c.url, headers: c.headers }]));
  const policies = (config: TelegramAuthorization) => Object.fromEntries(Object.entries(config.policies).map(([id, p]) => [id, { connectorId: p.connectorId, tools: p.tools.map(t => ({ name: t.name, capability: t.capability })) }]));
  if (next.revision !== current.revision || canonical(connectors(next)) !== canonical(connectors(current)) || canonical(policies(next)) !== canonical(policies(current))) return false;
  const sameKeys = (a: Record<string, unknown>, b: Record<string, unknown>) => canonical(Object.keys(a).sort()) === canonical(Object.keys(b).sort());
  if (!sameKeys(next.subjects, current.subjects) || !sameKeys(next.chats, current.chats)) return false;
  const narrowed = (before: { enabled: boolean }, after: { enabled: boolean }) => after.enabled === before.enabled || before.enabled && !after.enabled;
  for (const [id, before] of Object.entries(current.subjects)) {
    const after = next.subjects[id]!;
    if (!narrowed(before, after) || canonical({ capabilities: after.capabilities, privatePolicyId: after.privatePolicyId }) !== canonical({ capabilities: before.capabilities, privatePolicyId: before.privatePolicyId })) return false;
  }
  for (const [id, before] of Object.entries(current.chats)) {
    const after = next.chats[id]!;
    if (!narrowed(before, after) || canonical({ policyId: after.policyId, defaultCapabilities: after.defaultCapabilities, members: after.members }) !== canonical({ policyId: before.policyId, defaultCapabilities: before.defaultCapabilities, members: before.members })) return false;
  }
  return true;
}

/** Public management reads omit transport credentials entirely. */
export function authorizationSummary(config: TelegramAuthorization) {
  return { ...config, connectors: Object.fromEntries(Object.entries(config.connectors).map(([id, c]) => [id, { url: c.url, configured: true }])) };
}
