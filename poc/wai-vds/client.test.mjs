import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaseURL, presentServer, WaiVdsSandboxClient } from './client.mjs';

const key = 'wai_test_' + '1'.repeat(64);
const orderId = '11111111-1111-4111-8111-111111111111';
const serverId = '22222222-2222-4222-8222-222222222222';
const trial = { orderId, serverId, idempotencyKey: 'openstrudel-test-001' };
const order = { id: orderId, server_id: serverId, idem: trial.idempotencyKey, purpose: 'agent', mode: 'emulator', status: 'fulfilled' };
const server = { id: serverId, order_id: orderId, purpose: 'agent', mode: 'emulator', state: 'ready', cancel_at_end: false };
const catalog = { mode: { provider: 'emulator', payments: 'emulator' }, plan: {
  id: 'start', ram_mb: 2048, disk_gb: 20, ipv4: 1, amount: 1200, currency: 'usd', period_days: 30,
} };
const granted = { mode: 'emulator', billable: false, order, server };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function fixture(overrides = {}, baseURL = 'http://127.0.0.1:4781') {
  const calls = [];
  const defaults = {
    '/healthz': { ok: true, service: 'wai-vds', provider: 'emulator', payments: 'emulator' },
    '/api/v1/catalog': catalog, '/api/v1/agent/servers': granted,
    ['/api/v1/orders/' + orderId]: order, ['/api/v1/servers/' + serverId]: server,
    ['/api/v1/servers/' + serverId + '/delete']: { ok: true },
    ['/api/v1/servers/' + serverId + '/cancellation']: { ...server, cancel_at_end: true },
    '/api/v1/me': { mode: catalog.mode, user: { email: 'private@example.test' }, servers: [server] },
  };
  const client = new WaiVdsSandboxClient({ baseURL, apiKey: key, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const path = url.slice(baseURL.length);
    const data = Object.hasOwn(overrides, path) ? overrides[path] : defaults[path];
    if (typeof data === 'function') return data(options);
    assert.notEqual(data, undefined, path);
    return data instanceof Response ? data : json(data);
  } });
  return { client, calls };
}
const writes = calls => calls.filter(c => c.options.method === 'POST');

