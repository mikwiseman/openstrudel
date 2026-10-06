import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cloudFixture} from './openstrudel-fixture.mjs';
import {HOME_PROFILE,PAYMENT_CALLBACK} from '../src/openstrudel.mjs';

test('immutable Home quote is 4/30, inclusive and separate from the 2/20 price',t=>{
  const f=cloudFixture(t),{quote,input,order}=f.make();
  assert.equal(quote.profile.ram_mb,4096);assert.equal(quote.profile.disk_gb,30);assert.equal(quote.profile.public_ipv4,1);
  assert.equal(quote.amount_minor,2400);assert.equal(f.s.catalog().plan.amount,1200);
  const stored=f.s.db.get('SELECT * FROM os_installations');assert(!stored.bootstrap_sealed.includes(input.bootstrap.privateKeyPEM));
  assert.equal(f.s.db.get('SELECT * FROM orders').amount,quote.amount_minor);
  f.s.c.homeAmount=3600;assert.equal(f.s.cloud.order(f.a.session,input).order_id,order.order_id);assert.equal(f.s.cloud.status(f.a.session,order.order_id).amount_minor,2400);
  f.advance(16*60000);assert.equal(f.s.cloud.order(f.a.session,input).order_id,order.order_id);
  assert.throws(()=>f.s.cloud.order(f.a.session,{...input,return_state:randomUUID()}),e=>e.code==='idempotency_conflict');
});
test('quotes bind owner, consent, exact return URI and profile; no external identity',t=>{
  const f=cloudFixture(t),{input}=f.make();
  for(const override of [{external_user_id:f.owner.user.id},{consent:false},{quote_digest:'0'.repeat(64)},{return_uri:'https://evil.test/'},{return_uri:PAYMENT_CALLBACK+'?token=steal'}])assert.throws(()=>f.s.cloud.order(f.a.session,{...input,...override}));
  assert.throws(()=>f.s.cloud.order(f.b.session,input));
  assert.throws(()=>f.s.cloud.quote(f.a.session,{profile_id:HOME_PROFILE,payment_method:'card',platform:'ios'}),e=>e.code==='platform_purchase_unavailable');
  assert.equal(f.s.cloud.catalog().platforms.ios.purchase_enabled,false);
  f.s.c.homeLiveApproval='';f.s.c.provider='kamatera';f.s.c.payments='wai_pay';f.s.c.waiPayMode='live';
  assert.equal(f.s.cloud.catalog().purchase_enabled,false);
  assert.throws(()=>f.s.cloud.quote(f.a.session,{profile_id:HOME_PROFILE,payment_method:'card',platform:'mac'}),e=>e.code==='home_purchase_unavailable');
});
test('expired quote, changed deployment profile and reused installation are rejected',t=>{
  const f=cloudFixture(t),q=f.s.cloud.quote(f.a.session,{profile_id:HOME_PROFILE,payment_method:'card',platform:'mac'});
  const input={quote_id:q.quote_id,quote_digest:q.quote_digest,idempotency_key:randomUUID(),consent:true,bootstrap:f.bootstrap(),return_uri:PAYMENT_CALLBACK,return_state:randomUUID()};
  f.s.c.homeImage='changed';assert.throws(()=>f.s.cloud.order(f.a.session,input),e=>e.code==='profile_changed');f.s.c.homeImage='';
  f.advance(900001);assert.throws(()=>f.s.cloud.order(f.a.session,input),e=>e.code==='quote_expired');
});
test('order recovery is owner-only; unsupported calls cannot make cheaper v1 Home renewal',async t=>{
  const f=cloudFixture(t),{order,input}=f.make();await f.ready(order);
  assert.equal(f.s.cloud.list(f.a.session).orders[0].order_id,order.order_id);assert.equal(f.s.cloud.list(f.b.session).orders.length,0);
  for(const fn of [()=>f.s.cloud.status(f.b.session,order.order_id),()=>f.s.cloud.claim(f.b.session,input.bootstrap.installationId,{}),()=>f.s.cloud.manage(f.b.session,input.bootstrap.installationId,'access')])assert.throws(fn,e=>e.status===404);
  const server=f.s.db.get('SELECT * FROM servers');const v1=f.s.renewal(f.owner.user.id,server.id,{consent:true,payment_method:'card'});
  await assert.rejects(()=>f.s.checkout(f.owner.user.id,v1.id),e=>e.code==='home_order_invalid');
});
test('hosted fallback pins returns; an untrusted return never settles the order',async t=>{
  const f=cloudFixture(t),{order,input}=f.make(),r=await f.s.cloud.checkout(f.a.session,order.order_id);
  assert.equal(r.type,'hosted');assert.equal(r.action_required,'complete_payment');assert(r.url.startsWith('https://checkout.stripe.com/'));
  const p=[...f.invoices.values()][0];assert.equal(p.description,'OpenStrudel · Всегда на связи · 30 дней');assert(p.returnUrls.success.startsWith(f.s.c.origin+'/openstrudel/payment-return?'));assert.equal(p.returnUrls.success,p.returnUrls.failure);
  const link=f.s.cloud.paymentReturn(order.order_id,input.return_state);assert(link.startsWith(PAYMENT_CALLBACK));assert(!link.includes('token'));
  assert.throws(()=>f.s.cloud.paymentReturn(order.order_id,'wrong'));assert.equal(f.s.cloud.status(f.a.session,order.order_id).payment_state,'pending');
  assert.equal(f.s.db.get('SELECT count(*) n FROM servers').n,0);
});
test('lost response resumes the same payment; stale expiry does not invite double payment',async t=>{
  const f=cloudFixture(t),{order}=f.make();f.timeout();
  await assert.rejects(()=>f.s.cloud.checkout(f.a.session,order.order_id));
  let status=f.s.cloud.status(f.a.session,order.order_id);assert.equal(status.payment_state,'unknown');assert.equal(status.action_required,'wait_for_confirmation');
  f.failReads(true);await assert.rejects(()=>f.s.cloud.checkout(f.a.session,order.order_id));assert.equal(f.invoices.size,1);
  f.failReads(false);await f.s.cloud.checkout(f.a.session,order.order_id);assert.equal(f.invoices.size,1);
  f.advance(1800001);status=f.s.cloud.status(f.a.session,order.order_id);assert.equal(status.session_state,'confirmation_pending');assert.equal(status.action_required,'wait_for_confirmation');
  assert.throws(()=>f.s.cloud.abandon(f.a.session,order.order_id),e=>e.code==='payment_confirmation_required');
  assert.equal(f.calls.filter(x=>x.method==='POST'&&x.path==='').length,1);
});
test('only verified unpaid expiry permits retry; duplicate settlement never makes two VMs',async t=>{
  const f=cloudFixture(t),{order}=f.make();await f.s.cloud.checkout(f.a.session,order.order_id);
  const first=[...f.invoices.values()][0];Object.assign(first,{status:'expired',paymentVersion:2});await f.s.cloud.sync(f.a.session,order.order_id);
  assert.equal(f.s.cloud.status(f.a.session,order.order_id).action_required,'retry_payment');
  await f.s.cloud.checkout(f.a.session,order.order_id);assert.equal(f.invoices.size,2);
  const event=await f.pay();await f.s.payments.real.webhook(event.raw,event.headers);await f.pay(first);
  assert.equal(f.s.db.get('SELECT count(*) n FROM servers').n,1);assert.equal(f.s.cloud.status(f.a.session,order.order_id).payment_state,'additional_payment_review');
  const after=await f.s.cloud.checkout(f.a.session,order.order_id);assert.equal(after.url,null);assert.equal(f.invoices.size,2);
});
test('partial expired payment stays review-only, cannot abandon or change payment method',async t=>{
  const f=cloudFixture(t),{order}=f.make(f.a.session,{payment_method:'crypto'});await f.s.cloud.checkout(f.a.session,order.order_id);
  Object.assign([...f.invoices.values()][0],{status:'expired',paymentVersion:2,paidAmountMinor:100});await f.s.cloud.sync(f.a.session,order.order_id);
  assert.equal(f.s.cloud.status(f.a.session,order.order_id).action_required,'contact_support');assert.throws(()=>f.s.cloud.abandon(f.a.session,order.order_id));
  const r=await f.s.cloud.checkout(f.a.session,order.order_id);assert.equal(r.url,null);assert.equal(f.invoices.size,1);
});
test('Home remains unready after SSH; only verified Home starts its paid period and erases bootstrap',async t=>{
  const f=cloudFixture(t),{order}=f.make();await f.s.cloud.checkout(f.a.session,order.order_id);await f.pay();
  for(let i=0;i<3;i++){f.advance(10);await f.s.tick();}
  let s=f.s.cloud.status(f.a.session,order.order_id);assert.equal(s.provisioning_state,'checking');assert.equal(s.home_state,'pending');assert.equal(s.paid_until,null);
  await f.s.tick();assert.equal(f.s.cloud.status(f.a.session,order.order_id).home_state,'installing');
  f.s.cloud.installer.fault='pin';await f.s.tick();s=f.s.cloud.status(f.a.session,order.order_id);assert.equal(s.paid_until,null);assert.equal(s.home_state,'installing');
  assert.throws(()=>f.s.cloud.claim(f.a.session,order.installation_id,{}));
  f.s.cloud.installer.fault=null;await f.s.tick();s=f.s.cloud.status(f.a.session,order.order_id);assert.equal(s.home_state,'ready');assert.equal(s.paid_until,f.s.now()+30*86400e3);
  assert.equal(f.s.db.get('SELECT bootstrap_sealed FROM os_installations').bootstrap_sealed,null);
  assert.equal(f.s.cloud.installer.scheduled,1);
});
test('claims bind grant, owner and installation, are one-use, expire, and carry no owner token',async t=>{
  const f=cloudFixture(t),{order}=f.make();await f.ready(order);
  const claim=f.s.cloud.claim(f.a.session,order.installation_id,{}),input={claim_token:claim.claim_token,installation_id:order.installation_id};
  await assert.rejects(()=>f.s.cloud.consumeClaim(f.b.session,input));
  const next=f.grant();await assert.rejects(()=>f.s.cloud.consumeClaim(next.session,input));
  const result=await f.s.cloud.consumeClaim(f.a.session,input);assert.equal(result.owner_token_source,'device_keychain');assert(!JSON.stringify(result).includes('privateKey'));assert.equal(result.mode,'emulator');
  await assert.rejects(()=>f.s.cloud.consumeClaim(f.a.session,input));
  const late=f.s.cloud.claim(f.a.session,order.installation_id,{});f.advance(300001);await assert.rejects(()=>f.s.cloud.consumeClaim(f.a.session,{claim_token:late.claim_token,installation_id:order.installation_id}));
});
test('fresh owner login is required for root, export, deletion and owner-token recovery',async t=>{
  const f=cloudFixture(t),{order}=f.make();await f.ready(order);
  const root=f.s.cloud.manage(f.a.session,order.installation_id,'access');assert(root.private_key.includes('OPENSSH PRIVATE KEY'));
  const exportPlan=f.s.cloud.manage(f.a.session,order.installation_id,'export');assert.equal(exportPlan.type,'manual_ssh');assert(exportPlan.stdin_script.includes('trap'));assert.equal(f.invoices.size,1);
  const recovery=f.s.cloud.claim(f.a.session,order.installation_id,{recover_owner:true}),connection=await f.s.cloud.consumeClaim(f.a.session,{claim_token:recovery.claim_token,installation_id:order.installation_id});assert.equal(connection.owner_token_source,'home_pairing');assert.equal(connection.pairing.emulated,true);
  f.advance(300001);for(const action of ['access','export','delete'])assert.throws(()=>f.s.cloud.manage(f.a.session,order.installation_id,action,{confirm:order.installation_id}),e=>e.code==='reauthorization_required');
  assert.throws(()=>f.s.cloud.claim(f.a.session,order.installation_id,{recover_owner:true}),e=>e.code==='reauthorization_required');
  assert.equal(f.s.cloud.claim(f.a.session,order.installation_id,{}).expires_in,300);
});
test('refund before create prevents VM and after create retains identity for reconciliation',async t=>{
  for(const afterCreate of [false,true]){
    const f=cloudFixture(t),{order}=f.make();await f.s.cloud.checkout(f.a.session,order.order_id);await f.pay();
    if(afterCreate)await f.s.tick();
    const p=[...f.invoices.values()][0];p.refundedAmountMinor=p.paidAmountMinor;p.paymentVersion++;await f.event(p,'refund.succeeded');
    await f.s.tick();assert.equal(f.s.cloud.status(f.a.session,order.order_id).payment_state,'refunded');
    assert.equal((await f.s.provider.list()).length,afterCreate?1:0);assert.notEqual(f.s.cloud.status(f.a.session,order.order_id).home_state,'ready');
    if(afterCreate)assert(f.s.db.get('SELECT provider_id FROM servers').provider_id);
  }
});
test('renewal uses an immutable new quote on the same VM; cancellation and deletion differ',async t=>{
  const f=cloudFixture(t),{order}=f.make();await f.ready(order);const before=f.s.cloud.status(f.a.session,order.order_id).paid_until;
  const renewal=f.make(f.a.session,{installation_id:order.installation_id});assert.equal(renewal.order.kind,'renewal');assert.equal(renewal.order.amount_minor,2400);
  await f.s.cloud.checkout(f.a.session,renewal.order.order_id);await f.pay();assert.equal(f.s.db.get('SELECT paid_until FROM servers').paid_until,before+30*86400e3);assert.equal((await f.s.provider.list()).length,1);
  f.s.cloud.manage(f.a.session,order.installation_id,'cancellation',{cancel_at_end:true});assert.equal(f.s.db.get('SELECT state FROM servers').state,'ready');
  assert.throws(()=>f.s.cloud.manage(f.a.session,order.installation_id,'delete',{confirm:'wrong'}));
  f.s.cloud.manage(f.a.session,order.installation_id,'delete',{confirm:order.installation_id});for(let i=0;i<5;i++)await f.s.tick();assert.equal((await f.s.provider.list()).length,0);
});
test('account recovery restores saved Home without a second VM and revokes older app access',async t=>{
  const f=cloudFixture(t),{order}=f.make();await f.ready(order);
  f.s.recovery.recover(f.owner.user.email,f.owner.recovery_code,'a newly recovered long password','restore-ip');
  assert.throws(()=>f.s.cloud.auth.authenticate(f.a.access_token));
  const login=f.s.login(f.owner.user.email,'a newly recovered long password','return-ip'),fresh=f.grant(login);
  assert.equal(f.s.cloud.list(fresh.session).orders[0].order_id,order.order_id);assert.equal((await f.s.provider.list()).length,1);
});
test('late settlement after verified abandonment is refund review, even with a newer pending order',async t=>{
  const f=cloudFixture(t),{order}=f.make();await f.s.cloud.checkout(f.a.session,order.order_id);const old=[...f.invoices.values()][0];old.status='expired';old.paymentVersion++;
  await f.s.cloud.sync(f.a.session,order.order_id);f.s.cloud.abandon(f.a.session,order.order_id);const next=f.make();
  await f.pay(old);assert.equal(f.s.cloud.status(f.a.session,order.order_id).payment_state,'refund_review');assert.equal(f.s.cloud.status(f.a.session,next.order.order_id).order_status,'draft');assert.equal(f.s.db.get('SELECT count(*) n FROM servers').n,0);
});
test('refunded renewal is reported as refunded, without destroying the existing Home',async t=>{
  const f=cloudFixture(t),{order}=f.make();await f.ready(order);const next=f.make(f.a.session,{installation_id:order.installation_id});await f.s.cloud.checkout(f.a.session,next.order.order_id);await f.pay();
  const p=[...f.invoices.values()].at(-1);p.refundedAmountMinor=p.paidAmountMinor;p.paymentVersion++;await f.event(p,'refund.succeeded');
  assert.equal(f.s.cloud.status(f.a.session,next.order.order_id).payment_state,'refunded');assert.equal((await f.s.provider.list()).length,1);assert.equal(f.s.db.get('SELECT state FROM servers').state,'ready');
});
