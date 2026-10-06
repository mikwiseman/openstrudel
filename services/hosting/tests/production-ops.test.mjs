import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Vault } from '../src/security.mjs';
import { snapshot, verifySnapshot, restoreTar, recordArchive, pruneArchives, PAYLOAD } from '../scripts/production-backup.mjs';
import { decideMonitor, probeBusiness } from '../scripts/production-monitor.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wai-ops-test-'));t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');mkdirSync(data, { mode: 0o700 });
  const vault = new Vault(data), keys = vault.keypair('fixture-server');
  const db = new DatabaseSync(join(data, 'wai.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE orders(id TEXT PRIMARY KEY); CREATE TABLE api_keys(id TEXT PRIMARY KEY); CREATE TABLE servers(id TEXT PRIMARY KEY,private_key TEXT,public_key TEXT); CREATE TABLE recovery_keys(id TEXT); PRAGMA user_version=7;');
  db.prepare('INSERT INTO servers VALUES(?,?,?)').run('fixture-server', keys.privateKey, keys.publicKey);
  t.after(() => db.close());
  const env = join(root, 'runtime.env'), release = join(root, 'current-release');
  writeFileSync(env, 'WAI_PROVIDER=emulator\nWAI_PAYMENTS=emulator\nPRIVATE_TEST_VALUE=fixture-only\n', { mode: 0o600 });
  writeFileSync(release, 'test-release\n', { mode: 0o600 });
  return { root, data, env, release, output: join(root, 'snapshot'), db };
}
function ageBinary(name) {
  for (const p of [process.env[name === 'age' ? 'WAI_AGE_BIN' : 'WAI_AGE_KEYGEN_BIN'], join(homedir(), '.local/bin', name), name].filter(Boolean)) {
    try { execFileSync(p, ['--version'], { stdio: 'ignore' });return p; } catch {}
  }
}
test('online snapshot includes committed WAL and restores keys with additive schema 7', async t => {
  const f = fixture(t);const result = await snapshot(f);
  assert.equal(result.schema, 7);assert.equal(result.encrypted_server_keys_verified, 1);
  assert.deepEqual(readdirSync(f.output).sort(), [...PAYLOAD, 'manifest.json'].sort());
  f.db.prepare('INSERT INTO users VALUES(?)').run('later');
  const restored = new DatabaseSync(join(f.output, 'wai.sqlite'), { readOnly: true });
  assert.equal(restored.prepare('SELECT count(*) n FROM users').get().n, 0);restored.close();
  assert.equal(verifySnapshot(f.output).integrity, 'ok');
});
test('tampered snapshot is rejected, including wrong master with an updated file checksum', async t => {
  const f = fixture(t);await snapshot(f);
  writeFileSync(join(f.output, 'master.key'), Buffer.alloc(32, 9));
  assert.throws(() => verifySnapshot(f.output), /digest/);
  const path = join(f.output, 'manifest.json'), m = JSON.parse(readFileSync(path));
  m.files['master.key'] = createHash('sha256').update(Buffer.alloc(32, 9)).digest('hex');writeFileSync(path, JSON.stringify(m));
  assert.throws(() => verifySnapshot(f.output));
});
test('snapshot rejects a symlinked configuration and never overwrites an output', async t => {
  const f = fixture(t), link = join(f.root, 'link.env');symlinkSync(f.env, link);
  await assert.rejects(snapshot({ ...f, env: link }));
  await snapshot(f);await assert.rejects(snapshot(f), /not_empty/);
});
test('real age encryption/decryption restores the tar; corrupted ciphertext is rejected', async t => {
  const age = ageBinary('age'), keygen = ageBinary('age-keygen');
  if (!age || !keygen) { t.skip('Install reviewed age package to run this integration check');return; }
  const f = fixture(t);await snapshot(f);
  const identity = join(f.root, 'identity'), tar = join(f.root, 'payload.tar'), encrypted = join(f.root, 'backup.age'), decoded = join(f.root, 'decoded.tar');
  execFileSync(keygen, ['-o', identity], { stdio: 'ignore' });const recipient = execFileSync(keygen, ['-y', identity], { encoding: 'utf8' }).trim();
  execFileSync('tar', ['--format=ustar', '-C', f.output, '-cf', tar, ...PAYLOAD, 'manifest.json'], { stdio: 'ignore' });
  execFileSync(age, ['-r', recipient, '-o', encrypted, tar], { stdio: 'ignore' });
  execFileSync(age, ['-d', '-i', identity, '-o', decoded, encrypted], { stdio: 'ignore' });
  const verified = restoreTar(decoded, join(f.root, 'restored'));
  assert.equal(verified.encrypted_server_keys_verified, 1);assert.equal(verified.schema, 7);
  const damaged = readFileSync(encrypted);damaged[damaged.length - 1] ^= 1;writeFileSync(encrypted, damaged);
  assert.throws(() => execFileSync(age, ['-d', '-i', identity, '-o', join(f.root, 'bad.tar'), encrypted], { stdio: 'ignore' }));
});
test('restore rejects path traversal before creating any output files', async t => {
  const f = fixture(t);await snapshot(f);const tar = join(f.root, 'payload.tar');
  execFileSync('tar', ['--format=ustar', '-C', f.output, '-cf', tar, ...PAYLOAD, 'manifest.json'], { stdio: 'ignore' });
  const b = readFileSync(tar);b.fill(0, 0, 100);b.write('../outside', 0);b.fill(32, 148, 156);
  let sum = 0;for (let i = 0; i < 512; i++) sum += b[i];b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);writeFileSync(tar, b);
  const output = join(f.root, 'rejected');assert.throws(() => restoreTar(tar, output), /member/);assert.equal(existsSync(output), false);assert.equal(existsSync(join(f.root, 'outside')), false);
});
test('retention bounds managed archives while keeping the last verified restore', t => {
  const f = fixture(t), dir = join(f.root, 'archives');mkdirSync(dir);
  const names = Array.from({ length: 8 }, (_, i) => `wai-vds-2026100${i + 1}T000000Z-${i.toString(16).padStart(8, '0')}.tar.age`);
  for (const [i, n] of names.entries()) { writeFileSync(join(dir, n), 'age-encryption.org/v1\nfixture' + i);const m = recordArchive(dir, n);if (i === 0) recordArchive(dir, n, true, m.sha256); }
  writeFileSync(join(dir, 'unrelated-file'), 'retain');
  const r = pruneArchives(dir, 3);assert.equal(r.retained, 4);assert.equal(existsSync(join(dir, names[0])), true);assert.equal(existsSync(join(dir, names[7])), true);assert.equal(existsSync(join(dir, 'unrelated-file')), true);
  assert.throws(() => recordArchive(dir, names[7], true, '0'.repeat(64)), /hash/);
});

