import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Service,config} from '../src/service.mjs';
import {OpenStrudelAuthorization,NATIVE_CALLBACK,pkceChallenge} from '../src/openstrudel-auth.mjs';

const password='a strong owner password for tests';
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'wai-os-auth-'));let now=Date.now();
  const s=new Service(config({WAI_DATA:dir}),{now:()=>now}),oauth=new OpenStrudelAuthorization(s);
  const owner=s.register('owner@example.test',password,'owner'),other=s.register('other@example.test',password,'other');
  t.after(()=>{s.db.close();rmSync(dir,{recursive:true,force:true});});
  return {s,oauth,owner,other,advance:ms=>now+=ms};
}
function begin(f,override={}) {
  const verifier='A'.repeat(43),input={client_id:'openstrudel',response_type:'code',redirect_uri:NATIVE_CALLBACK,state:'opaque-owner-attempt-12345',scope:'home:manage',code_challenge_method:'S256',code_challenge:pkceChallenge(verifier),...override};
  return {...f.oauth.begin(input,'ip'),verifier,input};
}
function authorize(f,owner=f.owner,override={}) {
  const request=begin(f,override),r=f.oauth.complete(request.id,request.nonce,f.s.auth(owner.token));
  const returned=new URL(r.redirect_uri);
  assert.equal(returned.searchParams.get('state'),request.input.state);
  return {...request,code:returned.searchParams.get('code'),redirect:r.redirect_uri};
}
const exchange=(f,r,override={})=>f.oauth.exchange({grant_type:'authorization_code',client_id:'openstrudel',code:r.code,code_verifier:r.verifier,redirect_uri:NATIVE_CALLBACK,...override},'token-ip');

test('native public client gets only its verified owner with S256 and no shared secret',t=>{
  const f=fixture(t),r=authorize(f),credentials=exchange(f,r),session=f.oauth.authenticate(credentials.access_token);
  assert.equal(session.user_id,f.owner.user.id);assert.equal(session.kind,'openstrudel');assert.equal(credentials.expires_in,900);
  assert.equal(new URL(r.redirect).searchParams.get('iss'),f.s.c.origin);
  assert.throws(()=>f.s.auth(credentials.access_token));
  const stored=JSON.stringify(f.s.db.all('SELECT * FROM os_access'))+JSON.stringify(f.s.db.all('SELECT * FROM os_refresh'))+JSON.stringify(f.s.db.all('SELECT * FROM os_authorizations'));
  for(const secret of [credentials.access_token,credentials.refresh_token,r.code,r.nonce])assert.ok(!stored.includes(secret));
});
test('exact redirect, client, S256, state and challenge are mandatory',t=>{
  const f=fixture(t);
  for(const bad of [{redirect_uri:'https://evil.test/callback'},{redirect_uri:NATIVE_CALLBACK+'?next=evil'},{redirect_uri:'openstrudel://oauth/wai-vds/'},{redirect_uri:'openstrudel://user@oauth/wai-vds'},{client_id:'unknown'},{code_challenge_method:'plain'},{code_challenge:'short'},{state:'short'},{scope:'admin'},{prompt:'none'}])assert.throws(()=>begin(f,bad));
  const r=begin(f);assert.throws(()=>f.oauth.complete(r.id,'wrong',f.s.auth(f.owner.token)));
  assert.throws(()=>f.oauth.complete(r.id,r.nonce,{...f.s.auth(f.owner.token),kind:'api_key'}));
});
test('wrong verifier or callback cannot consume a code; valid exchange works once',t=>{
  const f=fixture(t),r=authorize(f);
  assert.throws(()=>exchange(f,r,{code_verifier:'B'.repeat(43)}));
  assert.throws(()=>exchange(f,r,{redirect_uri:'https://evil.test/callback'}));
  const c=exchange(f,r);assert.equal(f.oauth.authenticate(c.access_token).user_id,f.owner.user.id);
  assert.throws(()=>exchange(f,r),e=>e.code==='authorization_code_reused');
  assert.throws(()=>f.oauth.authenticate(c.access_token));
});
test('authorization nonce, cancellation and short code expiry are enforced',t=>{
  const f=fixture(t),r=begin(f),cancel=f.oauth.complete(r.id,r.nonce,null,{approved:false});
  assert.equal(new URL(cancel.redirect_uri).searchParams.get('error'),'access_denied');
  assert.throws(()=>f.oauth.complete(r.id,r.nonce,f.s.auth(f.owner.token)));
  const code=authorize(f);f.advance(120001);assert.throws(()=>exchange(f,code));
  const pending=begin(f);f.advance(600001);assert.throws(()=>f.oauth.request(pending.id,pending.nonce));
});
test('forced fresh login cannot reuse an older remembered owner session',t=>{
  const f=fixture(t);f.advance(1);const r=begin(f,{prompt:'login'});
  assert.throws(()=>f.oauth.complete(r.id,r.nonce,f.s.auth(f.owner.token)),e=>e.code==='fresh_owner_login_required');
  const login=f.s.login('owner@example.test',password,'fresh');
  assert.ok(f.oauth.complete(r.id,r.nonce,f.s.auth(login.token)).redirect_uri.includes('code='));
});
test('refresh rotates, preserves owner and auth age, and replay revokes the family',t=>{
  const f=fixture(t),c=exchange(f,authorize(f)),a=f.oauth.authenticate(c.access_token);f.advance(16*60e3);
  assert.throws(()=>f.oauth.authenticate(c.access_token));
  const next=f.oauth.exchange({client_id:'openstrudel',grant_type:'refresh_token',refresh_token:c.refresh_token},'refresh-ip'),session=f.oauth.authenticate(next.access_token);
  assert.equal(session.grant_id,a.grant_id);assert.equal(session.reauthed,a.reauthed);
  assert.throws(()=>f.s.requireFresh(session));
  assert.throws(()=>f.oauth.exchange({client_id:'openstrudel',grant_type:'refresh_token',refresh_token:c.refresh_token},'refresh-ip'),e=>e.code==='refresh_token_reused');
  assert.throws(()=>f.oauth.authenticate(next.access_token));
});
test('different owners and explicit logout have independent grants',t=>{
  const f=fixture(t),a=exchange(f,authorize(f)),b=exchange(f,authorize(f,f.other));
  const alice=f.oauth.authenticate(a.access_token),bob=f.oauth.authenticate(b.access_token);
  assert.notEqual(alice.user_id,bob.user_id);f.oauth.revoke(alice);
  assert.throws(()=>f.oauth.authenticate(a.access_token));assert.equal(f.oauth.authenticate(b.access_token).user_id,f.other.user.id);
});
test('account recovery revokes native grants and pending codes while preserving orders',t=>{
  const f=fixture(t),a=exchange(f,authorize(f)),pending=authorize(f);
  const order=f.s.order(f.owner.user.id,{purpose:'agent',idempotency_key:'owner-existing-order',consent:true});
  f.s.recovery.recover('owner@example.test',f.owner.recovery_code,'new long owner password for tests','recover');
  assert.throws(()=>f.oauth.authenticate(a.access_token));assert.throws(()=>exchange(f,pending));
  assert.equal(f.s.ownOrder(f.owner.user.id,order.id).id,order.id);
  assert.equal(f.s.db.get('SELECT count(*) n FROM orders').n,1);
});
test('grant has a fixed absolute lifetime even across refreshes',t=>{
  const f=fixture(t),c=exchange(f,authorize(f));f.advance(30*86400e3+1);
  assert.throws(()=>f.oauth.exchange({client_id:'openstrudel',grant_type:'refresh_token',refresh_token:c.refresh_token},'ip'));
});
