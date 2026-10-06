import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Service, config, DAY } from '../src/service.mjs';
import { ProviderError } from '../src/providers.mjs';
import { webhookSignature, hash } from '../src/security.mjs';
import { createServer } from '../src/main.mjs';

mkdirSync('work/test-runs',{recursive:true});
function fixture(t) {const dir=mkdtempSync(resolve('work/test-runs/service-'));let now=Date.now();const c=config({WAI_DATA:dir}),s=new Service(c,{now:()=>now});t.after(()=>{try{s.db.close();}catch{}rmSync(dir,{recursive:true,force:true});});return {s,c,dir,advance:n=>{now+=n;}};}
const account=(s,n='alice')=>s.register(n+'@example.test','correct horse battery staple!','ip-'+n);
const order=(s,a,purpose='agent')=>s.order(a.user.id,{purpose,idempotency_key:crypto.randomUUID(),consent:true});
async function paid(s,a,purpose='agent') {const o=order(s,a,purpose);await s.checkout(a.user.id,o.id);const p=s.db.get('SELECT * FROM payments WHERE order_id=?',o.id),e=s.payments.localEvent(p.session_id,'success');await s.payments.webhook(e.raw,e.signature);return s.db.get('SELECT * FROM servers WHERE order_id=?',o.id);}
async function ready(s,id) {for(let i=0;i<5;i++)await s.tick();return s.db.get('SELECT * FROM servers WHERE id=?',id);}

