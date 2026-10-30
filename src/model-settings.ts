import type { Store } from './store.js';
import { HomeError } from './home.js';
import { chatgptSignedIn } from './account.js';
import { providerConnected, providerConnectedAt, providerInfo, providerInfos, providerModels, providerNotConnected, subscriptionModels } from './providers.js';

/** `provider` is null only with a null model: as on the device, or automatic for the device itself. */
export type ModelSelection = { provider: string | null; model: string | null; serviceTier: string | null; reasoningEffort?: string | null };
export type ReasoningChoice = { id: string; name: string; description: string };
export type ModelChoice = { id: string; name: string; description: string; isDefault: boolean; defaultReasoningEffort?: string; reasoningEfforts?: ReasoningChoice[]; speeds: Array<{ id: string; name: string; description: string }>; provider?: string };
const defaultsKey = 'models.defaults';

/** The device's ordered reserves. A fixed employee or chat model opts out. */
export const readModelFallbacks = (store: Store): ModelSelection[] => JSON.parse(store.getSetting('models.fallbacks') ?? '[]');
export function followsDeviceModel(store: Store, agent?: string, conversationId?: string): boolean {
  return !(conversationId && readConversationModelSelection(store,conversationId).model) && !(agent && readModelSelection(store,agent).model);
}
/** On unless the owner turns it off. */
export const directFast = (store: Store): boolean => store.getSetting('models.directFast') !== 'false';
/** A direct chat on the device's model asks for Fast. Groups and a chosen chat or employee model keep their speed; schedules are the caller's. */
export const fastChat = (store: Store, agent: string, conversationId: string, groupContext: boolean): boolean =>
  !groupContext && directFast(store) && followsDeviceModel(store, agent, conversationId);
/** Fast replaces only the ordinary speed, and only where the model offers it. */
export const turnSpeed = (offersFast: boolean, serviceTier?: string | null): string =>
  offersFast && (serviceTier ?? 'default') === 'default' ? 'priority' : serviceTier ?? 'default';
export const offersFast = (model?: ModelChoice): boolean => model?.speeds.some(s => s.id === 'priority') === true;
export function parseModelFallbacks(value: unknown, primary: ModelSelection, store: Store, models: ModelChoice[]): ModelSelection[] {
  if (!Array.isArray(value) || value.length > 12) throw new HomeError('Выберите резервные модели.');
  const seen = new Set([JSON.stringify([primary.provider,primary.model])]);
  return value.map(item => {
    if (!item || typeof item !== 'object' || !item.model) throw new HomeError('Выберите резервную модель.');
    const selection = parseModelSelection(item,false), ref = JSON.stringify([selection.provider,selection.model]);
    if (seen.has(ref)) throw new HomeError('Модели в очереди не должны повторяться.');
    seen.add(ref); checkModelSelection(store,selection,models); return selection;
  });
}

/** These are labels, not capabilities. Only levels reported by the agent are offered. */
export function reasoningChoices(rows: Array<{ reasoningEffort: string; description?: string }>): ReasoningChoice[] {
  const names: Record<string,string> = {none:'Без обдумывания',minimal:'Минимальное',low:'Низкое',medium:'Среднее',high:'Высокое',xhigh:'Очень высокое',max:'Максимальное',ultra:'Ультра'};
  return [...new Map(rows.filter(r => typeof r.reasoningEffort === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(r.reasoningEffort))
    .map(r => [r.reasoningEffort,{id:r.reasoningEffort,name:names[r.reasoningEffort] ?? r.reasoningEffort,description:r.description ?? ''}])).values()];
}

export function modelReasoning(model: ModelChoice | undefined, requested?: string | null): string | undefined {
  if (requested != null && !model?.reasoningEfforts?.some(e => e.id === requested)) throw new HomeError('Этот уровень обдумывания недоступен для выбранной модели. Выберите другой в настройках.',409);
  return requested ?? model?.defaultReasoningEffort;
}