const id = 'a'.repeat(64), imageId = 'sha256:' + 'b'.repeat(64);
function healthy() { return { release: 'test-release', expectedImageId: imageId, container: { id, name: '/wai-vds', image: 'wai-vds:test-release', imageId, project: 'wai-vds', service: 'wai-vds', running: true, status: 'running', health: 'healthy', dataSource: '/srv/wai-vds/data', dataDestination: '/var/lib/wai-vds' }, internal: { ok: true, service: 'wai-vds', provider: 'kamatera', payments: 'wai_pay' }, public: { ok: true, service: 'wai-vds' } }; }
test('healthy, maintenance, external path failures and stopped containers never restart', () => {
  const good = healthy();assert.equal(decideMonitor(good).action, 'none');
  assert.equal(decideMonitor({ ...good, maintenance: true }).action, 'none');
  assert.equal(decideMonitor({ ...good, public: {} }).reason, 'public_path_failure');
  assert.equal(decideMonitor({ ...good, internal: {}, container: { ...good.container, running: false, status: 'exited' } }).reason, 'service_stopped');
});
test('only exact ownership and three consecutive internal failures permit one restart', () => {
  const bad = healthy();bad.internal = {};bad.container.health = 'unhealthy';let state;
  for (let i = 0; i < 2; i++) { const r = decideMonitor(bad, state, 1000000 + i * 120000);assert.equal(r.action, 'alert');state = r.state; }
  const recovered = decideMonitor(bad, state, 1240000);assert.equal(recovered.action, 'restart');assert.equal(recovered.containerId, id);
  assert.equal(decideMonitor({ ...bad, container: { ...bad.container, project: 'wai-pay' } }, state).reason, 'ownership_mismatch');
  assert.equal(decideMonitor({ ...bad, expectedImageId: 'sha256:' + 'c'.repeat(64) }, state).reason, 'ownership_mismatch');
  assert.equal(decideMonitor({ ...bad, container: { ...bad.container, id: 'c'.repeat(64) } }, state).action, 'alert');
});
test('restart cooldown, daily budget and backwards clock fail safely', () => {
  const bad = healthy();bad.internal = {};bad.container.health = 'unhealthy';
  for (const restarts of [[1000000], [1000000, 4000000], [9000000]]) {
    const now = restarts.length === 2 ? 8000000 : 1200000;
    assert.equal(decideMonitor(bad, { containerId: id, failures: 2, restarts }, now).reason, 'recovery_budget_exhausted');
  }
});
test('intermittent health resets the consecutive failure counter', () => {
  const bad = healthy();bad.internal = {};bad.container.health = 'unhealthy';
  const a = decideMonitor(bad);const b = decideMonitor(healthy(), a.state);const c = decideMonitor(bad, b.state);
  assert.equal(c.state.failures, 1);assert.equal(c.action, 'alert');
});
test('missing or stale backup and independent copy alert without restarting a healthy app', () => {
  const now = 200000000, good = healthy();
  assert.equal(decideMonitor({ ...good, backup: { latest: null, verified: null } }, {}, now).reason, 'backup_stale');
  assert.equal(decideMonitor({ ...good, backup: { latest: now, verified: now - 49 * 3600000 } }, {}, now).reason, 'independent_restore_verification_stale');
  assert.equal(decideMonitor({ ...good, backup: { latest: now, verified: now } }, {}, now).action, 'none');
});

function businessFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wai-monitor-test-')), file = join(root, 'live.sqlite'), db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE orders(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE servers(id TEXT PRIMARY KEY,provider_mode TEXT,state TEXT,created INTEGER,error TEXT,provider_id TEXT);
    CREATE TABLE attempts(server_id TEXT,state TEXT);
    CREATE TABLE operations(server_id TEXT,state TEXT,updated INTEGER);
    CREATE TABLE api_keys(id TEXT PRIMARY KEY,user_id TEXT,revoked INTEGER,expires INTEGER,mode TEXT);
    INSERT INTO settings VALUES('mode','kamatera:wai_pay:live');
    INSERT INTO users VALUES('critical-user'); PRAGMA user_version=7;`);
  t.after(() => { db.close();rmSync(root, { recursive: true, force: true }); });
  return { root, file, db };
}
const clearBusiness = () => ({ ok: true, needs_refund: 0, stuck_provisioning: 0, delete_attention: 0, openstrudel_no_valid_key: 0 });

test('business probe reads committed WAL without creating, migrating or changing the database', t => {
  const f = businessFixture(t);f.db.prepare('INSERT INTO orders VALUES(?,?)').run('fixture-order', 'needs_refund');
  const paths = [f.file, f.file + '-wal'], digest = () => paths.map(p => createHash('sha256').update(readFileSync(p)).digest('hex'));
  const before = digest(), result = probeBusiness(f.file);
  assert.equal(result.needs_refund, 1);assert.deepEqual(digest(), before);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.equal(f.db.prepare('SELECT count(*) n FROM orders').get().n, 1);
  const missing = join(f.root, 'does-not-exist.sqlite');assert.throws(() => probeBusiness(missing));assert.equal(existsSync(missing), false);
});

test('business alerts use creation age despite worker retries and exclude resolved refunded VMs', t => {
  const f = businessFixture(t), now = 90000000, old = now - 31 * 60000;
  const server = (id, state, { created = old, error = null, providerId = null, mode = 'kamatera' } = {}) => f.db.prepare('INSERT INTO servers VALUES(?,?,?,?,?,?)').run(id, mode, state, created, error, providerId);
  f.db.prepare('INSERT INTO orders VALUES(?,?)').run('refund-needed', 'needs_refund');
  f.db.prepare('INSERT INTO orders VALUES(?,?)').run('refund-done', 'refunded');
  server('stalled-retries', 'creating');f.db.prepare('INSERT INTO operations VALUES(?,?,?)').run('stalled-retries', 'creating', now);
  server('young', 'checking', { created: now - 30 * 60000 + 1 });
  for (const state of ['ready', 'overdue', 'deleted']) server(state, state);
  server('simulated', 'creating', { mode: 'emulator' });
  server('returned-before-create', 'rejected', { error: 'payment_refunded' });
  server('returned-after-reject', 'rejected', { error: 'payment_refunded' });f.db.prepare('INSERT INTO attempts VALUES(?,?)').run('returned-after-reject', 'rejected');
  server('new-deleted-refund', 'deleted', { error: 'payment_refunded' });
  server('refunded-possible-vm', 'attention', { error: 'payment_refunded', providerId: 'provider-id' });
  server('refunded-unknown-attempt', 'unknown', { error: 'payment_refunded' });f.db.prepare('INSERT INTO attempts VALUES(?,?)').run('refunded-unknown-attempt', 'unknown');
  server('deletion-needs-review', 'deleting', { created: now });f.db.prepare('INSERT INTO operations VALUES(?,?,?)').run('deletion-needs-review', 'delete_attention', now);
  f.db.prepare('INSERT INTO operations VALUES(?,?,?)').run('deleted', 'delete_attention', now);
  assert.deepEqual(probeBusiness(f.file, now), { ...clearBusiness(), needs_refund: 1, stuck_provisioning: 3, delete_attention: 1 });
});

test('critical OpenStrudel alerts only when its account has no current production key', t => {
  const f = businessFixture(t), now = 90000000;
  const key = (id, { user = 'critical-user', revoked = 0, expires = now + 1, mode = 'kamatera:wai_pay:live' } = {}) => f.db.prepare('INSERT INTO api_keys VALUES(?,?,?,?,?)').run(id, user, revoked, expires, mode);
  key('historical', { expires: now - 1 });assert.equal(probeBusiness(f.file, now).openstrudel_no_valid_key, 0);
  f.db.prepare('INSERT INTO settings VALUES(?,?)').run('openstrudel_production_account', 'critical-user');
  assert.equal(probeBusiness(f.file, now).openstrudel_no_valid_key, 1);
  key('expires-now', { expires: now });key('revoked', { revoked: 1 });key('sandbox', { mode: 'emulator:emulator' });key('test-payment', { mode: 'kamatera:wai_pay:test' });key('other-user', { user: 'unrelated' });
  assert.equal(probeBusiness(f.file, now).openstrudel_no_valid_key, 1);
  key('working');assert.equal(probeBusiness(f.file, now).openstrudel_no_valid_key, 0);
  assert.equal(probeBusiness(f.file, now + 1).openstrudel_no_valid_key, 1);
  f.db.prepare('UPDATE api_keys SET revoked=1 WHERE id=?').run('working');assert.equal(probeBusiness(f.file, now).openstrudel_no_valid_key, 1);
});

test('streamed probe CLI returns counts only and rejects a non-production database without secret output', t => {
  const f = businessFixture(t), code = readFileSync(new URL('../scripts/production-monitor.mjs', import.meta.url), 'utf8');
  const run = () => execFileSync(process.execPath, ['--input-type=module', '-', 'probe', f.file], { input: code, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.deepEqual(JSON.parse(run()), clearBusiness());
  f.db.prepare('UPDATE settings SET value=? WHERE key=?').run('private-fixture-mode-value', 'mode');
  assert.throws(run, error => { assert.equal(error.stdout, '');assert.ok(error.stderr.includes('monitor_probe_failed'));assert.ok(!error.stderr.includes('private-fixture-mode-value'));return true; });
});

test('repeated business alerts and failed probes never accumulate process failures or spend restart budget', () => {
  for (const business of [
    { ...clearBusiness(), needs_refund: 1 }, { ...clearBusiness(), stuck_provisioning: 2 },
    { ...clearBusiness(), delete_attention: 1 }, { ...clearBusiness(), openstrudel_no_valid_key: 1 },
    {}, { ok: false }, { ...clearBusiness(), needs_refund: -1 },
  ]) {
    let state = { containerId: id, failures: 2, restarts: [1000000] };
    for (let i = 0; i < 5; i++) {
      const result = decideMonitor({ ...healthy(), business }, state, 1200000 + i * 120000);
      assert.equal(result.action, 'alert');assert.equal(result.state.failures, 0);assert.deepEqual(result.state.restarts, [1000000]);state = result.state;
    }
  }
  const result = decideMonitor({ ...healthy(), business: { ...clearBusiness(), private_detail: 'do-not-print' } });
  assert.equal(result.action, 'none');assert.ok(!JSON.stringify(result).includes('do-not-print'));
});

test('business counts stay visible alongside a stale-backup alert and clear without a restart', () => {
  const now = 200000000, business = { ...clearBusiness(), needs_refund: 1 };
  const result = decideMonitor({ ...healthy(), business, backup: { latest: null, verified: null } }, {}, now);
  assert.equal(result.reason, 'backup_stale');assert.equal(result.business.needs_refund, 1);assert.equal(result.state.failures, 0);
  const cleared = decideMonitor({ ...healthy(), business: clearBusiness() }, result.state, now + 120000);
  assert.equal(cleared.action, 'none');assert.deepEqual(cleared.state.restarts, []);
});
