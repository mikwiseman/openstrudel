import { hash, passwordHash, safeEqual, token } from './security.mjs';

// A saved, single-use recovery code: no SMTP dependency or secrets in links.
export class AccountRecovery {
  constructor(service) { this.s=service; this.db=service.db; }
  issue(user) {
    const code='WAI-'+token().toUpperCase().match(/.{8}/g).join('-');
    this.db.run('INSERT INTO recovery_keys(user_id,digest,created) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET digest=excluded.digest,created=excluded.created',user,hash(code),this.s.now());
    this.db.audit(user,user,'recovery_code_issued',this.s.now());
    return code;
  }
  rotate(session,password) {
    if(session.kind==='api_key')throw this.s.err(403,'Создать код восстановления можно только в своём аккаунте.');
    this.s.reauth(session,password);
    return this.db.tx(()=>({recovery_code:this.issue(session.user_id)}));
  }
  recover(email,code,password,ip) {
    email=typeof email==='string'?email.trim().toLowerCase().slice(0,255):'';
    this.s.limit('recovery-ip:'+ip,20);
    this.s.limit('recovery-email:'+email,8);
    this.s.validatePassword(password);
    // Apply the same expensive password work before looking up either account.
    const encoded=passwordHash(password);
    code=typeof code==='string'&&code.length<=256?code.replace(/\s/g,'').toUpperCase():'';
    const digest=hash(code),validFormat=/^WAI-(?:[A-F0-9]{8}-){7}[A-F0-9]{8}$/.test(code);
    return this.db.tx(()=>{
      const user=this.db.get('SELECT u.id,r.digest FROM users u LEFT JOIN recovery_keys r ON r.user_id=u.id WHERE u.email=?',email);
      const valid=safeEqual(digest,user?.digest||hash('invalid-recovery-code'));
      if(!validFormat||!user?.digest||!valid)throw this.s.err(400,'Email или код восстановления не подошёл.');
      this.db.run('UPDATE users SET password=? WHERE id=?',encoded,user.id);
      this.db.run('UPDATE email_verifications SET password_enabled=1 WHERE user_id=?',user.id);
      this.db.run('UPDATE magic_links SET consumed=1 WHERE email=?',email);
      this.db.run('DELETE FROM sessions WHERE user_id=?',user.id);
      this.db.run('UPDATE api_keys SET revoked=1 WHERE user_id=?',user.id);
      this.db.run('UPDATE os_grants SET revoked=1 WHERE user_id=?',user.id);
      this.db.run('UPDATE os_authorizations SET consumed=1 WHERE user_id=?',user.id);
      const next=this.issue(user.id);
      this.db.audit(user.id,user.id,'account_recovered_sessions_and_api_keys_revoked',this.s.now());
      return {ok:true,recovery_code:next,requires_login:true};
    });
  }
}