test('accounts, validation, durable sessions, expiry, logout',t=>{const {s,advance}=fixture(t);assert.throws(()=>s.register('bad','tiny','x'));const a=account(s);assert.throws(()=>account(s),/существует/);assert.throws(()=>s.login(a.user.email,'wrong','x'),/не совпадают/);const b=s.login(a.user.email,'correct horse battery staple!','y');assert.equal(s.auth(b.token).user_id,a.user.id);assert.notEqual(s.db.get('SELECT password FROM users').password,'correct horse battery staple!');advance(DAY+1);assert.throws(()=>s.auth(a.token),/истекла/);});
test('login rate limits survive a process restart',t=>{const {s,c}=fixture(t);const a=account(s);for(let i=0;i<10;i++)assert.throws(()=>s.login(a.user.email,'wrong','p'));s.db.close();const restarted=new Service(c);assert.throws(()=>restarted.login(a.user.email,'correct horse battery staple!','p'),/много/);restarted.db.close();});
test('order idempotency rejects changed input and deduplicates repeated clicks',t=>{const {s}=fixture(t),a=account(s);const b={purpose:'agent',idempotency_key:'same-key-123',consent:true,amount:1};const o=s.order(a.user.id,b);assert.equal(o.amount,1200);assert.equal(s.order(a.user.id,b).id,o.id);assert.equal(order(s,a).id,o.id);assert.throws(()=>s.order(a.user.id,{...b,purpose:'site'}),/другими/);assert.throws(()=>s.order(a.user.id,{...b,consent:false}),/Подтвердите/);});
test('CLI price consent is checked before an order exists',t=>{
  const {s}=fixture(t),a=account(s),catalog=s.catalog();assert.equal(catalog.client_quote_version,1);
  const request={purpose:'clean',idempotency_key:'explicit-quote-test',payment_method:'test',consent:true,quote:{amount:1100,currency:'usd',period_days:30}};
  assert.throws(()=>s.order(a.user.id,request),/Цена изменилась/);assert.equal(s.db.get('SELECT count(*) n FROM orders').n,0);
  request.quote.amount=1200;const accepted=s.order(a.user.id,request);assert.equal(accepted.amount,1200);assert.equal(s.order(a.user.id,request).id,accepted.id);
});
test('checkout click concurrency returns one durable payment',async t=>{const {s}=fixture(t),a=account(s),o=order(s,a);const results=await Promise.all(Array.from({length:12},()=>s.checkout(a.user.id,o.id)));assert.equal(new Set(results.map(x=>x.url)).size,1);assert.equal(s.db.get('SELECT count(*) n FROM payments').n,1);assert.equal(s.db.get('SELECT count(*) n FROM servers').n,0);});
test('success return URL does not provision; cancel and failed payments do not provision',async t=>{const {s}=fixture(t),a=account(s),o=order(s,a);await s.checkout(a.user.id,o.id);const p=s.db.get('SELECT * FROM payments WHERE order_id=?',o.id);for(const result of ['cancel','fail']){const e=s.payments.localEvent(p.session_id,result);await s.payments.webhook(e.raw,e.signature);}await s.tick();assert.equal(s.db.get('SELECT count(*) n FROM servers').n,0);assert.equal(s.ownOrder(a.user.id,o.id).status,'checkout');});
test('signed and corroborated payment is applied exactly once; out-of-order failures never undo it',async t=>{const {s}=fixture(t),a=account(s),o=order(s,a);await s.checkout(a.user.id,o.id);const p=s.db.get('SELECT * FROM payments WHERE order_id=?',o.id),e=s.payments.localEvent(p.session_id,'success');await Promise.all(Array.from({length:8},()=>s.payments.webhook(e.raw,e.signature)));for(const result of ['success','fail','cancel']){const ev=s.payments.localEvent(p.session_id,result);await s.payments.webhook(ev.raw,ev.signature);}for(let i=0;i<5;i++)await s.tick();assert.equal(s.db.get('SELECT count(*) n FROM servers').n,1);assert.equal(s.db.get('SELECT count(*) n FROM sim_machines').n,1);assert.equal(s.ownOrder(a.user.id,o.id).status,'fulfilled');});
test('forged and old signatures cannot fulfill orders',async t=>{const {s}=fixture(t),a=account(s),o=order(s,a);await s.checkout(a.user.id,o.id);const p=s.db.get('SELECT * FROM payments WHERE order_id=?',o.id),e=s.payments.localEvent(p.session_id,'success');await assert.rejects(()=>s.payments.webhook(e.raw,'t=1,v1=bad'),/подпись/);await assert.rejects(()=>s.payments.webhook(e.raw,webhookSignature(e.raw,s.vault.webhookSecret,Math.floor(s.now()/1000)-301)),/подпись/);assert.equal(s.db.get('SELECT count(*) n FROM servers').n,0);});
test('tampered amount, currency, user, order, live mode, and session are rejected',async t=>{const {s}=fixture(t),a=account(s),o=order(s,a);await s.checkout(a.user.id,o.id);const p=s.db.get('SELECT * FROM payments WHERE order_id=?',o.id),e=s.payments.localEvent(p.session_id,'success');const changes=[e=>e.data.object.amount_total=1,e=>e.data.object.currency='eur',e=>e.data.object.client_reference_id='someone',e=>e.data.object.metadata.user_id='other',e=>e.data.object.metadata.order_id='missing',e=>e.livemode=true,e=>e.data.object.livemode=true,e=>e.data.object.id='another'];for(const change of changes){const x=JSON.parse(e.raw);x.id='evt_'+crypto.randomUUID();change(x);const raw=JSON.stringify(x);await assert.rejects(()=>s.payments.webhook(raw,webhookSignature(raw,s.vault.webhookSecret)));}assert.equal(s.db.get('SELECT count(*) n FROM servers').n,0);});
test('paid event waits for checkout corroboration and the same event can safely retry',async t=>{
  const {s}=fixture(t),a=account(s),o=order(s,a);await s.checkout(a.user.id,o.id);
  const p=s.db.get('SELECT * FROM payments WHERE order_id=?',o.id),e=s.payments.localEvent(p.session_id,'fail'),x=JSON.parse(e.raw);
  x.type='checkout.session.completed';x.data.object.payment_status='paid';const raw=JSON.stringify(x),signature=webhookSignature(raw,s.vault.webhookSecret);
  await assert.rejects(()=>s.payments.webhook(raw,signature),e=>e.status===503);
  assert.equal(s.db.get('SELECT count(*) n FROM servers').n,0);assert.equal(s.db.get('SELECT count(*) n FROM payment_events').n,0);
  s.db.run("UPDATE sim_payments SET state='paid' WHERE id=?",p.session_id);
  await s.payments.webhook(raw,signature);await s.payments.webhook(raw,signature);
  assert.equal(s.db.get('SELECT count(*) n FROM servers').n,1);
});
test('event ID reused with altered payload is rejected',async t=>{const {s}=fixture(t),a=account(s),o=order(s,a);await s.checkout(a.user.id,o.id);const p=s.db.get('SELECT * FROM payments WHERE order_id=?',o.id),e=s.payments.localEvent(p.session_id,'success');await s.payments.webhook(e.raw,e.signature);const x=JSON.parse(e.raw);x.foo='changed';const raw=JSON.stringify(x);await assert.rejects(()=>s.payments.webhook(raw,webhookSignature(raw,s.vault.webhookSecret)),/изменено/);});
test('timeout after creation recovers by exact name without repeating POST',async t=>{const {s}=fixture(t),a=account(s),v=await paid(s,a);s.provider.fault='timeout_after';await s.tick();assert.equal(s.db.get('SELECT state FROM operations').state,'unknown');const r=await ready(s,v.id);assert.equal(r.state,'ready');assert.equal(s.db.get('SELECT count(*) n FROM attempts').n,1);assert.equal(s.db.get('SELECT count(*) n FROM sim_machines').n,1);});
test('timeout before creation never triggers blind create even after user retries',async t=>{const {s,advance}=fixture(t),a=account(s),v=await paid(s,a);s.provider.fault='timeout_before';await s.tick();s.provider.fault=null;advance(16*60e3);await s.tick();assert.equal(s.db.get('SELECT state FROM operations').state,'attention');s.retry(a.user.id,v.id);await s.tick();assert.equal(s.db.get('SELECT count(*) n FROM attempts').n,1);assert.equal(s.db.get('SELECT count(*) n FROM sim_machines').n,0);});
for(const fault of ['capacity','balance'])test(`${fault}: paid order retained; explicit retry after definitive rejection succeeds once`,async t=>{const {s}=fixture(t),a=account(s),v=await paid(s,a);s.provider.fault=fault;await s.tick();assert.equal(s.db.get('SELECT state FROM operations').state,'rejected');assert.equal(s.ownOrder(a.user.id,v.order_id).status,'fulfilling');s.provider.fault=null;s.retry(a.user.id,v.id);assert.equal((await ready(s,v.id)).state,'ready');assert.equal(s.db.get('SELECT count(*) n FROM sim_machines').n,1);assert.equal(s.db.get('SELECT count(*) n FROM attempts').n,2);});
test('restart after provider creation but before recording result recovers',async t=>{const {s,c}=fixture(t),a=account(s),v=await paid(s,a);s.db.run("UPDATE operations SET state='submitting',attempt=1 WHERE server_id=?",v.id);await s.provider.create(v);s.db.close();const restarted=new Service(c);assert.equal((await ready(restarted,v.id)).state,'ready');assert.equal(restarted.db.get('SELECT count(*) n FROM sim_machines').n,1);restarted.db.close();});
test('setup failure never issues another create, and can recover',async t=>{const {s}=fixture(t),a=account(s),v=await paid(s,a);s.provider.fault='setup';for(let i=0;i<4;i++)await s.tick();assert.equal(s.db.get('SELECT state FROM servers').state,'configuring');assert.equal(s.db.get('SELECT count(*) n FROM sim_machines').n,1);s.provider.fault=null;assert.equal((await ready(s,v.id)).state,'ready');});
test('access is encrypted at rest, never in dashboard, owned, recent auth required',async t=>{const {s,advance,dir}=fixture(t),a=account(s),b=account(s,'bob'),v=await paid(s,a);await ready(s,v.id);const key=s.access(a.user.id,v.id,s.auth(a.token));assert.match(key,/BEGIN OPENSSH PRIVATE KEY/);assert(!JSON.stringify(s.dashboard(a.user.id)).includes('PRIVATE KEY'));assert(!s.db.get('SELECT private_key FROM servers').private_key.includes('PRIVATE KEY'));assert.throws(()=>s.access(b.user.id,v.id,s.auth(b.token)),/не найден/);assert.throws(()=>s.ownOrder(b.user.id,v.order_id));writeFileSync(join(dir,'verify-key'),key,{mode:0o600});assert.match(execFileSync('ssh-keygen',['-y','-f',join(dir,'verify-key')],{encoding:'utf8'}),/^ssh-ed25519/);advance(301e3);assert.throws(()=>s.access(a.user.id,v.id,s.auth(a.token)),/подтвердите/);s.reauth(s.auth(a.token),'correct horse battery staple!');assert(s.access(a.user.id,v.id,s.auth(a.token)));});
test('renewal consent, unique checkout and duplicate event extend exactly one period',async t=>{const {s}=fixture(t),a=account(s),v=await paid(s,a),r=await ready(s,v.id);assert.throws(()=>s.renewal(a.user.id,v.id,{consent:false}));const o=s.renewal(a.user.id,v.id,{consent:true});assert.equal(s.renewal(a.user.id,v.id,{consent:true}).id,o.id);await s.checkout(a.user.id,o.id);const p=s.db.get('SELECT * FROM payments WHERE order_id=?',o.id),e=s.payments.localEvent(p.session_id,'success');await s.payments.webhook(e.raw,e.signature);await s.payments.webhook(e.raw,e.signature);assert.equal(s.ownServer(a.user.id,v.id).paid_until,r.paid_until+30*DAY);assert.equal(s.db.get('SELECT count(*) n FROM servers').n,1);});
test('cancellation preserves paid access, then confirms provider deletion',async t=>{const {s,advance}=fixture(t),a=account(s),v=await paid(s,a);await ready(s,v.id);s.cancel(a.user.id,v.id,{cancel_at_end:true});await s.tick();assert.equal(s.ownServer(a.user.id,v.id).state,'ready');advance(30*DAY+1);for(let i=0;i<5;i++)await s.tick();assert.equal(s.ownServer(a.user.id,v.id).state,'deleted');assert.equal((await s.provider.list()).length,0);});
test('past due: 3-day grace then verified deletion; stopping is not deletion',async t=>{const {s,advance}=fixture(t),a=account(s),v=await paid(s,a);await ready(s,v.id);advance(30*DAY+1);await s.tick();assert.equal(s.ownServer(a.user.id,v.id).state,'overdue');assert.equal((await s.provider.list()).length,1);advance(3*DAY);await s.tick();assert.equal(s.ownServer(a.user.id,v.id).state,'deleting');for(let i=0;i<5;i++)await s.tick();assert.equal(s.ownServer(a.user.id,v.id).state,'deleted');});
test('late renewal payment during deletion becomes visible refund task and cannot resurrect server',async t=>{const {s}=fixture(t),a=account(s),v=await paid(s,a);await ready(s,v.id);const o=s.renewal(a.user.id,v.id,{consent:true});await s.checkout(a.user.id,o.id);s.remove(a.user.id,v.id,{confirm:v.id},s.auth(a.token));const p=s.db.get('SELECT * FROM payments WHERE order_id=?',o.id),e=s.payments.localEvent(p.session_id,'success');await s.payments.webhook(e.raw,e.signature);assert.equal(s.ownOrder(a.user.id,o.id).status,'needs_refund');assert.equal(s.ownServer(a.user.id,v.id).state,'deleting');});
test('deletion needs exact typed ID, current auth, and ownership',async t=>{const {s}=fixture(t),a=account(s),b=account(s,'bob'),v=await paid(s,a);await ready(s,v.id);assert.throws(()=>s.remove(a.user.id,v.id,{confirm:'yes'},s.auth(a.token)));assert.throws(()=>s.remove(b.user.id,v.id,{confirm:v.id},s.auth(b.token)));assert.equal(s.ownServer(a.user.id,v.id).state,'ready');});
test('two independent worker processes cannot create duplicate VMs',async t=>{const {s,c}=fixture(t),a=account(s),v=await paid(s,a);const code=`import {Service} from './src/service.mjs';const s=new Service(${JSON.stringify(c)});for(let i=0;i<5;i++)await s.tick();s.db.close();`;
  const child=()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});let err='';p.stderr.on('data',x=>err+=x);p.on('close',x=>x===0?resolve():reject(Error(err)));});await Promise.all([child(),child()]);await ready(s,v.id);assert.equal(s.db.get('SELECT count(*) n FROM sim_machines').n,1);assert.equal(s.db.get('SELECT count(*) n FROM attempts').n,1);});
