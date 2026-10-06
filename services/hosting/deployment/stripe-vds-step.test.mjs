import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { stripeVdsStep, STRIPE_VDS as C } from './stripe-vds-step.mjs';

const intent = { providerAccountId: C.id, setupId: 'a7f963e1-e0ff-4950-b8fe-16e7c7647489',
  idempotencyKey: 'wai-vds-webhook-a7f963e1-e0ff-4950-b8fe-16e7c7647489', createdAt: '2026-10-05T12:00:00Z' };
const now = () => Date.parse('2026-10-05T12:30:00Z');
const credentials = { providerAccountId: C.id, endpointId: 'we_mock123', apiKey: 'sk_live_mockonly123', webhookSecret: 'whsec_mockonly123' };
const endpoint = () => ({ id: credentials.endpointId, url: C.url, livemode: true, status: 'enabled', api_version: C.version,
  enabled_events: [...C.events].reverse(), metadata: { wai_vds_setup: intent.setupId, provider_account: C.id } });
function fixture() {
  const accounts = new Map([['stripe-main', { id: 'stripe-main', provider: 'STRIPE', mode: 'LIVE', isActive: true, envPrefix: 'STRIPE_MAIN' }]]);
  const app = { id: 'wai-vds', mode: 'LIVE', isActive: true, apiScopes: ['payments:v2'], callbackUrl: C.callback,
    updatedAt: new Date('2026-10-05T11:00:00Z'), defaultProviderAccounts: { STRIPE: 'stripe-main', CRYPTOMUS: 'cryptomus-main' } };
  const calls = [], writes = []; let endpoints = [], payments = 0, createFailure = false;
  const prisma = {
    app: { findUnique: async ({ where }) => { assert.equal(where.id, 'wai-vds'); return structuredClone(app); },
      updateMany: async ({ where, data }) => { assert.equal(where.id, 'wai-vds'); writes.push(['app', where, data]); Object.assign(app, data); return { count: 1 }; } },
    providerAccount: { findUnique: async ({ where }) => structuredClone(accounts.get(where.id) || null),
      updateMany: async ({ where, data }) => { assert.equal(where.id, C.id); writes.push(['account', where, data]); Object.assign(accounts.get(C.id), data); return { count: 1 }; } },
    payment: { count: async () => payments }
  };
  const env = { STRIPE_MAIN_SECRET_KEY: credentials.apiKey, STRIPE_WAI_VDS_SECRET_KEY: credentials.apiKey,
    STRIPE_WAI_VDS_WEBHOOK_SECRET: credentials.webhookSecret, ADMIN_PASSWORD: 'mock-admin-password-only' };
  const fetcher = async (url, opts) => {
    calls.push([url, opts]); assert.equal(opts.redirect, 'error');
    const ok = data => ({ ok: true, status: 200, json: async () => data });
    if (url.endsWith('/webhook_endpoints?limit=100')) return ok({ data: endpoints, has_more: false });
    if (url.endsWith('/webhook_endpoints') && opts.method === 'POST') {
      assert.equal(opts.headers['Idempotency-Key'], intent.idempotencyKey);
      const form = new URLSearchParams(opts.body); assert.equal(form.get('url'), C.url);
      assert.deepEqual(form.getAll('enabled_events[]'), C.events);
      if (createFailure) throw Error('secret provider error must not escape');
      endpoints = [endpoint()]; return ok({ ...endpoint(), secret: credentials.webhookSecret });
    }
    if (url === 'http://127.0.0.1:8000/admin/api/provider-accounts') {
      const row = { ...JSON.parse(opts.body), mode: 'LIVE' };
      assert.equal(row.id, C.id); assert.equal(row.isActive, false); accounts.set(row.id, row);
      writes.push(['account-create', row]); return ok({ success: true, providerAccount: row });
    }
    if (url === C.url) {
      const body = JSON.parse(opts.body); assert.equal(body.type, 'wai_vds.readiness');
      const t = Math.floor(now() / 1000), signature = createHmac('sha256', credentials.webhookSecret).update(t + '.' + opts.body).digest('hex');
      assert.equal(opts.headers['Stripe-Signature'], 't=' + t + ',v1=' + signature);
      return ok({ success: true, note: 'ignored event' });
    }
    throw Error('Unexpected network path: ' + url);
  };
  return { prisma, env, fetcher, now, calls, writes, app, accounts,
    setEndpoints: x => endpoints = x, setPayments: x => payments = x, failCreate: () => createFailure = true };
}
test('preflight makes only reads and refuses any preexisting target without a journal', async () => {
  const f = fixture(); assert.equal((await stripeVdsStep('preflight', {}, f)).targetAbsent, true);
  assert.equal(f.writes.length, 0); assert.ok(f.calls.every(x => !x[1].method));
  f.setEndpoints([endpoint()]); await assert.rejects(stripeVdsStep('preflight', {}, f), e => e.safeCode === 'endpoint_already_exists_without_journal');
});
test('prepare uses durable idempotency, exact target and seven events without DB changes', async () => {
  const f = fixture(); const r = await stripeVdsStep('prepare', { intent }, f);
  assert.deepEqual(r.credentials, credentials); assert.equal(f.writes.length, 0);
  assert.equal(f.calls.filter(x => x[1].method === 'POST').length, 1);
});
test('unknown create result is not retried automatically and errors exclude private bodies', async () => {
  const f = fixture(); f.failCreate();
  await assert.rejects(stripeVdsStep('prepare', { intent }, f), e => e.safeCode === 'request_outcome_unknown' && !e.message.includes('secret provider'));
  assert.equal(f.calls.filter(x => x[1].method === 'POST').length, 1);
});
test('persisted endpoint is reused without a write; stale uncertain intent never creates again', async () => {
  const f = fixture(); f.setEndpoints([endpoint()]);
  assert.equal((await stripeVdsStep('prepare', { intent, credentials }, f)).recovered, true);
  assert.equal(f.calls.filter(x => x[1].method === 'POST').length, 0);
  f.now = () => Date.parse('2026-10-06T12:00:00Z');
  await assert.rejects(stripeVdsStep('prepare', { intent }, f), e => e.safeCode === 'idempotency_recovery_window_closed');
});
test('foreign endpoint ownership or provider-account metadata cannot be adopted', async () => {
  const f = fixture(); f.setEndpoints([{ ...endpoint(), metadata: { wai_vds_setup: 'foreign' } }]);
  await assert.rejects(stripeVdsStep('prepare', { intent }, f), e => e.safeCode === 'endpoint_conflict');
  f.accounts.set(C.id, { id: C.id, provider: 'STRIPE', mode: 'LIVE', isActive: true, envPrefix: 'STRIPE_MAIN', label: 'foreign' });
  await assert.rejects(stripeVdsStep('prepare', { intent }, f), e => e.safeCode === 'target_account_conflict');
  assert.equal(f.writes.length, 0);
});
test('activation needs persisted credentials already injected into backend', async () => {
  const f = fixture(); delete f.env.STRIPE_WAI_VDS_WEBHOOK_SECRET;
  await assert.rejects(stripeVdsStep('activate', { intent, credentials }, f), e => e.safeCode === 'dedicated_runtime_credentials_missing');
  assert.equal(f.writes.length, 0);
});
test('activation touches only new target and own App, verifies synthetic raw HMAC, creates no payment', async () => {
  const f = fixture(); f.setEndpoints([endpoint()]); const before = structuredClone(f.accounts.get('stripe-main'));
  const r = await stripeVdsStep('activate', { intent, credentials }, f);
  assert.equal(r.invoicesCreated, 0); assert.equal(f.app.defaultProviderAccounts.STRIPE, C.id);
  assert.deepEqual(f.accounts.get('stripe-main'), before); assert.equal(f.accounts.get(C.id).isActive, true);
  assert.equal((await stripeVdsStep('verify', { intent, credentials }, f)).ownAppRouted, true);
  assert.ok(!f.calls.some(x => /payments$|checkout\/sessions/.test(x[0])));
});
test('rollback preserves shared accounts and refuses removal of credentials used by a payment', async () => {
  const f = fixture(); f.setEndpoints([endpoint()]); await stripeVdsStep('activate', { intent, credentials }, f);
  f.setPayments(1);
  await assert.rejects(stripeVdsStep('rollback', { intent }, f), e => e.safeCode === 'rollback_blocked_payments_exist');
  assert.equal(f.app.defaultProviderAccounts.STRIPE, C.id);
  f.setPayments(0); await stripeVdsStep('rollback', { intent }, f);
  assert.equal(f.app.defaultProviderAccounts.STRIPE, 'stripe-main'); assert.equal(f.accounts.get(C.id).isActive, false);
  assert.ok(f.accounts.has(C.id)); assert.equal(f.accounts.get('stripe-main').isActive, true);
  assert.ok(!f.calls.some(x => x[1].method === 'DELETE'));
});
