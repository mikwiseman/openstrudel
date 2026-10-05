// Read-only boundary for the documented production API. Not included in native builds.
import { readFileSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { assessVdsCatalog } from '../cloud-onboarding/eligibility.mjs';

export const productionBaseURL = 'https://pay.waiwai.is/vds';
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const orderStates = new Set(['draft', 'checkout', 'paid', 'fulfilling', 'fulfilled', 'needs_refund', 'refunded']);
const serverStates = new Set(['paid', 'creating', 'configuring', 'checking', 'ready', 'unknown', 'attention', 'rejected', 'overdue', 'deleting', 'deleted']);
const messages = {
  configuration: 'Не удалось прочитать закрытые настройки WAI VDS.',
  contract: 'Ответ WAI VDS требует проверки. Новые заказы не создавались.',
  access_expired: 'Доступ WAI VDS истёк или был отозван. Восстановите доступ в кабинете WAI VDS.',
  access_denied: 'У ключа WAI VDS нет права читать эти сведения.',
  rate_limited: 'WAI VDS просит подождать перед следующей проверкой.',
  unavailable: 'Не удалось проверить WAI VDS. Повторите чтение позже.',
};
export class ProductionReadinessError extends Error {
  constructor(code, retryAfterSeconds) {
    super(messages[code]); this.name = 'ProductionReadinessError'; this.code = code;
    if (Number.isSafeInteger(retryAfterSeconds)) this.retryAfterSeconds = retryAfterSeconds;
  }
}
const requireContract = condition => { if (!condition) throw new ProductionReadinessError('contract'); };

export function summarizeProductionOrder(order) {
  requireContract(uuid.test(order?.id || '') && order.mode === 'wai_pay' && orderStates.has(order.status));
  requireContract(order.server_id == null || uuid.test(order.server_id));
  requireContract(order.paid_at == null || (Number.isSafeInteger(order.paid_at) && order.paid_at > 0));
  const paymentConfirmed = Number.isSafeInteger(order.paid_at) && order.paid_at > 0;
  let phase;
  if (order.status === 'refunded') phase = 'refunded';
  else if (order.status === 'needs_refund') phase = 'operatorReview';
  else if (order.status === 'draft') phase = 'draft';
  else if (order.status === 'checkout' && !paymentConfirmed) phase = 'paymentUnconfirmed';
  else {
    requireContract(paymentConfirmed);
    if (['fulfilling', 'fulfilled'].includes(order.status)) requireContract(uuid.test(order.server_id || ''));
    phase = order.status === 'fulfilled' ? 'homeInstallationRequired' : 'provisioning';
  }
  // Expired/cancelled invoices still have order.status=checkout in API v1.
  // Neither a browser redirect nor that state proves a payment or frees capacity.
  return { phase, paymentConfirmed, homeReady: false, canStartOpenAI: false, canRetryCreation: false };
}

export function productionPaymentOptions(catalog) {
  requireContract(Array.isArray(catalog?.payment_methods) && Number.isSafeInteger(catalog.plan?.period_days) && catalog.plan.period_days > 0);
  const seen = new Set();
  return catalog.payment_methods.map(method => {
    const expectedCurrency = { card: 'usd', crypto: 'usdt', rub: 'rub' }[method?.id];
    requireContract(expectedCurrency && !seen.has(method.id) && method.currency === expectedCurrency
      && Number.isSafeInteger(method.amount) && method.amount > 0
      && typeof method.available === 'boolean' && method.test === false);
    seen.add(method.id);
    // WAI VDS specifies two decimal minor units for both USD and USDT in API v1.
    // USDT is retained as its own currency; it is never formatted as a dollar amount.
    return { method: method.id, amountMinor: method.amount, currency: method.currency.toUpperCase(),
      minorUnitDigits: 2, available: method.available, periodDays: catalog.plan.period_days };
  });
}

export async function inspectProduction({ baseURL = productionBaseURL, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  if (baseURL !== productionBaseURL || !/^wai_live_[a-f0-9]{64}$/.test(apiKey || '')) throw new ProductionReadinessError('configuration');
  // The only possible network operations are three fixed GET requests. No remote URL from
  // the response is followed; no order, checkout, private key, recovery or provisioning call.
  async function get(path, authenticated = false) {
    try {
      const response = await fetchImpl(baseURL + path, { method: 'GET', redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json',
          ...(authenticated ? { Authorization: 'Bearer ' + apiKey } : {}) } });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const code = ({ 401: 'access_expired', 403: 'access_denied', 429: 'rate_limited' })[response.status] || 'unavailable';
        const retry = response.headers.get('retry-after');
        throw new ProductionReadinessError(code, retry && /^\d+$/.test(retry) ? Number(retry) : undefined);
      }
      requireContract(response.headers.get('content-type')?.includes('application/json') && response.body);
      const reader = response.body.getReader(); const chunks = []; let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          bytes += value.length; requireContract(bytes <= 1024 * 1024); chunks.push(value);
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new ProductionReadinessError('contract'); }
      } finally { await reader.cancel().catch(() => {}); }
    } catch (error) {
      if (error instanceof ProductionReadinessError) throw error;
      throw new ProductionReadinessError('unavailable');
    }
  }
  const health = await get('/healthz');
  requireContract(health?.ok === true && health.service === 'wai-vds' && health.provider === 'kamatera' && health.payments === 'wai_pay');
  const catalog = await get('/api/v1/catalog');
  requireContract(catalog?.mode?.provider === health.provider && catalog.mode.payments === health.payments
    && catalog.mode.payment_live === true && typeof catalog.plan?.checkout_enabled === 'boolean');
  const assessment = assessVdsCatalog(catalog);
  const paymentOptions = productionPaymentOptions(catalog);
  const account = await get('/api/v1/me', true);
  requireContract(account?.mode?.provider === health.provider && account.mode.payments === health.payments
    && Array.isArray(account.orders) && Array.isArray(account.servers));
  const phases = {};
  for (const order of account.orders) {
    const summary = summarizeProductionOrder(order);
    phases[summary.phase] = (phases[summary.phase] || 0) + 1;
  }
  for (const server of account.servers) requireContract(uuid.test(server?.id || '') && server.mode === health.provider && serverStates.has(server.state));
  return {
    checkedAt: new Date().toISOString(), kind: 'authenticated_read_only_production', baseURL,
    provider: health.provider, payments: health.payments, checkoutEnabled: catalog.plan.checkout_enabled,
    resourceProfile: { memoryMiB: catalog.plan.ram_mb, diskGB: catalog.plan.disk_gb, publicIPv4: catalog.plan.ipv4 },
    paymentOptions, assessment, capacityVerified: false, paymentSettlementVerified: false,
    account: { orders: account.orders.length, orderPhases: phases, servers: account.servers.length,
      activeServers: account.servers.filter(s => s.state !== 'deleted').length },
    mutations: 0, ordersCreated: 0, realVMsCreated: 0, chargesPerformed: 0, nativePublicationAllowed: false,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--env-file') throw new ProductionReadinessError('configuration');
    const path = resolve(args[1]), stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new ProductionReadinessError('configuration');
    const env = Object.fromEntries(readFileSync(path, 'utf8').split('\n').filter(s => s && !s.startsWith('#')).map(s => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1).trim()]));
    console.log(JSON.stringify(await inspectProduction({ baseURL: env.WAI_VDS_BASE_URL, apiKey: env.WAI_VDS_API_KEY }), null, 2));
  } catch (error) {
    const safe = error instanceof ProductionReadinessError ? error : new ProductionReadinessError('configuration');
    console.error(JSON.stringify({ ok: false, code: safe.code, message: safe.message }));
    process.exitCode = 1;
  }
}