test('HTTP journey enforces CSRF, cookies, isolation, webhook and no-store key download',async t=>{const {s}=fixture(t);const server=createServer(s);await new Promise(r=>server.listen(0,'127.0.0.1',r));s.c.origin='http://127.0.0.1:'+server.address().port;t.after(()=>new Promise(r=>server.close(r)));
  const request=async(path,method='GET',body,cookie='',csrf='',origin=s.c.origin)=>{const r=await fetch(s.c.origin+path,{method,headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});let data=await r.text();try{data=JSON.parse(data);}catch{}return {r,data};};
  let a=await request('/api/v1/auth/register','POST',{email:'http@example.test',password:'correct horse battery staple!'});assert.equal(a.r.status,200);const cookie=a.r.headers.get('set-cookie').split(';')[0],csrf=a.data.csrf;assert.match(a.r.headers.get('set-cookie'),/HttpOnly/);assert.match(a.r.headers.get('set-cookie'),/SameSite=Strict/);
  assert.equal((await request('/api/v1/orders','POST',{},cookie,'wrong')).r.status,403);assert.equal((await request('/api/v1/orders','POST',{},cookie,csrf,'https://evil.example')).r.status,403);
  a=await request('/api/v1/orders','POST',{purpose:'site',idempotency_key:'http-test-idempotent',consent:true},cookie,csrf);const id=a.data.id;assert.equal(a.r.status,201);assert.equal((await request('/api/v1/orders/'+id)).r.status,401);
  const b=await request('/api/v1/auth/register','POST',{email:'other@example.test',password:'correct horse battery staple!'}),bc=b.r.headers.get('set-cookie').split(';')[0];assert.equal((await request('/api/v1/orders/'+id,'GET',null,bc)).r.status,404);
  const checkout=await request('/api/v1/orders/'+id+'/checkout','POST',{},cookie,csrf);const path=new URL(checkout.data.url).pathname;assert.equal((await request(path,'GET',null,bc)).r.status,404);
  assert.equal((await request('/?order='+id+'&payment=success','GET',null,cookie)).r.status,200);assert.equal(s.db.get('SELECT count(*) n FROM servers').n,0);
  assert.equal((await request(path+'/result','POST',{result:'success'},cookie,csrf)).r.status,200);const sid=s.db.get('SELECT id FROM servers').id;await ready(s,sid);
  const key=await request('/api/v1/servers/'+sid+'/access','POST',{},cookie,csrf);assert.equal(key.r.status,200);assert.match(key.data,/OPENSSH PRIVATE KEY/);assert.equal(key.r.headers.get('cache-control'),'no-store');assert.match(key.r.headers.get('content-disposition'),/attachment/);
  assert.equal((await request('/api/v1/servers/'+sid+'/access','POST',{},bc,b.data.csrf)).r.status,404);
  await request('/api/v1/auth/logout','POST',{},cookie,csrf);assert.equal((await request('/api/v1/me','GET',null,cookie)).r.status,401);
});
test('mode switching and accidental public emulator are blocked',t=>{const {s,c}=fixture(t);assert.throws(()=>config({WAI_HOST:'0.0.0.0'}),/loopback/);assert.throws(()=>config({WAI_PAYMENTS:'stripe_live'}));assert.throws(()=>config({WAI_PAYMENTS:'stripe_test',WAI_STRIPE_SECRET_KEY:'sk_live_x'}));s.db.close();assert.throws(()=>new Service({...c,provider:'kamatera'}),/separate data directory/);});

