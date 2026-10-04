#!/usr/bin/env node
// Real HTTP against the free sandbox; no payment, SSH, Home or infrastructure claim.
import { readFileSync, existsSync, lstatSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WaiVdsSandboxClient, WaiVdsError } from './client.mjs';

function save(path, data) {
  const temporary = path + '.tmp-' + randomUUID();
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(client, trial, expected) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = await client.status(trial);
    if (status.state === expected) return status;
    if (['unknown', 'attention', 'rejected'].includes(status.state)) throw new WaiVdsError('conflict');
    await sleep(2000);
  }
  throw new WaiVdsError('unavailable');
}

let state, stateFile;
try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--env-file' || args[2] !== '--evidence-dir') throw new WaiVdsError('configuration');
  const envFile = resolve(args[1]), directory = resolve(args[3]);
  const stat = lstatSync(envFile);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new WaiVdsError('configuration');
  const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const equal = line.indexOf('='); return [line.slice(0, equal), line.slice(equal + 1).trim()];
  }));
  const client = new WaiVdsSandboxClient({ baseURL: env.WAI_VDS_BASE_URL, apiKey: env.WAI_VDS_API_KEY });
  const preflight = await client.preflight();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || (lstatSync(directory).mode & 0o077) !== 0) throw new WaiVdsError('configuration');
  stateFile = join(directory, 'trial.json');
  state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {
    version: 1, baseURL: client.baseURL, idempotencyKey: 'openstrudel-' + randomUUID(),
    phase: 'intent', before: await client.inventory(), startedAt: new Date().toISOString(),
  };
  if (state.version !== 1 || state.baseURL !== client.baseURL || !state.idempotencyKey?.startsWith('openstrudel-') || !Array.isArray(state.before)) throw new WaiVdsError('configuration');
  // Intent reaches disk before the first POST. Re-running this directory reuses it.
  save(stateFile, state);
  if (!state.serverId) {
    Object.assign(state, await client.createTrial(state.idempotencyKey), { phase: 'created' });
    save(stateFile, state);
  }
  if (state.phase !== 'deleted') {
    const repeated = await client.createTrial(state.idempotencyKey);
    if (repeated.serverId !== state.serverId || repeated.orderId !== state.orderId) throw new WaiVdsError('contract');
    state.idempotencyVerified = true; save(stateFile, state);
    const current = await client.status(state);
    if (!['deleting', 'deleted'].includes(current.state)) {
      state.ready = await waitFor(client, state, 'ready'); save(stateFile, state);
      // A new client models reopening the application without a second order.
      const reopened = new WaiVdsSandboxClient({ baseURL: env.WAI_VDS_BASE_URL, apiKey: env.WAI_VDS_API_KEY });
      state.resumeVerified = (await reopened.status(state)).state === 'ready'; save(stateFile, state);
      await client.cancelAtPeriodEnd(state);
      state.cancellationVerified = (await client.status(state)).cancelAtEnd; save(stateFile, state);
      state.phase = 'deleting'; save(stateFile, state);
      await client.deleteTrial(state);
    }
    await waitFor(client, state, 'deleted');
    state.phase = 'deleted'; save(stateFile, state);
  }
  const inventory = await client.inventory();
  const baselineUnchanged = state.before.every(before => inventory.some(after => after.id === before.id && after.state === before.state && after.mode === before.mode));
  if (!baselineUnchanged || !inventory.some(s => s.id === state.serverId && s.state === 'deleted')) throw new WaiVdsError('contract');
  const evidence = {
    checkedAt: new Date().toISOString(), baseURL: client.baseURL, kind: 'real_http_emulator',
    catalog: preflight.catalog, assessment: preflight.assessment,
    orderId: state.orderId, serverId: state.serverId,
    checks: { stableIdempotency: state.idempotencyVerified === true, reopenExistingOrder: state.resumeVerified === true,
      cancelAtPeriodEnd: state.cancellationVerified === true, deletionConfirmed: true, baselineUnchanged },
    payment: 'sandbox_grant_bypasses_checkout', realPayments: 0, realVMs: 0,
    homeInstalled: false, ownerOpenAIOnVM: false, secondDeviceOnVM: false, sshTlsAfterReboot: false,
    readyForNativeIntegration: false, readyForPublicSales: false,
  };
  save(join(directory, 'evidence.json'), evidence);
  if (!Object.values(evidence.checks).every(Boolean)) throw new WaiVdsError('contract');
  console.log(JSON.stringify({ ok: true, kind: evidence.kind, checks: evidence.checks, realPayments: 0, realVMs: 0, evidence: join(directory, 'evidence.json') }));
} catch (error) {
  if (state && stateFile) {
    state.lastError = error instanceof WaiVdsError ? error.code : 'local_failure';
    try { save(stateFile, state); } catch {}
  }
  console.error(JSON.stringify({ ok: false, code: error instanceof WaiVdsError ? error.code : 'local_failure',
    message: error instanceof WaiVdsError ? error.message : 'Проверка прервана. Сохраните журнал попытки и повторите с той же папкой.',
    stateSaved: Boolean(stateFile && existsSync(stateFile)) }));
  process.exitCode = 1;
}
