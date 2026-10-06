import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sshHardeningScript } from '../src/providers.mjs';

const SSHD = '/usr/sbin/sshd';
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const connection = '198.51.100.12 51234 203.0.113.21 22';
const rootContext = 'user=root,addr=198.51.100.12,host=198.51.100.12,laddr=203.0.113.21,lport=22';

function fixture(t, original, { include, failFirstReload = false } = {}) {
  // Missing sshd is a failure: the Linux verification stage installs it explicitly.
  assert.ok(existsSync(SSHD), 'Real sshd is required for SSH policy regression tests');
  const parent = resolve('work/test-runs');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'ssh-hardening-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sshDir = join(dir, 'etc-ssh'), bin = join(dir, 'bin'), backupDir = join(dir, 'backups');
  for (const path of [sshDir, bin, backupDir]) mkdirSync(path, { mode: 0o700 });
  const config = join(sshDir, 'sshd_config'), hostKey = join(dir, 'host_ed25519');
  const reloadCount = join(dir, 'reload-count');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  let contents = 'Port 22222\nUseDNS no\n' + original;
  let includePath;
  if (include !== undefined) {
    const includes = join(sshDir, 'sshd_config.d');
    mkdirSync(includes, { mode: 0o700 });
    includePath = join(includes, '50-image.conf');
    writeFileSync(includePath, include, { mode: 0o600 });
    contents = 'Include "' + includes + '/*.conf"\n' + contents;
  }
  writeFileSync(config, contents, { mode: 0o600 });
  // Every parser call receives a temporary host key and a temporary config.
  // In particular the generated script's bare `sshd -t` cannot read /etc/ssh.
  writeFileSync(join(bin, 'sshd'), `#!/bin/sh
set -eu
has_config=0
for argument in "$@"; do [ "$argument" != -f ] || has_config=1; done
if [ "$has_config" = 0 ]; then
  exec ${shellQuote(SSHD)} -h ${shellQuote(hostKey)} -f ${shellQuote(config)} "$@"
fi
exec ${shellQuote(SSHD)} -h ${shellQuote(hostKey)} "$@"
`, { mode: 0o700 });
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
set -eu
[ "$#" = 2 ] && [ "$1" = reload ] && [ "$2" = ssh ] || exit 64
count=0
[ ! -f ${shellQuote(reloadCount)} ] || count=$(cat ${shellQuote(reloadCount)})
count=$((count + 1))
printf '%s\\n' "$count" > ${shellQuote(reloadCount)}
if [ "${failFirstReload ? '1' : '0'}" = 1 ] && [ "$count" = 1 ]; then exit 1; fi
`, { mode: 0o700 });
  const generated = sshHardeningScript()
    .replaceAll('/etc/ssh/', sshDir + '/')
    .replaceAll('/var/lib/wai-vds-ssh-', join(backupDir, 'wai-vds-ssh-'));
  assert.ok(!generated.includes('/etc/ssh/'));
  assert.ok(!generated.includes('/var/lib/wai-vds-ssh-'));
  const run = () => spawnSync('/bin/sh', ['-s'], {
    input: generated, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, SSH_CONNECTION: connection }
  });
  const effective = context => execFileSync(SSHD, ['-h', hostKey, '-T', '-f', config, ...(context ? ['-C', context] : [])], { encoding: 'utf8' });
  const reloads = () => existsSync(reloadCount) ? Number(readFileSync(reloadCount, 'utf8')) : 0;
  const backups = () => readdirSync(backupDir).map(name => join(backupDir, name));
  return { dir, sshDir, config, contents, includePath, run, effective, reloads, backups };
}

function passed(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function hardened(settings) {
  assert.match(settings, /^passwordauthentication no$/m);
  assert.match(settings, /^kbdinteractiveauthentication no$/m);
  assert.match(settings, /^permitrootlogin (?:prohibit-password|without-password)$/m);
}
const permissive = 'PasswordAuthentication yes\nKbdInteractiveAuthentication yes\nPermitRootLogin yes\n';

test('primary policy hardens an image without Include and repeated execution does not reload', t => {
  const f = fixture(t, permissive + 'PasswordAuthentication yes\nPermitRootLogin yes\n');
  assert.match(f.effective(rootContext), /^passwordauthentication yes$/m);
  passed(f.run());
  hardened(f.effective()); hardened(f.effective(rootContext));
  assert.equal(f.reloads(), 1);
  assert.equal(f.backups().length, 1);
  assert.equal(readFileSync(join(f.backups()[0], 'previous'), 'utf8'), f.contents);
  const applied = readFileSync(f.config, 'utf8'), before = statSync(f.config);
  passed(f.run());
  assert.equal(readFileSync(f.config, 'utf8'), applied);
  assert.equal(statSync(f.config).ino, before.ino);
  assert.equal(statSync(f.config).mtimeMs, before.mtimeMs);
  assert.equal(f.reloads(), 1);
  assert.equal(f.backups().length, 1);
  assert.equal((applied.match(/^# BEGIN WAI VDS SSH POLICY$/gm) || []).length, 1);
});

test('primary policy takes precedence over permissive existing Include files', t => {
  const f = fixture(t, permissive, { include: permissive });
  assert.match(f.effective(rootContext), /^passwordauthentication yes$/m);
  passed(f.run());
  hardened(f.effective()); hardened(f.effective(rootContext));
  assert.equal(readFileSync(f.includePath, 'utf8'), permissive);
  assert.equal(f.reloads(), 1);
});

test('a conflicting Match User root is rejected before applying or reloading', t => {
  const f = fixture(t, permissive + '\nMatch User root\n  PasswordAuthentication yes\n');
  const before = statSync(f.config), result = f.run();
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(f.config, 'utf8'), f.contents);
  assert.equal(statSync(f.config).ino, before.ino);
  assert.equal(f.reloads(), 0);
  assert.deepEqual(f.backups(), []);
  assert.deepEqual(readdirSync(f.sshDir), ['sshd_config']);
  assert.match(f.effective(rootContext), /^passwordauthentication yes$/m);
});

test('failed reload restores the exact original configuration and reloads it', t => {
  const f = fixture(t, permissive, { failFirstReload: true });
  const result = f.run();
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(f.config, 'utf8'), f.contents);
  assert.equal(statSync(f.config).mode & 0o777, 0o600);
  assert.equal(f.reloads(), 2);
  assert.equal(f.backups().length, 1);
  assert.equal(readFileSync(join(f.backups()[0], 'previous'), 'utf8'), f.contents);
  assert.match(f.effective(rootContext), /^passwordauthentication yes$/m);
  assert.deepEqual(readdirSync(f.sshDir), ['sshd_config']);
});
