// Integration boundary for the documented WAI VDS sandbox. Never ships in Home.
import { assessVdsCatalog } from '../cloud-onboarding/eligibility.mjs';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const states = new Set(['paid', 'creating', 'configuring', 'checking', 'ready', 'unknown', 'attention', 'rejected', 'overdue', 'deleting', 'deleted']);
const messages = {
  configuration: 'Не удалось прочитать настройки тестового подключения.',
  sandbox_required: 'Эта проверка работает только с учебными серверами.',
  access_expired: 'Тестовый доступ истёк или был отозван. Нужен действующий ключ WAI VDS.',
  access_denied: 'У тестового ключа нет нужного разрешения.',
  not_found: 'Сохранённый заказ или сервер недоступен. Проверьте учётную запись.',
  conflict: 'Заказ требует проверки. Новый сервер автоматически не создаётся.',
  rate_limited: 'Сервис просит подождать перед следующей проверкой.',
  unavailable: 'Связь с WAI VDS прервалась. Продолжите с сохранённым номером попытки.',
  contract: 'Ответ WAI VDS изменился. Подключение требует проверки.',
};

export class WaiVdsError extends Error {
  constructor(code, status, retryAfterSeconds) {
    super(messages[code]);
    this.name = 'WaiVdsError';
    this.code = code;
    if (status) this.status = status;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}
const requireContract = condition => { if (!condition) throw new WaiVdsError('contract'); };
const requireSandbox = mode => {
  if (mode?.provider !== 'emulator' || mode?.payments !== 'emulator' || mode?.payment_live === true) {
    throw new WaiVdsError('sandbox_required');
  }
};
const idPath = id => { requireContract(typeof id === 'string' && uuid.test(id)); return id; };

export function normalizeBaseURL(value) {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.search || u.hash || !/^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(u.pathname)) throw Error();
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) throw Error();
    return u.href.replace(/\/$/, '');
  } catch { throw new WaiVdsError('configuration'); }
}

export function presentServer(server) {
  requireContract(states.has(server?.state));
  // WAI VDS ready currently certifies SSH + Docker, not OpenStrudel Home.
  const phase = server.state === 'ready'
    ? (server.mode === 'emulator' ? 'sandboxReady' : 'homeInstallationRequired')
    : ['unknown', 'attention', 'rejected'].includes(server.state) ? 'needsReview' : server.state;
  return { phase, homeReady: false, canStartOpenAI: false, canCreateReplacement: false };
}

export class WaiVdsSandboxClient {
  #base; #key; #fetch; #timeout;
  constructor({ baseURL, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
    this.#base = normalizeBaseURL(baseURL);
    if (!/^wai_test_[a-f0-9]{64}$/.test(apiKey || '')) throw new WaiVdsError('sandbox_required');
    this.#key = apiKey;
    this.#fetch = fetchImpl;
    this.#timeout = timeoutMs;
  }
  get baseURL() { return this.#base; }

  async #request(path, method = 'GET', body) {
    try {
      const response = await this.#fetch(this.#base + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(this.#timeout),
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + this.#key,
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const code = ({ 401: 'access_expired', 403: 'access_denied', 404: 'not_found', 409: 'conflict', 429: 'rate_limited' })[response.status]
          || (response.status >= 500 ? 'unavailable' : 'contract');
        const retryHeader = response.headers.get('retry-after');
        const retrySeconds = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : undefined;
        throw new WaiVdsError(code, response.status, Number.isSafeInteger(retrySeconds) ? retrySeconds : undefined);
      }
      requireContract(response.headers.get('content-type')?.includes('application/json') && response.body);
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          requireContract(size <= 1024 * 1024);
          chunks.push(value);
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new WaiVdsError('contract'); }
      } finally { await reader.cancel().catch(() => {}); }
    } catch (error) {
      if (error instanceof WaiVdsError) throw error;
      // Never include fetch errors, response bodies, tokens or root keys in diagnostics.
      throw new WaiVdsError('unavailable');
    }
  }

  async preflight() {
    const health = await this.#request('/healthz');
    requireContract(health?.ok === true && health.service === 'wai-vds');
    requireSandbox(health);
    const catalog = await this.#request('/api/v1/catalog');
    requireSandbox(catalog?.mode);
    return { catalog, assessment: assessVdsCatalog(catalog) };
  }
  async inventory() {
    const account = await this.#request('/api/v1/me');
    requireSandbox(account?.mode);
    requireContract(Array.isArray(account.servers));
    return account.servers.map(s => {
      idPath(s.id); requireContract(states.has(s.state) && s.mode === 'emulator');
      return { id: s.id, state: s.state, mode: s.mode };
    });
  }
  async createTrial(idempotencyKey) {
    requireContract(/^[-a-zA-Z0-9_]{8,100}$/.test(idempotencyKey || ''));
    await this.preflight();
    const result = await this.#request('/api/v1/agent/servers', 'POST', {
      purpose: 'agent', idempotency_key: idempotencyKey, consent: true,
    });
    if (result?.mode !== 'emulator' || result.billable !== false) throw new WaiVdsError('sandbox_required');
    const order = result.order, server = result.server;
    idPath(order?.id); idPath(server?.id);
    requireContract(order.mode === 'emulator' && server.mode === 'emulator' && order.purpose === 'agent'
      && server.purpose === 'agent' && order.idem === idempotencyKey && order.server_id === server.id
      && server.order_id === order.id && states.has(server.state));
    return { orderId: order.id, serverId: server.id, idempotencyKey };
  }
  async status(trial) {
    const order = await this.#request('/api/v1/orders/' + idPath(trial.orderId));
    requireContract(order?.id === trial.orderId && order.idem === trial.idempotencyKey
      && order.server_id === trial.serverId && order.purpose === 'agent' && order.mode === 'emulator');
    const server = await this.#request('/api/v1/servers/' + idPath(trial.serverId));
    requireContract(server?.id === trial.serverId && server.order_id === trial.orderId && server.purpose === 'agent');
    if (server.mode !== 'emulator') throw new WaiVdsError('sandbox_required');
    return { state: server.state, orderStatus: order.status, cancelAtEnd: server.cancel_at_end === true,
      payment: 'sandbox_grant', ...presentServer(server) };
  }
  async cancelAtPeriodEnd(trial) {
    await this.preflight(); await this.status(trial);
    await this.#request('/api/v1/servers/' + idPath(trial.serverId) + '/cancellation', 'POST', { cancel_at_end: true });
  }
  async deleteTrial(trial) {
    await this.preflight();
    const status = await this.status(trial);
    if (['deleted', 'deleting'].includes(status.state)) return;
    requireContract(['ready', 'overdue', 'rejected', 'attention'].includes(status.state));
    await this.#request('/api/v1/servers/' + idPath(trial.serverId) + '/delete', 'POST', { confirm: trial.serverId });
  }
}
