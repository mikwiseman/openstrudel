/** Loopback-only native enrollment fixture. No Codex, Telegram, or user data. */
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { MobileAccess } from '../../src/mobile.js';

const directory = await mkdtemp(join(tmpdir(), 'strudel-pairing-'));
const store = new Store(':memory:');
let offset = 0;
let unavailableUntil = 0;
let healthRequests = 0;
let pendingOutage = false;
let unavailableResponses = 0;
const mobile = new MobileAccess(store, (req, res) => {
  const path = req.url?.split('?')[0];
  if (pendingOutage) { pendingOutage = false; unavailableUntil = Date.now()+8000; }
  if (path === '/health') healthRequests++;
  if (Date.now() < unavailableUntil) { unavailableResponses++; res.writeHead(503).end('{"error":"Temporarily unavailable"}'); return; }
  const payload = path === '/health' ? {ok:true, platform:'darwin'}
    : path === '/v1/profiles' ? {profiles:[]}
    : path === '/v1/account' ? {account:{connected:true,managed:false,email:'pairing@test.invalid'}}
    : path === '/v1/integrations' ? {telegram:{configured:false,running:false,linkedChats:[]}}
    : path === '/v1/conversation' ? {
      conversation:{id:'pairing-test',channel:'api',createdAt:'2026-09-30T12:00:00Z',updatedAt:'2026-09-30T12:00:00Z'},
      messages:[{id:'welcome',conversationId:'pairing-test',channel:'api',direction:'outbound',replyToId:null,text:'Подключение проверено.',externalId:null,createdAt:'2026-09-30T12:00:00Z',status:'completed',kind:'text',error:null}]
    } : {};
  res.end(JSON.stringify(payload));
}, {directory,port:0,host:'127.0.0.1',hostname:'127.0.0.1',now:()=>Date.now()+offset});
const control = createServer(async (req,res) => {
  const route = new URL(req.url ?? '/', 'http://127.0.0.1');
  res.setHeader('Content-Type','application/json');
  if(route.pathname === '/invite') {
    offset = 0;
    const invite = await mobile.invite();
    if(route.searchParams.has('expired')) offset = 301000;
    unavailableUntil = 0; pendingOutage = route.searchParams.has('delay');
    const url = new URL(invite.url);url.searchParams.set('name','Mac mini · Проверка');
    res.end(JSON.stringify({...invite,url:url.toString()}));return;
  }
  if(route.pathname === '/revoke') { store.deleteSetting('mobile.tokens');res.end('{}');return; }
  if(route.pathname === '/state') {res.end(JSON.stringify({...mobile.status(),healthRequests,unavailableResponses}));return;}
  res.writeHead(404).end('{}');
});
await new Promise<void>(done => control.listen(0,'127.0.0.1',done));
const address = control.address() as {port:number};
const output = process.argv[2];
if (!output) throw new Error('Pass the path for the fixture endpoint');
await writeFile(output,JSON.stringify({url:`http://127.0.0.1:${address.port}`}),{mode:0o600});
console.log('Isolated pairing fixture ready.');
async function close() {control.close();await mobile.close();store.close();await rm(directory,{recursive:true,force:true});process.exit(0);}
process.on('SIGTERM',close);process.on('SIGINT',close);
