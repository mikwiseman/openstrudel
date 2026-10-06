import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, createDecipheriv, createPrivateKey, createPublicKey, sign, verify, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, lstatSync, chmodSync, rmSync, renameSync, mkdtempSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const MAX_BYTES = 64 * 1024 * 1024;
export const PAYLOAD = ['wai.sqlite', 'master.key', 'bootstrap-signing.pem', 'runtime.env', 'current-release'];
const ARCHIVE = /^wai-vds-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.age$/;
const fail = code => { const error = Error(code); error.publicCode = code; throw error; };
const hash = b => createHash('sha256').update(b).digest('hex');
function regular(path, limit = MAX_BYTES) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('invalid_backup_file');
  return stat;
}
const bytes = (path, limit) => { regular(path, limit); return readFileSync(path); };
const digest = path => hash(bytes(path));
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink()) fail('invalid_backup_directory');
  chmodSync(path, 0o700);
}
function atomicJSON(path, value) {
  const temp = path + '.' + randomBytes(4).toString('hex') + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}

// Does not construct Service or Store: verification cannot provision, migrate, or charge.
export function verifySnapshot(directory) {
  const manifest = JSON.parse(bytes(join(directory, 'manifest.json'), 65536));
  if (manifest.format !== 'wai-vds-backup-v1' || !Number.isInteger(manifest.schema) || manifest.schema < 6) fail('unsupported_backup_manifest');
  const names = readdirSync(directory).sort();
  if (JSON.stringify(names) !== JSON.stringify([...PAYLOAD, 'manifest.json'].sort())) fail('unexpected_backup_members');
  for (const name of PAYLOAD) if (manifest.files?.[name] !== digest(join(directory, name))) fail('backup_digest_mismatch');
  const master = bytes(join(directory, 'master.key'), 32);
  if (master.length !== 32) fail('invalid_master_key');
  const signing = createPrivateKey(bytes(join(directory, 'bootstrap-signing.pem'), 8192));
  if (signing.asymmetricKeyType !== 'ed25519') fail('invalid_signing_key');
  const challenge = Buffer.from('wai-vds-backup-restore-check');
  if (!verify(null, challenge, createPublicKey(signing), sign(null, challenge, signing))) fail('signing_key_check_failed');
  const env = bytes(join(directory, 'runtime.env'), 1024 * 1024).toString();
  if (!/^WAI_PROVIDER=(kamatera|emulator)$/m.test(env) || !/^WAI_PAYMENTS=(wai_pay|emulator|stripe_test)$/m.test(env)) fail('invalid_runtime_environment');
  const release = bytes(join(directory, 'current-release'), 128).toString().trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(release)) fail('invalid_release_marker');
  const db = new DatabaseSync(join(directory, 'wai.sqlite'), { readOnly: true });
  let keyCount = 0,homeKeyCount=0;
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('database_integrity_failed');
    if (db.prepare('PRAGMA user_version').get().user_version !== manifest.schema) fail('schema_manifest_mismatch');
    for (const table of ['users', 'orders', 'servers', 'api_keys']) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) fail('missing_business_table');
    const checkDir = mkdtempSync(join(tmpdir(), 'wai-vds-key-check-'));
    try {
      for (const row of db.prepare('SELECT id,private_key,public_key FROM servers').iterate()) {
        const encoded = Buffer.from(row.private_key, 'base64');
        if (encoded.length < 29) fail('encrypted_server_key_invalid');
        const cipher = createDecipheriv('aes-256-gcm', master, encoded.subarray(0, 12));
        cipher.setAAD(Buffer.from(row.id)); cipher.setAuthTag(encoded.subarray(12, 28));
        const secret = Buffer.concat([cipher.update(encoded.subarray(28)), cipher.final()]);
        const file = join(checkDir, 'key');
        writeFileSync(file, secret, { mode: 0o600 });
        const publicKey = execFileSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
        if (publicKey.split(' ').slice(0, 2).join(' ') !== row.public_key.split(' ').slice(0, 2).join(' ')) fail('server_keypair_mismatch');
        rmSync(file); keyCount++;
      }
    } finally { rmSync(checkDir, { recursive: true, force: true }); }
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='os_installations'").get()) {
      for(const row of db.prepare('SELECT id,bootstrap_sealed,public_key_sha256,owner_token_hash FROM os_installations WHERE bootstrap_sealed IS NOT NULL').iterate()) {
        const b=Buffer.from(row.bootstrap_sealed,'base64');if(b.length<29)fail('encrypted_home_bootstrap_invalid');
        const cipher=createDecipheriv('aes-256-gcm',master,b.subarray(0,12));cipher.setAAD(Buffer.from('home:'+row.id));cipher.setAuthTag(b.subarray(12,28));
        const payload=JSON.parse(Buffer.concat([cipher.update(b.subarray(28)),cipher.final()]).toString());
        const key=createPrivateKey(payload.privateKeyPEM);
        if(payload.installationId!==row.id||payload.ownerTokenHash!==row.owner_token_hash||key.asymmetricKeyDetails?.namedCurve!=='prime256v1'||hash(createPublicKey(key).export({type:'spki',format:'der'}))!==row.public_key_sha256)fail('home_identity_mismatch');
        homeKeyCount++;
      }
    }
  } finally { db.close(); }
  return { integrity: 'ok', schema: manifest.schema, signing_key: 'verified', encrypted_server_keys_verified: keyCount, encrypted_home_bootstraps_verified:homeKeyCount,network_used: false };
}

