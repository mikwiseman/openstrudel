import { hash } from './security.mjs';
import { WaiPayClient, assertWaiPayPayment, verifyWaiPayEvent } from './wai-pay.mjs';

export class WaiPayments {
  constructor(service, fetcher) {
    this.s = service; this.db = service.db; this.c = service.c;
    this.client = new WaiPayClient({ apiKey: this.c.waiPayKey, mode: this.c.waiPayMode, baseUrl: this.c.waiPayBase }, { fetcher });
  }
  expected(attempt) {
    const request = JSON.parse(attempt.request_json);
    return { ...request, mode: this.c.waiPayMode, ...(attempt.payment_id ? { id: attempt.payment_id } : {}) };
  }
  makeRequest(order, generation) {
    const method = order.payment_method;
    const provider = { card: 'stripe', crypto: 'cryptomus', rub: 'tbank' }[method];
    const providerAccountId = { card: this.c.waiPayStripeAccount, crypto: this.c.waiPayCryptoAccount, rub: this.c.waiPayTbankAccount }[method];
    if (!provider || !providerAccountId) throw this.s.err(503, 'Способ оплаты ещё не подключён.');
    return {
      externalPaymentId: 'wai-vds-' + order.id + '-g' + generation,
      provider, providerAccountId, amountMinor: order.amount, currency: order.currency.toUpperCase(),
      description: order.purpose==='openstrudel_home'?'OpenStrudel · Всегда на связи · 30 дней':'WAI VDS · сервер · 30 дней',
      customer: { email: this.s.user(order.user_id).email },
      returnUrls: order.purpose==='openstrudel_home'?{success:this.returnURL(order),failure:this.returnURL(order)}:{ success: this.c.origin + '/?order=' + order.id + '&payment=returned', failure: this.c.origin + '/?order=' + order.id + '&payment=cancelled' },
      metadata: { wai_order_id: order.id, wai_user_id: order.user_id, purpose: order.purpose, generation }
    };
  }
  returnURL(order) {return order.purpose==='openstrudel_home'?this.s.cloud.paymentReturnURL(order):this.c.origin+'/?order='+order.id+'&payment=returned';}
  current(order) {
    return this.db.get('SELECT * FROM wai_pay_attempts WHERE order_id=? ORDER BY generation DESC LIMIT 1', order.id);
  }
  record(attempt, payment) {
    assertWaiPayPayment(payment, this.expected(attempt));
    this.db.tx(() => {
      const current = this.db.get('SELECT * FROM wai_pay_attempts WHERE external_id=?', attempt.external_id);
      if (current.payment_id && current.payment_id !== payment.id) throw this.s.err(409, 'Идентификатор оплаты изменился. Нужна сверка.');
      if (current.payment_id && current.payment_version >= payment.paymentVersion) {
        if(current.payment_version===payment.paymentVersion)this.db.run('UPDATE wai_pay_attempts SET verified_at=? WHERE external_id=?',this.s.now(),attempt.external_id);
        return;
      }
      const settled=payment.status==='succeeded'&&payment.paidAmountMinor-payment.refundedAmountMinor>=this.expected(attempt).amountMinor;
      const financialState=payment.status==='succeeded'&&!settled?'refunded':payment.status;
      const expires=Date.parse(payment.expiresAt||'');
      this.db.run('UPDATE wai_pay_attempts SET payment_id=?,state=?,paid_amount=?,payment_version=?,updated=?,verified_at=?,expires_at=?,refunded_amount=? WHERE external_id=?', payment.id, financialState, payment.paidAmountMinor, payment.paymentVersion, this.s.now(),this.s.now(),Number.isFinite(expires)?expires:null,payment.refundedAmountMinor, attempt.external_id);
      this.db.run("UPDATE payments SET session_id=?,url=?,state=? WHERE order_id=? AND generation=? AND state!='paid'", payment.id, payment.checkoutUrl, ['expired', 'canceled'].includes(payment.status) && payment.paidAmountMinor === 0 ? 'expired' : 'open', attempt.order_id, attempt.generation);
      if (payment.status==='succeeded'&&!settled) {
        this.db.audit(null,attempt.order_id,'refund_or_shortfall_needs_review:'+payment.id,this.s.now());
        this.s.paymentShortfall(attempt.order_id,payment);
      }
      if (settled) {
        assertWaiPayPayment(payment, this.expected(attempt), { requireSucceeded: true });
        const order = this.db.get('SELECT * FROM orders WHERE id=?', attempt.order_id);
        if (order.paid_at && order.paid_payment_id && order.paid_payment_id !== payment.id) this.db.audit(order.user_id, order.id, 'additional_payment_needs_refund:' + payment.id, this.s.now());
        if(!order.paid_at)this.db.run('UPDATE orders SET paid_payment_id=? WHERE id=?',payment.id,order.id);
        this.s.acceptPayment(attempt.order_id);
      }
      this.s.releaseExpiredCapacity(attempt.order_id);
    });
  }
  paidRedirect(order) {
    const latest=this.s.ownOrder(order.user_id,order.id);
    return latest.paid_at?{order_id:order.id,url:this.returnURL(order)}:null;
  }
  async checkout(order) {
    if (!['draft', 'checkout'].includes(order.status)) throw this.s.err(409, 'Этот заказ уже оплачен или закрыт.');
    const alreadyPaid=this.paidRedirect(order);if(alreadyPaid)return alreadyPaid;
    let attempt = this.current(order);
    if (attempt?.payment_id) {
      const remote = await this.client.syncPayment(attempt.payment_id);
      this.record(attempt, remote);
      const paid=this.paidRedirect(order);if(paid)return paid;
      if (remote.status === 'succeeded') return { order_id: order.id, url: this.returnURL(order) };
      if (['expired', 'canceled'].includes(remote.status) && remote.paidAmountMinor === 0) attempt = null;
      else {
        this.s.checkoutReady(this.s.ownOrder(order.user_id,order.id));
        if (!remote.checkoutUrl) throw this.s.err(409, 'Оплата ожидает сверки. Новая сессия не создаётся.');
        return { order_id: order.id, url: remote.checkoutUrl };
      }
    }
    if (!attempt) {
      this.db.tx(() => {
        if(this.paidRedirect(order))return;
        const latest = this.current(order);
        // Another request may already have advanced to the new generation.
        if (latest && (!['expired', 'canceled'].includes(latest.state)||latest.paid_amount>0)) return;
        const currentOrder=this.s.ownOrder(order.user_id,order.id);
        this.s.checkoutReady(currentOrder);
        // Expiry verification may have released the prior generation's hold.
        // Reacquire atomically before persisting any new chargeable intention.
        if(!this.s.reserveCapacity(currentOrder))throw this.s.err(409,'Свободные серверы закончились. Оплата нового сервера пока недоступна.');
        const generation = latest ? latest.generation + 1 : 0;
        const input = this.makeRequest(order, generation), request_json = JSON.stringify(input);
        this.db.run('INSERT INTO wai_pay_attempts(order_id,generation,external_id,request_json,state,created,updated) VALUES(?,?,?,?,?,?,?)', order.id, generation, input.externalPaymentId, request_json, 'submitting', this.s.now(), this.s.now());
        this.db.run("INSERT INTO payments(order_id,generation,state,created) VALUES(?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET generation=excluded.generation,session_id=NULL,url=NULL,state='submitting',created=excluded.created", order.id, generation, 'submitting', this.s.now());
        this.db.run("UPDATE orders SET status='checkout' WHERE id=? AND status='draft'", order.id);
      });
      const paid=this.paidRedirect(order);if(paid)return paid;
      attempt = this.current(order);
    }
    const input = JSON.parse(attempt.request_json);
    try {
      // An uncertain earlier HTTP response is recovered by the durable external ID.
      let payment = await this.client.getByExternal(attempt.external_id);
      const paidBeforeCreate=this.paidRedirect(order);if(paidBeforeCreate)return paidBeforeCreate;
      if (!payment) {
        this.s.checkoutReady(this.s.ownOrder(order.user_id,order.id));
        payment = await this.client.createPayment(input, attempt.external_id);
      }
      this.record(attempt, payment);
      const paidAfterCreate=this.paidRedirect(order);if(paidAfterCreate)return paidAfterCreate;
      if (!payment.checkoutUrl && payment.status !== 'succeeded') throw this.s.err(503, 'Платёж создан и ожидает готовности. Повторите проверку.');
      return { order_id: order.id, url: payment.status === 'succeeded' ? this.returnURL(order) : payment.checkoutUrl };
    } catch (error) {
      this.db.run("UPDATE wai_pay_attempts SET state=CASE WHEN payment_id IS NULL THEN 'unknown' ELSE state END,updated=? WHERE external_id=?", this.s.now(), attempt.external_id);
      throw error;
    }
  }
  async webhook(raw, headers) {
    const event = verifyWaiPayEvent(raw, headers, this.c.waiPayWebhook);
    if (!event) throw this.s.err(400, 'Неверная подпись или структура WAI Pay.');
    const digest = hash(raw), receiptId = 'wai:' + event.id;
    const previous = this.db.get('SELECT * FROM payment_events WHERE id=?', receiptId);
    if (previous) {
      if (previous.digest !== digest) throw this.s.err(400, 'Событие изменено.');
      return { duplicate: true };
    }
    const signed = event.data.payment;
    const attempt = this.db.get('SELECT * FROM wai_pay_attempts WHERE external_id=?', signed.externalPaymentId);
    if (!attempt) throw this.s.err(400, 'Оплата не относится к WAI VDS.');
    const expected = this.expected(attempt);
    assertWaiPayPayment(signed, expected, { requireSucceeded: event.type === 'payment.succeeded' });
    const current = await this.client.getPayment(signed.id);
    assertWaiPayPayment(current, { ...expected, id: signed.id });
    if (current.paymentVersion < signed.paymentVersion || event.type === 'payment.succeeded' && current.status !== 'succeeded') throw this.s.err(503, 'Платёж ожидает сверки. Повторите уведомление.');
    const received=this.db.get('SELECT digest FROM payment_events WHERE id=?',receiptId);
    if(received){if(received.digest!==digest)throw this.s.err(400,'Событие изменено.');return {duplicate:true};}
    // Record and receipt are two idempotent transactions: a crash between them
    // replays record safely; a receipt is never persisted before fulfillment.
    this.record(attempt, current);
    this.db.tx(() => {
      this.db.run('INSERT OR IGNORE INTO payment_events VALUES(?,?,?,?,?)', receiptId, digest, attempt.order_id, event.type, this.s.now());
      if (event.type.startsWith('refund.')) this.db.audit(null, attempt.order_id, event.type + ':' + current.id, this.s.now());
    });
    return { received: true, paid: current.status === 'succeeded'&&current.paidAmountMinor-current.refundedAmountMinor>=expected.amountMinor };
  }
  async reconcile() {
    const attempts = this.db.all("SELECT * FROM wai_pay_attempts WHERE created>? AND updated<?-CASE WHEN state IN ('succeeded','expired','canceled','refunded') THEN 3600000 ELSE 30000 END ORDER BY updated LIMIT 2", this.s.now()-30*86400e3, this.s.now());
    for (const attempt of attempts) {
      try {
        const payment = attempt.payment_id ? await this.client.syncPayment(attempt.payment_id) : await this.client.getByExternal(attempt.external_id);
        if (payment) {
          this.record(attempt, payment);
          if (payment.status === 'succeeded'&&attempt.state!=='succeeded'&&payment.paidAmountMinor-payment.refundedAmountMinor>=this.expected(attempt).amountMinor) this.db.audit(null, attempt.order_id, 'payment_recovered_by_authenticated_sync', this.s.now());
        }
      } catch { /* Retain the exact attempt. No new invoice on polling failure. */ }
      finally { this.db.run('UPDATE wai_pay_attempts SET updated=? WHERE external_id=?', this.s.now(), attempt.external_id); }
    }
  }
}