test('in-flight reconciliation cannot overwrite a concurrent accepted deletion',async t=>{
  const {s,advance}=fixture(t),a=account(s),v=await paid(s,a);
  s.provider.fault='timeout_before';await s.tick();advance(16*60e3);await s.tick();
  assert.equal(s.ownServer(a.user.id,v.id).state,'attention');
  s.provider.fault=null;await s.provider.create(v); // The timed-out request becomes visible late.
  const normal=s.provider.find.bind(s.provider);let release;
  s.provider.find=async name=>{const rows=await normal(name);return new Promise(r=>{release=()=>r(rows);});};
  const pending=s.tick();await new Promise(r=>setImmediate(r));
  s.reauth(s.auth(a.token),'correct horse battery staple!');s.remove(a.user.id,v.id,{confirm:v.id},s.auth(a.token));
  release();await pending;s.provider.find=normal;
  assert.equal(s.ownServer(a.user.id,v.id).state,'deleting');
  assert.equal(s.db.get('SELECT state FROM operations WHERE server_id=?',v.id).state,'delete_check');
  for(let i=0;i<5;i++)await s.tick();
  assert.equal(s.ownServer(a.user.id,v.id).state,'deleted');assert.equal((await s.provider.list()).length,0);
  assert.equal(s.db.get('SELECT count(*) n FROM attempts').n,1);
});