/** Capabilities come from the selected account's native Codex catalog. */
export function normalizeModels(rows: any[], requirements: any, provider = 'chatgpt'): ModelChoice[] {
  const features = requirements?.featureRequirements ?? {};
  return rows.filter(m => !m.hidden && typeof m.model === 'string').map(m => {
    const tiers = Array.isArray(m.serviceTiers) ? m.serviceTiers : (m.additionalSpeedTiers ?? []).includes('fast') ? [{id:'priority',name:'Fast',description:''}] : [];
    return { id:m.model, name:m.displayName || m.model, description:m.description || '', isDefault:m.isDefault === true, defaultReasoningEffort:m.defaultReasoningEffort || 'medium',
      reasoningEfforts:reasoningChoices(Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []),
      speeds:[{id:'default',name:'Обычная',description:''}, ...tiers.filter((s:any) => typeof s.id === 'string' && s.id !== 'default' && typeof s.name === 'string'
        && (requirements?.supportsIndependentSpeedModes === true ? (/ultra/i.test(s.id + s.name) ? features.ultrafast_mode !== false : features.fast_mode !== false) : features.fast_mode !== false))
        .map((s:any)=>({id:s.id,name:s.name,description:s.description || ''}))], provider };
  });
}
export function recommendedModel(models: ModelChoice[]): ModelChoice {
  return models.find(m=>m.isDefault) ?? {
    ...(models.find(m=>m.id === 'gpt-6.1-sol') ?? {id:'gpt-6.1-sol',name:'GPT-6.1 Sol',description:'',speeds:[{id:'default',name:'Обычная',description:''}]}),
    isDefault:false,defaultReasoningEffort:'medium',
  };
}
/** A model stored before providers existed is a ChatGPT model. */
export function readModelSelection(store: Store, agent?: string): ModelSelection {
  const stored = (value: any): ModelSelection => ({provider:value.provider ?? (value.model ? 'chatgpt' : null),model:value.model ?? null,serviceTier:value.serviceTier ?? null,...(value.reasoningEffort != null ? {reasoningEffort:value.reasoningEffort} : {})});
  if (!agent) return stored(JSON.parse(store.getSetting(defaultsKey) ?? JSON.stringify({model:process.env.OPENSTRUDEL_CODEX_MODEL ?? null,serviceTier:'default'})));
  if (agent === 'main') return stored(JSON.parse(store.getSetting('models.main') ?? '{"model":null,"serviceTier":null}'));
  const profile = store.getProfile(agent);
  if (!profile) throw new HomeError('Сотрудник не найден.',404);
  return stored({...profile,serviceTier:profile.serviceTier ?? (profile.model ? 'default' : null)});
}
/** A conversation inherits its employee unless explicitly changed. Stored on the
 * conversation so transfer/export and the existing device sync keep the choice. */
export function readConversationModelSelection(store: Store, conversationId: string): ModelSelection {
  const conversation = store.getConversation(conversationId);
  if (!conversation) throw new HomeError('Чат не найден.',404);
  return conversation.modelSelection ?? {provider:null,model:null,serviceTier:null};
}
export function saveConversationModelSelection(store: Store, conversationId: string, value: ModelSelection) {
  readConversationModelSelection(store,conversationId);
  store.db.prepare('UPDATE conversations SET model_selection=?,updated_at=? WHERE id=?')
    .run(value.model ? JSON.stringify(value) : null,new Date().toISOString(),conversationId);
}
/** ChatGPT when signed in, otherwise the first connection. Reserves do not change this preference. */
export function automaticProvider(store: Store): string {
  return chatgptSignedIn(store) ? 'chatgpt' : providerInfos().filter(p => providerConnected(store,p.id)).sort((a,b) => providerConnectedAt(store,a.id) - providerConnectedAt(store,b.id))[0]?.id ?? 'chatgpt';
}
/** Conversation → employee → device default → automatic. A Codex catalog fills the model only when one is given. */
export function resolveModelSelection(store: Store, agent?: string, models?: ModelChoice[], conversationId?: string): ModelSelection {
  const conversation = conversationId ? readConversationModelSelection(store,conversationId) : undefined;
  const selection = conversation?.model ? conversation : readModelSelection(store,agent);
  const resolved = selection.model ? selection : readModelSelection(store);
  if (resolved.model) return resolved;
  // A subscription's catalog is the one its agent last reported; without one, the agent runs its own default.
  const provider = automaticProvider(store), info = providerInfo(provider), reported = info?.engine === 'acp' ? subscriptionModels(store,provider) : undefined;
  const registry = reported ?? (info?.models.length ? providerModels(info) : undefined), catalog = registry ?? models?.filter(m => m.provider === provider);
  return {provider,model:catalog && (catalog.length || !reported) ? recommendedModel(catalog).id : null,serviceTier:registry ? 'default' : resolved.serviceTier,
    ...(resolved.reasoningEffort != null ? {reasoningEffort:resolved.reasoningEffort} : {})};
}
/** A restricted turn (a family chat, a mentor's own students) answers one bounded question with a few
 * business tool calls. Unless the owner chose a model for that chat, it runs the device's model at Fast
 * speed where the model offers it. `null` effort keeps the device's level: measured on 30.10, a lower one
 * answered two to three times faster but searched lesson recordings less deeply, so it is the owner's call. */
