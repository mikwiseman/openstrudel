#!/usr/bin/env node
import { X509Certificate, createPrivateKey, createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readlink, writeFile, rename, symlink, unlink, rmdir, open, chown } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { connect } from 'node:tls';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = cert => sha(cert.publicKey.export({ type: 'spki', format: 'der' }));
async function sync(directory) { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function setCurrent(directory, target) {
  const temporary = join(directory, '.current-' + randomUUID());
  await symlink(target, temporary);
  try { await rename(temporary, join(directory, 'current')); await sync(directory); }
  finally { await unlink(temporary).catch(() => {}); }
}

/** Only an exact certificate match succeeds. The local probe sends no token. */
export function probeCertificate({ host = '127.0.0.1', port, hostname, fingerprint }) {
  return new Promise(resolveProbe => {
    const socket = connect({ host, port, servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: false });
    const finish = ok => { socket.destroy(); resolveProbe(ok); };
    socket.setTimeout(2000, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      finish(Boolean(cert.raw && sha(cert.raw) === fingerprint));
    });
  });
}

/** Publish a CA renewal without changing this Home's pinned identity. */
export async function installTLS({ lineage, directory, hostname, uid, gid, prepare = false, probe, timeout = 90000 }) {
  directory = resolve(directory);
  if (!hostname || hostname.includes('/') || hostname.includes(':') && !isIP(hostname)) throw new Error('Specify the exact public hostname or IP address.');
  const certBytes = await readFile(join(lineage, 'fullchain.pem'));
  const keyBytes = await readFile(join(lineage, 'privkey.pem'));
  const cert = new X509Certificate(certBytes);
  if (!cert.checkPrivateKey(createPrivateKey(keyBytes))) throw new Error('Certificate and key do not match.');
  if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now() + 600000) throw new Error('Certificate is not valid for at least the next ten minutes.');
  if (!(isIP(hostname) ? cert.checkIP(hostname) : cert.checkHost(hostname, { subject: 'never' }))) throw new Error('Certificate does not cover the public address.');
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const lock = join(directory, '.install.lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error('TLS install is already running. If it crashed, verify its process is stopped before removing .install.lock.'); }
  try {
    let previous, previousFingerprint;
    try { previous = await readlink(join(directory, 'current')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (previous && !/^generations\/[0-9a-f-]+$/.test(previous)) throw new Error('Unexpected TLS layout; current must point to a managed generation.');
    if (prepare && previous) throw new Error('Initial preparation cannot replace an existing identity.');
    if (!previous && !prepare) throw new Error('Prepare the first certificate before enabling external TLS.');
    if (previous) {
      const previousBytes = await readFile(join(directory, previous, 'fullchain.pem'));
      previousFingerprint = sha(new X509Certificate(previousBytes).raw);
      if (identity(new X509Certificate(previousBytes)) !== identity(cert)) throw new Error('The public key changed. Renew with --reuse-key; changing Home identity requires a separate migration.');
      if (certBytes.equals(previousBytes)) return { changed: false };
      if (typeof probe !== 'function') throw new Error('Renewal requires a local TLS health probe.');
    }
    const generations = join(directory, 'generations');
    const generation = 'generations/' + Date.now() + '-' + randomUUID();
    const stage = join(directory, generation);
    await mkdir(generations, { recursive: true, mode: 0o750 });
    await mkdir(stage, { mode: 0o750 });
    for (const [name, data] of [['fullchain.pem', certBytes], ['privkey.pem', keyBytes]]) {
      const file = join(stage, name);
      await writeFile(file, data, { flag: 'wx', mode: 0o640 });
      if (uid !== undefined && gid !== undefined) await chown(file, uid, gid);
      const handle = await open(file, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    }
    if (uid !== undefined && gid !== undefined) for (const path of [directory, generations, stage]) await chown(path, uid, gid);
    await sync(stage); await sync(generations);
    // Previous timestamped generations remain available for rollback.
    await setCurrent(directory, generation);
    if (prepare) return { changed: true, prepared: true };
    const verify = async fingerprint => {
      const deadline = Date.now() + timeout;
      do {
        if (await probe(fingerprint)) return true;
        if (Date.now() >= deadline) break;
        await new Promise(done => setTimeout(done, 1000));
      } while (true);
      return false;
    };
    try {
      if (await verify(sha(cert.raw))) return { changed: true, verified: true };
      throw new Error('Home did not serve the renewed certificate within the deadline.');
    } catch (error) {
      await setCurrent(directory, previous);
      const restored = await verify(previousFingerprint).catch(() => false);
      throw new Error(error.message + ' The previous TLS files were restored. ' + (restored ? 'Home confirms the previous certificate.' : 'Home has not confirmed rollback; inspect the listener before retrying.'));
    }
  } finally { await rmdir(lock); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.env.OPENSTRUDEL_TLS_DIRECTORY;
  const lineage = process.env.RENEWED_LINEAGE;
  const hostname = process.env.OPENSTRUDEL_PUBLIC_HOST;
  const prepare = process.argv.slice(2).includes('--prepare');
  const port = Number(process.env.OPENSTRUDEL_PUBLIC_PORT ?? 7789);
  const uid = Number(process.env.OPENSTRUDEL_TLS_UID ?? 0), gid = Number(process.env.OPENSTRUDEL_TLS_GID ?? 1000);
  if (!directory || !lineage || !hostname || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) {
    console.error('Set RENEWED_LINEAGE, OPENSTRUDEL_TLS_DIRECTORY and OPENSTRUDEL_PUBLIC_HOST. Use --prepare only before the first external-TLS start.'); process.exitCode = 1;
  } else {
    try {
      const result = await installTLS({ lineage, directory, hostname, uid, gid, prepare, probe: fingerprint => probeCertificate({ port, hostname, fingerprint }) });
      console.log(JSON.stringify(result));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
