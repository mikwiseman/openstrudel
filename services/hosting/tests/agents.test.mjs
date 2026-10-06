import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Service, config, DAY } from '../src/service.mjs';
import { createServer } from '../src/main.mjs';

const password = 'agent access test password!';
function fixture(t) {
  mkdirSync('work/test-runs', { recursive: true });
  const dir = mkdtempSync(resolve('work/test-runs/agent-'));
  let now = Date.now();
  const s = new Service(config({ WAI_DATA: dir }), { now: () => now });
  const account = s.register('agent@example.test', password, 'agent-ip');
  t.after(() => { s.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { s, account, advance: n => { now += n; } };
}
const input = (purpose = 'agent', idempotency_key = crypto.randomUUID()) => ({ purpose, idempotency_key, consent: true });
async function ready(s) { for (let i = 0; i < 5; i++) await s.tick(); }

test('API keys are scoped, hashed, expiring and only returned once', t => {
  const { s, account } = fixture(t);
  const issued = s.agents.issue(account.user.id, { name: 'OpenStrudel' });
  assert.match(issued.token, /^wai_test_[a-f0-9]{64}$/);
  assert.equal(issued.key.expires, s.now() + 30 * DAY);
  assert.equal(s.auth(issued.token).user_id, account.user.id);
  assert(!s.auth(issued.token).scopes.includes('sandbox:provision'));
  assert(!JSON.stringify(s.agents.list(account.user.id)).includes(issued.token));
  assert(!JSON.stringify(s.db.all('SELECT * FROM api_keys')).includes(issued.token));
  assert(!JSON.stringify(s.agents.list(account.user.id)).includes('digest'));
  assert.equal(s.agents.list(account.user.id)[0].last_used, s.now());
});

test('expired, revoked, unknown and wrong-environment keys cannot authenticate', t => {
  const { s, account, advance } = fixture(t);
  const key = s.agents.issue(account.user.id, { expires_days: 1 });
  advance(DAY + 1);
  assert.throws(() => s.auth(key.token), e => e.status === 401);
  const second = s.agents.issue(account.user.id);
  s.agents.revoke(account.user.id, second.key.id);
  assert.throws(() => s.auth(second.token), e => e.status === 401);
  assert.throws(() => s.auth('wai_test_' + 'a'.repeat(64)), e => e.status === 401);
  const third = s.agents.issue(account.user.id);
  s.c.provider = 'kamatera';
  assert.throws(() => s.auth(third.token), e => e.status === 401);
});

test('keys cannot escalate through auth routes or key management; foreign keys stay private', t => {
  const { s, account } = fixture(t);
  const key = s.agents.issue(account.user.id);
  const session = s.auth(key.token);
  for (const path of ['/api/v1/api-keys', '/api/v1/auth/api-token', '/api/v1/auth/reauth', '/api/v1/auth/register', '/api/v1/auth/logout']) {
    assert.throws(() => s.agents.authorize(session, 'POST', path), e => e.status === 403);
  }
  const other = s.register('other@example.test', password, 'other-ip');
  assert.equal(s.agents.list(other.user.id).length, 0);
  assert.throws(() => s.agents.revoke(other.user.id, key.key.id), e => e.status === 404);
});

test('sandbox provisions every supported purpose and replays one request without duplication', async t => {
  const { s, account } = fixture(t);
  const key = s.agents.issue(account.user.id, { sandbox: true, max_servers: 3 });
  const session = s.auth(key.token);
  for (const purpose of ['agent', 'site', 'clean']) {
    const body = input(purpose);
    const first = s.agents.provision(session, body);
    const replay = s.agents.provision(session, body);
    assert.equal(first.server.id, replay.server.id);
    assert.equal(first.billable, false);
    assert.equal(first.mode, 'emulator');
  }
  await ready(s);
  assert.equal(s.dashboard(account.user.id).servers.length, 3);
  for (const server of s.dashboard(account.user.id).servers) {
    assert.equal(server.state, 'ready');
    assert.match(s.access(account.user.id, server.id, session), /BEGIN OPENSSH PRIVATE KEY/);
  }
  assert.equal(s.db.get('SELECT count(*) n FROM attempts').n, 3);
  assert.equal(s.db.get('SELECT count(*) n FROM payments').n, 0);
});

test('sandbox quota is atomic, includes in-flight servers and releases only after deletion', async t => {
  const { s, account } = fixture(t);
  const { token } = s.agents.issue(account.user.id, { sandbox: true, max_servers: 1 });
  const session = s.auth(token), firstBody = input();
  const first = s.agents.provision(session, firstBody);
  assert.throws(() => s.agents.provision(session, input('site')), e => e.status === 409);
  await ready(s);
  s.remove(account.user.id, first.server.id, { confirm: first.server.id }, session);
  assert.throws(() => s.agents.provision(session, input('site')), e => e.status === 409);
  await ready(s);
  assert.equal(s.agents.provision(session, firstBody).server.id, first.server.id);
  assert.notEqual(s.agents.provision(session, input('site')).server.id, first.server.id);
});

test('sandbox needs an operator grant and cannot run with real infrastructure or payments', t => {
  const { s, account } = fixture(t);
  const ordinary = s.auth(s.agents.issue(account.user.id).token);
  assert.throws(() => s.agents.provision(ordinary, input()), e => e.status === 403);
  const sandbox = s.auth(s.agents.issue(account.user.id, { sandbox: true }).token);
  s.c.provider = 'kamatera';
  assert.throws(() => s.agents.provision(sandbox, input()), e => e.status === 409);
  s.c.provider = 'emulator'; s.c.payments = 'stripe_test';
  assert.throws(() => s.agents.provision(sandbox, input()), e => e.status === 409);
  assert.equal(s.db.get('SELECT count(*) n FROM servers').n, 0);
});

test('coalesced idempotency aliases stay bound after readiness and deletion', async t => {
  const { s, account } = fixture(t);
  const session = s.auth(s.agents.issue(account.user.id, { sandbox: true }).token);
  const first = s.agents.provision(session, input('agent', 'request-number-one'));
  const second = s.agents.provision(session, input('agent', 'request-number-two'));
  assert.equal(first.server.id, second.server.id);
  await ready(s);
  assert.equal(s.agents.provision(session, input('agent', 'request-number-two')).server.id, first.server.id);
  s.remove(account.user.id, first.server.id, { confirm: first.server.id }, session);
  await ready(s);
  assert.equal(s.agents.provision(session, input('agent', 'request-number-two')).server.id, first.server.id);
  assert.equal(s.db.get('SELECT count(*) n FROM servers').n, 1);
  assert.throws(() => s.agents.provision(session, input('site', 'request-number-two')), e => e.status === 409);
});

test('public subpath preserves origins, cookie scope, checkout delivery and API discovery', async t => {
  const { s } = fixture(t), server = createServer(s);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  s.c.origin = origin + '/vds'; s.c.basePath = '/vds';
  t.after(() => new Promise(resolve => server.close(resolve)));
  const docs = await (await fetch(s.c.origin + '/openapi.json')).json();
  assert.equal(docs.servers[0].url, s.c.origin + '/api/v1');
  const registration = await fetch(s.c.origin + '/api/v1/auth/register', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'subpath@example.test', password }) });
  assert.equal(registration.status, 200);
  assert.match(registration.headers.get('set-cookie'), /Path=\/vds;/);
  const { csrf } = await registration.json(), cookie = registration.headers.get('set-cookie').split(';')[0];
  const post = async (path, body) => fetch(s.c.origin + path, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const order = await (await post('/api/v1/orders', input())).json();
  const payment = await (await post('/api/v1/orders/' + order.id + '/checkout', {})).json();
  assert(payment.url.startsWith(s.c.origin + '/checkout/'));
  const result = await fetch(payment.url + '/result', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ result: 'success' }) });
  assert.equal(result.status, 200);
  assert((await result.json()).return_url.startsWith(s.c.origin + '/?order='));
  assert.equal(s.db.get('SELECT count(*) n FROM servers').n, 1);
});

