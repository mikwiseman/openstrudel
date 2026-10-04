#!/usr/bin/env node
import { assessVdsCatalog } from './eligibility.mjs';

// Explicit documented VDS API only; this tool never authenticates, pays or creates a VM.
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--base-url') throw new Error('arguments');
  const base = new URL(args[1]);
  if (base.username || base.password || base.search || base.hash || !/^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(base.pathname)) throw new Error('endpoint');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new Error('endpoint');
  const root = base.href.replace(/\/$/, '');
  async function get(path) {
    const response = await fetch(root + path, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('response');
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 1024 * 1024) throw new Error('size');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { await reader.cancel().catch(() => {}); }
  }
  const [health, catalog] = await Promise.all([get('/healthz'), get('/api/v1/catalog')]);
  if (health?.ok !== true || health?.service !== 'wai-vds') throw new Error('health');
  if (health.provider !== catalog?.mode?.provider || health.payments !== catalog?.mode?.payments) throw new Error('mode');
  const assessment = assessVdsCatalog(catalog);
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), baseURL: root, mode: 'read_only_preflight',
    serviceResponding: true, catalog, assessment, realServerCreated: false }, null, 2));
} catch {
  console.error(JSON.stringify({ ok: false, message: 'Предварительная проверка не завершена. Укажите доступный документированный адрес: --base-url http://127.0.0.1:4781' }));
  process.exitCode = 1;
}
