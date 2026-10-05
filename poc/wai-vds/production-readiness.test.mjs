import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectProduction, productionBaseURL, productionPaymentOptions, summarizeProductionOrder } from './production-readiness.mjs';

const apiKey = 'wai_live_' + '7'.repeat(64);
const orderId = '11111111-1111-4111-8111-111111111111';
const serverId = '22222222-2222-4222-8222-222222222222';
const health = { ok: true, service: 'wai-vds', provider: 'kamatera', payments: 'wai_pay' };
const mode = { provider: 'kamatera', payments: 'wai_pay', payment_live: true };
const catalog = { mode, plan: { id: 'start', ram_mb: 2048, disk_gb: 20, ipv4: 1, amount: 1200, currency: 'usd', period_days: 30, checkout_enabled: true },
  payment_methods: [
    { id: 'card', currency: 'usd', amount: 1200, available: true, test: false },
    { id: 'crypto', currency: 'usdt', amount: 1300, available: true, test: false },
  ] };
const account = { user: { email: 'private@example.test' }, csrf: 'private-csrf', mode, orders: [], servers: [] };
const order = { id: orderId, mode: 'wai_pay', status: 'checkout', server_id: null, paid_at: null };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function fixture(overrides = {}) {
  const calls = [];
  const defaults = { '/healthz': health, '/api/v1/catalog': catalog, '/api/v1/me': account };
  return { calls, inspect: () => inspectProduction({ apiKey, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const path = url.slice(productionBaseURL.length);
    const response = Object.hasOwn(overrides, path) ? overrides[path] : defaults[path];
    assert.notEqual(response, undefined);
    if (typeof response === 'function') return response(options);
    return response instanceof Response ? response : json(response);
  } }) };
}