export async function snapshot({ data, env, release, output }) {
  privateDirectory(output);
  if (readdirSync(output).length) fail('snapshot_output_not_empty');
  const stable = new Map([['master.key', join(data, 'master.key')], ['bootstrap-signing.pem', join(data, 'bootstrap-signing.pem')], ['runtime.env', env], ['current-release', release]]);
  const before = Object.fromEntries([...stable].map(([name, file]) => [name, digest(file)]));
  regular(join(data, 'wai.sqlite'));
  const source = new DatabaseSync(join(data, 'wai.sqlite'), { readOnly: true });
  try { await backup(source, join(output, 'wai.sqlite')); } finally { source.close(); }
  chmodSync(join(output, 'wai.sqlite'), 0o600);
  for (const [name, file] of stable) { copyFileSync(file, join(output, name)); chmodSync(join(output, name), 0o600); }
  for (const [name, file] of stable) if (digest(file) !== before[name] || digest(join(output, name)) !== before[name]) fail('keys_or_configuration_changed_during_backup');
  // Make the independently backed-up database standalone, without a WAL dependency.
  const db = new DatabaseSync(join(output, 'wai.sqlite'));
  db.exec('PRAGMA journal_mode=DELETE');
  const schema = db.prepare('PRAGMA user_version').get().user_version; db.close();
  const files = Object.fromEntries(PAYLOAD.map(name => [name, digest(join(output, name))]));
  atomicJSON(join(output, 'manifest.json'), { format: 'wai-vds-backup-v1', created: new Date().toISOString(), schema, files });
  return verifySnapshot(output);
}

// The host creates POSIX ustar with six known regular files. No links, extensions,
// duplicate names, path traversal or arbitrary tar extraction are accepted here.
export function restoreTar(tarFile, output) {
  const tar = bytes(tarFile, MAX_BYTES * 2), expected = new Set([...PAYLOAD, 'manifest.json']), seen = new Set(), entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(x => x === 0)) { if (!tar.subarray(offset).every(x => x === 0)) fail('tar_trailing_data'); break; }
    const text = (a, n) => header.subarray(a, a + n).toString().replace(/\0.*$/s, '');
    const number = (a, n) => { const s = text(a, n).trim(); if (!/^[0-7]+$/.test(s)) fail('tar_invalid_number'); return parseInt(s, 8); };
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (number(148, 8) !== sum || text(257, 6) !== 'ustar' || text(345, 155) || ![0, 48].includes(header[156])) fail('tar_invalid_header');
    const name = text(0, 100), size = number(124, 12);
    if (!expected.has(name) || seen.has(name) || size > MAX_BYTES || offset + size > tar.length) fail('tar_invalid_member');
    entries.push([name, tar.subarray(offset, offset + size)]); seen.add(name); offset += Math.ceil(size / 512) * 512;
  }
  if (seen.size !== expected.size || offset > tar.length) fail('tar_incomplete');
  privateDirectory(output); if (readdirSync(output).length) fail('restore_output_not_empty');
  for (const [name, content] of entries) writeFileSync(join(output, name), content, { mode: 0o600, flag: 'wx' });
  return verifySnapshot(output);
}

