import type { Store } from "./store.js";
import { HomeError } from "./home.js";
import { chatgptSignedIn } from "./account.js";
import { isOpenAIAuthenticationError } from "./account-errors.js";
import { readModelSelection, resolveModelSelection, saveModelSelection, saveConversationModelSelection, type ModelChoice } from "./model-settings.js";

/** Providers reachable with an API key or a vendor subscription. ChatGPT sign-in stays in accounts.ts.
 * Responses-native providers run on Codex; the rest use their documented
 * Anthropic-compatible endpoint through the Claude Agent SDK. The Grok subscription
 * runs xAI's own agent over ACP, which signs in and keeps its token itself. */
export type ProviderEngine = "codex" | "claude" | "acp";

export interface ProviderModel {
  id: string;
  name: string;
  recommended?: boolean;
  contextWindow: number;
  /** False for text-only models: attached images are referenced by path only. */
  images: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  engine: ProviderEngine;
  /** Codex: OpenAI Responses base (`…/v1`). Claude: Anthropic base (`ANTHROPIC_BASE_URL`). */
  baseUrl: string;
  /** The header the vendor documents for Claude Code; a subscription signs in through its own agent. */
  auth: "bearer" | "x-api-key" | "signin";
  keysUrl: string;
  /** Codex's native web search tool is sent only where the provider accepts it. */
  webSearch: boolean;
  /** Empty for `openai`: its catalog is Codex's own `model/list`. A subscription's comes from its agent. */
  models: ProviderModel[];
  /** Extra Claude Code environment the vendor recommends. */
  env?: Record<string, string>;
}

