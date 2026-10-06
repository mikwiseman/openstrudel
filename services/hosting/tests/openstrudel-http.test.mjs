import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {cloudFixture} from './openstrudel-fixture.mjs';
import {createServer} from '../src/main.mjs';
import {pkceChallenge,NATIVE_CALLBACK} from '../src/openstrudel-auth.mjs';

async function fixture(t){const f=cloudFixture(t),server=createServer(f.s);server.listen(0,'127.0.0.1');await once(server,'listening');f.s.c.origin='http://127.0.0.1:'+server.address().port;t.after(()=>new Promise(r=>server.close(r)));return {...f,url:f.s.c.origin,fetch:async(path,options={})=>fetch(f.s.c.origin+path,options)};}
test('HTTP authorization uses browser login, nonce and CSRF; token exchange works without cookies',async t=>{
  const f=await fixture(t),verifier='K'.repeat(43),params=new URLSearchParams({client_id:'openstrudel',response_type:'code',redirect_uri:NATIVE_CALLBACK,state:randomUUID(),code_challenge_method:'S256',code_challenge:pkceChallenge(verifier)});
  const page=await f.fetch('/oauth/authorize?'+params);assert.equal(page.status,200);assert((await page.text()).includes('Ваша команда.'));assert(page.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  const nonce=page.headers.get('set-cookie').split(';')[0],login=await f.fetch('/api/v1/auth/login',{method:'POST',headers:{Origin:f.url,'Content-Type':'application/json'},body:JSON.stringify({email:f.owner.user.email,password:f.password})});
  const sessionCookie=login.headers.get('set-cookie').split(';')[0],auth=await login.json(),cookie=nonce+'; '+sessionCookie;
  let r=await f.fetch('/oauth/request',{headers:{Cookie:cookie}}),request=await r.json();assert.equal(request.owner.id,f.owner.user.id);assert.equal(request.requires_login,false);
  const body=JSON.stringify({request_id:request.request_id,approved:true});
  r=await f.fetch('/oauth/complete',{method:'POST',headers:{Origin:f.url,Cookie:cookie,'Content-Type':'application/json'},body});assert.equal(r.status,403);
  r=await f.fetch('/oauth/complete',{method:'POST',headers:{Origin:'https://evil.test',Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':auth.csrf},body});assert.equal(r.status,403);
  r=await f.fetch('/oauth/complete',{method:'POST',headers:{Origin:f.url,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':auth.csrf},body});assert.equal(r.status,200);
  const callback=new URL((await r.json()).redirect_uri);assert.equal(callback.searchParams.get('state'),params.get('state'));
  const form=new URLSearchParams({grant_type:'authorization_code',client_id:'openstrudel',code:callback.searchParams.get('code'),code_verifier:verifier,redirect_uri:NATIVE_CALLBACK});
  r=await f.fetch('/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});assert.equal(r.status,200);const token=await r.json();assert.equal(token.expires_in,900);
  r=await f.fetch('/api/v2/openstrudel/orders',{headers:{Authorization:'Bearer '+token.access_token}});assert.equal(r.status,200);assert.deepEqual((await r.json()).orders,[]);
});
test('native API rejects ordinary API key, web cookie and arbitrary-origin bearer; OpenAPI is public',async t=>{
  const f=await fixture(t);
  for(const headers of [{Cookie:'wai_session='+f.owner.token},{Authorization:'Bearer '+f.owner.token},{Authorization:'Bearer '+f.a.access_token,Origin:'https://evil.test'}]){const r=await f.fetch('/api/v2/openstrudel/orders',{headers});assert([401,403].includes(r.status));}
  const r=await f.fetch('/api/v2/openstrudel/openapi.json'),doc=await r.json();assert.equal(r.status,200);assert.equal(doc.openapi,'3.1.0');assert(doc.paths['/api/v2/openstrudel/claims/consume']);
  const metadata=await (await f.fetch('/.well-known/oauth-authorization-server')).json();assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);
});
test('HTTP return is neutral and contains no account, card or connection credentials',async t=>{
  const f=await fixture(t),{order,input}=f.make();await f.s.cloud.checkout(f.a.session,order.order_id);
  const r=await f.fetch('/openstrudel/payment-return?order_id='+order.order_id+'&state='+input.return_state),html=await r.text();assert.equal(r.status,200);assert(html.includes('проверит результат оплаты'));assert(!html.includes(f.owner.user.email));assert(!html.includes('privateKeyPEM'));assert.equal(f.s.cloud.status(f.a.session,order.order_id).payment_state,'pending');
  assert.equal((await f.fetch('/openstrudel/payment-return?order_id='+order.order_id+'&state=wrong')).status,400);
});
test('duplicate parameters and invalid callback return an error without redirecting',async t=>{
  const f=await fixture(t),r=await f.fetch('/oauth/authorize?client_id=openstrudel&client_id=other');assert.equal(r.status,400);assert.equal(r.headers.get('location'),null);
  const no=await f.fetch('/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'client_id=openstrudel&client_id=other'});assert.equal(no.status,400);
});
