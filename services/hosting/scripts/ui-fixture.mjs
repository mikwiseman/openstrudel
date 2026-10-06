/** Disposable local UI acceptance. No environment credentials, mail or provider. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Service, config } from '../src/service.mjs';
import { createServer } from '../src/main.mjs';

const directory = await mkdtemp(join(tmpdir(), 'openstrudel-store-ui-'));
const service = new Service(config({ WAI_DATA: directory, WAI_HOST: '127.0.0.1', WAI_PORT: '63871', WAI_ORIGIN: 'http://127.0.0.1:63871', WAI_PROVIDER: 'emulator', WAI_PAYMENTS: 'emulator' }));
const server = createServer(service);
server.listen(63871, '127.0.0.1', () => console.log('Synthetic hosting UI: http://127.0.0.1:63871'));
const timer = setInterval(() => service.tick().catch(() => console.error('Synthetic worker failed')), 1200);
async function stop() { clearInterval(timer); await new Promise(done => server.close(done)); service.db.close(); await rm(directory, { recursive: true, force: true }); process.exit(0); }
process.once('SIGTERM', stop); process.once('SIGINT', stop);
