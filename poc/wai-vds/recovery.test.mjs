import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

test('lost create response survives a process restart with one server, then completed journal makes no new POST', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'openstrudel-vds-recovery-'));
  const token = 'wai_test_' + '2'.repeat(64);
  const orderId = '11111111-1111-4111-8111-111111111111';
  const serverId = '22222222-2222-4222-8222-222222222222';
  let order, server, creations = 0, posts = 0;
  const intents = [];
  const http = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    assert.equal(request.headers.authorization, 'Bearer ' + token);
    const send = data => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
    if (request.method === 'POST') posts++;
    const path = request.url;
    if (path === '/healthz') return send({ ok: true, service: 'wai-vds', provider: 'emulator', payments: 'emulator' });
    if (path === '/api/v1/catalog') return send({ mode: { provider: 'emulator', payments: 'emulator' } });
    if (path === '/api/v1/me') return send({ mode: { provider: 'emulator', payments: 'emulator' }, servers: server ? [server] : [] });
    if (path === '/api/v1/agent/servers') {
      intents.push(body.idempotency_key);
      if (!server) {
        creations++;
        order = { id: orderId, server_id: serverId, idem: body.idempotency_key, purpose: 'agent', mode: 'emulator', status: 'fulfilled' };
        server = { id: serverId, order_id: orderId, purpose: 'agent', mode: 'emulator', state: 'ready' };
        // Provider accepted the intent, but the client never receives its resource IDs.
        response.destroy(); return;
      }
      return send({ order, server, mode: 'emulator', billable: false });
    }
    if (path === '/api/v1/orders/' + orderId) return send(order);
    if (path === '/api/v1/servers/' + serverId) return send(server);
    if (path === '/api/v1/servers/' + serverId + '/cancellation') { server.cancel_at_end = body.cancel_at_end; return send(server); }
    if (path === '/api/v1/servers/' + serverId + '/delete') { assert.equal(body.confirm, serverId); server.state = 'deleted'; return send({ ok: true }); }
    response.writeHead(404); response.end();
  });
  t.after(async () => { await new Promise(resolve => http.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const envFile = join(directory, '.env');
  writeFileSync(envFile, 'WAI_VDS_BASE_URL=http://127.0.0.1:' + http.address().port + '\nWAI_VDS_API_KEY=' + token + '\n', { mode: 0o600 });
  const evidenceDir = join(directory, 'evidence');
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('smoke.mjs', import.meta.url)), '--env-file', envFile, '--evidence-dir', evidenceDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
  });
  const first = await run(); assert.equal(first.code, 1);
  const saved = JSON.parse(readFileSync(join(evidenceDir, 'trial.json'), 'utf8'));
  assert.equal(saved.phase, 'intent'); assert.equal(saved.serverId, undefined);
  assert.equal(saved.lastError, 'unavailable');
  assert.equal(statSync(join(evidenceDir, 'trial.json')).mode & 0o777, 0o600);
  const second = await run(); assert.equal(second.code, 0, second.output);
  assert.equal(creations, 1); assert.equal(new Set(intents).size, 1);
  assert.equal(intents[0], saved.idempotencyKey); assert.equal(server.state, 'deleted');
  const after = posts;
  const third = await run(); assert.equal(third.code, 0, third.output); assert.equal(posts, after);
  const evidence = JSON.parse(readFileSync(join(evidenceDir, 'evidence.json'), 'utf8'));
  assert.ok(Object.values(evidence.checks).every(Boolean));
  assert.equal(evidence.homeInstalled, false); assert.equal(evidence.payment, 'sandbox_grant_bypasses_checkout');
  for (const text of [first.output, second.output, third.output, readFileSync(join(evidenceDir, 'trial.json'), 'utf8'), JSON.stringify(evidence)]) assert.ok(!text.includes(token));
});
