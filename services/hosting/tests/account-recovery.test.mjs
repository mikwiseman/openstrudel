import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {Service,config} from '../src/service.mjs';
import {createServer} from '../src/main.mjs';

const password='original secure passphrase',replacement='replacement secure passphrase';
function fixture(t){mkdirSync('work/test-runs',{recursive:true});const dir=mkdtempSync(resolve('work/test-runs/recovery-'));const s=new Service(config({WAI_DATA:dir}));t.after(()=>{s.db.close();rmSync(dir,{recursive:true,force:true});});return s;}

test('registration provides one recovery code and stores only its digest',t=>{
  const s=fixture(t),a=s.register('owner@example.test',password,'ip');
  assert.match(a.recovery_code,/^WAI-(?:[A-F0-9]{8}-){7}[A-F0-9]{8}$/);
  const stored=s.db.get('SELECT * FROM recovery_keys WHERE user_id=?',a.user.id);
  assert.match(stored.digest,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(stored).includes(a.recovery_code));
  assert.ok(!JSON.stringify(s.dashboard(a.user.id)).includes(stored.digest));
  assert.equal(s.login(a.user.email,password,'ip').recovery_code,undefined);
});

test('recovery consumes the code, changes password and revokes all prior sessions and API keys',t=>{
  const s=fixture(t),a=s.register('owner@example.test',password,'ip');
  const otherSession=s.session(a.user.id),key=s.agents.issue(a.user.id,{name:'Agent'});
  const result=s.recovery.recover(a.user.email,a.recovery_code.toLowerCase(),replacement,'ip');
  assert.equal(result.ok,true);assert.equal(result.requires_login,true);assert.equal(result.token,undefined);
  assert.notEqual(result.recovery_code,a.recovery_code);
  for(const token of [a.token,otherSession.token,key.token])assert.throws(()=>s.auth(token),e=>e.status===401);
  assert.throws(()=>s.login(a.user.email,password,'ip'),e=>e.status===401);
  assert.equal(s.login(a.user.email,replacement,'ip').user.id,a.user.id);
  assert.throws(()=>s.recovery.recover(a.user.email,a.recovery_code,password,'ip'),e=>e.status===400);
  assert.equal(s.recovery.recover(a.user.email,result.recovery_code,password,'ip').ok,true);
});

test('recovery cannot use another account code or disclose whether an account exists',t=>{
  const s=fixture(t),a=s.register('owner@example.test',password,'ip'),b=s.register('other@example.test',password,'ip');
  const errors=[];
  for(const [email,code] of [[a.user.email,b.recovery_code],['absent@example.test',a.recovery_code],[a.user.email,'wrong']]){
    assert.throws(()=>s.recovery.recover(email,code,replacement,'ip'),e=>{errors.push(e.message);return e.status===400;});
  }
  assert.equal(new Set(errors).size,1);
  assert.equal(s.auth(a.token).user_id,a.user.id);
  assert.equal(s.login(a.user.email,password,'ip').user.id,a.user.id);
});

test('recovery code replacement requires current password and cannot be performed by an API key',t=>{
  const s=fixture(t),a=s.register('owner@example.test',password,'ip'),session=s.auth(a.token);
  assert.throws(()=>s.recovery.rotate(session,'wrong'),e=>e.status===401);
  const key=s.auth(s.agents.issue(a.user.id).token);
  assert.throws(()=>s.recovery.rotate(key,password),e=>e.status===403);
  const replacementCode=s.recovery.rotate(session,password).recovery_code;
  assert.throws(()=>s.recovery.recover(a.user.email,a.recovery_code,replacement,'ip'),e=>e.status===400);
  assert.equal(s.recovery.recover(a.user.email,replacementCode,replacement,'ip').ok,true);
});

test('recovery failures are rate-limited and do not revoke access or consume a good code',t=>{
  const s=fixture(t),a=s.register('owner@example.test',password,'ip');
  for(let i=0;i<8;i++)assert.throws(()=>s.recovery.recover(a.user.email,'wrong',replacement,'ip'),e=>e.status===400);
  assert.throws(()=>s.recovery.recover(a.user.email,a.recovery_code,replacement,'ip'),e=>e.status===429);
  assert.equal(s.auth(a.token).user_id,a.user.id);
  assert.equal(s.db.get('SELECT count(*) n FROM recovery_keys').n,1);
});

test('HTTP recovery enforces origin, requires no stale cookie, and never issues a session automatically',async t=>{
  const s=fixture(t),server=createServer(s);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  t.after(()=>new Promise(ok=>server.close(ok)));
  s.c.origin='http://127.0.0.1:'+server.address().port;
  const send=(path,body,origin=s.c.origin)=>fetch(s.c.origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const registered=await send('/api/v1/auth/register',{email:'http@example.test',password});const a=await registered.json();
  assert.ok(a.recovery_code);assert.match(registered.headers.get('cache-control'),/no-store/);
  const body={email:a.user.email,password:replacement,recovery_code:a.recovery_code};
  assert.equal((await send('/api/v1/auth/recover',body,'https://foreign.example')).status,403);
  const recovered=await send('/api/v1/auth/recover',body);assert.equal(recovered.status,200);assert.equal(recovered.headers.get('set-cookie'),null);
  assert.equal((await recovered.json()).requires_login,true);
  assert.equal((await send('/api/v1/auth/login',{email:a.user.email,password})).status,401);
  assert.equal((await send('/api/v1/auth/login',{email:a.user.email,password:replacement})).status,200);
});
