import {randomUUID} from 'node:crypto';
import {hash,token,safeEqual} from './security.mjs';
import {ProviderError} from './providers.mjs';
import {OpenStrudelAuthorization,OPENSTRUDEL_CLIENT} from './openstrudel-auth.mjs';
import {HomeInstaller,EmulatedHomeInstaller,validateHomeBootstrap,HOME_RECIPE_SHA256,HOME_RELEASE_URL} from './openstrudel-home.mjs';

export const HOME_PROFILE='openstrudel-home-v1';
export const HOME_RELEASE_SHA256='2d2276516882aee51f79c003320ac226101f3291c1d365f25b03b520ef516a69';
export const PAYMENT_CALLBACK='openstrudel://checkout/wai-vds';
const PURPOSE='openstrudel_home',DAY=86400e3;
const statePattern=/^[A-Za-z0-9._~-]{16,128}$/;
const strict=(b,keys)=>b&&typeof b==='object'&&!Array.isArray(b)&&Object.keys(b).every(k=>keys.includes(k));

// This facade never trusts a caller-supplied owner ID. All ownership originates
// in a short-lived OAuth grant; the ordinary API keys cannot enter this API.
export class OpenStrudelCloud {
  constructor(service,{installer}={}) {
    this.s=service;this.db=service.db;this.auth=new OpenStrudelAuthorization(service);
    this.installer=installer||(service.c.provider==='emulator'?new EmulatedHomeInstaller(service):new HomeInstaller(service));
  }
  error(status,code,message='Не удалось выполнить действие. Заказ сохранён.') {const e=this.s.err(status,message);e.code=code;return e;}
  fresh(session) {if(this.s.now()-session.auth_time>5*60e3)throw this.error(403,'reauthorization_required','Подтвердите вход в OpenStrudel ещё раз.');}
  profile() {
    return {id:HOME_PROFILE,version:1,region:this.s.c.region,ram_mb:4096,disk_gb:30,cpu:'1A',public_ipv4:1,traffic_gb:5000,
      os:'Ubuntu 24.04 LTS',image:this.s.c.homeImage||null,release_url:HOME_RELEASE_URL,release_sha256:HOME_RELEASE_SHA256,recipe_sha256:HOME_RECIPE_SHA256};
  }
  enabled() {
    const c=this.s.c;
    if(!Number.isSafeInteger(c.homeAmount)||c.homeAmount<1)return false;
    if(c.provider==='emulator'&&c.payments==='emulator')return true;
    // Test gateways and emulator infrastructure can never enable a LIVE Home.
    if(c.provider==='emulator'&&c.payments==='wai_pay'&&c.waiPayMode==='test')return true;
    return c.provider==='kamatera'&&c.payments==='wai_pay'&&c.waiPayMode==='live'&&this.s.provisioningApproved()
      &&c.homeLiveApproval==='I_APPROVE_OPENSTRUDEL_HOME_SPEND'&&!!c.homeImage&&c.homeImage.startsWith(c.region+':');
  }
  catalog() {
    const methods=this.s.catalog().payment_methods.filter(m=>['card','crypto','test'].includes(m.id)).map(m=>({id:m.id,currency:m.currency.toUpperCase(),amount_minor:this.s.c.homeAmount||null,currency_exponent:2}));
    return {client_id:OPENSTRUDEL_CLIENT,profile:this.profile(),purchase_enabled:this.enabled()&&methods.length>0,
      availability_reason:this.enabled()?null:'home_live_acceptance_pending',payment_methods:methods,
      checkout:{type:'hosted',embedded:false,provider:'WAI Pay',return_to:'OpenStrudel'},
      platforms:{mac:{purchase_enabled:this.enabled()},web:{purchase_enabled:this.enabled()},ios:{purchase_enabled:false,mode:'join_by_invitation'}},
      automatic_renewal:false,period_days:30,grace_days:3,openai:'owner_signs_in_on_home',mode:this.s.c.provider==='emulator'?'emulator':'live_gated'};
  }
  purchaseAllowed(platform) {
    if(!['mac','web','ios'].includes(platform))throw this.error(400,'invalid_platform');
    if(platform==='ios')throw this.error(403,'platform_purchase_unavailable','На iPhone можно подключиться к готовой команде по приглашению.');
    if(!this.enabled())throw this.error(503,'home_purchase_unavailable','Размещение OpenStrudel ещё проходит проверку. Оплата пока закрыта.');
  }
  quote(session,b) {
    if(!strict(b,['profile_id','payment_method','platform','installation_id']))throw this.error(400,'invalid_quote_request');
    this.purchaseAllowed(b.platform);
    if(b.profile_id!==HOME_PROFILE)throw this.error(400,'profile_unavailable');
    const method=this.catalog().payment_methods.find(m=>m.id===b.payment_method);
    if(!method)throw this.error(400,'payment_method_unavailable');
    let installation=null;
    if(b.installation_id) {installation=this.ownInstallation(session,b.installation_id);const server=this.server(installation);if(!server||!['ready','overdue'].includes(server.state)||server.cancel_at_end)throw this.error(409,'renewal_unavailable');}
    this.s.limit('os-quote:'+session.user_id,30);
    const id=randomUUID(),now=this.s.now();
    const body={quote_id:id,profile:installation?JSON.parse(installation.profile):this.profile(),platform:b.platform,kind:installation?'renewal':'initial',installation_id:installation?.id||null,
      payment_method:method.id,amount_minor:method.amount_minor,currency:method.currency,currency_exponent:2,
      total_is_final:true,tax_note:'Итоговая фиксированная сумма; доплаты сервиса при оплате нет. Комиссию банка или сети определяет ваш провайдер.',
      period_days:30,starts_at:installation?'current_period_end_or_payment':'verified_home_ready',automatic_renewal:false,grace_days:3,
      cancellation:'Отмена обслуживания удаляет сервер в конце оплаченного срока. Без продления сервер удаляется после 3 дней льготного периода.',
      refund_policy:'При невозможности подготовить Home заказ направляется оператору на возврат. Возврат не считается выполненным до подтверждения платёжного сервиса.',
      created_at:now,expires_at:now+15*60e3,checkout_deadline:now+24*3600e3,mode:this.s.c.provider==='emulator'?'emulator':'live'};
    const serialized=JSON.stringify(body),digest=hash(serialized);
    this.db.run('INSERT INTO os_quotes VALUES(?,?,?,?,?,?,?)',id,session.user_id,OPENSTRUDEL_CLIENT,serialized,digest,now,body.expires_at);
    return {...body,quote_digest:digest};
  }
  returnURI(uri) {
    const allowed=this.s.c.openstrudelPaymentRedirects||[PAYMENT_CALLBACK];
    if(typeof uri!=='string'||!allowed.includes(uri))throw this.error(400,'invalid_return_uri');
    const u=new URL(uri);if(u.username||u.password||u.search||u.hash||uri!==PAYMENT_CALLBACK&&u.protocol!=='https:')throw this.error(400,'invalid_return_uri');
    return uri;
  }
  ownOrder(session,id) {
    const r=this.db.get('SELECT * FROM os_orders WHERE order_id=? AND user_id=? AND client_id=?',id,session.user_id,OPENSTRUDEL_CLIENT);
    if(!r)throw this.error(404,'order_not_found');return r;
  }
  ownInstallation(session,id) {
    const r=this.db.get('SELECT * FROM os_installations WHERE id=? AND user_id=?',id,session.user_id);
    if(!r)throw this.error(404,'installation_not_found');return r;
  }
  server(row) {return this.db.get('SELECT * FROM servers WHERE order_id=?',row.order_id);}
  order(session,b) {
    if(!strict(b,['quote_id','quote_digest','idempotency_key','consent','bootstrap','return_uri','return_state'])||b.consent!==true
      ||!/^[-a-zA-Z0-9_]{8,100}$/.test(b.idempotency_key||'')||!statePattern.test(b.return_state||''))throw this.error(400,'invalid_order_request');
    const uri=this.returnURI(b.return_uri),q=this.db.get('SELECT * FROM os_quotes WHERE id=? AND user_id=? AND client_id=?',b.quote_id,session.user_id,OPENSTRUDEL_CLIENT);
    if(!q||!safeEqual(q.digest,b.quote_digest||''))throw this.error(400,'quote_invalid');
    const quote=JSON.parse(q.body),home=quote.kind==='initial'?validateHomeBootstrap(b.bootstrap):null;
    if(!home&&b.bootstrap!==undefined)throw this.error(400,'renewal_bootstrap_forbidden');
    const fingerprint=hash(JSON.stringify({quote:q.id,bootstrap:home?.payload||null,return_uri:uri,return_state:b.return_state}));
    const id=this.db.tx(()=>{
      const previous=this.db.get('SELECT * FROM orders WHERE user_id=? AND idem=?',session.user_id,b.idempotency_key);
      if(previous){const native=this.ownOrder(session,previous.id);if(native.fingerprint!==fingerprint)throw this.error(409,'idempotency_conflict');return previous.id;}
      if(q.expires<=this.s.now())throw this.error(409,'quote_expired','Цена устарела. Получите и подтвердите новую котировку.');
      this.purchaseAllowed(quote.platform);
      if(quote.kind==='initial'&&JSON.stringify(quote.profile)!==JSON.stringify(this.profile()))throw this.error(409,'profile_changed');
      let installation,server;
      if(quote.kind==='renewal') {
        installation=this.ownInstallation(session,quote.installation_id);server=this.server(installation);
        if(!server||!['ready','overdue'].includes(server.state)||server.cancel_at_end||server.paid_until>this.s.now()+31*DAY)throw this.error(409,'renewal_unavailable');
        if(this.db.get("SELECT id FROM orders WHERE server_id=? AND kind='renewal' AND status IN('draft','checkout','paid')",server.id))throw this.error(409,'existing_order','Завершите сохранённый заказ продления.');
      } else {
        if(this.db.get('SELECT id FROM os_installations WHERE id=?',home.payload.installationId))throw this.error(409,'installation_already_bound');
        if(this.db.get("SELECT id FROM orders WHERE user_id=? AND purpose=? AND kind='initial' AND status IN('draft','checkout','paid','fulfilling')",session.user_id,PURPOSE))throw this.error(409,'existing_order','Сначала завершите или закройте сохранённый заказ.');
      }
      const oid=randomUUID(),iid=installation?.id||home.payload.installationId;
      this.db.run('INSERT INTO orders(id,user_id,idem,purpose,kind,server_id,amount,currency,mode,created,payment_method) VALUES(?,?,?,?,?,?,?,?,?,?,?)',oid,session.user_id,b.idempotency_key,PURPOSE,quote.kind,server?.id||null,quote.amount_minor,quote.currency.toLowerCase(),this.s.c.payments,this.s.now(),quote.payment_method);
      this.db.run('INSERT INTO os_orders VALUES(?,?,?,?,?,?,?,?,?)',oid,session.user_id,OPENSTRUDEL_CLIENT,q.id,fingerprint,iid,uri,b.return_state,this.s.now());
      if(home)this.db.run('INSERT INTO os_installations(id,user_id,order_id,profile,release_sha256,public_key_sha256,owner_token_hash,bootstrap_sealed,created) VALUES(?,?,?,?,?,?,?,?,?)',iid,session.user_id,oid,JSON.stringify(quote.profile),quote.profile.release_sha256,home.publicKeySHA256,home.payload.ownerTokenHash,this.s.vault.seal(JSON.stringify(home.payload),'home:'+iid),this.s.now());
      this.db.audit(session.user_id,oid,'openstrudel_quote_consent:'+q.digest,this.s.now());return oid;
    });
    return this.status(session,id);
  }
  orderSnapshot(order) {
    const row=this.db.get('SELECT q.body FROM os_orders o JOIN os_quotes q ON q.id=o.quote_id WHERE o.order_id=?',order.id);
    if(!row)throw this.error(409,'home_order_invalid');return JSON.parse(row.body);
  }
  readyForPurchase(order,{funded=false}={}) {
    const quote=this.orderSnapshot(order);this.purchaseAllowed(quote.platform);
    if(order.kind==='initial'&&JSON.stringify(quote.profile)!==JSON.stringify(this.profile()))throw this.error(409,'profile_changed');
    if(!funded&&quote.checkout_deadline<=this.s.now())throw this.error(409,'quote_checkout_expired','Срок оплаты истёк. Сначала проверьте результат сохранённого платежа.');
  }
  paymentReturnURL(order) {
    const row=this.db.get('SELECT * FROM os_orders WHERE order_id=?',order.id);if(!row)throw this.error(409,'home_order_invalid');
    return this.s.c.origin+'/openstrudel/payment-return?order_id='+order.id+'&state='+row.return_state;
  }
  paymentReturn(id,state) {
    const r=this.db.get('SELECT * FROM os_orders WHERE order_id=?',id);
    if(!r||!safeEqual(r.return_state,String(state||'')))throw this.error(400,'invalid_return');
    const u=new URL(this.returnURI(r.return_uri));u.searchParams.set('order_id',id);u.searchParams.set('state',r.return_state);
    // This URL contains no credential or financial truth. The native client
    // authenticates and fetches the saved order regardless of the return link.
    return u.href;
  }
  status(session,id) {
    const row=this.ownOrder(session,id),o=this.s.ownOrder(session.user_id,id),home=this.ownInstallation(session,row.installation_id),server=this.server(home);
    const attempts=this.db.all('SELECT * FROM wai_pay_attempts WHERE order_id=? ORDER BY generation',id),a=attempts.at(-1),p=this.db.get('SELECT * FROM payments WHERE order_id=?',id);
    const funded=this.s.paymentFunded(id);
    const duplicate=attempts.filter(x=>x.state==='succeeded'&&x.paid_amount-x.refunded_amount>=o.amount).length>1;
    let payment='unpaid',checkout='none',action='start_payment';
    if(a) {
      if(['expired','canceled'].includes(a.state)&&a.paid_amount===0){payment='unpaid';checkout=a.state;action='retry_payment';}
      else if(['unknown','submitting'].includes(a.state)||!a.verified_at){payment='unknown';checkout='unknown';action='wait_for_confirmation';}
      else if(a.refunded_amount>0){payment=a.refunded_amount>=a.paid_amount?'refunded':'partially_refunded';checkout='closed';action='contact_support';}
      else if(a.paid_amount>0&&a.state!=='succeeded'){payment='partially_paid';checkout='review';action='contact_support';}
      else if(a.state==='succeeded'){payment='paid';checkout='closed';action='wait_for_home';}
      else if(a.state==='failed'){payment='failed';checkout='review';action='contact_support';}
      else if(a.expires_at&&a.expires_at<=this.s.now()){payment='unknown';checkout='confirmation_pending';action='wait_for_confirmation';}
      else {payment='pending';checkout='open';action='complete_payment';}
    } else if(p) {
      if(p.state==='paid'){payment='paid';checkout='closed';action='wait_for_home';}
      else if(p.state==='expired'){checkout='expired';action='retry_payment';}
      else {payment=p.state==='open'?'pending':'unknown';checkout=p.state==='open'?'open':'unknown';action=p.state==='open'?'complete_payment':'wait_for_confirmation';}
    }
    if(funded){payment='paid';checkout='closed';action=home.state==='ready'?'claim_connection':'wait_for_home';}
    if(o.status==='refunded'){payment='refunded';checkout='closed';action='contact_support';}
    if(o.status==='needs_refund'){payment='refund_review';checkout='closed';action='contact_support';}
    if(duplicate){payment='additional_payment_review';checkout='closed';action='contact_support';}
    if(server&&['attention','rejected'].includes(server.state)||home.state==='attention')action='contact_support';
    if(server&&['deleting','deleted'].includes(server.state))action='none';
    if(o.status==='canceled'){checkout='closed';action='none';}
    const quote=this.orderSnapshot(o);
    if(['start_payment','retry_payment'].includes(action)&&quote.checkout_deadline<=this.s.now())action='new_quote_required';
    if(['start_payment','retry_payment'].includes(action)&&!this.enabled())action='purchase_unavailable';
    return {order_id:id,installation_id:home.id,quote_id:row.quote_id,quote_digest:this.db.get('SELECT digest FROM os_quotes WHERE id=?',row.quote_id).digest,
      order_status:o.status,kind:o.kind,amount_minor:o.amount,currency:o.currency.toUpperCase(),currency_exponent:2,payment_method:o.payment_method,
      payment_state:payment,session_state:checkout,action_required:action,session_expires_at:a?.expires_at||null,payment_verified_at:a?.verified_at||null,
      provisioning_state:server?.state||'not_started',home_state:server?.state==='deleted'?'deleted':home.state,
      paid_until:server?.paid_until||null,cancel_at_end:!!server?.cancel_at_end,readiness_verified_at:home.checked_at||null,
      mode:this.s.c.provider==='emulator'?'emulator':'live',created_at:o.created};
  }
  list(session) {return {orders:this.db.all('SELECT order_id FROM os_orders WHERE user_id=? ORDER BY created DESC',session.user_id).map(r=>this.status(session,r.order_id))};}
  async sync(session,id) {
    this.ownOrder(session,id);this.s.limit('os-sync:'+session.user_id,30,60000);
    const o=this.s.ownOrder(session.user_id,id),a=this.s.payments.real?.current(o);
    if(a){const p=a.payment_id?await this.s.payments.real.client.syncPayment(a.payment_id):await this.s.payments.real.client.getByExternal(a.external_id);if(p)this.s.payments.real.record(a,p);}
    return this.status(session,id);
  }
  async checkout(session,id) {
    this.ownOrder(session,id);this.s.limit('os-checkout:'+session.user_id,20);
    await this.sync(session,id);
    let status=this.status(session,id);
    if(['paid','refunded','refund_review','additional_payment_review','partially_refunded','partially_paid','failed'].includes(status.payment_state))return {type:'hosted',url:null,...status};
    const o=this.s.ownOrder(session.user_id,id);
    // Unknown creation is recovered by the same external payment ID inside the
    // existing durable checkout code. No new generation is possible here.
    const result=await this.s.checkout(session.user_id,id);
    status=this.status(session,id);
    return {type:'hosted',url:['complete_payment','start_payment'].includes(status.action_required)?result.url:null,...status};
  }
  abandon(session,id) {
    this.ownOrder(session,id);
    this.db.tx(()=>{
      const o=this.s.ownOrder(session.user_id,id),a=this.db.all('SELECT state,paid_amount FROM wai_pay_attempts WHERE order_id=?',id),p=this.db.get('SELECT state FROM payments WHERE order_id=?',id);
      if(o.paid_at||o.server_id||!['draft','checkout','canceled'].includes(o.status)||a.some(x=>!['expired','canceled'].includes(x.state)||x.paid_amount!==0)||p&&p.state!=='expired')throw this.error(409,'payment_confirmation_required');
      this.db.run("UPDATE orders SET status='canceled' WHERE id=?",id);this.db.run("UPDATE os_installations SET bootstrap_sealed=NULL,state='canceled' WHERE order_id=?",id);this.s.releaseCapacity(id,'owner_closed_unpaid_order');
    });return this.status(session,id);
  }
  async prepare(server,op) {
    const row=this.db.get('SELECT * FROM os_installations WHERE order_id=?',server.order_id);if(!row)throw new ProviderError('home_order_invalid',true);
    if(row.state==='ready')return true;
    if(row.state==='pending') {
      await this.installer.schedule(server,row);
      if(!this.s.operationCurrent(op))return false;
      this.db.run("UPDATE os_installations SET state='installing',error=NULL WHERE id=? AND state='pending'",row.id);return false;
    }
    const result=await this.installer.verify(server,row);
    if(!this.s.operationCurrent(op))return false;
    if(result.installation_id!==row.id||result.release_sha256!==row.release_sha256||!/^[a-f0-9]{64}$/.test(result.certificate_sha256)||result.mode!==this.s.c.provider)throw new ProviderError('home_identity_unverified',true);
    if(!this.s.paymentFunded(server.order_id))throw new ProviderError('payment_refunded',true);
    this.db.run("UPDATE os_installations SET state='ready',certificate_sha256=?,checked_at=?,details=?,bootstrap_sealed=NULL,error=NULL WHERE id=?",result.certificate_sha256,this.s.now(),JSON.stringify(result),row.id);
    this.db.audit(server.user_id,row.id,this.s.c.provider==='emulator'?'home_ready_emulated':'home_identity_and_https_verified',this.s.now());return true;
  }
  claim(session,id,b) {
    if(!strict(b,['recover_owner'])||b.recover_owner!==undefined&&typeof b.recover_owner!=='boolean')throw this.error(400,'invalid_claim_request');
    const row=this.ownInstallation(session,id),server=this.server(row);
    if(row.state!=='ready'||!server||!['ready','overdue'].includes(server.state))throw this.error(409,'home_not_ready');
    if(b.recover_owner)this.fresh(session);
    this.s.limit('os-claim:'+session.user_id,10);
    const secret=token(),ttl=5*60e3;
    this.db.run('INSERT INTO os_claims(digest,installation_id,user_id,grant_id,expires,recover_owner) VALUES(?,?,?,?,?,?)',hash(secret),id,session.user_id,session.grant_id,this.s.now()+ttl,Number(b.recover_owner===true));
    return {claim_token:secret,installation_id:id,expires_in:300};
  }
  async consumeClaim(session,b) {
    if(!strict(b,['claim_token','installation_id'])||!/^[a-f0-9]{64}$/.test(b.claim_token||''))throw this.error(400,'invalid_claim');
    const row=this.ownInstallation(session,b.installation_id),server=this.server(row);
    const claim=this.db.tx(()=>{
      const c=this.db.get('SELECT * FROM os_claims WHERE digest=? AND user_id=? AND grant_id=? AND installation_id=?',hash(b.claim_token),session.user_id,session.grant_id,row.id);
      if(!c||c.consumed||c.expires<=this.s.now())throw this.error(400,'claim_expired_or_used');
      if(row.state!=='ready'||!server||!['ready','overdue'].includes(server.state))throw this.error(409,'home_not_ready');
      if(c.recover_owner)this.fresh(session);
      this.db.run('UPDATE os_claims SET consumed=1 WHERE digest=?',c.digest);return c;
    });
    const connection={installation_id:row.id,url:JSON.parse(row.details).url,certificate_sha256:row.certificate_sha256,release_sha256:row.release_sha256,owner_token_source:'device_keychain',openai_action:'owner_sign_in_on_home',mode:this.s.c.provider};
    if(claim.recover_owner){connection.pairing=await this.installer.recover(server,row);connection.owner_token_source='home_pairing';}
    this.db.audit(session.user_id,row.id,'home_connection_claimed',this.s.now());return connection;
  }
  manage(session,id,action,b={}) {
    const row=this.ownInstallation(session,id),server=this.server(row);if(!server)throw this.error(409,'server_not_ready');
    if(action==='cancellation'){if(!strict(b,['cancel_at_end']))throw this.error(400,'invalid_request');this.s.cancel(session.user_id,server.id,b);return this.status(session,row.order_id);}
    if(action==='access'){this.fresh(session);return {installation_id:id,ip:server.ip,ssh:this.s.serverView(server).ssh,host_key:server.host_key,private_key:this.s.access(session.user_id,server.id,session)};}
    if(action==='delete'){this.fresh(session);if(!strict(b,['confirm'])||b.confirm!==id)throw this.error(400,'deletion_confirmation_required');this.s.remove(session.user_id,server.id,{confirm:server.id},session);return this.status(session,row.order_id);}
    if(action==='export'){
      this.fresh(session);if(!['ready','overdue'].includes(server.state))throw this.error(409,'server_not_ready');
      return {installation_id:id,type:'manual_ssh',contains_secrets:true,temporary_home_stop:true,
        instruction:'Сохраните архив локально и храните его зашифрованным. Home будет остановлен на время копирования и запущен после него.',
        command:`ssh -i wai-vds-${server.id.slice(0,8)} root@${server.ip} 'bash -s' > openstrudel-home.tar.gz`,
        stdin_script:`set -eu\ncd /opt/openstrudel-home/deploy\ncompose() { docker compose --project-name openstrudel --project-directory "$PWD" --env-file .env -f compose.yaml "$@"; }\ncompose stop home >/dev/null\ntrap 'compose start home >&2' EXIT\nv=$(docker volume inspect openstrudel_data --format '{{.Mountpoint}}')\ntest -d "$v"\ntar -C "$v" -czf - .\n`};
    }
    throw this.error(404,'not_found');
  }
}
