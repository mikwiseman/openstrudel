import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Service,config} from '../src/service.mjs';
import {ResendMailer} from '../src/magic-links.mjs';
import {hash} from '../src/security.mjs';
import {createServer} from '../src/main.mjs';
import {NATIVE_CALLBACK,pkceChallenge} from '../src/openstrudel-auth.mjs';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'wai-magic-')),mail=[];let now=Date.now(),failure;
  const s=new Service(config({WAI_DATA:dir,WAI_MAGIC_LINK_ENABLED:'1',WAI_RESEND_API_KEY:'re_fixture',WAI_RESEND_FROM:'WAI Server <login@mail.example.test>'}),{now:()=>now,mailer:{send:async m=>{mail.push(m);if(failure)throw failure;return randomUUID();}}});
  const context={ip:'test-ip',nonce:'a'.repeat(64)};
  const request=async(email='owner@example.test',body={},ctx=context)=>{await s.magic.request({email,...body},ctx);return new URL(mail.at(-1).url).hash.slice(1);};
  t.after(()=>{s.db.close();rmSync(dir,{recursive:true,force:true});});
  return {s,mail,context,request,advance:ms=>now+=ms,fail:e=>failure=e};
}
async function httpFixture(t){const f=fixture(t),server=createServer(f.s);await new Promise(r=>server.listen(0,'127.0.0.1',r));f.s.c.origin='http://127.0.0.1:'+server.address().port;t.after(()=>new Promise(r=>server.close(r)));return {...f,url:f.s.c.origin,get:(path,headers={})=>fetch(f.s.c.origin+path,{headers}),post:(path,body={},cookie='',headers={})=>fetch(f.s.c.origin+path,{method:'POST',headers:{Origin:f.s.c.origin,'Content-Type':'application/json',Cookie:cookie,...headers},body:JSON.stringify(body)})};}
const cookieOf=r=>r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');