test('public deployment prefix is retained; redirects are forbidden and keys stay in headers', async () => {
  const { client, calls } = fixture({}, 'https://pay.example.test/vds');
  await client.createTrial(trial.idempotencyKey);
  assert.equal(calls.at(-1).url, 'https://pay.example.test/vds/api/v1/agent/servers');
  for (const call of calls) {
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.Authorization, 'Bearer ' + key);
    assert.ok(!call.url.includes(key));
  }
  assert.ok(!JSON.stringify(client).includes(key));
});
test('configuration rejects cleartext remote hosts, credential URLs and queries', () => {
  for (const value of ['http://remote.test', 'https://user:password@example.test', 'https://example.test/?key=secret', 'https://example.test/#key']) {
    assert.throws(() => normalizeBaseURL(value), { code: 'configuration' });
  }
});
test('live or unscoped credentials cannot initialize the sandbox client', () => {
  for (const apiKey of ['wai_live_' + 'a'.repeat(64), 'a'.repeat(64), '']) {
    assert.throws(() => new WaiVdsSandboxClient({ baseURL: 'http://localhost:4781', apiKey }), { code: 'sandbox_required' });
  }
});
test('live provider, live payment and missing modes stop before any mutation', async () => {
  for (const mode of [{ provider: 'kamatera', payments: 'emulator' }, { provider: 'emulator', payments: 'wai_pay' }, {}, { ...catalog.mode, payment_live: true }]) {
    const { client, calls } = fixture({ '/api/v1/catalog': { ...catalog, mode } });
    await assert.rejects(client.createTrial(trial.idempotencyKey), { code: 'sandbox_required' });
    assert.equal(writes(calls).length, 0);
  }
});
test('health and catalog must agree on an emulated WAI VDS service', async () => {
  const { client, calls } = fixture({ '/healthz': { ok: true, service: 'wai-vds', provider: 'kamatera', payments: 'emulator' } });
  await assert.rejects(client.createTrial(trial.idempotencyKey), { code: 'sandbox_required' });
  assert.equal(writes(calls).length, 0);
});
test('current resource profile fails Home acceptance even when sandbox API works', async () => {
  const { assessment } = await fixture().client.preflight();
  assert.equal(assessment.matchingResourceProfile, false);
  assert.ok(assessment.blockers.includes('insufficient_memory'));
  assert.ok(assessment.blockers.includes('insufficient_disk'));
  assert.equal(assessment.readyForPublicSales, false);
});
test('same stable intent is sent on a deliberate idempotency replay', async () => {
  const { client, calls } = fixture();
  assert.deepEqual(await client.createTrial(trial.idempotencyKey), trial);
  assert.deepEqual(await client.createTrial(trial.idempotencyKey), trial);
  assert.equal(writes(calls)[0].options.body, writes(calls)[1].options.body);
});
test('network uncertainty does not repeat the POST automatically or leak its error', async () => {
  const { client, calls } = fixture({ '/api/v1/agent/servers': () => { throw Error('secret=' + key); } });
  await assert.rejects(client.createTrial(trial.idempotencyKey), e => e.code === 'unavailable' && !e.message.includes(key));
  assert.equal(writes(calls).length, 1);
});
test('a server-side pending-order alias cannot become an owned cleanup target', async () => {
  const { client } = fixture({ '/api/v1/agent/servers': { ...granted, order: { ...order, idem: 'another-existing-order' } } });
  await assert.rejects(client.createTrial(trial.idempotencyKey), { code: 'contract' });
});
test('billable or malformed acknowledgement cannot pass as a free trial', async () => {
  for (const result of [{ ...granted, billable: true }, { ...granted, mode: 'kamatera' }]) {
    await assert.rejects(fixture({ '/api/v1/agent/servers': result }).client.createTrial(trial.idempotencyKey), { code: 'sandbox_required' });
  }
  await assert.rejects(fixture({ '/api/v1/agent/servers': { ...granted, server: { ...server, order_id: serverId } } }).client.createTrial(trial.idempotencyKey), { code: 'contract' });
});
test('VM readiness never enables Home, OpenAI login or automatic replacement', () => {
  for (const mode of ['emulator', 'kamatera']) {
    const result = presentServer({ ...server, mode });
    assert.equal(result.homeReady, false); assert.equal(result.canStartOpenAI, false); assert.equal(result.canCreateReplacement, false);
    assert.equal(result.phase, mode === 'emulator' ? 'sandboxReady' : 'homeInstallationRequired');
  }
  for (const state of ['unknown', 'attention', 'rejected']) assert.equal(presentServer({ ...server, state }).phase, 'needsReview');
});
test('an unexpected server state fails closed', () => {
  assert.throws(() => presentServer({ ...server, state: 'home-ready' }), { code: 'contract' });
});
test('status checks read the existing order and retain sandbox payment attribution', async () => {
  const { client, calls } = fixture();
  const status = await client.status(trial);
  assert.equal(status.phase, 'sandboxReady'); assert.equal(status.payment, 'sandbox_grant');
  assert.equal(writes(calls).length, 0);
});
test('cleanup verifies exact order, original intent and server relationship before deletion', async () => {
  for (const bad of [{ ...order, idem: 'someone-else' }, { ...order, server_id: orderId }, { ...order, mode: 'kamatera' }]) {
    const { client, calls } = fixture({ ['/api/v1/orders/' + orderId]: bad });
    await assert.rejects(client.deleteTrial(trial), { code: 'contract' });
    assert.equal(writes(calls).length, 0);
  }
});
test('deleting or deleted resources never receive another deletion request', async () => {
  for (const state of ['deleting', 'deleted']) {
    const { client, calls } = fixture({ ['/api/v1/servers/' + serverId]: { ...server, state } });
    await client.deleteTrial(trial); assert.equal(writes(calls).length, 0);
  }
});
test('cancellation and deletion use only the verified server ID', async () => {
  const { client, calls } = fixture();
  await client.cancelAtPeriodEnd(trial); await client.deleteTrial(trial);
  assert.deepEqual(writes(calls).map(c => JSON.parse(c.options.body)), [{ cancel_at_end: true }, { confirm: serverId }]);
});
test('expired access has a distinct action and no raw server diagnostics', async () => {
  const { client, calls } = fixture({ ['/api/v1/orders/' + orderId]: json({ error: key }, 401) });
  await assert.rejects(client.status(trial), e => e.code === 'access_expired' && !e.message.includes(key));
  assert.equal(writes(calls).length, 0);
});
test('rate limit preserves Retry-After and never retries automatically', async () => {
  const { client, calls } = fixture({ '/healthz': json({ error: key }, 429, { 'retry-after': '37' }) });
  await assert.rejects(client.preflight(), { code: 'rate_limited', retryAfterSeconds: 37 });
  assert.equal(calls.length, 1);
});
test('malformed, oversized and non-JSON responses are rejected', async () => {
  for (const response of [new Response('secret', { headers: { 'content-type': 'text/plain' } }), new Response('{', { headers: { 'content-type': 'application/json' } }), json({ oversized: 'x'.repeat(1024 * 1024) })]) {
    await assert.rejects(fixture({ '/healthz': response }).client.preflight(), { code: 'contract' });
  }
});
test('inventory returns no account details or access keys', async () => {
  const inventory = await fixture().client.inventory();
  assert.deepEqual(inventory, [{ id: serverId, state: 'ready', mode: 'emulator' }]);
  assert.ok(!JSON.stringify(inventory).includes('private@'));
});
