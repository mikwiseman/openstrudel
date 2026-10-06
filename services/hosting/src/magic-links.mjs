import {randomUUID} from 'node:crypto';
import {hash,token,safeEqual,passwordHash} from './security.mjs';

export const MAGIC_SCHEMA=`
CREATE TABLE IF NOT EXISTS email_verifications(user_id TEXT PRIMARY KEY REFERENCES users(id),verified_at INTEGER NOT NULL,password_enabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS magic_sessions(token TEXT PRIMARY KEY REFERENCES sessions(token) ON DELETE CASCADE,verified_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS magic_links(id TEXT PRIMARY KEY,digest TEXT UNIQUE NOT NULL,email TEXT NOT NULL,nonce_hash TEXT NOT NULL,context TEXT NOT NULL CHECK(context IN('login','reauth','oauth')),return_view TEXT NOT NULL,authorization_id TEXT,session_hash TEXT,created INTEGER NOT NULL,expires INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0,send_state TEXT NOT NULL DEFAULT 'sending',provider_id TEXT);
CREATE INDEX IF NOT EXISTS magic_links_expiry ON magic_links(expires);
`;
const emailPattern=/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const validEmail=email=>typeof email==='string'&&email.length<=254&&emailPattern.test(email);

export class ResendMailer {
  constructor(c,fetcher=fetch){this.c=c;this.fetch=fetcher;}
  async send({id,email,url,brand,minutes}) {
    const subject=`Вход в ${brand}`,text=`${brand}\n\nПодтвердите вход по ссылке:\n${url}\n\nСсылка действует ${minutes} мин. Откройте её в том же браузере, где начали вход.\nЕсли вы не запрашивали вход, просто удалите письмо. Никому не пересылайте ссылку.`;
    const html=`<!doctype html><html lang="ru"><body style="margin:0;background:#faf9f6;color:#242426;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"><div style="max-width:440px;margin:48px auto;padding:24px"><p style="font-weight:600">${escape(brand)}</p><h1 style="font-size:32px;font-weight:600;letter-spacing:-1px;margin:40px 0 20px">Один шаг — и вы внутри.</h1><p style="line-height:1.6">Подтвердите вход в том же браузере, где его начали.</p><p style="margin:32px 0"><a href="${escape(url)}" style="display:inline-block;background:#242426;color:white;text-decoration:none;border-radius:12px;padding:16px 24px">Войти в ${escape(brand)}</a></p><p style="color:#656461;font-size:14px;line-height:1.6">Ссылка действует ${minutes} мин. и сработает один раз.<br>Не запрашивали вход? Просто удалите письмо.<br>Никому не пересылайте ссылку.</p></div></body></html>`;
    let response;
    try {response=await this.fetch('https://api.resend.com/emails',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+this.c.resendKey,'Content-Type':'application/json','Idempotency-Key':'wai-magic/'+id},body:JSON.stringify({from:this.c.resendFrom,to:[email],subject,html,text}),signal:AbortSignal.timeout(12000)});}
    catch {throw Object.assign(Error('mail_delivery_unknown'),{uncertain:true});}
    if(!response.ok)throw Object.assign(Error('mail_delivery_failed'),{uncertain:response.status>=500});
    let data;try{data=await response.json();}catch{throw Object.assign(Error('mail_delivery_unknown'),{uncertain:true});}
    if(typeof data.id!=='string'||!/^[a-f0-9-]{36}$/.test(data.id))throw Object.assign(Error('mail_delivery_unknown'),{uncertain:true});
    return data.id;
  }
}

