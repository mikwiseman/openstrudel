import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Service, config, DAY } from '../src/service.mjs';
import { PRICE_SOURCE, pricingCatalog, pricingBody } from './fixtures/kamatera-pricing.mjs';

// Native provider and payment HTTP clients run against local response functions.
// No credentials are read and no network, charge, SSH or real VM is used.
function fixture(t, { existing = 0, lagInventory = false } = {}) {
  mkdirSync('work/test-runs', { recursive: true });
  const dir = mkdtempSync(resolve('work/test-runs/production-payment-'));
  let now = Date.now(), paymentTimeout = false, createTimeout = false;
  const invoices = new Map(), paymentCalls = [], providerCalls = [], accepted = [], hooks = {};
  const oldVMs = Array.from({ length: existing }, () => ({ id: randomUUID(), name: 'wai-vds-' + randomUUID().replaceAll('-', '') }));
  const fetcher = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://pay.waiwai.is');
    const path = new URL(url).pathname.slice('/api/v2/payments'.length);
    paymentCalls.push({ path, method: options.method });
    let p;
    if (options.method === 'POST' && path === '') {
      const input = JSON.parse(options.body);
      p = [...invoices.values()].find(x => x.externalPaymentId === input.externalPaymentId);
      if (!p) {
        p = { ...input, id: randomUUID(), status: 'pending', mode: 'live', requestedAmountMinor: input.amountMinor, paidAmountMinor: 0, refundedAmountMinor: 0, paymentVersion: 1, paidAt: null, checkoutUrl: 'https://checkout.stripe.com/c/pay/fixture-' + invoices.size };
        invoices.set(p.id, p);
      }
      if (paymentTimeout) { paymentTimeout = false; throw Error('Lost checkout response'); }
    } else if (path.startsWith('/by-external/')) p = [...invoices.values()].find(x => x.externalPaymentId === decodeURIComponent(path.slice('/by-external/'.length)));
    else p = invoices.get(path.split('/')[1]);
    if (hooks.paymentRead && options.method === 'GET') await hooks.paymentRead(path);
    return p ? Response.json({ payment: p }) : Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  };
  const c = config({ WAI_DATA: dir, WAI_PROVIDER: 'kamatera', WAI_PAYMENTS: 'wai_pay', WAI_PAY_MODE: 'live', WAI_PAY_API_KEY: 'wp_live_fixture_never_network_0123456789', WAI_PAY_WEBHOOK_SECRET: 'w'.repeat(64), WAI_PAY_CARD_ENABLED: '1', WAI_PAY_STRIPE_ACCOUNT_ID: 'stripe-fixture', WAI_ALLOW_PAID_VM: 'I_APPROVE_KAMATERA_SPEND', WAI_MAX_PROVIDER_MONTHLY_USD: '10', WAI_MAX_LIVE_SERVERS: '1', WAI_APPROVED_IMAGE: 'EU:fixture-image', WAI_KAMATERA_CLIENT_ID: 'fixture-id', WAI_KAMATERA_SECRET: 'fixture-secret' });
  const s = new Service(c, { now: () => now, fetcher });
  s.provider.fetcher = async (url, options) => {
    if(url===PRICE_SOURCE)return new Response(pricingBody(pricingCatalog('fixture-image')));
    assert.equal(new URL(url).origin, 'https://console.kamatera.com');
    const path = new URL(url).pathname.slice('/service'.length), method = options.method;
    providerCalls.push({ method, path });
    if (path === '/authenticate') { if (hooks.authenticate) await hooks.authenticate(); return Response.json({ authentication: 'mock-bearer' }); }
    if (method === 'GET' && path.startsWith('/server/options/images/')) return Response.json([{ id: c.approvedImage, minRequirements: {}, sizeGB: 1 }]);
    if (method === 'GET' && path.startsWith('/server/options/image/')) {
      if (hooks.preflight) await hooks.preflight();
      return Response.json({ datacenter: 'EU', image: c.approvedImage, cpu: ['1A'], ram: { A: [2048] }, disk: [20], billing: ['monthly'], traffic: [{ name: 't5000' }], imageRequirements: {} });
    }
    if (method === 'GET' && path === '/servers') return Response.json([...oldVMs, ...(lagInventory ? [] : accepted)]);
    if (method === 'POST' && path === '/server') {
      const body = JSON.parse(options.body); accepted.push({ id: randomUUID(), name: body.name });
      if (hooks.create) await hooks.create();
      if (createTimeout) throw Error('Lost native create response');
      return Response.json(String(accepted.length));
    }
    throw Error('Unexpected mock provider call ' + method + ' ' + path);
  };
  t.after(() => { s.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const account = label => s.register(label + '@fixture.example.test', 'A-long-fixture-password-2026', 'fixture-' + label);
  const order = a => s.order(a.user.id, { purpose: 'clean', consent: true, payment_method: 'card', idempotency_key: randomUUID() });
  const invoice = o => [...invoices.values()].filter(x => x.metadata.wai_order_id === o.id).at(-1);
  const event = (p, type) => {
    const id = randomUUID(), data = { payment: structuredClone(p) };
    if (type.startsWith('refund.')) data.refund = { id: randomUUID(), paymentId: p.id, currency: p.currency, status: 'succeeded', amountMinor: p.refundedAmountMinor };
    const raw = JSON.stringify({ id, type, apiVersion: 2, paymentVersion: p.paymentVersion, occurredAt: new Date(now).toISOString(), data });
    return s.payments.real.webhook(raw, { 'X-WaiPay-Version': '2', 'X-WaiPay-Event-Id': id, 'X-WaiPay-Delivery-Id': randomUUID(), 'X-WaiPay-Signature': 'sha256=' + createHmac('sha256', c.waiPayWebhook).update(raw).digest('hex') });
  };
  const pay = async value => { const p = value.externalPaymentId ? value : invoice(value); Object.assign(p, { status: 'succeeded', paidAmountMinor: p.requestedAmountMinor, paidAt: new Date(now).toISOString(), paymentVersion: p.paymentVersion + 1 }); await event(p, 'payment.succeeded'); return p; };
  const refund = async (p, amount = p.paidAmountMinor) => { Object.assign(p, { refundedAmountMinor: amount, paymentVersion: p.paymentVersion + 1 }); await event(p, 'refund.succeeded'); };
  const expire = async p => { Object.assign(p, { status: 'expired', paymentVersion: p.paymentVersion + 1 }); await event(p, 'payment.expired'); };
  const reservation = o => s.db.get('SELECT * FROM capacity_reservations WHERE order_id=?', o.id);
  const server = o => s.db.get('SELECT * FROM servers WHERE order_id=?', o.id);
  const served = o => { const v = server(o); s.db.run("UPDATE servers SET state='ready',paid_until=? WHERE id=?", now + DAY, v.id); s.db.run("UPDATE operations SET state='ready' WHERE server_id=?", v.id); s.db.run("UPDATE orders SET status='fulfilled' WHERE id=?", o.id); return server(o); };
  return { s, c, hooks, invoices, paymentCalls, providerCalls, accepted, account, order, invoice, event, pay, refund, expire, reservation, server, served, advance: n => { now += n; }, timeoutPayment: () => { paymentTimeout = true; }, timeoutCreate: () => { createTimeout = true; } };
}

test('full native capacity is rejected before creating any chargeable invoice', async t => {
  const f = fixture(t, { existing: 1 }), a = f.account('full'), o = f.order(a);
  await assert.rejects(() => f.s.checkout(a.user.id, o.id), e => e.status === 409);
  assert.equal(f.invoices.size, 0); assert.equal(f.accepted.length, 0);
});

test('two customers racing for one slot get only one hosted checkout despite delayed inventory', async t => {
  const f = fixture(t, { lagInventory: true }), a = f.account('alice'), b = f.account('bob'), oa = f.order(a), ob = f.order(b);
  const results = await Promise.allSettled([f.s.checkout(a.user.id, oa.id), f.s.checkout(b.user.id, ob.id)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.status, 409);
  assert.equal(f.invoices.size, 1);
  const paidOrder = results[0].status === 'fulfilled' ? oa : ob;
  assert.equal(f.reservation(paidOrder).state, 'held');
  await f.pay(paidOrder); await f.s.tick();
  assert.equal(f.reservation(paidOrder).state, 'committed'); assert.equal(f.accepted.length, 1);
});

test('unknown checkout holds capacity across restart and local time passing', async t => {
  const f = fixture(t), a = f.account('unknown'), b = f.account('later'), oa = f.order(a), ob = f.order(b);
  f.timeoutPayment(); await assert.rejects(() => f.s.checkout(a.user.id, oa.id));
  assert.equal(f.reservation(oa).state, 'held');
  f.advance(40 * DAY);
  const restarted = new Service(f.c, { now: f.s.now, fetcher: f.s.payments.real.client.fetcher });
  restarted.provider.fetcher = f.s.provider.fetcher;
  try { await assert.rejects(() => restarted.checkout(b.user.id, ob.id), e => e.status === 409); } finally { restarted.db.close(); }
  const resumed = await f.s.checkout(a.user.id, oa.id);
  assert.equal(resumed.url, f.invoice(oa).checkoutUrl); assert.equal(f.invoices.size, 1);
});

test('verified unpaid expiry frees the slot; a late paid old invoice cannot overbook it', async t => {
  const f = fixture(t), a = f.account('expired'), b = f.account('replacement'), oa = f.order(a), ob = f.order(b);
  await f.s.checkout(a.user.id, oa.id); const first = f.invoice(oa); await f.expire(first);
  assert.equal(f.reservation(oa).state, 'released');
  await f.s.checkout(b.user.id, ob.id); await f.pay(first);
  assert.equal(f.s.ownOrder(a.user.id, oa.id).status, 'needs_refund'); assert.equal(f.server(oa), undefined);
  await f.pay(ob); await f.s.tick(); assert.equal(f.accepted.length, 1);
});

test('old expiry cannot free a new payable generation and partial payment never frees a slot', async t => {
  const f = fixture(t), a = f.account('versions'), b = f.account('blocked'), oa = f.order(a), ob = f.order(b);
  await f.s.checkout(a.user.id, oa.id); const old = f.invoice(oa);
  await f.expire(old); await f.s.checkout(a.user.id, oa.id); const current = f.invoice(oa);
  await f.expire(old); assert.equal(f.reservation(oa).state, 'held');
  Object.assign(current, { status: 'expired', paidAmountMinor: 100, paymentVersion: 2 });
  await f.event(current, 'payment.expired');
  await assert.rejects(() => f.s.checkout(b.user.id, ob.id), e => e.status === 409);
  assert.equal(f.reservation(oa).state, 'held'); assert.equal(f.invoices.size, 2);
});

test('independent service connections cannot reserve the same last slot', async t => {
  const f = fixture(t), a = f.account('process-a'), b = f.account('process-b'), oa = f.order(a), ob = f.order(b);
  const other = new Service(f.c, { now: f.s.now, fetcher: f.s.payments.real.client.fetcher });
  other.provider.fetcher = f.s.provider.fetcher;
  try {
    const results = await Promise.allSettled([f.s.checkout(a.user.id, oa.id), other.checkout(b.user.id, ob.id)]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(f.invoices.size, 1);
  } finally { other.db.close(); }
});

test('legacy checkout without a reservation still occupies capacity after upgrade', async t => {
  const f = fixture(t), a = f.account('legacy'), b = f.account('new'), oa = f.order(a), ob = f.order(b);
  await f.s.checkout(a.user.id, oa.id);
  f.s.db.run('DELETE FROM capacity_reservations WHERE order_id=?', oa.id);
  await assert.rejects(() => f.s.checkout(b.user.id, ob.id), e => e.status === 409);
  assert.equal(f.invoices.size, 1);
});

test('refund of the paid generation does not forget another still payable invoice for the same order', async t => {
  const f = fixture(t), a = f.account('generations'), b = f.account('next-generation'), oa = f.order(a), ob = f.order(b);
  await f.s.checkout(a.user.id, oa.id); const old = f.invoice(oa);
  await f.expire(old); await f.s.checkout(a.user.id, oa.id); const pending = f.invoice(oa);
  await f.pay(old); await f.refund(old);
  assert.equal(f.s.ownOrder(a.user.id, oa.id).status, 'refunded');
  await assert.rejects(() => f.s.checkout(b.user.id, ob.id), e => e.status === 409);
  await f.expire(pending); await f.s.checkout(b.user.id, ob.id);
  assert.equal(f.invoices.size, 3); assert.equal(f.accepted.length, 0);
});

test('renewal uses no new slot while capacity is full, but deletion rejects a saved draft before payment', async t => {
  const f = fixture(t), a = f.account('renewal'), o = f.order(a);
  await f.s.checkout(a.user.id, o.id); await f.pay(o); const v = f.served(o);
  const renewal = f.s.renewal(a.user.id, v.id, { consent: true, payment_method: 'card' });
  await f.s.checkout(a.user.id, renewal.id); assert.equal(f.invoices.size, 2); assert.equal(f.reservation(renewal), undefined);
  await f.pay(renewal); assert.equal(f.s.ownOrder(a.user.id, renewal.id).status, 'fulfilled');
  f.s.db.run('UPDATE servers SET paid_until=? WHERE id=?', f.s.now() + DAY + 1, v.id);
  const draft = f.s.renewal(a.user.id, v.id, { consent: true, payment_method: 'card' });
  f.s.remove(a.user.id, v.id, { confirm: v.id }, f.s.auth(a.token));
  await assert.rejects(() => f.s.checkout(a.user.id, draft.id), e => e.status === 409);
  assert.equal(f.invoices.size, 2);
});

test('full refund before queued provisioning prevents create and rejects customer retry', async t => {
  const f = fixture(t), a = f.account('refund'), o = f.order(a);
  await f.s.checkout(a.user.id, o.id); const p = await f.pay(o); await f.refund(p); await f.s.tick();
  assert.equal(f.accepted.length, 0); assert.equal(f.s.ownOrder(a.user.id, o.id).status, 'refunded');
  assert.equal(f.reservation(o).state, 'released');
  assert.throws(() => f.s.retry(a.user.id, f.server(o).id), e => e.status === 409);
});

test('a fully refunded payment first seen via its refund event releases the unused slot', async t => {
  const f = fixture(t), a = f.account('refund-first'), b = f.account('after-refund'), o = f.order(a), next = f.order(b);
  await f.s.checkout(a.user.id, o.id); const p = f.invoice(o);
  Object.assign(p, { status: 'succeeded', paidAmountMinor: p.requestedAmountMinor, paidAt: new Date(f.s.now()).toISOString(), paymentVersion: 2 });
  await f.refund(p);
  assert.equal(f.server(o), undefined); assert.equal(f.reservation(o).state, 'released');
  await f.s.checkout(b.user.id, next.id); assert.equal(f.invoices.size, 2); assert.equal(f.accepted.length, 0);
});

for (const boundary of ['preflight', 'authenticate']) test('refund during native ' + boundary + ' is fenced before the create HTTP request', async t => {
  const f = fixture(t), a = f.account('fence-' + boundary), o = f.order(a);
  await f.s.checkout(a.user.id, o.id); const p = await f.pay(o);
  if (boundary === 'preflight') f.hooks.preflight = async () => { delete f.hooks.preflight; await f.refund(p); };
  else {
    f.hooks.preflight = async () => { f.s.provider.auth = null; delete f.hooks.preflight; };
    f.hooks.authenticate = async () => { delete f.hooks.authenticate; await f.refund(p); };
  }
  await f.s.tick();
  assert.equal(f.providerCalls.filter(x => x.method === 'POST' && x.path === '/server').length, 0);
  assert.equal(f.reservation(o).state, 'released');
  assert.equal(f.s.db.get('SELECT state FROM attempts').state, 'rejected');
});

for (const uncertain of [false, true]) test('refund after native POST retains identity and reconciliation, uncertain=' + uncertain, async t => {
  const f = fixture(t), a = f.account('after-' + uncertain), b = f.account('waiting-' + uncertain), o = f.order(a), next = f.order(b);
  await f.s.checkout(a.user.id, o.id); const p = await f.pay(o);
  f.hooks.create = async () => { await f.refund(p); }; if (uncertain) f.timeoutCreate();
  await f.s.tick(); assert.equal(f.accepted.length, 1); assert.equal(f.reservation(o).state, 'committed');
  await f.s.tick();
  assert.equal(f.server(o).provider_id, f.accepted[0].id); assert.equal(f.server(o).state, 'attention');
  assert.notEqual(f.s.db.get('SELECT state FROM attempts').state, 'rejected');
  await assert.rejects(() => f.s.checkout(b.user.id, next.id), e => e.status === 409);
  assert.equal(f.accepted.length, 1);
});

test('refund and temporarily absent inventory never turn an uncertain create into confirmed deletion', async t => {
  const f = fixture(t, { lagInventory: true }), a = f.account('hidden'), o = f.order(a);
  await f.s.checkout(a.user.id, o.id); const p = await f.pay(o);
  f.hooks.create = async () => f.refund(p); f.timeoutCreate(); await f.s.tick();
  assert.equal(f.s.db.get('SELECT state FROM operations').state, 'unknown');
  f.advance(16 * 60000); await f.s.tick();
  const server = f.server(o); assert.equal(server.state, 'attention');
  f.s.reauth(f.s.auth(a.token), 'A-long-fixture-password-2026');
  f.s.remove(a.user.id, server.id, { confirm: server.id }, f.s.auth(a.token)); await f.s.tick();
  assert.equal(f.s.db.get('SELECT state FROM operations').state, 'delete_attention');
  assert.equal(f.reservation(o).state, 'committed'); assert.equal(f.accepted.length, 1);
});

test('confirmed provider absence during deletion releases the VM reservation', async t => {
  const f = fixture(t), a = f.account('removed'), b = f.account('next-slot'), o = f.order(a), next = f.order(b);
  await f.s.checkout(a.user.id, o.id); await f.pay(o); await f.s.tick(); await f.s.tick();
  const server = f.served(o); assert.equal(server.provider_id, f.accepted[0].id);
  f.s.remove(a.user.id, server.id, { confirm: server.id }, f.s.auth(a.token));
  f.accepted.splice(0); await f.s.tick();
  assert.equal(f.server(o).state, 'deleted'); assert.equal(f.reservation(o).state, 'released');
  await f.s.checkout(b.user.id, next.id); assert.equal(f.invoices.size, 2);
});

test('old invoice paid after the spend gate closes becomes a visible refund task without a VM', async t => {
  const f = fixture(t), a = f.account('closed'), o = f.order(a);
  await f.s.checkout(a.user.id, o.id); f.c.allowPaid = '';
  await f.pay(o); await f.s.tick();
  assert.equal(f.s.ownOrder(a.user.id, o.id).status, 'needs_refund'); assert.equal(f.server(o), undefined);
  assert.equal(f.reservation(o).state, 'released'); assert.equal(f.accepted.length, 0);
});

test('closing the spend gate after success but before create also stops the queued VM', async t => {
  const f = fixture(t), a = f.account('closed-queued'), o = f.order(a);
  await f.s.checkout(a.user.id, o.id); await f.pay(o); f.c.allowPaid = ''; await f.s.tick();
  assert.equal(f.s.ownOrder(a.user.id, o.id).status, 'needs_refund'); assert.equal(f.accepted.length, 0);
  assert.equal(f.reservation(o).state, 'released');
});
