import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Service, config } from '../src/service.mjs';
import { passwordHash, token } from '../src/security.mjs';

const s = new Service(config());
const output = resolve('work/openstrudel.env');
try {
  if (!s.agents.sandbox()) throw Error('OpenStrudel test key requires a separate emulator runtime.');
  if (existsSync(output)) {
    const raw = readFileSync(output, 'utf8').match(/^WAI_VDS_API_KEY=(\S+)$/m)?.[1];
    const session = s.auth(raw);
    if (!session.scopes?.includes('sandbox:provision')) throw Error('Existing file is not a sandbox key.');
    console.log(JSON.stringify({ key_file: output, reused: true, expires: new Date(session.expires).toISOString(), mode: 'emulator', secret_displayed: false }));
  } else {
    let user = s.db.get("SELECT value FROM settings WHERE key='openstrudel_account'")?.value;
    if (!user) {
      user = randomUUID();
      s.db.tx(() => {
        s.db.run('INSERT INTO users VALUES(?,?,?,?)', user, 'openstrudel+' + user + '@example.invalid', passwordHash(token()), s.now());
        s.db.run("INSERT INTO settings VALUES('openstrudel_account',?)", user);
      });
    }
    const key = s.agents.issue(user, { name: 'OpenStrudel · sandbox', sandbox: true, max_servers: 10, expires_days: 30 });
    try {
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
      writeFileSync(output, 'WAI_VDS_BASE_URL=' + s.c.origin + '\nWAI_VDS_API_KEY=' + key.token + '\n', { mode: 0o600, flag: 'wx' });
    } catch (error) { s.agents.revoke(user, key.key.id); throw error; }
    console.log(JSON.stringify({ key_file: output, key_id: key.key.id, expires: new Date(key.key.expires).toISOString(), max_active_servers: 10, mode: 'emulator', secret_displayed: false }));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message })); process.exitCode = 1;
} finally { s.db.close(); }