test('removing an unknown create keeps reconciliation active until late VM is explicitly deleted',async t=>{
  const {s,advance}=fixture(t),a=account(s),v=await paid(s,a);
  s.provider.fault='timeout_before';await s.tick();advance(16*60e3);await s.tick();
  s.reauth(s.auth(a.token),'correct horse battery staple!');s.remove(a.user.id,v.id,{confirm:v.id},s.auth(a.token));
  await s.tick();assert.equal(s.ownServer(a.user.id,v.id).state,'deleting');
  assert.equal(s.db.get('SELECT state FROM operations').state,'delete_attention');
  s.provider.fault=null;await s.provider.create(v);await s.tick();
  assert.equal((await s.provider.list()).length,1); // No mutation until explicit retry.
  s.retry(a.user.id,v.id);for(let i=0;i<5;i++)await s.tick();
  assert.equal(s.ownServer(a.user.id,v.id).state,'deleted');assert.equal((await s.provider.list()).length,0);
});

for(const leaseChange of ['expired','taken_over'])test(`${leaseChange} worker lease fences post-await writes and subsequent setup`,async t=>{
  const {s}=fixture(t),a=account(s),v=await paid(s,a);await s.tick();await s.tick();
  assert.equal(s.ownServer(a.user.id,v.id).state,'configuring');
  const normal=s.provider.details.bind(s.provider);let release,setupCalls=0;
  s.provider.details=async v=>{const details=await normal(v);return new Promise(r=>{release=()=>r(details);});};
  s.provider.setup=async()=>{setupCalls++;return {hostKey:'must not be used'};};
  const pending=s.tick();await new Promise(r=>setImmediate(r));
  if(leaseChange==='expired')s.db.run("UPDATE leases SET expires=? WHERE name='worker'",s.now()-1);
  else s.db.run("UPDATE leases SET owner=? WHERE name='worker'",'another-worker');
  release();await pending;
  assert.equal(setupCalls,0);assert.equal(s.ownServer(a.user.id,v.id).ip,null);
  assert.equal(s.db.get('SELECT state FROM operations').state,'configuring');
  if(leaseChange==='taken_over')assert.equal(s.db.get("SELECT owner FROM leases WHERE name='worker'").owner,'another-worker');
});

