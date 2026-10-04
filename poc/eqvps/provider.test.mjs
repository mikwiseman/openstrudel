import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EqvpsProbe, selectHomeOffers, readPartnerToken } from './provider.mjs';

const token = 'rk_fixture_only_not_a_real_key';
const catalog = { data: [{
  id: 12, slug: 'fixture-ip',
  specs: { network: 'dedicated', ipv4: 1, memory_mb: 4096, disk_gb: 40 },
  available_os: [{ id: 4, name: 'Ubuntu 24.04' }],
  plans: [
    { plan_id: 20, amount: 5, period: 'year', currency: 'USD' },
    { plan_id: 12, amount: 16, period: 'month', currency: 'USD' },
  ],
}] };
const tool = { name: 'reseller_order_for_client', inputSchema: {
  type: 'object', properties: { test: { type: 'boolean' }, plan_id: { type: 'integer' }, client_id: { type: 'string' }, os_id: { type: 'integer' } },
  required: ['plan_id', 'client_id'],
} };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const rpc = (id, result) => json({ jsonrpc: '2.0', id, result });

test('catalog excludes NAT, insufficient RAM/disk, unavailable OS and non-USD monthly quotes', () => {
  const base = catalog.data[0];
  const modified = (patch, specs = {}) => ({ ...base, ...patch, specs: { ...base.specs, ...specs } });
  const offers = selectHomeOffers({ data: [
    base,
    modified({ slug: 'nat' }, { network: 'nat', ipv4: 0 }),
    modified({ slug: 'small' }, { memory_mb: 2048 }),
    modified({ slug: 'tiny-disk' }, { disk_gb: 20 }),
    modified({ slug: 'ipv6-only' }, { ipv4: 0 }),
    modified({ slug: 'wrong-os', available_os: [{ id: 1, name: 'Ubuntu 22.04' }] }),
    modified({ slug: 'wrong-currency', plans: [{ plan_id: 15, amount: 12, period: 'month', currency: 'EUR' }] }),
    modified({ slug: 'annual-only', plans: [{ plan_id: 20, amount: 5, period: 'year', currency: 'USD' }] }),
  ] });
  assert.equal(offers.offers.length, 1);
  assert.equal(offers.recommendedReference.osId, 4);
  assert.equal(offers.recommendedReference.monthlyUSD, 16);
  assert.equal(offers.capacityVerified, false);
  assert.equal(offers.pricingBasis, 'public_retail_catalog_not_reseller_quote');
});

test('cheapest qualifying public plan is a reference, with no invented availability or wholesale quote', () => {
  const base = catalog.data[0];
  const cheaper = { ...base, slug: 'cheaper', plans: [{ plan_id: 14, amount: 15, period: 'month', currency: 'USD' }] };
  assert.equal(selectHomeOffers({ data: [base, cheaper] }).recommendedReference.product, 'cheaper');
  assert.equal(selectHomeOffers({ data: [] }).recommendedReference, null);
  assert.throws(() => selectHomeOffers({ products: [] }), { code: 'invalid_catalog' });
});

