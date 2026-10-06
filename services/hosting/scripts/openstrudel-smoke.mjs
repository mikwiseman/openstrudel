// Run with node --env-file=work/openstrudel.env scripts/openstrudel-smoke.mjs
// This checks every purpose, then deletes only resources created by this run.
const base = process.env.WAI_VDS_BASE_URL;
const key = process.env.WAI_VDS_API_KEY;
if (!base || !key) throw Error('Load the private OpenStrudel environment file first.');
const request = async (path, method = 'GET', body) => {
  const response = await fetch(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bearer ' + key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw Error('WAI VDS request failed: ' + response.status);
  return response.json();
};
const catalog = await request('/api/v1/catalog');
if (catalog.mode.provider !== 'emulator' || catalog.mode.payments !== 'emulator') throw Error('This smoke test may only run in the free emulator.');
const created = [];
const wait = async (id, state) => {
  for (let attempt = 0; attempt < 30; attempt++) {
    const server = await request('/api/v1/servers/' + id);
    if (server.state === state) return server;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw Error('Timed out waiting for state ' + state);
};
try {
  for (const purpose of ['agent', 'site', 'clean']) {
    const body = { purpose, idempotency_key: 'openstrudel-' + crypto.randomUUID(), consent: true };
    const first = await request('/api/v1/agent/servers', 'POST', body);
    created.push(first.server.id);
    const repeated = await request('/api/v1/agent/servers', 'POST', body);
    if (first.server.id !== repeated.server.id || first.billable !== false) throw Error('Idempotency or mode check failed.');
  }
  for (const id of created) {
    const server = await wait(id, 'ready');
    console.log(JSON.stringify({ purpose: server.purpose, ready: true, mode: server.mode, idempotent: true, real_ssh: false }));
  }
} finally {
  for (const id of created) {
    await wait(id, 'ready');
    await request('/api/v1/servers/' + id + '/delete', 'POST', { confirm: id });
    await wait(id, 'deleted');
  }
  console.log(JSON.stringify({ cleanup: 'all smoke-test resources deleted', count: created.length, real_vms_created: 0 }));
}