export function recordArchive(directory, name, verified = false, expectedHash) {
  if (!ARCHIVE.test(name) || basename(name) !== name) fail('invalid_archive_name');
  const file = join(directory, name), content = bytes(file), size = content.length, sha256 = hash(content);
  if (!content.subarray(0, 22).toString().startsWith('age-encryption.org/v1\n')) fail('invalid_age_archive');
  if (expectedHash && sha256 !== expectedHash) fail('archive_hash_mismatch');
  const old = (() => { try { return JSON.parse(bytes(file + '.json', 65536)); } catch { return {}; } })();
  if (old.sha256 && old.sha256 !== sha256) fail('archive_changed');
  const result = { format: 'wai-vds-age-v1', file: name, bytes: size, sha256, created: old.created || new Date().toISOString(), ...(old.restore_verified_at ? { restore_verified_at: old.restore_verified_at } : {}), ...(verified ? { restore_verified_at: new Date().toISOString() } : {}) };
  atomicJSON(file + '.json', result); return result;
}

export function pruneArchives(directory, keep = 14, maxBytes = 512 * 1024 * 1024) {
  if (!Number.isInteger(keep) || keep < 2 || keep > 60 || maxBytes < MAX_BYTES * 2) fail('invalid_retention');
  const files = [];
  for (const name of readdirSync(directory).filter(n => ARCHIVE.test(n)).sort().reverse()) {
    const meta = JSON.parse(bytes(join(directory, name + '.json'), 65536));
    if (meta.file !== name || meta.sha256 !== digest(join(directory, name))) fail('retention_manifest_mismatch');
    files.push({ name, bytes: regular(join(directory, name)).size, verified: !!meta.restore_verified_at });
  }
  const protectedNames = new Set([files[0]?.name, files.find(f => f.verified)?.name]);
  const retained = new Set(files.filter((f, i) => i < keep || protectedNames.has(f.name)).map(f => f.name));
  let total = files.filter(f => retained.has(f.name)).reduce((n, f) => n + f.bytes, 0);
  for (const f of [...files].reverse()) if (total > maxBytes && retained.has(f.name) && !protectedNames.has(f.name)) { retained.delete(f.name); total -= f.bytes; }
  if (total > maxBytes) fail('retention_budget_too_small');
  for (const f of files) if (!retained.has(f.name)) { rmSync(join(directory, f.name)); rmSync(join(directory, f.name + '.json')); }
  return { retained: retained.size, removed: files.length - retained.size, encrypted_bytes: total, last_verified_preserved: true };
}

async function main(args) {
  const [action, ...a] = args;
  if (action === 'snapshot') return snapshot({ data: a[0], env: a[1], release: a[2], output: a[3] });
  if (action === 'verify') return verifySnapshot(a[0]);
  if (action === 'restore-tar') return restoreTar(a[0], a[1]);
  if (action === 'record') return recordArchive(a[0], a[1]);
  if (action === 'acknowledge') { if (!/^[a-f0-9]{64}$/.test(a[2] || '')) fail('invalid_archive_digest'); return recordArchive(a[0], a[1], true, a[2]); }
  if (action === 'prune') return pruneArchives(a[0], a[1] ? Number(a[1]) : 14, a[2] ? Number(a[2]) : undefined);
  fail('unknown_backup_action');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error.publicCode || 'backup_operation_failed', action: process.argv[2] || 'missing' })); process.exitCode = 1; }
}
