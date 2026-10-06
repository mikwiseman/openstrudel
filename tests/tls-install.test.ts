import { mkdtemp, readFile, readlink, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { X509Certificate, createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
// The deploy hook runs on an operator's host, outside the customer runtime.
// @ts-expect-error standalone Node deployment module
import { installTLS, probeCertificate } from '../deploy/tls-install.mjs';

function certificate(directory: string, serial: number, reuse?: string) {
  const key = join(directory, 'privkey.pem');
  execFileSync('openssl', ['req', '-new', '-x509', ...(reuse ? ['-key', reuse] : ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-keyout', key]), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-set_serial', String(serial), '-out', join(directory, 'fullchain.pem')], { stdio: 'ignore' });
}

describe('atomic external TLS renewal', () => {
  it('serves the renewed certificate without changing the public key or restarting the listener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strudel-ca-hook-')), lineage = join(root, 'issuer'), directory = join(root, 'tls');
    await mkdir(lineage); certificate(lineage, 1);
    const server = createServer({ cert: await readFile(join(lineage, 'fullchain.pem')), key: await readFile(join(lineage, 'privkey.pem')) });
    try {
      await installTLS({ lineage, directory, hostname: 'localhost', prepare: true });
      const first = await readlink(join(directory, 'current'));
      await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
      const port = (server.address() as any).port;
      certificate(lineage, 2, join(lineage, 'privkey.pem'));
      const result = await installTLS({ lineage, directory, hostname: 'localhost', probe: async (fingerprint: string) => {
        server.setSecureContext({ cert: await readFile(join(directory, 'current/fullchain.pem')), key: await readFile(join(directory, 'current/privkey.pem')) });
        return probeCertificate({ port, hostname: 'localhost', fingerprint });
      } });
      expect(result).toEqual({ changed: true, verified: true });
      expect(await readlink(join(directory, 'current'))).not.toBe(first);
      expect(await readFile(join(directory, first, 'privkey.pem'))).toEqual(await readFile(join(directory, 'current/privkey.pem')));
      expect(await installTLS({ lineage, directory, hostname: 'localhost' })).toEqual({ changed: false });
    } finally { await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
  });

  it('refuses an unknown key, mismatched key, wrong address and concurrent publication before changing current', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strudel-ca-hook-')), lineage = join(root, 'issuer'), other = join(root, 'other'), directory = join(root, 'tls');
    await mkdir(lineage); await mkdir(other); certificate(lineage, 1); certificate(other, 2);
    try {
      await installTLS({ lineage, directory, hostname: 'localhost', prepare: true });
      const first = await readlink(join(directory, 'current'));
      await expect(installTLS({ lineage: other, directory, hostname: 'localhost' })).rejects.toThrow('public key changed');
      await expect(installTLS({ lineage, directory, hostname: 'elsewhere.invalid' })).rejects.toThrow('public address');
      await mkdir(join(directory, '.install.lock'));
      await expect(installTLS({ lineage, directory, hostname: 'localhost' })).rejects.toThrow('already running');
      await writeFile(join(lineage, 'privkey.pem'), await readFile(join(other, 'privkey.pem')));
      await expect(installTLS({ lineage, directory, hostname: 'localhost' })).rejects.toThrow('do not match');
      expect(await readlink(join(directory, 'current'))).toBe(first);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('restores previous files if Home does not confirm the new certificate, retaining the previous generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strudel-ca-hook-')), lineage = join(root, 'issuer'), directory = join(root, 'tls');
    await mkdir(lineage); certificate(lineage, 1);
    try {
      await installTLS({ lineage, directory, hostname: 'localhost', prepare: true });
      const first = await readlink(join(directory, 'current'));
      const previous = new X509Certificate(await readFile(join(directory, 'current/fullchain.pem')));
      const fingerprint = createHash('sha256').update(previous.raw).digest('hex');
      certificate(lineage, 2, join(lineage, 'privkey.pem'));
      const checked: string[] = [];
      await expect(installTLS({ lineage, directory, hostname: 'localhost', timeout: 0, probe: async (f: string) => { checked.push(f); return f === fingerprint; } })).rejects.toThrow('Home confirms the previous certificate');
      expect(checked).toHaveLength(2); expect(checked[0]).not.toBe(fingerprint); expect(checked[1]).toBe(fingerprint);
      expect(await readlink(join(directory, 'current'))).toBe(first);
      const cert = new X509Certificate(await readFile(join(directory, 'current/fullchain.pem')));
      expect(cert.serialNumber).toBe('01');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
