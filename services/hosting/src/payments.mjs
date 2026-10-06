import { randomUUID } from 'node:crypto';
import { hash, verifyWebhook, webhookSignature } from './security.mjs';
import { ProviderError } from './providers.mjs';
import { WaiPayments } from './wai-payments.mjs';

export class Payments {
  constructor(service,fetcher=fetch) {this.s=service;this.db=service.db;this.c=service.c;this.fetcher=fetcher;this.real=this.c.payments==='wai_pay'?new WaiPayments(service,fetcher):null;}
  async stripe(method,path,body,idem) {
    let r;try {r=await this.fetcher('https://api.stripe.com/v1'+path,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+this.c.stripeKey,'Stripe-Version':'2025-02-24.acacia',...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(idem?{'Idempotency-Key':idem}:{})},...(body?{body:body.toString()}:{})});}catch{throw new ProviderError('checkout_unknown');}
    if(!r.ok)throw new ProviderError('checkout_unavailable');return r.json();
  }
  async checkout(order) {
    if(this.real)return this.real.checkout(order);
    if(!['draft','checkout'].includes(order.status))throw this.s.err(409,'Этот заказ уже оплачен или закрыт.');
    let p=this.db.get('SELECT * FROM payments WHERE order_id=?',order.id);
    if(p?.state==='expired') {
      this.db.tx(()=>{const current=this.db.get('SELECT * FROM payments WHERE order_id=?',order.id);if(current.state==='expired')this.db.run("UPDATE payments SET generation=generation+1,session_id=NULL,url=NULL,state='submitting',created=? WHERE order_id=?",this.s.now(),order.id);});
      p=this.db.get('SELECT * FROM payments WHERE order_id=?',order.id);
    }
    if(p?.url){
      // An expired hosted URL must not trap an unpaid order forever when a webhook was lost.
      if(this.c.payments==='stripe_test'&&this.s.now()-p.created>23*3600e3) {
        const remote=await this.stripe('GET','/checkout/sessions/'+encodeURIComponent(p.session_id));
        if(remote.id!==p.session_id||remote.metadata?.order_id!==order.id||remote.metadata?.user_id!==order.user_id||remote.livemode!==false)throw new ProviderError('checkout_invalid');
        if(remote.status==='expired'&&remote.payment_status==='unpaid') {
          this.db.run("UPDATE payments SET state='expired' WHERE order_id=? AND session_id=? AND state='open'",order.id,p.session_id);
          return this.checkout(this.s.ownOrder(order.user_id,order.id));
        }
      }
      return {url:p.url,order_id:order.id};
    }
    if(p && this.s.now()-p.created>23*3600e3)throw this.s.err(409,'Старая попытка оплаты требует сверки. Обратитесь к оператору.');
    if(!p) this.db.run('INSERT OR IGNORE INTO payments(order_id,state,created) VALUES(?,?,?)',order.id,'submitting',this.s.now());
    p=this.db.get('SELECT * FROM payments WHERE order_id=?',order.id);
    const generation=p.generation, suffix=generation?'_g'+generation:'';
    let session;
    if(this.c.payments==='emulator') {
      const id='cs_test_'+order.id+suffix;
      // The emulator keeps only the latest unpaid session; expired session events remain in the receipt ledger.
      this.db.run('INSERT OR REPLACE INTO sim_payments VALUES(?,?,?)',id,order.id,'unpaid');
      session={id,url:this.c.origin+'/checkout/'+id};
    } else {
      const form=new URLSearchParams({mode:'payment','payment_method_types[0]':'card',client_reference_id:order.user_id,'metadata[order_id]':order.id,'metadata[user_id]':order.user_id,'line_items[0][price_data][currency]':order.currency,'line_items[0][price_data][unit_amount]':String(order.amount),'line_items[0][price_data][product_data][name]':'WAI VDS · 30 дней · тест','line_items[0][quantity]':'1',success_url:this.c.origin+'/?order='+order.id+'&payment=returned',cancel_url:this.c.origin+'/?order='+order.id+'&payment=cancelled'});
      session=await this.stripe('POST','/checkout/sessions',form,'wai-vds-checkout-'+order.id+suffix);
      if(!session.id||!session.url?.startsWith('https://checkout.stripe.com/'))throw new ProviderError('checkout_invalid');
    }
    this.db.tx(()=>{this.db.run("UPDATE payments SET session_id=?,url=?,state='open' WHERE order_id=? AND generation=? AND state='submitting'",session.id,session.url,order.id,generation);this.db.run("UPDATE orders SET status='checkout' WHERE id=? AND status='draft'",order.id);});
    return {url:session.url,order_id:order.id};
  }
  localSession(id) {
    const p=this.db.get('SELECT * FROM sim_payments WHERE id=?',id);if(!p)return null;const o=this.db.get('SELECT * FROM orders WHERE id=?',p.order_id);
    return {id,client_reference_id:o.user_id,metadata:{order_id:o.id,user_id:o.user_id},amount_total:o.amount,currency:o.currency,livemode:false,mode:'payment',payment_status:p.state==='paid'?'paid':'unpaid',status:p.state==='paid'?'complete':p.state==='expired'?'expired':'open'};
  }
  localEvent(id,result) {
    const p=this.db.get('SELECT * FROM sim_payments WHERE id=?',id);if(!p)throw this.s.err(404,'Оплата не найдена.');
    // A terminal paid checkout can never be downgraded by a later cancel/fail click.
    if(result==='success'&&p.state==='expired')throw this.s.err(409,'Эта платёжная сессия истекла. Откройте новую из кабинета.');
    if(result==='success')this.db.run("UPDATE sim_payments SET state='paid' WHERE id=?",id);
    if(result==='cancel'&&p.state!=='paid')this.db.run("UPDATE sim_payments SET state='expired' WHERE id=?",id);
    const obj=this.localSession(id),event={id:'evt_'+randomUUID(),type:result==='success'?'checkout.session.completed':result==='cancel'?'checkout.session.expired':'checkout.session.async_payment_failed',livemode:false,data:{object:obj}};
    const raw=JSON.stringify(event);return {raw,signature:webhookSignature(raw,this.s.vault.webhookSecret,Math.floor(this.s.now()/1000))};
  }
  async webhook(raw,signature) {
    if(this.real)throw this.s.err(400,'Use the WAI Pay webhook endpoint.');
    const secret=this.c.payments==='emulator'?this.s.vault.webhookSecret:this.c.stripeWebhook;
    if(!verifyWebhook(raw,signature,secret,this.s.now()))throw this.s.err(400,'Неверная подпись платежа.');
    let e;try{e=JSON.parse(raw);}catch{throw this.s.err(400,'Неверное событие.');}
    if(typeof e.id!=='string'||e.id.length>200||e.livemode!==false)throw this.s.err(400,'Режим события не совпадает.');
    const digest=hash(raw),old=this.db.get('SELECT digest FROM payment_events WHERE id=?',e.id);
    if(old){if(old.digest!==digest)throw this.s.err(400,'Событие изменено.');return {duplicate:true};}
    const handled=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'];
    if(!handled.includes(e.type))return {ignored:true};
    const obj=e.data?.object;if(!obj?.id||!obj.metadata?.order_id)throw this.s.err(400,'Неизвестный платёж.');
    const order=this.db.get('SELECT * FROM orders WHERE id=?',obj.metadata.order_id),p=this.db.get('SELECT * FROM payments WHERE session_id=?',obj.id);
    if(!order||!p||p.order_id!==order.id||order.mode!==this.c.payments)throw this.s.err(400,'Платёж не относится к заказу.');
    const live=this.c.payments==='emulator'?this.localSession(obj.id):await this.stripe('GET','/checkout/sessions/'+encodeURIComponent(obj.id));
    const valid=x=>x && x.id===p.session_id && x.mode==='payment' && x.client_reference_id===order.user_id && x.metadata?.order_id===order.id && x.metadata?.user_id===order.user_id && x.amount_total===order.amount && x.currency===order.currency && x.livemode===false;
    if(!valid(obj)||!valid(live))throw this.s.err(400,'Сумма, валюта или владелец платежа не совпадают.');
    const success=['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(e.type);
    // The signed event and a server-to-server checkout lookup must BOTH say paid.
    const paid=success&&obj.payment_status==='paid'&&live.payment_status==='paid';
    // A signed success can arrive before a read replica reflects payment. Do not consume its event ID.
    if(success&&obj.payment_status==='paid'&&live.payment_status!=='paid')throw this.s.err(503,'Платёж ожидает сверки. Событие можно повторить.');
    if(e.type==='checkout.session.expired'&&obj.status==='expired'&&live.status!=='expired')throw this.s.err(503,'Состояние оплаты ожидает сверки.');
    this.db.tx(()=>{
      if(this.db.get('SELECT id FROM payment_events WHERE id=?',e.id))return;
      this.db.run('INSERT INTO payment_events VALUES(?,?,?,?,?)',e.id,digest,order.id,e.type,this.s.now());
      if(paid) this.s.acceptPayment(order.id);
      else if(!['paid','fulfilled','needs_refund'].includes(this.db.get('SELECT status FROM orders WHERE id=?',order.id).status)){
        if(e.type==='checkout.session.expired'&&obj.status==='expired'&&live.status==='expired'&&live.payment_status==='unpaid')
          this.db.run("UPDATE payments SET state='expired' WHERE order_id=? AND state!='paid'",order.id);
        this.db.audit(order.user_id,order.id,e.type,this.s.now());
      }
    });return {received:true,paid};
  }
}