test('read-only probe uses fixed HTTPS endpoints, prohibits redirects and keeps credentials off public catalog', async () => {
  const calls = [];
  const probe = new EqvpsProbe({ token, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'GET') return json(catalog);
    const body = JSON.parse(init.body);
    assert.equal(body.method, 'tools/list');
    return rpc(body.id, { tools: [] });
  } });
  await probe.publicCatalog();
  const capabilities = await probe.capabilities();
  assert.equal(calls[0].url, 'https://api.eqvps.com/api/v1/eqvps/products');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[1].url, 'https://mcp.eqvps.com/mcp');
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${token}`);
  assert.ok(calls.every(call => call.init.redirect === 'error'));
  assert.equal(capabilities.resellerOrderVisible, false);
  assert.equal(capabilities.readyForPaidProvisioning, false);
});

test('SSE accepts split multiline events, skips other IDs, and closes the stream after its response', async () => {
  let cancelled = false;
  const probe = new EqvpsProbe({ fetchImpl: async (_url, init) => {
    const id = JSON.parse(init.body).id;
    const payload = `: heartbeat\r\n\r\ndata: {"jsonrpc":"2.0","id":"unrelated","result":{}}\r\n\r\ndata: {"jsonrpc":"2.0","id":"${id}",\r\ndata: "result":{"tools":[]}}\r\n\r\n`;
    const bytes = new TextEncoder().encode(payload);
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.slice(0, 37)); controller.enqueue(bytes.slice(37)); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  } });
  assert.equal((await probe.capabilities()).toolCount, 0);
  assert.equal(cancelled, true);
});

test('tool pagination discovers the reseller schema on later pages and rejects a looping cursor', async () => {
  const cursors = [];
  const probe = new EqvpsProbe({ token, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    cursors.push(body.params.cursor);
    return rpc(body.id, body.params.cursor ? { tools: [tool] } : { tools: [], nextCursor: 'page-two' });
  } });
  assert.equal((await probe.capabilities()).dryRunAdvertised, true);
  assert.deepEqual(cursors, [undefined, 'page-two']);
  const looping = new EqvpsProbe({ fetchImpl: async (_url, init) => rpc(JSON.parse(init.body).id, { tools: [], nextCursor: 'same' }) });
  await assert.rejects(looping.capabilities(), { code: 'incomplete_tool_list' });
});

test('dry-run requires a partner key before any network request', async () => {
  let calls = 0;
  const probe = new EqvpsProbe({ fetchImpl: async () => { calls++; throw new Error('must not call'); } });
  await assert.rejects(probe.dryRun({ planId: '1', clientId: 'client' }), { code: 'partner_account_required' });
  assert.equal(calls, 0);
});

test('dry-run refuses absent, undocumented or false-only test schemas without submitting an order', async () => {
  for (const testSchema of [undefined, { type: 'string' }, { type: 'boolean', const: false }, { type: 'boolean', enum: [false] }]) {
    const changed = structuredClone(tool);
    changed.inputSchema.properties.test = testSchema;
    let calls = 0;
    const probe = new EqvpsProbe({ token, fetchImpl: async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      assert.equal(body.method, 'tools/list');
      return rpc(body.id, { tools: [changed] });
    } });
    await assert.rejects(probe.dryRun({ planId: '1', clientId: 'client' }), { code: 'dry_run_not_advertised' });
    assert.equal(calls, 1);
  }
});

test('accepted dry-run sends test=true once and never includes returned credentials in its report', async () => {
  const calls = [];
  const secret = 'root-password-not-for-output';
  const probe = new EqvpsProbe({ token, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return rpc(body.id, body.method === 'tools/list' ? { tools: [tool] }
      : { content: [{ type: 'text', text: JSON.stringify({ root_password: secret, token }) }], isError: false });
  } });
  const result = await probe.dryRun({ planId: '9', clientId: 'existing-client', osId: '4' });
  assert.deepEqual(calls[1].params, { name: 'reseller_order_for_client', arguments: { plan_id: 9, client_id: 'existing-client', os_id: 4, test: true } });
  assert.equal(calls.length, 2);
  assert.equal(result.realServerVerified, false);
  assert.equal(result.paymentVerified, false);
  assert.equal(result.requestSentWithTestTrue, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('unknown required fields and mismatched IDs block the order', async () => {
  for (const required of [['plan_id', 'client_id', 'consent'], ['plan_id', 'client_id']]) {
    const changed = structuredClone(tool);
    changed.inputSchema.required = required;
    const probe = new EqvpsProbe({ token, fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.method, 'tools/list');
      return rpc(body.id, { tools: [changed] });
    } });
    await assert.rejects(probe.dryRun({ planId: required.includes('consent') ? '1' : 'not-a-number', clientId: 'test-client' }),
      { code: required.includes('consent') ? 'additional_order_fields' : 'unknown_identifier_schema' });
  }
});

test('a timeout after a test request does not trigger any retry or paid fallback', async () => {
  let orders = 0;
  const probe = new EqvpsProbe({ token, timeoutMs: 10, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'tools/list') return rpc(body.id, { tools: [tool] });
    orders++;
    assert.equal(body.params.arguments.test, true);
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error(`unsafe ${token}`)), { once: true }));
  } });
  await assert.rejects(probe.dryRun({ planId: '9', clientId: 'client' }), { code: 'timeout' });
  assert.equal(orders, 1);
});

test('HTTP errors expose a safe status without upstream bodies, tokens, or passwords', async () => {
  for (const [status, code] of [[401, 'auth_required'], [403, 'auth_required'], [429, 'rate_limited'], [503, 'provider_http_error']]) {
    const probe = new EqvpsProbe({ token, fetchImpl: async () => new Response(`password ${token}`, { status }) });
    await assert.rejects(probe.capabilities(), error => {
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.message.includes(token), false);
      return true;
    });
  }
});

test('malformed, oversized, HTML, and mismatched RPC responses fail closed', async () => {
  for (const [response, code] of [
    [new Response('{broken', { headers: { 'content-type': 'application/json' } }), 'invalid_json'],
    [json({ jsonrpc: '2.0', id: 'wrong-id', result: { tools: [] } }), 'invalid_rpc'],
    [new Response('<html>challenge</html>', { headers: { 'content-type': 'text/html' } }), 'unexpected_content'],
    [json('x'.repeat(2 * 1024 * 1024)), 'response_too_large'],
  ]) {
    await assert.rejects(new EqvpsProbe({ fetchImpl: async () => response }).capabilities(), { code });
  }
});

test('RPC and tool errors are not mistaken for a successful simulation', async () => {
  const rpcError = new EqvpsProbe({ fetchImpl: async (_url, init) => json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, error: { code: -1, message: token } }) });
  await assert.rejects(rpcError.capabilities(), { code: 'rpc_error' });
  const toolError = new EqvpsProbe({ token, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    return rpc(body.id, body.method === 'tools/list' ? { tools: [tool] } : { isError: true, content: [{ type: 'text', text: token }] });
  } });
  await assert.rejects(toolError.dryRun({ planId: '9', clientId: 'client' }), { code: 'dry_run_rejected' });
});

test('token file requires private permissions, owned regular file, and no symlink', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'openstrudel-eqvps-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'partner-token');
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  assert.equal(await readPartnerToken(path), token);
  await chmod(path, 0o644);
  await assert.rejects(readPartnerToken(path), { code: 'unsafe_token_file' });
  await chmod(path, 0o600);
  const link = join(dir, 'linked-token');
  await symlink(path, link);
  await assert.rejects(readPartnerToken(link), { code: 'token_file_unavailable' });
  assert.throws(() => new EqvpsProbe({ token: 'not-a-partner-key' }), { code: 'invalid_token' });
});