test('persistent worker cursor serves new paid orders despite eight stuck setup operations',async t=>{
  const {s,c,advance}=fixture(t);
  for(let i=0;i<8;i++)await paid(s,account(s,'stuck'+i));
  s.provider.fault='setup';for(let i=0;i<3;i++)await s.tick();advance(1000);
  const v=await paid(s,account(s,'new-customer'));
  assert.equal(s.db.get('SELECT count(*) n FROM sim_machines').n,8);
  const restarted=new Service(c,{now:s.now});
  try {
    restarted.provider.fault='setup';for(let i=0;i<3;i++)await restarted.tick();
    assert.equal(s.db.get('SELECT count(*) n FROM attempts WHERE server_id=?',v.id).n,1);
    assert.notEqual(s.db.get('SELECT state FROM operations WHERE server_id=?',v.id).state,'queued');
    assert.equal(s.db.get('SELECT count(*) n FROM sim_machines').n,9);
  } finally {restarted.db.close();}
});

test('poweroff timeout escalates visibly; explicit retry rechecks running VM and completes deletion',async t=>{
  const {s,advance}=fixture(t),a=account(s),v=await paid(s,a);await ready(s,v.id);
  const normal=s.provider.poweroff.bind(s.provider);let calls=0;
  s.provider.poweroff=async v=>{calls++;if(calls===1)throw new ProviderError('network_before_request');return normal(v);};
  s.remove(a.user.id,v.id,{confirm:v.id},s.auth(a.token));await s.tick();advance(16*60e3);await s.tick();
  assert.equal(s.ownServer(a.user.id,v.id).state,'deleting');assert.equal(s.db.get('SELECT state FROM operations').state,'delete_attention');
  assert.equal(calls,1);assert.equal((await s.provider.list())[0].state,'running');
  s.retry(a.user.id,v.id);for(let i=0;i<5;i++)await s.tick();
  assert.equal(calls,2);assert.equal(s.ownServer(a.user.id,v.id).state,'deleted');
});

