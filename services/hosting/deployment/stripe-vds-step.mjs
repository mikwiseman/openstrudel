// Invoked by stripe-vds-setup.py inside the existing waipay-backend container.
// stdout is a private pipe: prepare returns credentials for root-only persistence.
import { createHmac, randomUUID } from 'node:crypto';

export const STRIPE_VDS = Object.freeze({
  id: 'stripe-vds', prefix: 'STRIPE_WAI_VDS', label: 'WAI VDS · Stripe',
  url: 'https://pay.waiwai.is/webhooks/stripe/stripe-vds',
  version: '2025-02-24.acacia',
  callback: 'https://pay.waiwai.is/vds/api/v1/webhooks/wai-pay',
  events: ['checkout.session.completed', 'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed', 'checkout.session.expired',
    'refund.created', 'refund.updated', 'refund.failed']
});
const oldDefaults = { STRIPE: 'stripe-main', CRYPTOMUS: 'cryptomus-main' };
const newDefaults = { STRIPE: STRIPE_VDS.id, CRYPTOMUS: 'cryptomus-main' };
const same = (a, b) => Array.isArray(a) && Array.isArray(b)
  ? JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
  : JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort());
const fail = code => { const e = new Error('Stripe VDS setup stopped'); e.safeCode = code; throw e; };
const validCredential = c => c?.providerAccountId === STRIPE_VDS.id && /^we_[A-Za-z0-9]+$/.test(c.endpointId || '') &&
  /^sk_live_[A-Za-z0-9_-]+$/.test(c.apiKey || '') && /^whsec_[A-Za-z0-9_-]+$/.test(c.webhookSecret || '');
const accountMatches = a => a?.id === STRIPE_VDS.id && a.provider === 'STRIPE' && a.envPrefix === STRIPE_VDS.prefix && a.mode === 'LIVE' && a.label === STRIPE_VDS.label;

