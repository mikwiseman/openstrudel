import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store } from './storage.mjs';
import { Vault, token, hash, passwordHash, passwordOK } from './security.mjs';
import { Emulator, Kamatera, ProviderError } from './providers.mjs';
import { Payments } from './payments.mjs';
import { AgentAccess } from './agents.mjs';
import { AccountRecovery } from './account-recovery.mjs';
import { trustedProxyRanges } from './client-ip.mjs';
import {MagicLinks} from './magic-links.mjs';
import { OpenStrudelCloud } from './openstrudel.mjs';

export const DAY=86400e3;
export const PURPOSES={agent:'AI-агент или бот',site:'Сайт или приложение',clean:'Чистый Linux'};
export function config(env=process.env) {
  const c={host:env.WAI_HOST||'127.0.0.1',port:Number(env.WAI_PORT||4781),origin:env.WAI_ORIGIN||'http://127.0.0.1:4781',data:env.WAI_DATA||'work/runtime',provider:env.WAI_PROVIDER||'emulator',payments:env.WAI_PAYMENTS||'emulator',secure:env.WAI_SECURE_COOKIE==='1',kamateraId:env.WAI_KAMATERA_CLIENT_ID,kamateraSecret:env.WAI_KAMATERA_SECRET,allowPaid:env.WAI_ALLOW_PAID_VM,maxMonthly:Number(env.WAI_MAX_PROVIDER_MONTHLY_USD||0),maxServers:Number(env.WAI_MAX_LIVE_SERVERS||1),approvedImage:env.WAI_APPROVED_IMAGE,region:env.WAI_REGION||'EU',stripeKey:env.WAI_STRIPE_SECRET_KEY,stripeWebhook:env.WAI_STRIPE_WEBHOOK_SECRET,waiPayBase:env.WAI_PAY_BASE_URL||'https://pay.waiwai.is',waiPayKey:env.WAI_PAY_API_KEY,waiPayWebhook:env.WAI_PAY_WEBHOOK_SECRET,waiPayMode:env.WAI_PAY_MODE||'live',waiPayCard:env.WAI_PAY_CARD_ENABLED==='1',waiPayCrypto:env.WAI_PAY_CRYPTO_ENABLED==='1',waiPayStripeAccount:env.WAI_PAY_STRIPE_ACCOUNT_ID,waiPayCryptoAccount:env.WAI_PAY_CRYPTO_ACCOUNT_ID,waiPayTbankAccount:env.WAI_PAY_TBANK_ACCOUNT_ID,waiPayRubAmount:Number(env.WAI_PAY_RUB_AMOUNT||0)};
  c.magicEnabled=env.WAI_MAGIC_LINK_ENABLED==='1';c.resendKey=env.WAI_RESEND_API_KEY;c.resendFrom=env.WAI_RESEND_FROM;
  if(c.magicEnabled&&(!/^re_[A-Za-z0-9_-]+$/.test(c.resendKey||'')||!/^WAI Server <[a-z0-9._+-]+@[a-z0-9.-]+>$/.test(c.resendFrom||'')))throw Error('Resend credentials and verified sender required');
  const publicURL=new URL(c.origin);
  c.homeAmount=Number(env.WAI_HOME_AMOUNT_MINOR||0);c.homeImage=env.WAI_HOME_IMAGE||'';c.homeLiveApproval=env.WAI_HOME_LIVE_APPROVAL||'';
  for(const [field,name] of [['openstrudelRedirects','WAI_OPENSTRUDEL_REDIRECTS'],['openstrudelPaymentRedirects','WAI_OPENSTRUDEL_PAYMENT_REDIRECTS']])if(env[name]) {
    const values=JSON.parse(env[name]);if(!Array.isArray(values)||!values.length||values.some(x=>typeof x!=='string'))throw Error('Invalid OpenStrudel callback allowlist');c[field]=values;
  }
  if(!Number.isSafeInteger(c.homeAmount)||c.homeAmount<0||c.homeAmount>2147483647)throw Error('Invalid Home retail amount');
  c.trustedProxies=trustedProxyRanges(env.WAI_TRUSTED_PROXY_CIDRS||'');
  c.basePath=publicURL.pathname.replace(/\/$/,'');
  if(publicURL.username||publicURL.password||publicURL.search||publicURL.hash||!/^([/][a-zA-Z0-9_-]+)*$/.test(c.basePath))throw Error('Invalid public base URL');
  c.origin=publicURL.origin+c.basePath;
  if(!['emulator','kamatera'].includes(c.provider)||!['emulator','stripe_test','wai_pay'].includes(c.payments))throw Error('Unsupported payment or provider mode');
  if(c.payments==='stripe_test'&&(!c.stripeKey?.startsWith('sk_test_')||!c.stripeWebhook?.startsWith('whsec_')))throw Error('Stripe TEST credentials required');
  if(c.payments==='wai_pay'&&(!c.waiPayKey||!c.waiPayWebhook||!['live','test'].includes(c.waiPayMode)))throw Error('WAI Pay application credentials and mode required');
  if(!Number.isInteger(c.maxServers)||c.maxServers<1)throw Error('Invalid live server cap');
  if(c.payments==='emulator'&&(!['127.0.0.1','localhost','::1'].includes(c.host)||!['localhost','127.0.0.1','[::1]'].includes(new URL(c.origin).hostname)))throw Error('Emulator must be loopback only');
  if(c.host!=='127.0.0.1'&&!c.secure)throw Error('Public serving requires Secure cookies');
  return c;
}
export class Service {
  constructor(c,{now=Date.now,provider,fetcher,homeInstaller,mailer}={}) {
    this.c=c;this.now=now;this.db=new Store(join(c.data,'wai.sqlite'));this.vault=new Vault(c.data);this.provider=provider|| (c.provider==='emulator'?new Emulator(this.db,now):new Kamatera(c,this.vault));this.payments=new Payments(this,fetcher);this.agents=new AgentAccess(this);this.workerId=randomUUID();this.busy=false;
    const mode=this.db.get("SELECT value FROM settings WHERE key='mode'");const value=c.provider+':'+c.payments+(c.payments==='wai_pay'?':'+c.waiPayMode:'');
    if(mode&&mode.value!==value)throw Error('Use a separate data directory when switching modes');
    this.db.run("INSERT OR IGNORE INTO settings VALUES('mode',?)",value);
    this.recovery=new AccountRecovery(this);
    this.cloud=new OpenStrudelCloud(this,{installer:homeInstaller});
    this.magic=new MagicLinks(this,mailer);
  }
  err(status,message) {const e=new Error(message);e.status=status;return e;}
  limit(key,max=10,period=600e3) {const k=hash(key);this.db.tx(()=>{const r=this.db.get('SELECT * FROM rate_limits WHERE key=?',k);if(!r||r.expires<this.now())this.db.run('INSERT OR REPLACE INTO rate_limits VALUES(?,?,?)',k,1,this.now()+period);else {if(r.count>=max)throw this.err(429,'Слишком много попыток. Попробуйте позже.');this.db.run('UPDATE rate_limits SET count=count+1 WHERE key=?',k);}});}
  session(userId) {const t=token(),csrf=token();this.db.run('INSERT INTO sessions VALUES(?,?,?,?,?)',hash(t),userId,csrf,this.now()+DAY,this.now());return {token:t,csrf,user:this.user(userId)};}
  user(id) {return this.db.get('SELECT id,email,created FROM users WHERE id=?',id);}
  auth(raw) {if(raw?.startsWith('wai_'))return this.agents.auth(raw);if(!raw)throw this.err(401,'Войдите в свой аккаунт.');const s=this.db.get('SELECT * FROM sessions WHERE token=? AND expires>?',hash(raw),this.now());if(!s)throw this.err(401,'Сессия истекла. Войдите снова.');return s;}
  register(email,password,ip) {
    this.limit('register:'+ip,8);email=String(email||'').trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw this.err(400,'Введите правильный email.');
    this.validatePassword(password);const id=randomUUID(),encoded=passwordHash(password);
    try{return this.db.tx(()=>{this.db.run('INSERT INTO users VALUES(?,?,?,?)',id,email,encoded,this.now());const recovery_code=this.recovery.issue(id);return {...this.session(id),recovery_code};});}catch(e){if(e.code?.startsWith('ERR_SQLITE')&&this.db.get('SELECT id FROM users WHERE email=?',email))throw this.err(409,'Аккаунт уже существует. Войдите по ссылке или с паролем.');throw e;}
  }
  validatePassword(p) {if(typeof p!=='string'||p.length<12||p.length>256)throw this.err(400,'Пароль должен содержать от 12 до 256 символов.');}
  login(email,password,ip) {this.limit('login-ip:'+ip,30);this.limit('login-email:'+String(email).toLowerCase(),10);if(typeof password!=='string'||password.length>256)throw this.err(400,'Некорректный пароль.');const u=this.db.get('SELECT * FROM users WHERE email=?',String(email||'').trim().toLowerCase());const valid=passwordOK(password,u?.password||passwordHash('dummy-password-value'));if(!u||!valid)throw this.err(401,'Email или пароль не совпадают.');return this.session(u.id);}
  reauth(session,password) {if(!session||session.kind)throw this.err(403,'Подтвердите вход в браузере.');if(password===undefined||password===null||password===''){if(this.magic.fresh(session))return;throw this.err(403,'Подтвердите вход ссылкой из письма или паролем.');}this.limit('reauth:'+session.user_id,10);if(typeof password!=='string'||password.length>256||!passwordOK(password,this.db.get('SELECT password FROM users WHERE id=?',session.user_id).password))throw this.err(401,'Пароль не совпадает.');this.db.run('UPDATE sessions SET reauthed=? WHERE token=?',this.now(),session.token);}
  requireFresh(session) {if(this.now()-session.reauthed>5*60e3)throw this.err(403,'Для доступа к ключу или удаления подтвердите вход.');}
  ownOrder(user,id) {const r=this.db.get('SELECT * FROM orders WHERE id=? AND user_id=?',id,user);if(!r)throw this.err(404,'Заказ не найден.');return r;}
  ownServer(user,id) {const r=this.db.get('SELECT * FROM servers WHERE id=? AND user_id=?',id,user);if(!r)throw this.err(404,'Сервер не найден.');return r;}
  order(user,b) {
    if(!PURPOSES[b.purpose]||typeof b.idempotency_key!=='string'||!/^[-a-zA-Z0-9_]{8,100}$/.test(b.idempotency_key))throw this.err(400,'Проверьте назначение и ключ запроса.');
    if(b.consent!==true)throw this.err(400,'Подтвердите цену, период и условия удаления.');
    const quote=this.quote(b.payment_method);
    if(b.quote && (b.quote.amount!==quote.amount || b.quote.currency!==quote.currency || b.quote.period_days!==30)) throw this.err(409,'Цена изменилась. Проверьте каталог и подтвердите новую сумму.');
    return this.db.tx(()=>{const old=this.db.get('SELECT * FROM orders WHERE user_id=? AND (idem=? OR id IN (SELECT order_id FROM order_aliases WHERE user_id=? AND idem=?))',user,b.idempotency_key,user,b.idempotency_key);if(old){if(old.purpose!==b.purpose||old.kind!=='initial'||(old.payment_method&&old.payment_method!==quote.id))throw this.err(409,'Ключ запроса уже использован с другими данными.');return old;}
      const pending=this.db.get("SELECT * FROM orders WHERE user_id=? AND purpose=? AND kind='initial' AND status IN('draft','checkout','paid','fulfilling')",user,b.purpose);if(pending){if(pending.payment_method&&pending.payment_method!==quote.id)throw this.err(409,'Завершите сохранённый заказ с выбранным способом оплаты.');this.db.run('INSERT OR IGNORE INTO order_aliases VALUES(?,?,?)',user,b.idempotency_key,pending.id);return pending;}
      const id=randomUUID();this.db.run('INSERT INTO orders(id,user_id,idem,purpose,kind,amount,currency,mode,created) VALUES(?,?,?,?,?,?,?,?,?)',id,user,b.idempotency_key,b.purpose,'initial',quote.amount,quote.currency,this.c.payments,this.now());this.db.run('UPDATE orders SET payment_method=? WHERE id=?',quote.id,id);this.db.audit(user,id,'price_and_period_consent_v1',this.now());return this.ownOrder(user,id);});
  }
  catalog() {
    const methods=this.c.payments==='wai_pay' ? [
      ...(this.c.waiPayCard?[{id:'card',label:'Банковская карта',currency:'usd',amount:1200,available:true,test:this.c.waiPayMode==='test'}]:[]),
      ...(this.c.waiPayCrypto?[{id:'crypto',label:'Криптовалюта · USDT',currency:'usdt',amount:1200,available:true,test:this.c.waiPayMode==='test'}]:[]),
      ...(Number.isSafeInteger(this.c.waiPayRubAmount)&&this.c.waiPayRubAmount>0&&this.c.waiPayTbankAccount?[{id:'rub',label:'Карта в рублях · Т-Банк',currency:'rub',amount:this.c.waiPayRubAmount,available:true,test:this.c.waiPayMode==='test'}]:[])
    ] : [{id:this.c.payments==='emulator'?'test':'card',label:this.c.payments==='emulator'?'Тестовая оплата':'Банковская карта',currency:'usd',amount:1200,available:true,test:true}];
    const enabled=this.c.payments!=='wai_pay'||(methods.length>0&&(this.c.waiPayMode==='test'||(this.c.provider==='kamatera'&&this.provisioningApproved())));
    return {client_quote_version:1,plan:{id:'start',name:'Старт',amount:1200,currency:'usd',period_days:30,ram_mb:2048,cpu:'1A (shared)',disk_gb:20,ipv4:1,region:'Амстердам',traffic_gb:5000,backups:'manual_export',automatic_renewal:false,checkout_enabled:enabled,checkout_message:enabled?null:'Настраиваем оплату. Новые заказы скоро станут доступны.'},mode:{provider:this.c.provider,payments:this.c.payments,payment_live:this.c.payments==='wai_pay'&&this.c.waiPayMode==='live'},payment_methods:methods,tax_note:this.c.payments==='wai_pay'?'Фиксированная сумма выбранного способа оплаты. Продление вручную.':'Итоговая тестовая цена. Реальные налоги и продажи ещё не включены.'};
  }
  quote(method) {
    const catalog=this.catalog(),chosen=catalog.payment_methods.find(x=>x.id===(method||catalog.payment_methods[0]?.id));
    if(!chosen||!chosen.available)throw this.err(400,'Этот способ оплаты недоступен.');
    return chosen;
  }
  provisioningApproved() {return this.c.allowPaid==='I_APPROVE_KAMATERA_SPEND'&&Number.isFinite(this.c.maxMonthly)&&this.c.maxMonthly>=6&&!!this.c.approvedImage;}
  checkoutReady(order) {
    if(order.purpose==='openstrudel_home')this.cloud.readyForPurchase(order);
    if(!this.catalog().plan.checkout_enabled)throw this.err(409,'Реальная оплата ещё не включена: выдача серверов не готова.');
    if(!['draft','checkout'].includes(order.status))throw this.err(409,'Этот заказ уже оплачен или закрыт.');
    if(order.kind==='renewal') {
      const server=this.db.get('SELECT * FROM servers WHERE id=?',order.server_id);
      if(!server||!['ready','overdue'].includes(server.state)||server.cancel_at_end)throw this.err(409,'Для продления сначала восстановите обслуживание.');
    }
  }
  capacityOrders() {
    // Reservations survive process restarts and upstream inventory lag. Include
    // older DB rows too: an upgrade must not forget an existing VM or checkout.
    return new Set(this.db.all(`SELECT order_id FROM capacity_reservations WHERE state IN('held','committed')
      UNION SELECT s.order_id FROM servers s LEFT JOIN capacity_reservations r ON r.order_id=s.order_id
        WHERE s.provider_mode='kamatera' AND s.state!='deleted' AND (r.order_id IS NULL OR r.state!='released' OR s.provider_id IS NOT NULL
          OR EXISTS(SELECT 1 FROM attempts a WHERE a.server_id=s.id AND a.state!='rejected'))
      UNION SELECT o.id FROM orders o WHERE o.kind='initial'
        AND (EXISTS(SELECT 1 FROM wai_pay_attempts a WHERE a.order_id=o.id
            AND (a.state NOT IN('expired','canceled','succeeded','refunded') OR a.state IN('expired','canceled') AND a.paid_amount>0))
          OR o.paid_at IS NULL AND EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.state IN('open','submitting')
            AND NOT EXISTS(SELECT 1 FROM wai_pay_attempts a WHERE a.order_id=o.id)))`).map(x=>x.order_id));
  }
  reserveCapacity(order,inventory=[]) {
    // Called inside BEGIN IMMEDIATE, never across an await. Renewal consumes
    // the original VM's slot and must remain payable at the account limit.
    if(this.c.provider!=='kamatera'||order.kind!=='initial')return true;
    const held=this.capacityOrders();held.delete(order.id);
    const localNames=new Set(this.db.all("SELECT provider_name FROM servers WHERE provider_mode='kamatera' AND state!='deleted'").map(x=>x.provider_name));
    const external=inventory.filter(x=>x.name?.startsWith('wai-vds-')&&!localNames.has(x.name)).length;
    if(held.size+external>=this.c.maxServers)return false;
    this.db.run("INSERT INTO capacity_reservations(order_id,state,created,updated,reason) VALUES(?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET state=CASE WHEN capacity_reservations.state='committed' THEN 'committed' ELSE excluded.state END,updated=excluded.updated,reason=excluded.reason",order.id,order.paid_at?'committed':'held',this.now(),this.now(),'checkout_reserved');
    return true;
  }
  releaseCapacity(orderId,reason) {this.db.run("UPDATE capacity_reservations SET state='released',updated=?,reason=? WHERE order_id=?",this.now(),reason,orderId);}
  releaseExpiredCapacity(orderId) {
    const o=this.db.get('SELECT * FROM orders WHERE id=?',orderId);
    if(!o||o.paid_at||o.server_id)return;
    const attempts=this.db.all('SELECT state,paid_amount FROM wai_pay_attempts WHERE order_id=?',orderId);
    if(attempts.length&&attempts.every(x=>['expired','canceled'].includes(x.state)&&x.paid_amount===0))this.releaseCapacity(orderId,'verified_unpaid_expiry');
  }
  paymentFunded(orderId) {
    const o=this.db.get('SELECT * FROM orders WHERE id=?',orderId);
    if(!o?.paid_at||['refunded','needs_refund'].includes(o.status))return false;
    if(this.c.payments!=='wai_pay')return true;
    return !!o.paid_payment_id&&this.db.get('SELECT state FROM wai_pay_attempts WHERE order_id=? AND payment_id=?',orderId,o.paid_payment_id)?.state==='succeeded';
  }
  possibleProviderResource(server) {return !!server.provider_id||!!this.db.get("SELECT 1 FROM attempts WHERE server_id=? AND state!='rejected' LIMIT 1",server.id);}
  paymentShortfall(orderId,payment) {
    const o=this.db.get('SELECT * FROM orders WHERE id=?',orderId);
    if(o.paid_payment_id&&o.paid_payment_id!==payment.id)return;
    const status=payment.paidAmountMinor>0&&payment.refundedAmountMinor===payment.paidAmountMinor?'refunded':'needs_refund';
    this.db.run('UPDATE orders SET status=? WHERE id=?',status,orderId);
    this.db.run('UPDATE payments SET state=? WHERE order_id=?',status,orderId);
    // A refunded renewal needs operator review. Do not silently shorten a
    // running owner's paid period or delete their data on a refund callback.
    if(o.kind==='renewal')return;
    const server=this.db.get('SELECT * FROM servers WHERE order_id=?',orderId);
    if(!server)this.releaseCapacity(orderId,'payment_refunded_before_provision');
    else if(!this.possibleProviderResource(server)) {
      const op=this.db.get('SELECT * FROM operations WHERE server_id=?',server.id);
      this.db.run("UPDATE operations SET state='rejected',updated=?,error='payment_refunded' WHERE id=?",this.operationTime(op),op.id);
      this.db.run("UPDATE servers SET state='rejected',error='payment_refunded' WHERE id=?",server.id);
      this.releaseCapacity(orderId,'payment_refunded_before_provision');
    }
    // A submitting/accepted/unknown attempt may already have reached Kamatera.
    // Keep its state, identity and slot; the before-POST fence or reconciliation
    // establishes what actually happened. A refund is not proof of absence.
  }
  rejectUnstarted(server,op,reason) {
    this.db.run("UPDATE operations SET state='rejected',updated=?,error=? WHERE id=?",this.operationTime(op),reason,op.id);
    this.db.run("UPDATE servers SET state='rejected',error=? WHERE id=?",reason,server.id);
    if(reason!=='payment_refunded')this.db.run("UPDATE orders SET status='needs_refund' WHERE id=?",server.order_id);
    if(!this.possibleProviderResource(server))this.releaseCapacity(server.order_id,reason);
    this.db.audit(server.user_id,server.order_id,'provisioning_stopped:'+reason,this.now());
  }
  createFence(server,op) {
    if(!this.operationCurrent(op))throw new ProviderError('operation_superseded',true);
    if(!this.paymentFunded(server.order_id))throw new ProviderError('payment_refunded',true);
    if(server.purpose==='openstrudel_home'){try {this.cloud.readyForPurchase(this.db.get('SELECT * FROM orders WHERE id=?',server.order_id),{funded:true});}catch {throw new ProviderError('home_launch_not_approved',true);}}
    if(this.c.provider==='kamatera') {
      if(!this.provisioningApproved())throw new ProviderError('budget_approval_required',true);
      if(this.db.get('SELECT state FROM capacity_reservations WHERE order_id=?',server.order_id)?.state!=='committed'||this.capacityOrders().size>this.c.maxServers)throw new ProviderError('server_limit',true);
    }
  }
  async checkout(user,id,options={}) {
    const o=this.ownOrder(user,id);
    if(options.method&&o.payment_method&&options.method!==o.payment_method)throw this.err(409,'Способ оплаты закреплён в заказе.');
    this.checkoutReady(o);
    if(o.kind==='initial') {
      await this.provider.preflight(o.purpose==='openstrudel_home'?'openstrudel-home-v1':'start');
      if(this.c.provider==='kamatera') {
        const inventory=await this.provider.list();
        this.db.tx(()=>{
          const current=this.ownOrder(user,id);if(current.paid_at)return;
          this.checkoutReady(current);
          if(!this.provisioningApproved())throw this.err(409,'Выдача новых серверов пока закрыта.');
          if(!this.reserveCapacity(current,inventory))throw this.err(409,'Свободные серверы закончились. Оплата нового сервера пока недоступна.');
        });
      }
    }
    try {return await this.payments.checkout(o);}
    catch(e) {
      // Validation before an invoice intention can safely undo a bare hold.
      // Unknown/submitting intentions are deliberately retained without a TTL.
      this.db.tx(()=>{
        if(!this.db.get('SELECT 1 FROM payments WHERE order_id=?',id)&&!this.db.get('SELECT 1 FROM wai_pay_attempts WHERE order_id=?',id))this.releaseCapacity(id,'checkout_not_started');
        else this.releaseExpiredCapacity(id);
      });
      throw e;
    }
  }
  // Called only inside the verified webhook transaction. This is intentionally synchronous.
  acceptPayment(id) {
    const o=this.db.get('SELECT * FROM orders WHERE id=?',id);if(o.paid_at)return;
    if(o.kind==='initial'&&['canceled','refunded','needs_refund'].includes(o.status)) {
      this.db.run("UPDATE payments SET state='paid' WHERE order_id=?",id);
      this.db.run("UPDATE orders SET status='needs_refund',paid_at=? WHERE id=?",this.now(),id);
      this.releaseCapacity(id,'late_settlement_closed_order');this.db.audit(o.user_id,id,'late_payment_needs_refund:closed_order',this.now());return;
    }
    this.db.run("UPDATE payments SET state='paid' WHERE order_id=?",id);
    this.db.run("UPDATE orders SET status='paid',paid_at=? WHERE id=?",this.now(),id);
    if(o.kind==='renewal') {
      const s=this.db.get('SELECT * FROM servers WHERE id=?',o.server_id);
      if(!s||['deleting','deleted'].includes(s.state)){this.db.run("UPDATE orders SET status='needs_refund' WHERE id=?",id);this.db.audit(o.user_id,id,'late_payment_needs_refund',this.now());return;}
      this.db.run('UPDATE servers SET paid_until=?,cancel_at_end=0,state=CASE WHEN state=? THEN ? ELSE state END WHERE id=?',Math.max(this.now(),s.paid_until||0)+30*DAY,'overdue','ready',s.id);
      this.db.run("UPDATE orders SET status='fulfilled' WHERE id=?",id);
    } else {
      let blocked=['refunded','needs_refund'].includes(o.status)?'closed_order':null;
      if(o.purpose==='openstrudel_home') {try {this.cloud.readyForPurchase(o,{funded:true});}catch {blocked='home_launch_not_approved';}}
      if(this.c.provider==='kamatera') {
        if(!this.provisioningApproved())blocked='spend_gate_closed';
        else if(!blocked&&!this.reserveCapacity({...o,paid_at:this.now()}))blocked='capacity_unavailable';
      }
      if(blocked) {this.db.run("UPDATE orders SET status='needs_refund' WHERE id=?",id);this.releaseCapacity(id,blocked);this.db.audit(o.user_id,id,'late_payment_needs_refund:'+blocked,this.now());return;}
      this.db.run("UPDATE capacity_reservations SET state='committed',updated=?,reason='payment_verified' WHERE order_id=?",this.now(),id);
      const sid=randomUUID(),keys=this.vault.keypair(sid);
      this.db.run('INSERT INTO servers(id,user_id,order_id,purpose,state,provider_mode,provider_name,public_key,private_key,created) VALUES(?,?,?,?,?,?,?,?,?,?)',sid,o.user_id,id,o.purpose,'paid',this.c.provider,'wai-vds-'+sid.replaceAll('-',''),keys.publicKey,keys.privateKey,this.now());
      this.db.run('INSERT INTO operations(id,server_id,state,updated) VALUES(?,?,?,?)',randomUUID(),sid,'queued',this.now());
      this.db.run("UPDATE orders SET status='fulfilling',server_id=? WHERE id=?",sid,id);
    }
    this.db.audit(o.user_id,id,'payment_verified',this.now());
  }
  renewal(user,id,b) {if(b.consent!==true)throw this.err(400,'Продление требует вашего согласия.');const s=this.ownServer(user,id);if(!['ready','overdue'].includes(s.state)||s.cancel_at_end)throw this.err(409,'Для продления сначала восстановите обслуживание.');if(s.paid_until>this.now()+31*DAY)throw this.err(409,'Период уже продлён.');
    const quote=this.quote(b.payment_method);
    return this.db.tx(()=>{const existing=this.db.get("SELECT * FROM orders WHERE server_id=? AND kind='renewal' AND status IN('draft','checkout','paid')",id);if(existing)return existing;const oid=randomUUID();this.db.run('INSERT INTO orders(id,user_id,idem,purpose,kind,server_id,amount,currency,mode,created) VALUES(?,?,?,?,?,?,?,?,?,?)',oid,user,'renew-'+id+'-'+s.paid_until,s.purpose,'renewal',id,quote.amount,quote.currency,this.c.payments,this.now());this.db.run('UPDATE orders SET payment_method=? WHERE id=?',quote.id,oid);this.db.audit(user,id,'renewal_consent_v1',this.now());return this.ownOrder(user,oid);});}
  cancel(user,id,b) {const s=this.ownServer(user,id);if(!['ready','overdue'].includes(s.state))throw this.err(409,'Действие недоступно на этой стадии.');if(typeof b.cancel_at_end!=='boolean')throw this.err(400,'Нужно указать отмену или восстановление.');this.db.run('UPDATE servers SET cancel_at_end=? WHERE id=?',Number(b.cancel_at_end),id);this.db.audit(user,id,b.cancel_at_end?'cancel_at_period_end':'resume_service',this.now());return this.serverView(this.ownServer(user,id));}
  remove(user,id,b,session) {
    this.requireFresh(session);
    if(b.confirm!==id)throw this.err(400,'Введите идентификатор сервера для подтверждения.');
    this.db.tx(()=>{
      const s=this.ownServer(user,id),op=this.db.get('SELECT * FROM operations WHERE server_id=?',id);
      if(!['ready','overdue','rejected','attention'].includes(s.state))throw this.err(409,'Сначала дождитесь сверки текущей операции.');
      this.db.run("UPDATE servers SET state='deleting',error=NULL WHERE id=?",id);
      this.db.run("UPDATE operations SET state='delete_check',updated=?,error=NULL WHERE server_id=?",this.operationTime(op),id);
      this.db.audit(user,id,'explicit_delete',this.now());
    });
  }
  retry(user,id) {
    this.db.tx(()=>{
      const server=this.ownServer(user,id),op=this.db.get('SELECT * FROM operations WHERE server_id=?',id);
      if(op.state==='rejected') {
        if(!this.paymentFunded(server.order_id))throw this.err(409,'Оплата возвращена или ожидает сверки. Создание сервера недоступно.');
        if(this.c.provider==='kamatera'&&(!this.provisioningApproved()||!this.reserveCapacity(this.db.get('SELECT * FROM orders WHERE id=?',server.order_id))))throw this.err(409,'Выдача новых серверов пока недоступна.');
        this.db.run("UPDATE operations SET state='queued',updated=?,error=NULL WHERE server_id=?",this.operationTime(op),id);
        this.db.run("UPDATE servers SET state='paid',error=NULL WHERE id=?",id);
      } else if(op.state==='delete_attention') {
        // An explicit retry only schedules fresh ownership and power-state reads.
        // The worker may repeat poweroff, or DELETE only after confirming off.
        this.db.run("UPDATE operations SET state='delete_check',updated=?,error=NULL WHERE server_id=?",this.operationTime(op),id);
        this.db.run("UPDATE servers SET state='deleting',error=NULL WHERE id=?",id);
      } else if(['unknown','attention'].includes(op.state)) {
        this.db.run('UPDATE operations SET updated=? WHERE server_id=?',this.operationTime(op),id);
      } else throw this.err(409,'Операция уже выполняется.');
      this.db.audit(user,id,'reconcile_requested',this.now());
    });
  }
  access(user,id,session) {this.requireFresh(session);const s=this.ownServer(user,id);if(!['ready','overdue'].includes(s.state))throw this.err(409,'Доступ ещё не готов.');this.db.audit(user,id,'private_key_downloaded',this.now());return this.vault.open(s.private_key,s.id);}
  serverView(s) {const op=this.db.get('SELECT state,updated,error FROM operations WHERE server_id=?',s.id);return {id:s.id,order_id:s.order_id,purpose:s.purpose,state:s.state,mode:s.provider_mode,ip:s.ip,paid_until:s.paid_until,cancel_at_end:!!s.cancel_at_end,created:s.created,ready_at:s.ready_at,error:s.error,operation:op,backup:s.backup,ssh:s.ip?`ssh -i wai-vds-${s.id.slice(0,8)} root@${s.ip}`:null,public_key:s.public_key,host_key:s.host_key};}
  dashboard(user) {return {user:this.user(user),mode:{provider:this.c.provider,payments:this.c.payments},servers:this.db.all('SELECT * FROM servers WHERE user_id=? ORDER BY created DESC',user).map(x=>this.serverView(x)),orders:this.db.all('SELECT * FROM orders WHERE user_id=? ORDER BY created DESC',user)};}
  operationTime(op) {return Math.max(this.now(),(op?.updated||0)+1);}
  leaseHeld() {
    const lease=this.db.get("SELECT * FROM leases WHERE name='worker'");
    return !this.leaseLost&&lease?.owner===this.workerId&&lease.expires>this.now();
  }
  operationCurrent(op) {
    if(!op||!this.leaseHeld())return false;
    const current=this.db.get('SELECT * FROM operations WHERE id=?',op.id);
    return current?.state===op.state&&current.updated===op.updated&&current.attempt===op.attempt;
  }
  changeOperation(op,change) {
    return this.db.tx(()=>{
      if(!this.operationCurrent(op))return null;
      change();return this.db.get('SELECT * FROM operations WHERE id=?',op.id);
    });
  }
  progress(op,state,error=null,serverState=state) {
    return this.changeOperation(op,()=>{
      this.db.run('UPDATE operations SET state=?,updated=?,error=? WHERE id=?',state,this.operationTime(op),error,op.id);
      this.db.run('UPDATE servers SET state=?,error=? WHERE id=?',serverState,error,op.server_id);
      if(state==='deleted')this.releaseCapacity(this.db.get('SELECT order_id FROM servers WHERE id=?',op.server_id).order_id,'provider_deletion_confirmed');
    });
  }
  async tick() {
    if(this.busy)return;this.busy=true;this.leaseLost=false;let heartbeat;
    try {
      const won=this.db.tx(()=>{const l=this.db.get("SELECT * FROM leases WHERE name='worker'");if(l&&l.expires>this.now()&&l.owner!==this.workerId)return false;this.db.run("INSERT OR REPLACE INTO leases VALUES('worker',?,?)",this.workerId,this.now()+30000);return true;});if(!won)return;
      heartbeat=setInterval(()=>{
        try {
          const now=this.now();
          if(!this.db.run("UPDATE leases SET expires=? WHERE name='worker' AND owner=? AND expires>?",now+30000,this.workerId,now).changes)this.leaseLost=true;
        } catch {this.leaseLost=true;}
      },5000);heartbeat.unref();
      if(this.payments.real)await this.payments.real.reconcile();
      if(!this.leaseHeld())return;
      this.expire();
      // A persisted cursor prevents a full batch of slow operations from starving
      // newer paid orders. updated remains the time of the current stage.
      const cursor=this.db.get("SELECT value FROM settings WHERE key='worker_cursor'")?.value||'';
      const ops=this.db.all("SELECT * FROM operations WHERE state NOT IN ('ready','deleted','rejected') ORDER BY CASE WHEN id>? THEN 0 ELSE 1 END,id LIMIT 8",cursor);
      for(const op of ops) {
        if(!this.leaseHeld())break;
        await this.step(op);
        this.db.tx(()=>{if(this.leaseHeld())this.db.run("INSERT OR REPLACE INTO settings VALUES('worker_cursor',?)",op.id);});
      }
    } finally {if(heartbeat)clearInterval(heartbeat);this.db.run("DELETE FROM leases WHERE name='worker' AND owner=?",this.workerId);this.busy=false;}
  }
  expire() {
    this.db.tx(()=>{for(const s of this.db.all("SELECT * FROM servers WHERE state IN ('ready','overdue') AND paid_until<=?",this.now())){
      if(s.cancel_at_end||s.paid_until+3*DAY<=this.now()) {this.db.run("UPDATE servers SET state='deleting' WHERE id=?",s.id);this.db.run("UPDATE operations SET state='delete_check',updated=? WHERE server_id=?",this.now(),s.id);this.db.audit(s.user_id,s.id,'period_expired_delete',this.now());}
      else this.db.run("UPDATE servers SET state='overdue' WHERE id=?",s.id);
    }});
  }
  async step(op) {
    if(!this.operationCurrent(op))return;
    let s=this.db.get('SELECT * FROM servers WHERE id=?',op.server_id);
    try {
      if(op.state==='queued') {
        // Commit intention before crossing a network boundary. A crash here means reconcile, never repeat POST.
        op=this.changeOperation(op,()=>{
          let blocked=!this.paymentFunded(s.order_id)?'payment_refunded':null;
          if(!blocked&&s.purpose==='openstrudel_home') {try {this.cloud.readyForPurchase(this.db.get('SELECT * FROM orders WHERE id=?',s.order_id),{funded:true});}catch {blocked='home_launch_not_approved';}}
          if(!blocked&&this.c.provider==='kamatera') {
            if(!this.provisioningApproved())blocked='budget_approval_required';
            else if(!this.reserveCapacity(this.db.get('SELECT * FROM orders WHERE id=?',s.order_id)))blocked='server_limit';
          }
          if(blocked){this.rejectUnstarted(s,op,blocked);return;}
          this.db.run('INSERT INTO attempts VALUES(?,?,?,?,?)',randomUUID(),s.id,op.attempt+1,'submitting',this.now());
          this.db.run("UPDATE operations SET state='submitting',attempt=attempt+1,updated=? WHERE server_id=?",this.operationTime(op),s.id);
          this.db.run("UPDATE servers SET state='creating' WHERE id=?",s.id);
        });
        if(!op||op.state!=='submitting')return;
        try {
          const r=await this.provider.create(s,{beforePost:()=>this.createFence(s,op)});
          this.changeOperation(op,()=>{
            this.db.run("UPDATE operations SET state='creating',command_id=?,updated=? WHERE server_id=?",r.commandId,this.operationTime(op),s.id);
            this.db.run("UPDATE attempts SET state='accepted' WHERE server_id=? AND number=?",s.id,op.attempt);
          });
        } catch(e) {
          this.changeOperation(op,()=>{
            const state=e.definitive?'rejected':'unknown',error=e.code||'unknown_result';
            this.db.run('UPDATE operations SET state=?,updated=?,error=? WHERE id=?',state,this.operationTime(op),error,op.id);
            this.db.run('UPDATE servers SET state=?,error=? WHERE id=?',state,error,s.id);
            this.db.run('UPDATE attempts SET state=? WHERE server_id=? AND number=?',state,s.id,op.attempt);
            if(e.definitive&&!this.paymentFunded(s.order_id))this.rejectUnstarted(s,op,'payment_refunded');
            else if(e.definitive&&['budget_approval_required','server_limit','home_launch_not_approved'].includes(error))this.rejectUnstarted(s,op,error);
          });
        }
        return;
      }
      if(['submitting','creating','unknown','attention'].includes(op.state)) {
        const matches=await this.provider.find(s.provider_name);
        if(matches.length>1){this.progress(op,'attention','duplicate_provider_name');return;}
        if(matches.length===0){if(this.now()-op.updated>15*60e3)this.progress(op,'attention','provider_result_unknown');return;}
        if(s.provider_id&&s.provider_id!==matches[0].id){this.progress(op,'attention','provider_identity_mismatch');return;}
        this.changeOperation(op,()=>{
          const funded=this.paymentFunded(s.order_id),state=funded?'configuring':'attention',error=funded?null:'payment_refunded';
          this.db.run('UPDATE servers SET provider_id=?,state=?,error=? WHERE id=?',matches[0].id,state,error,s.id);
          this.db.run('UPDATE operations SET state=?,updated=?,error=? WHERE id=?',state,this.operationTime(op),error,op.id);
        });return;
      }
      if(op.state==='configuring') {
        if(!this.paymentFunded(s.order_id)){this.progress(op,'attention','payment_refunded');return;}
        const d=await this.provider.details(s);if(!d?.ip||!this.operationCurrent(op))return;
        if(!this.paymentFunded(s.order_id)){this.progress(op,'attention','payment_refunded');return;}
        if(!this.changeOperation(op,()=>this.db.run('UPDATE servers SET ip=? WHERE id=?',d.ip,s.id)))return;
        s={...s,ip:d.ip};
        const r=await this.provider.setup(s);
        this.changeOperation(op,()=>{
          this.db.run("UPDATE servers SET host_key=?,state='checking',error=NULL WHERE id=?",r.hostKey,s.id);
          this.db.run("UPDATE operations SET state='checking',updated=?,error=NULL WHERE id=?",this.operationTime(op),op.id);
        });return;
      }
      if(op.state==='checking') {
        if(!this.paymentFunded(s.order_id)){this.progress(op,'attention','payment_refunded');return;}
        await this.provider.check(s);
        if(!this.paymentFunded(s.order_id)){this.progress(op,'attention','payment_refunded');return;}
        if(s.purpose==='openstrudel_home'&&!await this.cloud.prepare(s,op))return;
        if(!this.paymentFunded(s.order_id)){this.progress(op,'attention','payment_refunded');return;}
        this.changeOperation(op,()=>{this.db.run("UPDATE servers SET state='ready',ready_at=?,paid_until=?,error=NULL WHERE id=?",this.now(),this.now()+30*DAY,s.id);this.db.run("UPDATE operations SET state='ready',updated=?,error=NULL WHERE server_id=?",this.operationTime(op),s.id);this.db.run("UPDATE orders SET status='fulfilled' WHERE id=?",s.order_id);this.db.audit(s.user_id,s.id,this.c.provider==='emulator'?'simulated_ready':'ssh_verified_ready',this.now());});return;
      }
      if(['delete_check','powering_off','terminating','delete_verify','delete_attention'].includes(op.state)) {
        const found=await this.provider.find(s.provider_name);
        if(!this.operationCurrent(op))return;
        if(found.length>1)throw new ProviderError('ownership_guard');
        if(!found.length) {
          const attempt=this.db.get('SELECT state FROM attempts WHERE server_id=? ORDER BY number DESC LIMIT 1',s.id);
          if(!s.provider_id&&attempt&&attempt.state!=='rejected') {
            this.progress(op,'delete_attention','creation_result_unknown','deleting');return;
          }
          this.progress(op,'deleted');return;
        }
        if(s.provider_id&&found[0].id!==s.provider_id)throw new ProviderError('ownership_guard');
        if(!s.provider_id) {
          // Reconcile a late creation by the same exact name before any delete.
          if(!this.changeOperation(op,()=>this.db.run('UPDATE servers SET provider_id=? WHERE id=?',found[0].id,s.id)))return;
          s={...s,provider_id:found[0].id};
        }
        if(op.state==='delete_attention')return;
        if(['delete_verify','terminating'].includes(op.state)) {
          if(this.now()-op.updated>15*60e3)this.progress(op,'delete_attention','deletion_unconfirmed','deleting');
          return;
        }
        const details=await this.provider.details(s);
        if(!this.operationCurrent(op))return;
        if(op.state==='delete_check') {
          op=this.progress(op,'powering_off',null,'deleting');if(!op)return;
          if(details.state!=='off')await this.provider.poweroff(s);return;
        }
        if(details.state==='off'&&op.state==='powering_off') {
          op=this.progress(op,'delete_verify',null,'deleting');if(!op)return;
          await this.provider.remove(s);return;
        }
        if(this.now()-op.updated>15*60e3)this.progress(op,'delete_attention','poweroff_unconfirmed','deleting');
      }
    } catch(e) {
      const code=e.code||'provider_unavailable';
      if(op&&['delete_check','powering_off','terminating','delete_verify'].includes(op.state)&&(e.definitive||this.now()-op.updated>15*60e3)) {
        this.progress(op,'delete_attention',code,'deleting');
      } else this.changeOperation(op,()=>{
        this.db.run('UPDATE operations SET error=? WHERE id=?',code,op.id);
        this.db.run('UPDATE servers SET error=? WHERE id=?',code,s.id);
      });
    }
  }
}