test('definitive DELETE failure is recoverable only by explicit retry with fresh off verification',async t=>{
  const {s}=fixture(t),a=account(s),v=await paid(s,a);await ready(s,v.id);
  const normal=s.provider.remove.bind(s.provider);let calls=0;
  s.provider.remove=async v=>{calls++;assert.equal((await s.provider.details(v)).state,'off');if(calls===1)throw new ProviderError('provider_http_400',true);return normal(v);};
  s.remove(a.user.id,v.id,{confirm:v.id},s.auth(a.token));for(let i=0;i<5;i++)await s.tick();
  assert.equal(calls,1);assert.equal(s.db.get('SELECT state FROM operations').state,'delete_attention');
  assert.equal(s.ownServer(a.user.id,v.id).state,'deleting');
  s.retry(a.user.id,v.id);for(let i=0;i<5;i++)await s.tick();
  assert.equal(calls,2);assert.equal(s.ownServer(a.user.id,v.id).state,'deleted');
});

test('unknown DELETE result reconciles confirmed absence without sending another DELETE',async t=>{
  const {s}=fixture(t),a=account(s),v=await paid(s,a);await ready(s,v.id);
  const normal=s.provider.remove.bind(s.provider);let calls=0;
  s.provider.remove=async v=>{calls++;await normal(v);throw new ProviderError('unknown_result');};
  s.remove(a.user.id,v.id,{confirm:v.id},s.auth(a.token));for(let i=0;i<5;i++)await s.tick();
  assert.equal(calls,1);assert.equal(s.ownServer(a.user.id,v.id).state,'deleted');
});
