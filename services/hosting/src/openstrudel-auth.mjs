import {createHash,randomUUID} from 'node:crypto';
import {hash,safeEqual,token} from './security.mjs';

export const OPENSTRUDEL_CLIENT='openstrudel';
export const NATIVE_CALLBACK='openstrudel://oauth/wai-vds';
export const pkceChallenge=value=>createHash('sha256').update(value).digest('base64url');
const DAY=86400e3;
const verifierPattern=/^[A-Za-z0-9._~-]{43,128}$/;
const statePattern=/^[A-Za-z0-9._~-]{16,128}$/;

export class OpenStrudelAuthorization {
  constructor(service) {this.s=service;this.db=service.db;}
  error(status,code,message='Не удалось подтвердить вход. Начните вход в OpenStrudel заново.') {
    const e=this.s.err(status,message);e.code=code;return e;
  }
  redirects() {return this.s.c.openstrudelRedirects||[NATIVE_CALLBACK];}
  redirect(value) {
    if(typeof value!=='string'||!this.redirects().includes(value))throw this.error(400,'invalid_redirect_uri');
    const u=new URL(value);
    if(u.username||u.password||u.hash||u.search||value!==NATIVE_CALLBACK&&u.protocol!=='https:')throw this.error(400,'invalid_redirect_uri');
    return value;
  }
  begin(input,ip) {
    this.s.limit('os-authorize:'+ip,30);
    if(input.client_id!==OPENSTRUDEL_CLIENT||input.response_type!=='code'||input.code_challenge_method!=='S256'
       ||!/^[A-Za-z0-9_-]{43}$/.test(input.code_challenge||'')||!statePattern.test(input.state||'')
       ||input.scope&&input.scope!=='home:manage'||input.prompt&&!['login','consent'].includes(input.prompt))throw this.error(400,'invalid_authorization_request');
    const redirect=this.redirect(input.redirect_uri),id=randomUUID(),nonce=token();
    this.db.run('INSERT INTO os_authorizations(id,nonce_hash,client_id,redirect_uri,state,challenge,created,expires,force_login) VALUES(?,?,?,?,?,?,?,?,?)',
      id,hash(nonce),OPENSTRUDEL_CLIENT,redirect,input.state,input.code_challenge,this.s.now(),this.s.now()+10*60e3,Number(input.prompt==='login'));
    return {id,nonce,expires_in:600};
  }
  request(id,nonce) {
    const r=this.db.get('SELECT * FROM os_authorizations WHERE id=?',id);
    if(!r||r.expires<=this.s.now()||r.code_hash||r.consumed||!safeEqual(r.nonce_hash,hash(String(nonce||''))))throw this.error(400,'authorization_expired');
    // Removing a callback from operator configuration also invalidates uncompleted requests.
    this.redirect(r.redirect_uri);return r;
  }
  complete(id,nonce,session,{approved=true}={}) {
    const r=this.request(id,nonce),url=new URL(r.redirect_uri);
    url.searchParams.set('state',r.state);
    if(!approved) {
      this.db.run('UPDATE os_authorizations SET consumed=1 WHERE id=? AND consumed=0',id);
      url.searchParams.set('error','access_denied');return {redirect_uri:url.href};
    }
    if(!session||session.kind==='api_key'||session.kind==='openstrudel')throw this.error(401,'owner_login_required');
    if(this.s.now()-session.reauthed>5*60e3||r.force_login&&session.reauthed<r.created)throw this.error(401,'fresh_owner_login_required','Подтвердите вход в OpenStrudel ещё раз.');
    const code=token();
    const changed=this.db.run('UPDATE os_authorizations SET user_id=?,auth_time=?,code_hash=?,expires=? WHERE id=? AND code_hash IS NULL AND consumed=0',
      session.user_id,session.reauthed,hash(code),this.s.now()+120e3,id);
    if(changed.changes!==1)throw this.error(400,'authorization_expired');
    url.searchParams.set('code',code);
    url.searchParams.set('iss',this.s.c.origin);
    return {redirect_uri:url.href};
  }
  credentials(grant) {
    const access='os_access_'+token(),refresh='os_refresh_'+token();
    this.db.run('INSERT INTO os_access VALUES(?,?,?)',hash(access),grant.id,this.s.now()+15*60e3);
    this.db.run('INSERT INTO os_refresh(digest,grant_id,expires) VALUES(?,?,?)',hash(refresh),grant.id,grant.expires);
    return {access_token:access,token_type:'Bearer',expires_in:900,refresh_token:refresh,refresh_expires_in:Math.max(0,Math.floor((grant.expires-this.s.now())/1000)),scope:'home:manage'};
  }
  exchange(input,ip) {
    this.s.limit('os-token:'+ip,60);
    const fields=input.grant_type==='refresh_token'?['grant_type','client_id','refresh_token']:['grant_type','client_id','code','code_verifier','redirect_uri'];
    if(Object.keys(input).some(k=>!fields.includes(k)))throw this.error(400,'invalid_request');
    if(input.client_id!==OPENSTRUDEL_CLIENT)throw this.error(400,'invalid_client');
    if(input.grant_type==='refresh_token')return this.refresh(input);
    if(input.grant_type!=='authorization_code'||!/^[a-f0-9]{64}$/.test(input.code||'')||!verifierPattern.test(input.code_verifier||''))throw this.error(400,'invalid_grant');
    this.redirect(input.redirect_uri);
    let replay=false;
    const result=this.db.tx(()=>{
      const r=this.db.get('SELECT * FROM os_authorizations WHERE code_hash=?',hash(input.code));
      if(!r||r.expires<=this.s.now()||r.client_id!==input.client_id||r.redirect_uri!==input.redirect_uri
         ||!safeEqual(r.challenge,pkceChallenge(input.code_verifier))||!r.user_id)throw this.error(400,'invalid_grant');
      if(r.consumed) {
        if(r.grant_id)this.db.run('UPDATE os_grants SET revoked=1 WHERE id=?',r.grant_id);
        replay=true;return null;
      }
      const grant={id:randomUUID(),user_id:r.user_id,client_id:r.client_id,auth_time:r.auth_time,created:this.s.now(),expires:this.s.now()+30*DAY};
      this.db.run('INSERT INTO os_grants(id,user_id,client_id,auth_time,created,expires) VALUES(?,?,?,?,?,?)',grant.id,grant.user_id,grant.client_id,grant.auth_time,grant.created,grant.expires);
      this.db.run('UPDATE os_authorizations SET consumed=1,grant_id=? WHERE id=?',grant.id,r.id);
      this.db.audit(grant.user_id,grant.id,'openstrudel_owner_authorized',this.s.now());
      return this.credentials(grant);
    });
    if(replay)throw this.error(400,'authorization_code_reused');
    return result;
  }
  refresh(input) {
    if(!/^os_refresh_[a-f0-9]{64}$/.test(input.refresh_token||''))throw this.error(400,'invalid_grant');
    let replay=false;
    const result=this.db.tx(()=>{
      const r=this.db.get('SELECT * FROM os_refresh WHERE digest=?',hash(input.refresh_token));
      const g=r&&this.db.get('SELECT * FROM os_grants WHERE id=?',r.grant_id);
      if(!g||g.revoked||g.expires<=this.s.now()||r.expires<=this.s.now()||g.client_id!==input.client_id)throw this.error(400,'invalid_grant');
      if(r.used){this.db.run('UPDATE os_grants SET revoked=1 WHERE id=?',g.id);replay=true;return null;}
      this.db.run('UPDATE os_refresh SET used=1 WHERE digest=?',r.digest);
      return this.credentials(g);
    });
    if(replay)throw this.error(400,'refresh_token_reused');
    return result;
  }
  authenticate(raw) {
    if(!/^os_access_[a-f0-9]{64}$/.test(raw||''))throw this.error(401,'invalid_token');
    const r=this.db.get('SELECT g.* FROM os_access a JOIN os_grants g ON g.id=a.grant_id WHERE a.digest=? AND a.expires>? AND g.expires>? AND g.revoked=0',hash(raw),this.s.now(),this.s.now());
    if(!r)throw this.error(401,'invalid_token');
    return {...r,kind:'openstrudel',grant_id:r.id,reauthed:r.auth_time};
  }
  revoke(session) {
    this.db.run('UPDATE os_grants SET revoked=1 WHERE id=? AND user_id=?',session.grant_id,session.user_id);
    this.db.audit(session.user_id,session.grant_id,'openstrudel_access_revoked',this.s.now());
    return {ok:true};
  }
}