export async function stripeVdsStep(phase, input, { prisma, fetcher = fetch, env = process.env, now = Date.now }) {
  const req = async (url, options = {}) => {
    let r;
    try { r = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { fail('request_outcome_unknown'); }
    if (!r.ok) fail('http_' + r.status);
    try { return await r.json(); } catch { fail('response_outcome_unknown'); }
  };
  const source = await prisma.providerAccount.findUnique({ where: { id: 'stripe-main' } });
  const app = await prisma.app.findUnique({ where: { id: 'wai-vds' } });
  const target = await prisma.providerAccount.findUnique({ where: { id: STRIPE_VDS.id } });
  if (!source || source.provider !== 'STRIPE' || source.mode !== 'LIVE' || !source.isActive) fail('source_account_changed');
  if (!app || app.mode !== 'LIVE' || !app.isActive || app.callbackUrl !== STRIPE_VDS.callback ||
      !same(app.apiScopes, ['payments:v2']) || (!same(app.defaultProviderAccounts, oldDefaults) && !same(app.defaultProviderAccounts, newDefaults))) fail('own_app_changed');
  if (target && !accountMatches(target)) fail('target_account_conflict');
  const apiKey = env[source.envPrefix + '_SECRET_KEY'];
  if (!/^sk_live_[A-Za-z0-9_-]+$/.test(apiKey || '')) fail('source_live_key_missing');
  const stripe = (path, options = {}) => req('https://api.stripe.com/v1' + path, {
    ...options, headers: { Authorization: 'Bearer ' + apiKey, 'Stripe-Version': STRIPE_VDS.version, ...options.headers }
  });
  const list = async () => {
    const result = await stripe('/webhook_endpoints?limit=100');
    if (!Array.isArray(result.data) || result.has_more) fail('endpoint_inventory_incomplete');
    return result.data.filter(e => e.url === STRIPE_VDS.url);
  };
  const intentOK = () => {
    if (input?.intent?.providerAccountId !== STRIPE_VDS.id || !/^[a-f0-9-]{36}$/.test(input.intent.setupId || '') ||
        input.intent.idempotencyKey !== 'wai-vds-webhook-' + input.intent.setupId || !Number.isFinite(Date.parse(input.intent.createdAt))) fail('durable_intent_required');
  };
  const endpointOK = endpoint => endpoint?.url === STRIPE_VDS.url && endpoint.livemode === true && endpoint.status === 'enabled' &&
    endpoint.api_version === STRIPE_VDS.version && same(endpoint.enabled_events, STRIPE_VDS.events) &&
    endpoint.metadata?.wai_vds_setup === input.intent.setupId && endpoint.metadata?.provider_account === STRIPE_VDS.id;

  if (phase === 'preflight') {
    if (target || !same(app.defaultProviderAccounts, oldDefaults)) fail('target_already_exists_without_journal');
    if ((await list()).length) fail('endpoint_already_exists_without_journal');
    if (await prisma.payment.count({ where: { appId: 'wai-vds' } })) fail('app_has_payments_review_migration');
    return { ok: true, targetAbsent: true, endpointAbsent: true, originalDefaults: oldDefaults, mode: 'LIVE' };
  }
  intentOK();
  if (phase === 'prepare') {
    const endpoints = await list();
    if (endpoints.length > 1 || endpoints.some(e => !endpointOK(e))) fail('endpoint_conflict');
    if (input.credentials) {
      if (!validCredential(input.credentials) || input.credentials.apiKey !== apiKey || endpoints.length !== 1 ||
          endpoints[0].id !== input.credentials.endpointId) fail('persisted_credentials_mismatch');
      return { ok: true, credentials: input.credentials, recovered: true };
    }
    // Stripe may prune idempotency keys after 24 hours. Never recreate on an old uncertain intent.
    if (now() - Date.parse(input.intent.createdAt) >= 23 * 3600e3 || now() < Date.parse(input.intent.createdAt)) fail('idempotency_recovery_window_closed');
    const form = new URLSearchParams({ url: STRIPE_VDS.url, api_version: STRIPE_VDS.version,
      description: 'WAI VDS dedicated payment webhooks', 'metadata[wai_vds_setup]': input.intent.setupId,
      'metadata[provider_account]': STRIPE_VDS.id });
    for (const event of STRIPE_VDS.events) form.append('enabled_events[]', event);
    const endpoint = await stripe('/webhook_endpoints', { method: 'POST', body: form.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': input.intent.idempotencyKey } });
    const credentials = { providerAccountId: STRIPE_VDS.id, endpointId: endpoint.id, apiKey, webhookSecret: endpoint.secret };
    if (!endpointOK(endpoint) || !validCredential(credentials)) fail('endpoint_create_outcome_unknown');
    return { ok: true, credentials, recovered: endpoints.length === 1 };
  }
  if (phase === 'rollback') {
    if (await prisma.payment.count({ where: { providerAccountId: STRIPE_VDS.id } })) fail('rollback_blocked_payments_exist');
    if (same(app.defaultProviderAccounts, newDefaults)) {
      const changed = await prisma.app.updateMany({ where: { id: 'wai-vds', updatedAt: app.updatedAt }, data: { defaultProviderAccounts: oldDefaults } });
      if (changed.count !== 1) fail('app_concurrent_change');
    }
    if (target?.isActive) await prisma.providerAccount.updateMany({ where: { id: STRIPE_VDS.id, envPrefix: STRIPE_VDS.prefix, provider: 'STRIPE', mode: 'LIVE' }, data: { isActive: false } });
    return { ok: true, originalDefaultsRestored: true, newAccountInactive: true, historyRetained: true };
  }
  if (!validCredential(input.credentials) || input.credentials.apiKey !== apiKey ||
      env[STRIPE_VDS.prefix + '_SECRET_KEY'] !== apiKey ||
      env[STRIPE_VDS.prefix + '_WEBHOOK_SECRET'] !== input.credentials.webhookSecret) fail('dedicated_runtime_credentials_missing');
  const endpoints = await list();
  if (endpoints.length !== 1 || !endpointOK(endpoints[0]) || endpoints[0].id !== input.credentials.endpointId) fail('dedicated_endpoint_mismatch');
  if (phase === 'activate') {
    if (!target) {
      if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16) fail('admin_auth_missing');
      const created = await req('http://127.0.0.1:8000/admin/api/provider-accounts', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Password': env.ADMIN_PASSWORD },
        body: JSON.stringify({ id: STRIPE_VDS.id, provider: 'STRIPE', label: STRIPE_VDS.label, envPrefix: STRIPE_VDS.prefix, isActive: false }) });
      if (!created.success || !accountMatches(created.providerAccount) || created.providerAccount.isActive) fail('new_account_result_unknown');
    }
    // Harmless synthetic event verifies raw-body signature handling, not settlement.
    const body = JSON.stringify({ id: 'evt_vds_readiness_' + randomUUID().replaceAll('-', ''), object: 'event',
      type: 'wai_vds.readiness', livemode: true, data: { object: {} } });
    const timestamp = Math.floor(now() / 1000);
    const signature = createHmac('sha256', input.credentials.webhookSecret).update(timestamp + '.' + body).digest('hex');
    const probe = await req(STRIPE_VDS.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=' + timestamp + ',v1=' + signature }, body });
    if (probe.success !== true || probe.note !== 'ignored event') fail('signature_probe_failed');
    const activated = await prisma.providerAccount.updateMany({ where: { id: STRIPE_VDS.id, envPrefix: STRIPE_VDS.prefix, provider: 'STRIPE', mode: 'LIVE' }, data: { isActive: true } });
    if (activated.count !== 1) fail('new_account_changed');
    if (same(app.defaultProviderAccounts, oldDefaults)) {
      const changed = await prisma.app.updateMany({ where: { id: 'wai-vds', updatedAt: app.updatedAt }, data: { defaultProviderAccounts: newDefaults } });
      if (changed.count !== 1) fail('app_concurrent_change');
    }
    return { ok: true, providerAccountId: STRIPE_VDS.id, signatureProbe: 'synthetic_nonpayment_verified', invoicesCreated: 0,
      rootRuntimeUpdateRequired: { WAI_PAY_STRIPE_ACCOUNT_ID: STRIPE_VDS.id } };
  }
  if (phase === 'verify') {
    if (!target?.isActive || !same(app.defaultProviderAccounts, newDefaults)) fail('routing_not_active');
    return { ok: true, providerAccountId: STRIPE_VDS.id, endpointId: input.credentials.endpointId, ownAppRouted: true, invoicesCreated: 0 };
  }
  fail('unknown_phase');
}

if (process.argv[1] === '-') {
  let prisma;
  try {
    if (process.env.WAI_STRIPE_VDS_PRIVATE_PIPE !== '1' || process.stdout.isTTY) fail('private_wrapper_required');
    const { PrismaClient } = await import('@prisma/client'); prisma = new PrismaClient();
    process.stdout.write(JSON.stringify(await stripeVdsStep(process.argv[2], globalThis.__WAI_SETUP_INPUT || {}, { prisma })));
  } catch (e) { process.stdout.write(JSON.stringify({ ok: false, code: e.safeCode || 'setup_failed' })); process.exitCode = 1; }
  finally { await prisma?.$disconnect(); }
}
