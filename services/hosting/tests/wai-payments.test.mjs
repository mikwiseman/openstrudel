import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Service, config } from '../src/service.mjs';

function fixture(t) {
  mkdirSync('work/test-runs', { recursive: true });
  const dir = mkdtempSync(resolve('work/test-runs/wai-payment-'));
  let now = Date.now(), timeoutAfterCreate = false;
  const invoices = new Map(), calls = [];
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname.slice('/api/v2/payments'.length);
    calls.push({ path, method: options.method, body: options.body, idem: options.headers['Idempotency-Key'] });
    let payment;
    if (options.method === 'POST' && path === '') {
      const input = JSON.parse(options.body);
      payment = [...invoices.values()].find(x => x.externalPaymentId === input.externalPaymentId);
      if (!payment) {
        payment = { ...input, id: randomUUID(), status: 'pending', mode: 'test', requestedAmountMinor: input.amountMinor, paidAmountMinor: 0, refundedAmountMinor: 0, paymentVersion: 1, paidAt: null, checkoutUrl: input.provider === 'stripe' ? 'https://checkout.stripe.com/c/pay/cs_mock' : input.provider === 'cryptomus' ? 'https://pay.cryptomus.com/pay/mock' : 'https://pay.tbank.ru/mock' };
        invoices.set(payment.id, payment);
      }
      if (timeoutAfterCreate) { timeoutAfterCreate = false; throw Error('Network lost after provider accepted'); }
    } else if (path.startsWith('/by-external/')) payment = [...invoices.values()].find(x => x.externalPaymentId === decodeURIComponent(path.slice('/by-external/'.length)));
    else payment = invoices.get(decodeURIComponent(path.split('/')[1]));
    return payment ? new Response(JSON.stringify({ payment }), { status: 200 }) : new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 });
  };
  const c = config({ WAI_DATA: dir, WAI_PAYMENTS: 'wai_pay', WAI_PAY_MODE: 'test', WAI_PAY_API_KEY: 'wp_live_' + 'test'.repeat(12), WAI_PAY_WEBHOOK_SECRET: 'w'.repeat(64), WAI_PAY_CARD_ENABLED: '1', WAI_PAY_CRYPTO_ENABLED: '1', WAI_PAY_STRIPE_ACCOUNT_ID: 'stripe-test', WAI_PAY_CRYPTO_ACCOUNT_ID: 'crypto-test', WAI_PAY_TBANK_ACCOUNT_ID: 'tbank-test', WAI_PAY_RUB_AMOUNT: '120000' });
  const s = new Service(c, { fetcher, now: () => now });
  const account = s.register('payment@example.test', 'long payment password!', 'payment-ip');
  t.after(() => { s.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const order = (method = 'card', purpose = 'agent') => s.order(account.user.id, { purpose, payment_method: method, consent: true, idempotency_key: randomUUID() });
  const paid = payment => Object.assign(payment, { status: 'succeeded', paidAmountMinor: payment.requestedAmountMinor, paidAt: new Date(now).toISOString(), paymentVersion: payment.paymentVersion + 1 });
  const event = (payment, type = 'payment.succeeded', id = randomUUID()) => {
    const envelope = { id, apiVersion: 2, occurredAt: new Date(now).toISOString(), paymentVersion: payment.paymentVersion, type, data: { payment: structuredClone(payment) } };
    if (type.startsWith('refund.')) envelope.data.refund = { id: randomUUID(), paymentId: payment.id, currency: payment.currency, status: 'succeeded', amountMinor: payment.refundedAmountMinor };
    const raw = JSON.stringify(envelope);
    return { raw, headers: { 'X-WaiPay-Version': '2', 'X-WaiPay-Event-Id': id, 'X-WaiPay-Delivery-Id': randomUUID(), 'X-WaiPay-Signature': 'sha256=' + createHmac('sha256', c.waiPayWebhook).update(raw).digest('hex') } };
  };
  return { s, c, account, order, paid, event, invoices, calls, advance: n => { now += n; }, timeout: () => { timeoutAfterCreate = true; } };
}

test('WAI checkout persists exact currency, price, account and request before hosted creation', async t => {
  const f = fixture(t);
  for (const [method, purpose, currency, amount] of [['card', 'agent', 'USD', 1200], ['crypto', 'site', 'USDT', 1200], ['rub', 'clean', 'RUB', 120000]]) {
    const order = f.order(method, purpose);
    const checkout = await f.s.checkout(f.account.user.id, order.id, { method });
    assert(checkout.url.startsWith('https://'));
    const attempt = f.s.db.get('SELECT * FROM wai_pay_attempts WHERE order_id=?', order.id);
    const request = JSON.parse(attempt.request_json);
    assert.equal(request.amountMinor, amount); assert.equal(request.currency, currency);
    assert.equal(request.metadata.wai_user_id, f.account.user.id);
    assert.equal(request.metadata.wai_order_id, order.id);
    assert(!Object.hasOwn(request, 'callbackUrl'));
  }
  assert.equal(f.s.db.get('SELECT count(*) n FROM servers').n, 0);
});

test('unknown checkout result resolves the same external ID without another create POST', async t => {
  const f = fixture(t), order = f.order(); f.timeout();
  await assert.rejects(() => f.s.checkout(f.account.user.id, order.id));
  assert.equal(f.invoices.size, 1);
  const checkout = await f.s.checkout(f.account.user.id, order.id);
  assert(checkout.url.startsWith('https://checkout.stripe.com/'));
  assert.equal(f.calls.filter(x => x.path === '' && x.method === 'POST').length, 1);
  assert.equal(f.s.db.get('SELECT count(*) n FROM wai_pay_attempts').n, 1);
});

test('signed WAI success corroborates server-side and duplicate/reordered events create one VM', async t => {
  const f = fixture(t), order = f.order(); await f.s.checkout(f.account.user.id, order.id);
  const payment = [...f.invoices.values()][0]; f.paid(payment);
  const e = f.event(payment); await f.s.payments.real.webhook(e.raw, e.headers); await f.s.payments.real.webhook(e.raw, e.headers);
  const older = { ...payment, status: 'failed', paidAmountMinor: 0, paidAt: null, paymentVersion: 1 };
  const oldEvent = f.event(older, 'payment.failed'); await f.s.payments.real.webhook(oldEvent.raw, oldEvent.headers);
  assert.equal(f.s.db.get('SELECT count(*) n FROM servers').n, 1);
  assert.equal(f.s.ownOrder(f.account.user.id, order.id).status, 'fulfilling');
  assert.equal(f.s.db.get('SELECT count(*) n FROM payment_events').n, 2);
});

test('invalid signatures and changed price, owner, account, mode or currency do not fulfill', async t => {
  const f = fixture(t), order = f.order(); await f.s.checkout(f.account.user.id, order.id);
  const payment = [...f.invoices.values()][0]; f.paid(payment);
  const e = f.event(payment);
  await assert.rejects(() => f.s.payments.real.webhook(e.raw, { ...e.headers, 'X-WaiPay-Signature': 'sha256=' + '0'.repeat(64) }));
  for (const alter of [p => p.requestedAmountMinor = 1, p => p.metadata.wai_user_id = 'wrong', p => p.providerAccountId = 'wrong', p => p.mode = 'live', p => p.currency = 'EUR']) {
    const changed = structuredClone(payment); alter(changed); const bad = f.event(changed);
    await assert.rejects(() => f.s.payments.real.webhook(bad.raw, bad.headers));
  }
  assert.equal(f.s.db.get('SELECT count(*) n FROM servers').n, 0);
});

test('signed success ahead of lookup returns retryable 503 without consuming event', async t => {
  const f = fixture(t), order = f.order(); await f.s.checkout(f.account.user.id, order.id);
  const payment = [...f.invoices.values()][0], signed = f.paid(structuredClone(payment)), e = f.event(signed);
  await assert.rejects(() => f.s.payments.real.webhook(e.raw, e.headers), error => error.status === 503);
  assert.equal(f.s.db.get('SELECT count(*) n FROM payment_events').n, 0);
  Object.assign(payment, signed); await f.s.payments.real.webhook(e.raw, e.headers);
  assert.equal(f.s.db.get('SELECT count(*) n FROM servers').n, 1);
});

test('lost webhook is recovered by authenticated upstream sync without a new checkout', async t => {
  const f = fixture(t), order = f.order(); await f.s.checkout(f.account.user.id, order.id);
  f.paid([...f.invoices.values()][0]); f.advance(31000);
  await f.s.payments.real.reconcile(); await f.s.payments.real.reconcile();
  assert.equal(f.s.db.get('SELECT count(*) n FROM servers').n, 1);
  assert.equal(f.calls.filter(x => x.path === '' && x.method === 'POST').length, 1);
  assert(f.s.db.get("SELECT id FROM audit WHERE action='payment_recovered_by_authenticated_sync'"));
});

test('confirmed unpaid expiry advances generation; late payment never duplicates VM', async t => {
  const f = fixture(t), order = f.order(); await f.s.checkout(f.account.user.id, order.id);
  const first = [...f.invoices.values()][0]; Object.assign(first, { status: 'expired', paymentVersion: 2 });
  await f.s.checkout(f.account.user.id, order.id);
  assert.equal(f.invoices.size, 2);
  const second = [...f.invoices.values()][1]; f.paid(second); let e = f.event(second); await f.s.payments.real.webhook(e.raw, e.headers);
  f.paid(first); e = f.event(first); await f.s.payments.real.webhook(e.raw, e.headers);
  assert.equal(f.s.db.get('SELECT count(*) n FROM servers').n, 1);
  assert(f.s.db.get("SELECT id FROM audit WHERE action LIKE 'additional_payment_needs_refund:%'"));
});

test('partly paid expired crypto invoice stays bound and cannot silently start a new invoice', async t => {
  const f = fixture(t), order = f.order('crypto'); await f.s.checkout(f.account.user.id, order.id);
  const payment = [...f.invoices.values()][0]; Object.assign(payment, { status: 'expired', paidAmountMinor: 100, paymentVersion: 2 });
  await f.s.checkout(f.account.user.id, order.id);
  assert.equal(f.invoices.size, 1); assert.equal(f.s.db.get('SELECT count(*) n FROM servers').n, 0);
});

test('refund before delayed success is audited without issuing a server; existing access is not destroyed', async t => {
  const f = fixture(t), order = f.order(); await f.s.checkout(f.account.user.id, order.id);
  const payment = [...f.invoices.values()][0]; f.paid(payment);
  const oldSuccess = f.event(payment);
  Object.assign(payment, { refundedAmountMinor: payment.requestedAmountMinor, paymentVersion: 3 });
  const refund = f.event(payment, 'refund.succeeded'); await f.s.payments.real.webhook(refund.raw, refund.headers);
  await f.s.payments.real.webhook(oldSuccess.raw, oldSuccess.headers);
  assert.equal(f.s.db.get('SELECT count(*) n FROM servers').n, 0);
  assert(f.s.db.get("SELECT id FROM audit WHERE action LIKE 'refund_or_shortfall_needs_review:%'"));
});

test('live payment stays unavailable until real provisioning is enabled and a method is configured', async t => {
  const f = fixture(t), order = f.order(); f.s.c.waiPayMode = 'live';
  assert.equal(f.s.catalog().plan.checkout_enabled, false);
  await assert.rejects(() => f.s.checkout(f.account.user.id, order.id), error => error.status === 409);
  assert.equal(f.calls.length, 0);
});

test('payment method cannot change after consent or under the same idempotency key', async t => {
  const f = fixture(t), order = f.order();
  await assert.rejects(() => f.s.checkout(f.account.user.id, order.id, { method: 'crypto' }), error => error.status === 409);
  assert.throws(() => f.s.order(f.account.user.id, { purpose: 'agent', payment_method: 'crypto', consent: true, idempotency_key: order.idem }), error => error.status === 409);
});

test('late settlement during expiry sync cannot create another checkout generation', async t => {
  const f = fixture(t), order = f.order(); await f.s.checkout(f.account.user.id, order.id);
  const first = [...f.invoices.values()][0]; Object.assign(first, { status: 'expired', paymentVersion: 2 });
  await f.s.checkout(f.account.user.id, order.id);
  const second = [...f.invoices.values()][1];
  const realSync = f.s.payments.real.client.syncPayment.bind(f.s.payments.real.client);
  f.s.payments.real.client.syncPayment = async id => {
    if (id === second.id) {
      f.paid(first); const e = f.event(first); await f.s.payments.real.webhook(e.raw, e.headers);
      Object.assign(second, { status: 'expired', paymentVersion: 2 });
    }
    return realSync(id);
  };
  const result = await f.s.checkout(f.account.user.id, order.id);
  assert(result.url.startsWith(f.c.origin + '/?order='));
  assert.equal(f.invoices.size, 2); assert.equal(f.s.db.get('SELECT count(*) n FROM wai_pay_attempts').n, 2);
  assert.equal(f.s.db.get('SELECT count(*) n FROM servers').n, 1);
});

test('hourly reconciliation recovers a late paid expired invoice when its callback is lost', async t => {
  const f = fixture(t), order = f.order(); await f.s.checkout(f.account.user.id, order.id);
  const first = [...f.invoices.values()][0]; Object.assign(first, { status: 'expired', paymentVersion: 2 });
  await f.s.checkout(f.account.user.id, order.id);
  f.paid(first); f.advance(3600e3 + 1);
  await f.s.payments.real.reconcile();
  assert.equal(f.s.db.get('SELECT count(*) n FROM servers').n, 1);
  assert.equal(f.s.ownOrder(f.account.user.id, order.id).paid_payment_id, first.id);
  assert.equal(f.invoices.size, 2);
});