export class MagicLinks {
  constructor(s,mailer){this.s=s;this.db=s.db;this.mailer=mailer||new ResendMailer(s.c);}
  enabled(){return this.s.c.magicEnabled===true;}
  fresh(session){return !!session&&!session.kind&&this.s.now()-session.reauthed<300000&&!!this.db.get('SELECT 1 FROM magic_sessions WHERE token=? AND verified_at>?',session.token,this.s.now()-300000);}
  options(session){return {magic_link:this.enabled(),password:true,magic_fresh_until:this.fresh(session)?Math.min(session.reauthed,this.db.get('SELECT verified_at FROM magic_sessions WHERE token=?',session.token).verified_at)+300000:0,password_enabled:session?this.db.get('SELECT password_enabled FROM email_verifications WHERE user_id=?',session.user_id)?.password_enabled!==0:null};}
  invalid(){return this.s.err(400,'Ссылка истекла или уже использована. Запросите новую.');}
  browserError(){return this.s.err(409,'Откройте ссылку в том браузере, где начали вход. Если это невозможно, запросите новую ссылку здесь.');}
  async request(input,{nonce,session,authorization,ip}) {
    if(!this.enabled())throw this.s.err(503,'Вход по письму временно недоступен. Попробуйте войти с паролем.');
    if(!input||Object.keys(input).some(k=>!['email','context','return_view'].includes(k)))throw this.s.err(400,'Некорректный запрос входа.');
    const context=input.context||'login';
    if(!['login','reauth','oauth'].includes(context))throw this.s.err(400,'Некорректный запрос входа.');
    const view=input.return_view||'servers';if(!['new','servers','agent'].includes(view))throw this.s.err(400,'Некорректный адрес возврата.');
    if(context==='reauth'&&(!session||session.kind))throw this.s.err(401,'Войдите в аккаунт ещё раз.');
    if(context==='oauth'&&!authorization)throw this.invalid();
    const email=context==='reauth'?this.s.user(session.user_id).email:String(input.email||'').trim().toLowerCase();
    if(!validEmail(email))throw this.s.err(400,'Введите правильный email.');
    this.s.limit('magic-ip:'+ip,20,3600000);
    this.s.limit('magic-email-minute:'+email,1,60000);
    this.s.limit('magic-email-hour:'+email,5,3600000);
    this.s.limit('magic-global-hour',100,3600000);this.s.limit('magic-global-day',1000,86400000);
    const id=randomUUID(),secret=token(),now=this.s.now(),expires=Math.min(now+600000,authorization?.expires||Infinity);
    this.db.tx(()=>{
      this.db.run('DELETE FROM magic_links WHERE expires<?',now-86400000);
      this.db.run('UPDATE magic_links SET consumed=1 WHERE email=? AND nonce_hash=? AND consumed=0',email,hash(nonce));
      this.db.run('INSERT INTO magic_links(id,digest,email,nonce_hash,context,return_view,authorization_id,session_hash,created,expires) VALUES(?,?,?,?,?,?,?,?,?,?)',id,hash(secret),email,hash(nonce),context,view,authorization?.id||null,context==='reauth'?session.token:null,now,expires);
    });
    const url=this.s.c.origin+'/auth/email#'+id+'.'+secret;
    try {
      const providerId=await this.mailer.send({id,email,url,brand:context==='oauth'?'OpenStrudel':'WAI Server',minutes:Math.max(1,Math.floor((expires-now)/60000))});
      this.db.run("UPDATE magic_links SET send_state='sent',provider_id=? WHERE id=?",providerId,id);
    } catch(e) {
      this.db.run('UPDATE magic_links SET send_state=? WHERE id=?',e.uncertain?'unknown':'failed',id);
      // Never log provider text, recipient, email body, credentials or link.
      this.db.audit(null,id,e.uncertain?'magic_mail_delivery_unknown':'magic_mail_delivery_failed',this.s.now());
      throw this.s.err(503,'Не удалось подтвердить отправку письма. Если оно не придёт, попробуйте ещё раз через минуту.');
    }
    return {ok:true,expires_in:Math.floor((expires-now)/1000),retry_after:60};
  }
  inspect(raw,{nonce,session,authorization,ip}) {
    this.s.limit('magic-check:'+ip,60);
    if(!/^[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(raw||''))throw this.invalid();
    const [id,secret]=raw.split('.'),r=this.db.get('SELECT * FROM magic_links WHERE id=?',id);
    if(!r||r.consumed||r.expires<=this.s.now()||r.send_state==='failed'||!safeEqual(r.digest,hash(secret)))throw this.invalid();
    if(!safeEqual(r.nonce_hash,hash(nonce||'')))throw this.browserError();
    if(r.context==='reauth'&&(!session||session.kind||session.token!==r.session_hash||this.s.user(session.user_id).email!==r.email))throw this.browserError();
    if(r.context==='oauth'&&(!authorization||authorization.id!==r.authorization_id))throw this.browserError();
    return r;
  }
  consume(raw,context) {
    const checked=this.inspect(raw,context);
    return this.db.tx(()=>{
      const r=checked;
      if(this.db.run('UPDATE magic_links SET consumed=1 WHERE id=? AND consumed=0',r.id).changes!==1)throw this.invalid();
      let user=this.db.get('SELECT * FROM users WHERE email=?',r.email),firstVerification=!user||!this.db.get('SELECT 1 FROM email_verifications WHERE user_id=?',user.id);
      if(!user) {
        user={id:randomUUID(),email:r.email};
        this.db.run('INSERT INTO users(id,email,password,created) VALUES(?,?,?,?)',user.id,r.email,passwordHash(token()),this.s.now());
      }
      if(firstVerification) {
        // An unverified password signup must not give a pre-hijacker lasting access.
        this.db.run('UPDATE users SET password=? WHERE id=?',passwordHash(token()),user.id);
        this.db.run('DELETE FROM sessions WHERE user_id=? AND token!=?',user.id,r.context==='reauth'?r.session_hash:'');
        this.db.run('UPDATE api_keys SET revoked=1 WHERE user_id=?',user.id);
        this.db.run('UPDATE os_grants SET revoked=1 WHERE user_id=?',user.id);
        this.db.run('UPDATE os_authorizations SET consumed=1 WHERE user_id=?',user.id);
        this.db.run('DELETE FROM recovery_keys WHERE user_id=?',user.id);
        this.db.run('INSERT INTO email_verifications(user_id,verified_at) VALUES(?,?)',user.id,this.s.now());
      }
      let auth;
      if(r.context==='reauth') {
        this.db.run('UPDATE sessions SET reauthed=? WHERE token=?',this.s.now(),r.session_hash);
        this.db.run('INSERT INTO magic_sessions VALUES(?,?) ON CONFLICT(token) DO UPDATE SET verified_at=excluded.verified_at',r.session_hash,this.s.now());
        auth={user:this.s.user(user.id),csrf:context.session.csrf};
      } else {
        auth=this.s.session(user.id);
        this.db.run('INSERT INTO magic_sessions VALUES(?,?)',hash(auth.token),this.s.now());
      }
      this.db.run('UPDATE magic_links SET consumed=1 WHERE email=?',r.email);
      let redirect_uri=this.s.c.origin+(r.return_view==='new'?'/':r.return_view==='agent'?'/?mode=agent':'/?view=servers');
      if(r.context==='oauth')redirect_uri=this.s.cloud.auth.complete(context.authorization.id,context.authorization.nonce,this.s.auth(auth.token)).redirect_uri;
      this.db.audit(user.id,r.id,'magic_link_'+r.context+'_verified',this.s.now());
      return {...auth,redirect_uri,context:r.context,first_verification:firstVerification};
    });
  }
  setPassword(session,password) {
    if(!this.fresh(session))throw this.s.err(403,'Сначала подтвердите вход ссылкой из письма.');
    this.s.limit('magic-password:'+session.user_id,10);
    this.s.validatePassword(password);
    this.db.tx(()=>{
      this.db.run('UPDATE users SET password=? WHERE id=?',passwordHash(password),session.user_id);
      this.db.run('UPDATE email_verifications SET password_enabled=1 WHERE user_id=?',session.user_id);
      this.db.audit(session.user_id,session.user_id,'verified_owner_password_set',this.s.now());
    });
    return {ok:true};
  }
}