export type RestrictedModel = { reasoningEffort: string | null; fast: boolean };
export const restrictedModelDefault: RestrictedModel = { reasoningEffort: null, fast: true };
const effortPattern = /^[a-z][a-z0-9_-]{0,39}$/;
export function readRestrictedModel(store: Store): RestrictedModel {
  try {
    const value = JSON.parse(store.getSetting('models.restricted') ?? 'null');
    if (value && typeof value === 'object' && typeof value.fast === 'boolean' && (value.reasoningEffort === null || typeof value.reasoningEffort === 'string' && effortPattern.test(value.reasoningEffort)))
      return { reasoningEffort: value.reasoningEffort, fast: value.fast };
  } catch { /* A damaged value falls back to the default. */ }
  return { ...restrictedModelDefault };
}
/** `null` restores the default. */
export function parseRestrictedModel(value: any): RestrictedModel | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || typeof value.fast !== 'boolean' || !(value.reasoningEffort === null || typeof value.reasoningEffort === 'string' && effortPattern.test(value.reasoningEffort)))
    throw new HomeError('Выберите уровень обдумывания и скорость для чатов с ограниченным доступом.');
  return { reasoningEffort: value.reasoningEffort, fast: value.fast };
}
/** The chat's own model as chosen; otherwise the device model with the restricted level and speed. */
export function restrictedModelSelection(store: Store, conversationId: string): ModelSelection & { fast: boolean } {
  const chat = readConversationModelSelection(store, conversationId);
  if (chat.model) return { ...chat, fast: false };
  const device = resolveModelSelection(store, 'main'), restricted = readRestrictedModel(store);
  return { ...device, ...(restricted.reasoningEffort !== null ? { reasoningEffort: restricted.reasoningEffort } : {}), fast: restricted.fast };
}
/** `models` is one provider's catalog. */
export function validateModelSelection(value: Pick<ModelSelection, 'model' | 'serviceTier' | 'reasoningEffort'>, models: ModelChoice[]) {
  const model = value.model ? models.find(m=>m.id === value.model) : recommendedModel(models);
  if (!model) throw new HomeError('Эта модель недоступна для аккаунта. Выберите другую в настройках модели.',409);
  if (!model.speeds.some(s=>s.id === value.serviceTier)) throw new HomeError('Эта скорость недоступна для выбранной модели. Выберите другую в настройках.',409);
  modelReasoning(model,value.reasoningEffort);
}
/** A saved choice must run here: its provider is connected and offers the model and speed. */
export function checkModelSelection(store: Store, value: ModelSelection, models: ModelChoice[]) {
  const provider = value.model ? value.provider! : automaticProvider(store);
  if (provider !== 'chatgpt' && !providerConnected(store,provider)) throw providerNotConnected(provider);
  validateModelSelection(value,models.filter(m=>m.provider === provider));
}
/** Older apps send no provider: their models are ChatGPT models. */
export function parseModelSelection(value: any, allowInherit: boolean): ModelSelection {
  if (value.reasoningEffort != null && (typeof value.reasoningEffort !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(value.reasoningEffort))) throw new HomeError('Выберите уровень обдумывания.');
  if (allowInherit && value.model === null && value.serviceTier === null && value.provider == null && value.reasoningEffort == null) return {provider:null,model:null,serviceTier:null};
  const automatic = !allowInherit && value.model === null && value.provider == null;
  const provider = automatic ? null : value.provider ?? 'chatgpt';
  if ((!automatic && (typeof value.model !== 'string' || !value.model || value.model.length > 160 || (provider !== 'chatgpt' && !providerInfo(provider)))) || typeof value.serviceTier !== 'string' || !value.serviceTier || value.serviceTier.length > 80) throw new HomeError('Выберите модель и скорость.');
  return {provider,model:value.model,serviceTier:value.serviceTier,...(value.reasoningEffort != null ? {reasoningEffort:value.reasoningEffort} : {})};
}
export function saveModelSelection(store: Store, value: ModelSelection, agent?: string) {
  if (!agent || agent === 'main') store.setSetting(agent ? 'models.main' : defaultsKey,JSON.stringify(value));
  else {
    if (!store.getProfile(agent)) throw new HomeError('Сотрудник не найден.',404);
    store.db.prepare('UPDATE employee_profiles SET provider=?,model=?,service_tier=?,reasoning_effort=? WHERE id=?').run(value.provider,value.model,value.serviceTier,value.reasoningEffort ?? null,agent);
  }
}
