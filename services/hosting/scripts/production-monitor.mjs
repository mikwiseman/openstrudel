import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const BUSINESS_FIELDS = ['needs_refund', 'stuck_provisioning', 'delete_attention', 'openstrudel_no_valid_key'];

// Read committed WAL state without starting the app, migrations, or a worker.
export function probeBusiness(file, now = Date.now()) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
    if (db.prepare("SELECT value FROM settings WHERE key='mode'").get()?.value !== 'kamatera:wai_pay:live') throw Error('production_mode_required');
    const counts = db.prepare(`SELECT
      (SELECT count(*) FROM orders WHERE status='needs_refund') AS needs_refund,
      (SELECT count(*) FROM servers s WHERE s.provider_mode='kamatera'
        AND s.state IN('paid','creating','configuring','checking','unknown','attention','rejected') AND s.created<=?
        AND NOT(COALESCE(s.error,'')='payment_refunded' AND s.provider_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.server_id=s.id AND a.state!='rejected'))) AS stuck_provisioning,
      (SELECT count(*) FROM operations op JOIN servers s ON s.id=op.server_id
        WHERE op.state='delete_attention' AND s.provider_mode='kamatera' AND s.state!='deleted') AS delete_attention,
      (SELECT count(*) FROM settings cfg JOIN users u ON u.id=cfg.value
        WHERE cfg.key='openstrudel_production_account' AND NOT EXISTS(
          SELECT 1 FROM api_keys k WHERE k.user_id=u.id AND k.revoked=0 AND k.expires>?
            AND k.mode='kamatera:wai_pay:live')) AS openstrudel_no_valid_key`).get(now - 30 * 60000, now);
    return { ok: true, ...counts };
  } finally { db.close(); }
}

export function decideMonitor(snapshot, previous = {}, now = Date.now()) {
  const prior = { failures: 0, restarts: [], ...previous };
  const restarts = Array.isArray(prior.restarts) ? prior.restarts.filter(n => Number.isFinite(n) && n > now - 86400000) : [];
  const next = { version: 1, checked: now, failures: 0, restarts };
  let business;
  const result = (action, reason) => ({ action, reason, ...(business ? { business } : {}), state: next });
  if (snapshot.maintenance === true) return result('none', 'maintenance');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(snapshot.release || '')) return result('alert', 'invalid_release');
  const c = snapshot.container;
  if (!c || !/^[a-f0-9]{64}$/.test(c.id || '') || c.name !== '/wai-vds' || c.project !== 'wai-vds' || c.service !== 'wai-vds' || c.image !== 'wai-vds:' + snapshot.release || c.imageId !== snapshot.expectedImageId || !/^sha256:[a-f0-9]{64}$/.test(c.imageId || '') || c.dataSource !== '/srv/wai-vds/data' || c.dataDestination !== '/var/lib/wai-vds') return result('alert', 'ownership_mismatch');
  if (snapshot.internal?.ok === true && snapshot.internal.service === 'wai-vds' && snapshot.internal.provider === 'kamatera' && snapshot.internal.payments === 'wai_pay') {
    if (snapshot.public?.ok !== true || snapshot.public.service !== 'wai-vds') return result('alert', 'public_path_failure');
    if (!c.running || c.health !== 'healthy') return result('alert', 'docker_health_disagrees');
    if (snapshot.business !== undefined) {
      if (snapshot.business?.ok !== true || !BUSINESS_FIELDS.every(k => Number.isSafeInteger(snapshot.business[k]) && snapshot.business[k] >= 0)) return result('alert', 'business_probe_unavailable');
      business = Object.fromEntries(BUSINESS_FIELDS.map(k => [k, snapshot.business[k]]));
    }
    if (snapshot.backup) {
      if (!Number.isFinite(snapshot.backup.latest) || snapshot.backup.latest > now + 60000 || now - snapshot.backup.latest > 36 * 3600000) return result('alert', 'backup_stale');
      if (!Number.isFinite(snapshot.backup.verified) || snapshot.backup.verified > now + 60000 || now - snapshot.backup.verified > 48 * 3600000) return result('alert', 'independent_restore_verification_stale');
    }
    if (business && Object.values(business).some(n => n > 0)) return result('alert', 'operator_attention');
    return result('none', 'healthy');
  }
  if (!c.running || c.status !== 'running') return result('alert', 'service_stopped');
  if (snapshot.internal?.ok === true) return result('alert', 'unexpected_service_mode');
  next.failures = prior.containerId === c.id && Number.isInteger(prior.failures) && prior.failures >= 0 ? Math.min(prior.failures + 1, 100) : 1;
  next.containerId = c.id;
  if (c.health !== 'unhealthy' || next.failures < 3) return result('alert', 'awaiting_confirmed_failure');
  if (restarts.some(t => now - t < 30 * 60000) || restarts.length >= 2) return result('alert', 'recovery_budget_exhausted');
  next.restarts.push(now); next.failures = 0;
  return { ...result('restart', 'confirmed_owned_service_failure'), containerId: c.id };
}

if (process.argv[1] && (import.meta.url === pathToFileURL(resolve(process.argv[1])).href || process.argv[1] === '-' && process.argv[2] === 'probe')) {
  try {
    if (process.argv[2] === 'probe') {
      if (!process.argv[3]) throw Error();
      console.log(JSON.stringify(probeBusiness(process.argv[3])));
    } else {
      const input = readFileSync(0, 'utf8'); if (input.length > 65536) throw Error();
      const { snapshot, state } = JSON.parse(input);
      console.log(JSON.stringify(decideMonitor(snapshot, state)));
    }
  } catch { console.error(JSON.stringify({ ok: false, error: process.argv[2] === 'probe' ? 'monitor_probe_failed' : 'monitor_input_invalid' })); process.exitCode = 1; }
}
