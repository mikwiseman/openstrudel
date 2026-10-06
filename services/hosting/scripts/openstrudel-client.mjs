import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const envFile = process.env.WAI_VDS_ENV_FILE || fileURLToPath(new URL('.env', import.meta.url));
const settings = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const base = settings.WAI_VDS_BASE_URL, key = settings.WAI_VDS_API_KEY;
if (!base || !key) throw Error('WAI VDS configuration is incomplete.');
const [action = 'help', value, extra, paymentMethod = 'card'] = process.argv.slice(2);
const api = async (path, method = 'GET', body, binary = false) => {
  const response = await fetch(base + '/api/v1' + path, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: 'Bearer ' + key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw Error(error.error || 'WAI VDS HTTP ' + response.status); }
  return binary ? response.text() : response.json();
};
const serverID = () => { if (!/^[a-f0-9-]{36}$/.test(value || '')) throw Error('Supply the exact server UUID.'); return value; };
try {
  let result;
  if (action === 'catalog') result = await api('/catalog');
  else if (action === 'list') result = await api('/me');
  else if (action === 'order') {
    if (!['agent', 'site', 'clean'].includes(value) || !/^[-a-zA-Z0-9_]{8,100}$/.test(extra || '') || !['card', 'crypto'].includes(paymentMethod)) throw Error('Supply purpose, stable idempotency key and card|crypto after the owner consents to the catalog price.');
    result = await api('/orders', 'POST', {purpose:value,idempotency_key:extra,payment_method:paymentMethod,consent:true});
  } else if (action === 'checkout') result = await api('/orders/' + serverID() + '/checkout', 'POST', {});
  else if (action === 'order-status') result = await api('/orders/' + serverID());
  else if (action === 'create') {
    if (!['agent', 'site', 'clean'].includes(value)) throw Error('Purpose must be agent, site or clean.');
    if (!extra || !/^[-a-zA-Z0-9_]{8,100}$/.test(extra)) throw Error('Supply a stable idempotency key (8–100 characters); reuse it on retries.');
    result = await api('/agent/servers', 'POST', { purpose: value, idempotency_key: extra, consent: true });
  } else if (action === 'status') result = await api('/servers/' + serverID());
  else if (action === 'delete') result = await api('/servers/' + serverID() + '/delete', 'POST', { confirm: value });
  else if (action === 'access') {
    if (!extra) throw Error('Supply a new private output file path.');
    const privateKey = await api('/servers/' + serverID() + '/access', 'POST', {}, true);
    writeFileSync(resolve(extra), privateKey, { mode: 0o600, flag: 'wx' });
    result = { saved: resolve(extra), secret_displayed: false, mode: '0600' };
  } else result = { commands: ['catalog', 'list', 'create agent|site|clean <stable-idempotency-key> (sandbox only)', 'order agent|site|clean <stable-idempotency-key> card|crypto', 'checkout <order-uuid>', 'order-status <order-uuid>', 'status <server-uuid>', 'access <server-uuid> <new-key-file>', 'delete <server-uuid>'], note: 'Read the catalog and /llms.txt first. Sandbox create has no charges. In production, obtain owner consent to price and terms before order, then hand the checkout URL to the owner. Never pay automatically or mistake a demo VM for a live server.' };
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