test('new verified owner signs in once without a password; only hashes are stored',async t=>{
  const f=fixture(t),raw=await f.request(' Owner@Example.Test ');
  assert.equal(f.s.db.get('SELECT count(*) n FROM users').n,0);
  assert.equal(new URL(f.mail[0].url).search,'');
  const row=f.s.db.get('SELECT * FROM magic_links');assert(!JSON.stringify(row).includes(raw.split('.')[1]));assert(!JSON.stringify(row).includes(f.context.nonce));
  const result=f.s.magic.consume(raw,f.context),session=f.s.auth(result.token);
  assert.equal(result.user.email,'owner@example.test');assert(f.s.magic.fresh(session));assert.equal(f.s.magic.options(session).password_enabled,false);
  assert.equal(result.redirect_uri,f.s.c.origin+'/?view=servers');assert.throws(()=>f.s.magic.consume(raw,f.context),e=>e.status===400);
  assert.equal(f.s.db.get('SELECT count(*) n FROM users').n,1);
});
test('email scanner inspection does not consume; another browser cannot redeem or burn the link',async t=>{
  const f=fixture(t),raw=await f.request();
  assert.equal(f.s.magic.inspect(raw,f.context).consumed,0);assert.equal(f.s.magic.inspect(raw,f.context).consumed,0);
  for(const nonce of [null,'b'.repeat(64)])assert.throws(()=>f.s.magic.consume(raw,{...f.context,nonce}),e=>e.status===409);
  assert.equal(f.s.magic.consume(raw,f.context).user.email,'owner@example.test');
});
test('expired, tampered and unknown links do not create users',async t=>{
  const f=fixture(t),raw=await f.request();assert.throws(()=>f.s.magic.consume(raw.slice(0,-1)+(raw.endsWith('a')?'b':'a'),f.context),e=>e.status===400);
  f.advance(600000);assert.throws(()=>f.s.magic.consume(raw,f.context),e=>e.status===400);assert.equal(f.s.db.get('SELECT count(*) n FROM users').n,0);
});
test('new link replaces only that browser email attempt; limits persist in SQLite',async t=>{
  const f=fixture(t),first=await f.request();await assert.rejects(f.request(),e=>e.status===429);f.advance(61000);const second=await f.request();
  assert.throws(()=>f.s.magic.consume(first,f.context),e=>e.status===400);assert(f.s.magic.consume(second,f.context).token);
  const same=new Service(f.s.c,{now:f.s.now,mailer:f.s.magic.mailer});t.after(()=>same.db.close());
  await assert.rejects(same.magic.request({email:'owner@example.test'},f.context),e=>e.status===429);
});
test('pre-registered unverified password cannot hijack owner after email proof',async t=>{
  const f=fixture(t),attacker=f.s.register('owner@example.test','an attacker guessed email password','register-ip'),api=f.s.agents.issue(attacker.user.id);
  const raw=await f.request(),owner=f.s.magic.consume(raw,f.context);
  assert.equal(owner.user.id,attacker.user.id);assert.throws(()=>f.s.auth(attacker.token),e=>e.status===401);assert.throws(()=>f.s.auth(api.token),e=>e.status===401);
  assert.throws(()=>f.s.login(owner.user.email,'an attacker guessed email password','login'),e=>e.status===401);
  assert.throws(()=>f.s.recovery.recover(owner.user.email,attacker.recovery_code,'another password long enough','recovery'),e=>e.status===400);
});
test('verified owner can add optional password and later use either method',async t=>{
  const f=fixture(t),raw=await f.request(),first=f.s.magic.consume(raw,f.context),session=f.s.auth(first.token);
  f.s.magic.setPassword(session,'a verified owner new password');const passwordLogin=f.s.login(first.user.email,'a verified owner new password','login');
  assert.equal(passwordLogin.user.id,first.user.id);f.advance(61000);
  const next=f.s.magic.consume(await f.request(),f.context);assert.equal(next.user.id,first.user.id);assert.equal(f.s.auth(first.token).user_id,first.user.id);
  assert.equal(f.s.login(first.user.email,'a verified owner new password','login').user.id,first.user.id);
  assert.throws(()=>f.s.magic.setPassword(f.s.auth(passwordLogin.token),'other new password here'),e=>e.status===403);
});
test('fresh mail proof supports root/key/recovery reauth; expires after five minutes',async t=>{
  const f=fixture(t),owner=f.s.magic.consume(await f.request(),f.context);assert.doesNotThrow(()=>f.s.reauth(f.s.auth(owner.token)));
  assert(f.s.recovery.rotate(f.s.auth(owner.token)).recovery_code);f.advance(300000);
  assert.throws(()=>f.s.reauth(f.s.auth(owner.token)),e=>e.status===403);assert.throws(()=>f.s.magic.setPassword(f.s.auth(owner.token),'password with enough length'),e=>e.status===403);
});
test('reauth email is bound to the active session and cannot switch owner',async t=>{
  const f=fixture(t),owner=f.s.magic.consume(await f.request(),f.context);f.advance(301000);const session=f.s.auth(owner.token),ctx={...f.context,session};
  const raw=await f.request('attacker@example.test',{context:'reauth'},ctx);assert.equal(f.mail.at(-1).email,owner.user.email);
  assert.throws(()=>f.s.magic.consume(raw,{...ctx,session:undefined}),e=>e.status===409);
  const other=f.s.session(owner.user.id);assert.throws(()=>f.s.magic.consume(raw,{...ctx,session:f.s.auth(other.token)}),e=>e.status===409);
  const result=f.s.magic.consume(raw,ctx);assert.equal(result.token,undefined);assert(f.s.magic.fresh(f.s.auth(owner.token)));assert(!f.s.magic.fresh(f.s.auth(other.token)));
});
test('saved-code recovery invalidates every pending email link and old browser proof',async t=>{
  const f=fixture(t),owner=f.s.magic.consume(await f.request(),f.context),recovery=f.s.recovery.rotate(f.s.auth(owner.token));f.advance(61000);const raw=await f.request();
  f.s.recovery.recover(owner.user.email,recovery.recovery_code,'recovered password is long enough','recover');
  assert.throws(()=>f.s.magic.consume(raw,f.context),e=>e.status===400);assert.equal(f.s.db.get('SELECT count(*) n FROM magic_sessions').n,0);
});
test('unknown send result is not retried blindly; definitive failure cannot authenticate',async t=>{
  const f=fixture(t);f.fail(Object.assign(Error('private upstream content'),{uncertain:true}));await assert.rejects(f.request(),e=>e.status===503&&!e.message.includes('private'));
  assert.equal(f.mail.length,1);assert.equal(f.s.db.get('SELECT send_state FROM magic_links').send_state,'unknown');assert(f.s.magic.consume(new URL(f.mail[0].url).hash.slice(1),f.context).token);
  f.advance(61000);f.fail(Error('failed'));await assert.rejects(f.request());assert.throws(()=>f.s.magic.consume(new URL(f.mail.at(-1).url).hash.slice(1),f.context),e=>e.status===400);
});
test('no user enumeration in request response; arbitrary redirects and email injection are rejected',async t=>{
  const f=fixture(t);f.s.register('existing@example.test','existing password long enough','registration');
  const a=await f.s.magic.request({email:'existing@example.test'},f.context),b=await f.s.magic.request({email:'absent@example.test'},f.context);assert.deepEqual(a,b);
  for(const input of [{email:'ok@example.test',redirect_uri:'https://evil.test'},{email:'ok@example.test',return_view:'//evil.test'},{email:'x@example.test\r\nBcc: bad@example.test'}])await assert.rejects(f.s.magic.request(input,f.context),e=>e.status===400);
});
test('HTTP rejects foreign origin, does not expose tokens, requires explicit POST and safe cookies',async t=>{
  const f=await httpFixture(t);
  assert.equal((await f.post('/api/v1/auth/magic-link/request',{email:'owner@example.test'},'',{Origin:'https://evil.test'})).status,403);
  const r=await f.post('/api/v1/auth/magic-link/request',{email:'owner@example.test'}),browser=cookieOf(r);assert.equal(r.status,202);assert(r.headers.get('set-cookie').includes('HttpOnly'));assert(r.headers.get('set-cookie').includes('SameSite=Lax'));
  const raw=new URL(f.mail[0].url).hash.slice(1);assert(!(await r.text()).includes(raw));
  const page=await f.get('/auth/email');assert.equal(page.status,200);assert.equal(page.headers.get('referrer-policy'),'no-referrer');assert((await page.text()).includes('Подтвердить вход'));assert.equal(f.s.db.get('SELECT consumed FROM magic_links').consumed,0);
  assert.equal((await f.post('/oauth/magic-link/consume',{token:raw})).status,409);
  assert.equal((await f.post('/oauth/magic-link/consume',{token:raw},browser,{Origin:'https://evil.test'})).status,403);
  const signed=await f.post('/oauth/magic-link/consume',{token:raw},browser);assert.equal(signed.status,200);const body=await signed.json();assert(!body.token);assert(!JSON.stringify(body).includes(raw));
  assert.equal((await f.get('/api/v1/me',{Cookie:cookieOf(signed)})).status,200);
  assert.equal((await f.post('/oauth/magic-link/consume',{token:raw},browser)).status,400);
});
test('HTTP reauth needs CSRF and cannot be requested by an API credential',async t=>{
  const f=await httpFixture(t),owner=f.s.register('owner@example.test','long enough account password','register');
  assert.equal((await f.post('/api/v1/auth/magic-link/request',{context:'reauth'},'wai_session='+owner.token)).status,403);
  assert.equal((await f.post('/api/v1/auth/magic-link/request',{context:'reauth'},'',{Authorization:'Bearer '+f.s.agents.issue(owner.user.id).token})).status,403);
});
test('OpenStrudel magic link preserves exact callback, browser nonce, state and PKCE',async t=>{
  const f=await httpFixture(t),verifier='V'.repeat(43),state=randomUUID(),params=new URLSearchParams({client_id:'openstrudel',response_type:'code',redirect_uri:NATIVE_CALLBACK,state,code_challenge_method:'S256',code_challenge:pkceChallenge(verifier)});
  const page=await f.get('/oauth/authorize?'+params),oauthCookie=cookieOf(page);
  const requested=await f.post('/oauth/magic-link/request',{email:'native@example.test',context:'oauth'},oauthCookie),magicCookie=cookieOf(requested),raw=new URL(f.mail[0].url).hash.slice(1);assert.equal(f.mail[0].brand,'OpenStrudel');
  assert.equal((await f.post('/oauth/magic-link/consume',{token:raw},magicCookie)).status,409);
  const signed=await f.post('/oauth/magic-link/consume',{token:raw},oauthCookie+'; '+magicCookie),body=await signed.json();assert.equal(signed.status,200);
  const callback=new URL(body.redirect_uri);assert.equal(callback.origin,'null');assert.equal(callback.protocol,'openstrudel:');assert.equal(callback.searchParams.get('state'),state);assert.equal(callback.searchParams.get('iss'),f.url);
  const exchange={grant_type:'authorization_code',client_id:'openstrudel',code:callback.searchParams.get('code'),redirect_uri:NATIVE_CALLBACK,code_verifier:'W'.repeat(43)};
  assert.equal((await f.post('/oauth/token',exchange)).status,400);exchange.code_verifier=verifier;assert.equal((await f.post('/oauth/token',exchange)).status,200);
});
test('OAuth expiry and cancellation invalidate its mail link',async t=>{
  const f=fixture(t),start=f.s.cloud.auth.begin({client_id:'openstrudel',response_type:'code',redirect_uri:NATIVE_CALLBACK,state:randomUUID(),code_challenge_method:'S256',code_challenge:pkceChallenge('V'.repeat(43))},'ip');
  const authorization={...f.s.cloud.auth.request(start.id,start.nonce),nonce:start.nonce},ctx={...f.context,authorization};const raw=await f.request('owner@example.test',{context:'oauth'},ctx);
  f.s.cloud.auth.complete(start.id,start.nonce,null,{approved:false});assert.throws(()=>f.s.magic.consume(raw,ctx));assert.equal(f.s.db.get('SELECT count(*) n FROM users').n,0);
});
test('Resend adapter uses fixed endpoint, idempotency and no provider error details',async()=>{
  let call;const id=randomUUID(),c={resendKey:'re_fixture',resendFrom:'WAI Server <login@mail.example.test>'};
  const mailer=new ResendMailer(c,async(url,init)=>{call={url,init};return new Response(JSON.stringify({id}));});
  assert.equal(await mailer.send({id,email:'delivered@resend.dev',url:'https://server.example.test/auth/email#secret',brand:'WAI Server',minutes:10}),id);
  assert.equal(call.url,'https://api.resend.com/emails');assert.equal(call.init.redirect,'error');assert.equal(call.init.headers['Idempotency-Key'],'wai-magic/'+id);const sent=JSON.parse(call.init.body);assert.deepEqual(sent.to,['delivered@resend.dev']);assert(sent.text.includes('#secret'));assert(!sent.html.includes('<img'));
  const broken=new ResendMailer(c,async()=>new Response(JSON.stringify({message:'provider secret'}),{status:401}));await assert.rejects(broken.send({id,email:'delivered@resend.dev',url:'https://example.test/#a',brand:'WAI Server',minutes:10}),e=>!e.message.includes('secret')&&!e.uncertain);
});

test('password reauth cannot extend the five-minute email proof or its UI deadline',async t=>{
  const f=fixture(t),a=f.s.magic.consume(await f.request(),f.context);f.s.magic.setPassword(f.s.auth(a.token),'verified password long enough');
  const deadline=f.s.magic.options(f.s.auth(a.token)).magic_fresh_until;f.advance(240000);f.s.reauth(f.s.auth(a.token),'verified password long enough');
  assert.equal(f.s.magic.options(f.s.auth(a.token)).magic_fresh_until,deadline);f.advance(61000);
  assert.equal(f.s.magic.options(f.s.auth(a.token)).magic_fresh_until,0);assert.throws(()=>f.s.magic.setPassword(f.s.auth(a.token),'new long password for owner'),e=>e.status===403);
});
test('production magic cookie is host-only, secure and never sets a parent domain',async t=>{
  const f=await httpFixture(t);f.s.c.secure=true;
  const r=await f.post('/api/v1/auth/magic-link/request',{email:'secure@example.test'}),value=r.headers.get('set-cookie');
  assert.match(value,/^__Host-wai_magic=/);assert.match(value,/; Secure/);assert.match(value,/; Path=\//);assert(!value.includes('Domain='));
});