test('production inspection makes only three fixed GETs; credentials are confined to the account request', async () => {
  const { inspect, calls } = fixture(); const result = await inspect();
  assert.deepEqual(calls.map(c => c.url), ['/healthz', '/api/v1/catalog', '/api/v1/me'].map(p => productionBaseURL + p));
  for (const c of calls) { assert.equal(c.options.method, 'GET'); assert.equal(c.options.redirect, 'error'); assert.equal(c.options.body, undefined); }
  assert.ok(!calls[0].options.headers.Authorization); assert.ok(!calls[1].options.headers.Authorization);
  assert.equal(calls[2].options.headers.Authorization, 'Bearer ' + apiKey);
  assert.equal(result.mutations, 0); assert.equal(result.ordersCreated, 0); assert.equal(result.realVMsCreated, 0);
  assert.ok(!JSON.stringify(result).includes(apiKey)); assert.ok(!JSON.stringify(result).includes('private'));
});
test('production credentials cannot be sent to a different URL or used as a sandbox key', async () => {
  let calls = 0; const fetchImpl = () => { calls++; throw Error(); };
  for (const baseURL of ['http://pay.waiwai.is/vds', 'https://other.example/vds', productionBaseURL + '?token=x', productionBaseURL + '/other']) {
    await assert.rejects(inspectProduction({ baseURL, apiKey, fetchImpl }), { code: 'configuration' });
  }
  await assert.rejects(inspectProduction({ apiKey: apiKey.replace('live', 'test'), fetchImpl }), { code: 'configuration' });
  assert.equal(calls, 0);
});
test('the advertised live mode must agree across health, catalog and account', async () => {
  for (const changed of [
    { '/healthz': { ...health, provider: 'emulator' } },
    { '/api/v1/catalog': { ...catalog, mode: { ...mode, payment_live: false } } },
    { '/api/v1/me': { ...account, mode: { provider: 'emulator', payments: 'emulator' } } },
  ]) await assert.rejects(fixture(changed).inspect(), { code: 'contract' });
});
test('an open checkout cannot certify suitable resources, funds, capacity or Home readiness', async () => {
  const result = await fixture().inspect();
  assert.equal(result.checkoutEnabled, true); assert.equal(result.assessment.matchingResourceProfile, false);
  assert.equal(result.capacityVerified, false); assert.equal(result.paymentSettlementVerified, false);
  assert.equal(result.assessment.homeBootstrapVerified, false); assert.equal(result.nativePublicationAllowed, false);
  assert.equal(result.assessment.readyForPublicSales, false);
});
test('USD and USDT quotes retain their separate amounts and currency', () => {
  assert.deepEqual(productionPaymentOptions(catalog).map(q => ({ amount: q.amountMinor, currency: q.currency })), [
    { amount: 1200, currency: 'USD' }, { amount: 1300, currency: 'USDT' },
  ]);
});
test('ambiguous currencies, duplicate methods, live test quotes and missing periods are rejected', () => {
  for (const method of [
    { ...catalog.payment_methods[1], currency: 'usd' }, { ...catalog.payment_methods[0], test: true },
    { ...catalog.payment_methods[0], amount: -1 }, { ...catalog.payment_methods[0], amount: 1.5 },
  ]) assert.throws(() => productionPaymentOptions({ ...catalog, payment_methods: [method] }), { code: 'contract' });
  assert.throws(() => productionPaymentOptions({ ...catalog, payment_methods: [catalog.payment_methods[0], catalog.payment_methods[0]] }), { code: 'contract' });
  assert.throws(() => productionPaymentOptions({ ...catalog, plan: {} }), { code: 'contract' });
});
test('an expired unpaid invoice still reported as checkout is not interpreted as successful or safe to repeat', () => {
  const result = summarizeProductionOrder({ ...order, return_url: '?payment=success', upstream: 'expired' });
  assert.equal(result.phase, 'paymentUnconfirmed'); assert.equal(result.paymentConfirmed, false);
  assert.equal(result.canRetryCreation, false); assert.equal(result.homeReady, false);
});
test('refunded and needs_refund orders stay distinct and never offer another server automatically', () => {
  for (const [status, phase] of [['refunded', 'refunded'], ['needs_refund', 'operatorReview']]) {
    const result = summarizeProductionOrder({ ...order, status, paid_at: Date.now() });
    assert.equal(result.phase, phase); assert.equal(result.canRetryCreation, false);
    assert.equal(result.canStartOpenAI, false); assert.equal(result.homeReady, false);
  }
});
test('fulfilled VM requires paid evidence and a server but still requires Home setup', () => {
  const valid = { ...order, status: 'fulfilled', server_id: serverId, paid_at: Date.now() };
  assert.equal(summarizeProductionOrder(valid).phase, 'homeInstallationRequired');
  for (const invalid of [{ ...valid, paid_at: null }, { ...valid, server_id: null }, { ...valid, status: 'unexpected' }]) {
    assert.throws(() => summarizeProductionOrder(invalid), { code: 'contract' });
  }
});
test('order states are aggregated without leaking account IDs, private keys or user details', async () => {
  const result = await fixture({ '/api/v1/me': { ...account, orders: [order, { ...order, status: 'refunded' }],
    servers: [{ id: serverId, state: 'deleted', mode: 'kamatera', private_key: 'private-key', ip: '192.0.2.1' }] } }).inspect();
  assert.deepEqual(result.account, { orders: 2, orderPhases: { paymentUnconfirmed: 1, refunded: 1 }, servers: 1, activeServers: 0 });
  assert.ok(!JSON.stringify(result).includes(serverId)); assert.ok(!JSON.stringify(result).includes('private-key'));
});
test('key recovery or revocation returns a WAI VDS access error without starting OpenAI authorization', async () => {
  const f = fixture({ '/api/v1/me': json({ error: apiKey }, 401) });
  await assert.rejects(f.inspect(), e => e.code === 'access_expired' && !e.message.includes(apiKey) && !e.message.includes('OpenAI'));
  assert.equal(f.calls.length, 3);
});
test('scope denial and rate limiting stay distinct; neither causes a retry', async () => {
  for (const [status, code] of [[403, 'access_denied'], [429, 'rate_limited']]) {
    const f = fixture({ '/healthz': json({ error: apiKey }, status, { 'retry-after': '42' }) });
    await assert.rejects(f.inspect(), { code, retryAfterSeconds: 42 }); assert.equal(f.calls.length, 1);
  }
});
test('network failure and oversized or malformed responses never expose upstream data', async () => {
  for (const [response, code] of [
    [() => { throw Error(apiKey); }, 'unavailable'],
    [new Response('{', { headers: { 'content-type': 'application/json' } }), 'contract'],
    [json({ data: 'x'.repeat(1024 * 1024) }), 'contract'],
  ]) await assert.rejects(fixture({ '/healthz': response }).inspect(), e => e.code === code && !e.message.includes(apiKey));
});