test('HTTP agent flow exposes public docs, isolates ownership and prevents self-granted sandbox', async t => {
  const { s, account } = fixture(t);
  const server = createServer(s);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  s.c.origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async (path, method = 'GET', body, token) => fetch(s.c.origin + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const docs = await request('/openapi.json');
  assert.equal(docs.status, 200);
  assert((await docs.json()).paths['/agent/servers']);
  assert.match(await (await request('/llms.txt')).text(), /sandbox:provision/);
  const normal = s.agents.issue(account.user.id);
  assert.equal((await request('/api/v1/agent/servers', 'POST', input(), normal.token)).status, 403);
  assert.equal((await request('/api/v1/api-keys', 'POST', { name: 'Escalate', password, sandbox: true }, normal.token)).status, 403);
  const registered = await fetch(s.c.origin + '/api/v1/api-keys', { method: 'POST', headers: { Origin: s.c.origin, Cookie: 'wai_session=' + account.token, 'X-CSRF-Token': account.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Human key', password, sandbox: true, max_servers: 999 }) });
  assert.equal(registered.status, 201);
  assert(!(await registered.json()).key.scopes.includes('sandbox:provision'));
  const sandbox = s.agents.issue(account.user.id, { sandbox: true });
  const created = await request('/api/v1/agent/servers', 'POST', input(), sandbox.token);
  assert.equal(created.status, 202);
  const job = await created.json();
  await ready(s);
  assert.equal((await (await request(job.poll_url, 'GET', null, sandbox.token)).json()).state, 'ready');
  const access = await request(job.poll_url + '/access', 'POST', {}, sandbox.token);
  assert.equal(access.status, 200); assert.equal(access.headers.get('cache-control'), 'no-store');
  assert.match(await access.text(), /OPENSSH PRIVATE KEY/);
  const other = s.register('outsider@example.test', password, 'outsider');
  const otherKey = s.agents.issue(other.user.id);
  assert.equal((await request(job.poll_url, 'GET', null, otherKey.token)).status, 404);
  s.agents.revoke(account.user.id, sandbox.key.id);
  assert.equal((await request(job.poll_url, 'GET', null, sandbox.token)).status, 401);
});