const providers: ProviderInfo[] = [
  { id: "openai", name: "OpenAI API", engine: "codex", baseUrl: "https://api.openai.com/v1", auth: "bearer",
    keysUrl: "https://platform.openai.com/api-keys", webSearch: true, models: [] },
  { id: "anthropic", name: "Anthropic", engine: "claude", baseUrl: "https://api.anthropic.com", auth: "x-api-key",
    keysUrl: "https://platform.claude.com/settings/keys", webSearch: true, models: [
      { id: "claude-fable-5-1", name: "Claude Fable 5.1", recommended: true, contextWindow: 1_000_000, images: true },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", contextWindow: 1_000_000, images: true },
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", contextWindow: 1_000_000, images: true },
      { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", contextWindow: 1_000_000, images: true },
    ] },
  { id: "xai", name: "xAI", engine: "codex", baseUrl: "https://api.x.ai/v1", auth: "bearer",
    keysUrl: "https://console.x.ai", webSearch: false, models: [
      { id: "grok-4.7", name: "Grok 4.7", recommended: true, contextWindow: 500_000, images: true },
      { id: "grok-4.5", name: "Grok 4.5", contextWindow: 500_000, images: true },
    ] },
  { id: "grok", name: "Grok", engine: "acp", baseUrl: "", auth: "signin", keysUrl: "", webSearch: true, models: [] },
  { id: "kimi", name: "Kimi", engine: "claude", baseUrl: "https://api.moonshot.ai/anthropic", auth: "bearer",
    keysUrl: "https://platform.moonshot.ai/console/api-keys", webSearch: false, models: [
      { id: "kimi-k3", name: "Kimi K3", recommended: true, contextWindow: 1_048_576, images: true },
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", contextWindow: 262_144, images: true },
    ] },
  { id: "kimicode", name: "Kimi Code", engine: "claude", baseUrl: "https://api.kimi.ai/coding", auth: "x-api-key",
    keysUrl: "https://www.kimi.com/code/console", webSearch: false, models: [
      { id: "k3-256k", name: "Kimi K3", recommended: true, contextWindow: 262_144, images: true },
      { id: "kimi-for-coding", name: "Kimi K2.8 Preview", contextWindow: 1_048_576, images: true },
    ] },
  // The GLM Coding Plan's documented Claude Code route.
  { id: "zai", name: "GLM Coding Plan", engine: "claude", baseUrl: "https://api.z.ai/api/anthropic", auth: "bearer",
    keysUrl: "https://z.ai/manage-apikey/apikey-list", webSearch: false, env: { API_TIMEOUT_MS: "3000000" }, models: [
      { id: "glm-5.3", name: "GLM-5.3", recommended: true, contextWindow: 1_048_576, images: false },
      { id: "glm-5.3-flash", name: "GLM-5.3 Flash", contextWindow: 1_048_576, images: true },
    ] },
  { id: "deepseek", name: "DeepSeek", engine: "claude", baseUrl: "https://api.deepseek.com/anthropic", auth: "bearer",
    keysUrl: "https://platform.deepseek.com/api_keys", webSearch: false, models: [
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", recommended: true, contextWindow: 1_048_576, images: false },
      { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", contextWindow: 1_048_576, images: true },
    ] },
  { id: "openrouter", name: "OpenRouter", engine: "claude", baseUrl: "https://openrouter.ai/api", auth: "bearer",
    keysUrl: "https://openrouter.ai/settings/keys", webSearch: false, models: [
      { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", recommended: true, contextWindow: 1_000_000, images: true },
      { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", contextWindow: 1_050_000, images: true },
      { id: "google/gemini-4-argon", name: "Gemini 4 Argon", contextWindow: 1_048_576, images: true },
      { id: "x-ai/grok-4.7", name: "Grok 4.7", contextWindow: 500_000, images: true },
      { id: "moonshotai/kimi-k3", name: "Kimi K3", contextWindow: 1_048_576, images: true },
      { id: "z-ai/glm-5.3", name: "GLM-5.3", contextWindow: 1_048_576, images: false },
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1_048_576, images: false },
    ] },
];

/** `OPENSTRUDEL_PROVIDER_<ID>_BASE_URL` points a provider at a regional endpoint, proxy or test server. */
export function providerInfo(id: string): ProviderInfo | undefined {
  const info = providers.find(p => p.id === id);
  const override = info && process.env[`OPENSTRUDEL_PROVIDER_${info.id.toUpperCase()}_BASE_URL`];
  return info && override ? { ...info, baseUrl: override.replace(/\/+$/, "") } : info;
}

export function providerInfos(): ProviderInfo[] {
  return providers.map(p => providerInfo(p.id)!);
}

/** A schedule on a subscription's own agent (Grok) runs in a new session every time: no saved thread, no chat seed, nothing saved back.
 * A resumed session carried the whole chat into every check; the employee's own tools carry what a run needs. */
export const freshSession = (provider: string | null | undefined, scheduled: boolean | undefined): boolean => scheduled === true && providerInfo(provider ?? "")?.engine === "acp";

/** A key route fails every turn until the owner acts, so a Telegram group hears about one `reason` once. */
export class ProviderIncident extends HomeError {
  constructor(message: string, status: number, readonly reason: string) { super(message, status); }
}
/** A key route's authentication failure. Never an OpenAI sign-in problem. */
export class ProviderKeyError extends ProviderIncident {
  constructor(readonly provider: ProviderInfo) { super(`${provider.name} не принял ключ. Замените его в настройках аккаунтов.`, 409, "key:" + provider.id); }
}

export interface ProviderSummary { id: string; name: string; auth: "signin" | "key"; connected: boolean; keyHint: string | null; keysUrl: string | null; usedBy: number }

/** Keys live only in this Home's private settings. They are never returned, logged or exported. */
export const providerKey = (store: Store, id: string): string | null => store.getSetting(`providers.${id}.key`);
/** A subscription's token stays in its agent's own home; this only records that its sign-in completed. */
export const providerConnected = (store: Store, id: string): boolean =>
  providerInfo(id)?.auth === "signin" ? store.getSetting(`providers.${id}.signedIn`) !== null : Boolean(providerKey(store, id));
/** A subscription's catalog, as its agent last reported it. */
export const subscriptionModels = (store: Store, id: string): ModelChoice[] => JSON.parse(store.getSetting(`providers.${id}.models`) ?? "[]");
/** Connection order. A key saved before it was recorded counts as earliest. */
export const providerConnectedAt = (store: Store, id: string) => Number(store.getSetting(`providers.${id}.connectedAt`) ?? 0);
/** Codex reserves built-in ids such as `openai`; a thread-scoped provider must not collide with them. */
export const codexProviderId = (id: string) => "openstrudel-" + id;
export const providerNotConnected = (id: string) => new ProviderIncident(`Подключите ${providerInfo(id)?.name ?? id} на этом устройстве или выберите другую модель.`, 409, "missing:" + id);

export function providerModels(info: ProviderInfo): ModelChoice[] {
  return info.models.map(m => ({ id: m.id, name: m.name, description: "", isDefault: m.recommended === true,
    speeds: [{ id: "default", name: "Обычная", description: "" }], provider: info.id }));
}

/** ChatGPT first, then every registry provider. `usedBy` counts the agents whose selection resolves to it. */
export function providerSummaries(store: Store): ProviderSummary[] {
  const used = [undefined, "main", ...store.listProfiles().map(p => p.id)].map(agent => resolveModelSelection(store, agent).provider);
  used.push(...store.listConversations().filter(c => c.modelSelection?.model).map(c => c.modelSelection!.provider));
  const usedBy = (id: string) => used.filter(provider => provider === id).length;
  return [{ id: "chatgpt", name: "ChatGPT", auth: "signin", connected: chatgptSignedIn(store), keyHint: null, keysUrl: null, usedBy: usedBy("chatgpt") },
    ...providerInfos().map(p => {
      if (p.auth === "signin") return { id: p.id, name: p.name, auth: "signin" as const, connected: providerConnected(store, p.id), keyHint: null, keysUrl: null, usedBy: usedBy(p.id) };
      const key = providerKey(store, p.id);
      return { id: p.id, name: p.name, auth: "key" as const, connected: Boolean(key), keyHint: key ? "••••" + key.slice(-3) : null, keysUrl: p.keysUrl, usedBy: usedBy(p.id) };
    })];
}

/** A key is saved only after the provider accepts it. Kimi Code answers any client but a coding agent
 * with 403 "only available for Coding Agents", so its key is saved unchecked and its first turn reports a rejected key. */
export async function connectProvider(store: Store, id: string, value: unknown): Promise<ProviderSummary> {
  const info = providerInfo(id);
  if (!info || info.auth === "signin") throw new HomeError("Провайдер не найден.", 404);
  const key = typeof value === "string" ? value.trim() : "";
  if (!key || key.length > 4096 || /\s/.test(key)) throw new HomeError("Вставьте ключ.");
  if (id !== "kimicode") await checkKey(info, key);
  const previous = providerKey(store, id), first = !providerInfos().some(p => providerConnected(store, p.id));
  store.setSetting(`providers.${id}.key`, key);
  if (previous && previous !== key) forgetThreads(store, id);
  if (!previous) markConnected(store, id);
  // The first key fixes the automatic device default, so no later key or sign-in changes an agent's model.
  const recommended = info.models.find(m => m.recommended);
  if (first && recommended && !chatgptSignedIn(store) && !readModelSelection(store).model) saveModelSelection(store, { provider: id, model: recommended.id, serviceTier: "default" });
  return providerSummaries(store).find(p => p.id === id)!;
}

/** Records the connection order, which decides Automatic. */
export function markConnected(store: Store, id: string) {
  store.setSetting(`providers.${id}.connectedAt`, String(Math.max(Date.now(), ...providerInfos().map(p => providerConnectedAt(store, p.id) + 1))));
}

async function checkKey(info: ProviderInfo, key: string) {
  const auth: Record<string, string> = info.auth === "x-api-key" ? { "x-api-key": key } : { authorization: "Bearer " + key };
  let response: Response;
  try {
    response = await fetch(info.baseUrl + (info.engine === "codex" ? "/models" : "/v1/messages"), info.engine === "codex" ? { headers: auth, signal: AbortSignal.timeout(10_000) } : {
      method: "POST", headers: { ...auth, "anthropic-version": "2023-06-01", "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ model: info.models.find(m => m.recommended)!.id, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    });
  } catch { throw new HomeError(`Не удалось связаться с ${info.name}. Проверьте подключение к интернету и попробуйте ещё раз.`, 502); }
  if (response.status === 401 || response.status === 403) throw new HomeError(`${info.name} не принял ключ. Проверьте его и вставьте снова.`);
  if (!response.ok) {
    const body: any = await response.json().catch(() => null);
    const detail = String(body?.error?.message ?? body?.message ?? response.statusText).replace(/\s+/g, " ").slice(0, 200);
    throw new HomeError(`${info.name} не подтвердил ключ: ${response.status} ${detail}`.trim(), response.status >= 500 ? 502 : 400);
  }
}

/** Another key may belong to another organization, which cannot resume threads holding this one's encrypted reasoning. */
function forgetThreads(store: Store, id: string) {
  const route = "provider-" + id;
  store.db.prepare("DELETE FROM settings WHERE key LIKE ? OR key LIKE ?").run(`codex.thread.${route}.%`, `codex.threadCheckpoint.${route}.%`);
  for (const conversation of store.listConversations()) if (store.getSetting("codex.threadOwner." + conversation.id) === route) {
    store.setConversationThread(conversation.id, null);
    store.deleteSetting("codex.threadOwner." + conversation.id);
  }
}

/** Employees on the provider return to the device default; a device or main-chat default returns to automatic. */
export function disconnectProvider(store: Store, id: string): number {
  if (!providerInfo(id)) throw new HomeError("Провайдер не найден.", 404);
  let reset = Number(store.db.prepare("UPDATE employee_profiles SET provider=NULL,model=NULL,service_tier=NULL,reasoning_effort=NULL WHERE provider=?").run(id).changes);
  for (const conversation of store.listConversations()) if (conversation.modelSelection?.provider === id) {
    saveConversationModelSelection(store,conversation.id,{provider:null,model:null,serviceTier:null}); reset++;
  }
  for (const agent of [undefined, "main"]) if (readModelSelection(store, agent).provider === id) { saveModelSelection(store, { provider: null, model: null, serviceTier: agent ? null : "default" }, agent); reset++; }
  for (const name of ["key", "connectedAt", "signedIn", "models"]) store.deleteSetting(`providers.${id}.${name}`);
  const reserves = JSON.parse(store.getSetting("models.fallbacks") ?? "[]");
  if (reserves.some((m: {provider:string})=>m.provider===id)) store.setSetting("models.fallbacks",JSON.stringify(reserves.filter((m: {provider:string})=>m.provider!==id)));
  forgetThreads(store, id);
  return reset;
}

/** Kimi Code refuses an exhausted plan with 403: one that names a quota or limit is not a rejected key. */
export const exhaustedPlan = (text: string) => /\b403\b/.test(text) && /quota|limit/i.test(text);

/** A key route's failure names its provider. It never invalidates a ChatGPT account.
 * A subscription has no key to reject: its engine reports a lost sign-in itself. */
export function providerFailure(info: ProviderInfo, error: unknown): unknown {
  if (error instanceof HomeError) return error;
  const message = error instanceof Error ? error.message : String(error), subscription = info.auth === "signin";
  const limits = new ProviderIncident(subscription ? `Лимит подписки ${info.name} исчерпан. Повторите позже или выберите другую модель.`
    : `У ключа ${info.name} закончился лимит или баланс. Проверьте оплату у провайдера или повторите позже.`, 429, "limits:" + info.id);
  // The agent's own HTTP status decides before its words, which may quote a tool or a page (Grok keeps it in the request's data).
  const status = error instanceof Error ? (error.cause as { data?: { http_status?: unknown } } | undefined)?.data?.http_status : undefined;
  if (typeof status === "number") return status === 402 || status === 429 ? limits : error;
  if (exhaustedPlan(message)) return limits;
  if (!subscription && (isOpenAIAuthenticationError(error) || /\b40[13]\b|forbidden|authentication|invalid.{0,20}(?:api.?key|token)/i.test(message))) return new ProviderKeyError(info);
  if (/\b4(?:02|29)\b|rate.?limit|quota|insufficient|billing|credit|balance|usage limit|too many requests/i.test(message)) return limits;
  return error;
}
