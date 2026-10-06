import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { unpaidCryptoStep } from './unpaid-crypto-proof-step.mjs';
const input = { orderId: 'a7f963e1-e0ff-4950-b8fe-16e7c7647489', userId: 'b7f963e1-e0ff-4950-b8fe-16e7c7647489', paymentId: 'cowncryptopayment' };
input.externalId = 'wai-vds-' + input.orderId + '-g0';
function fixture() {
  const created = '2026-10-05T15:00:00+03:00', expiry = Date.parse(created)/1000+900;
  const payment = { id: input.paymentId, appId: 'wai-vds', providerAccountId: 'cryptomus-main', provider: 'CRYPTOMUS', mode: 'LIVE', apiVersion: 2,
    externalOrderId: input.externalId, requestedAmount: 1200, currency: 'USDT', paidAmount: 0, refundedAmount: 0, paidAt: null,
    metadata: { wai_order_id: input.orderId, wai_user_id: input.userId }, providerPaymentId: 'c7f963e1-e0ff-4950-b8fe-16e7c7647489',
    status: 'PENDING', expiresAt: new Date(expiry*1000) };
  const invoice = { uuid: payment.providerPaymentId, order_id: payment.id, amount: '12.00', currency: 'USDT', payment_amount: '0.00',
    status: 'check', is_final: false, created_at: created, expired_at: expiry };
  const env = { CRYPTOMUS_MAIN_MERCHANT_ID: 'd7f963e1-e0ff-4950-b8fe-16e7c7647489', CRYPTOMUS_MAIN_API_KEY: 'mock-secret-do-not-print' };
  const calls = [], logs = [], events = [];
  const prisma = { payment: { findUnique: async() => payment }, providerAccount: { findUnique: async() => ({ id: 'cryptomus-main', isActive: true, mode: 'LIVE', provider: 'CRYPTOMUS', envPrefix: 'CRYPTOMUS_MAIN' }) },
    webhookLog: { findMany: async() => logs }, clientEvent: { findMany: async() => events } };
  const fetcher = async(url, options) => { calls.push([url, options]);
    assert.equal(url, 'https://api.cryptomus.com/v1/payment/info'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { uuid: payment.providerPaymentId });
    assert.equal(options.headers.sign, createHash('md5').update(Buffer.from(options.body).toString('base64')+env.CRYPTOMUS_MAIN_API_KEY).digest('hex'));
    return { ok: true, status: 200, json: async() => ({ state: 0, result: { ...invoice } }) }; };
  return { payment, invoice, env, calls, logs, events, prisma, fetcher, now: () => expiry*1000+1000 };
}
test('one exact invoice information request; read-only and no secret/URL/address in output', async() => {
  const f = fixture(); f.invoice.url = 'https://pay.cryptomus.com/private'; f.invoice.address = 'private-address';
  const result = await unpaidCryptoStep('inspect', input, f);
  assert.equal(f.calls.length, 1); assert.equal(result.providerMutationRequests, 0); assert.equal(result.cryptomus.lifetimeSeconds, 900);
  const text = JSON.stringify(result); for (const s of [f.env.CRYPTOMUS_MAIN_API_KEY, f.invoice.url, f.invoice.address]) assert.ok(!text.includes(s));
});
test('foreign app/account, wrong user or paid DB payment fails before upstream request', async() => {
  for (const mutate of [f => f.payment.appId='foreign', f => f.payment.providerAccountId='foreign', f => f.payment.metadata.wai_user_id='foreign', f => f.payment.paidAmount=1, f => f.payment.paidAt=new Date(), f => f.payment.refundedAmount=1]) {
    const f=fixture(); mutate(f); await assert.rejects(unpaidCryptoStep('inspect', input, f), e=>e.safeCode==='payment_binding_or_unpaid_guard'); assert.equal(f.calls.length,0);
  }
});
test('native UUID/order/amount/currency binding rejects another invoice', async() => {
  for (const mutate of [f=>f.invoice.uuid='foreign',f=>f.invoice.order_id=input.externalId,f=>f.invoice.amount='1200',f=>f.invoice.currency='USD']) {
    const f=fixture(); mutate(f); await assert.rejects(unpaidCryptoStep('inspect', input, f),e=>e.safeCode==='crypto_invoice_binding_or_amount_guard'); assert.equal(f.calls.length,1);
  }
});
test('paid/partial/confirming native outcomes cannot be counted as unpaid and trigger no mutations', async() => {
  for (const status of ['paid','paid_over','wrong_amount','wrong_amount_waiting','confirm_check','refund_process']) {
    const f=fixture(); f.invoice.status=status; await assert.rejects(unpaidCryptoStep('inspect',input,f),e=>e.safeCode==='crypto_invoice_unpaid_status_guard'); assert.equal(f.calls.length,1);
  }
  const f=fixture(); f.invoice.payment_amount='0.000001'; await assert.rejects(unpaidCryptoStep('inspect',input,f),e=>e.safeCode==='crypto_received_amount_guard');
});
test('900-second lifetime and saved expiry must agree; no refresh to shorten a mismatched invoice', async() => {
  for (const mutate of [f=>f.invoice.expired_at+=900,f=>f.payment.expiresAt=new Date(0),f=>f.invoice.created_at='2026-10-05T15:00:00']) {
    const f=fixture(); mutate(f); await assert.rejects(unpaidCryptoStep('inspect',input,f),e=>e.safeCode==='crypto_900_second_expiry_binding_guard'); assert.equal(f.calls.length,1);
  }
});
test('missing amount is unknown, not zero; a terminal missing field remains rejected', async() => {
  const f=fixture(); delete f.invoice.payment_amount;
  assert.equal((await unpaidCryptoStep('inspect',input,f)).cryptomus.receivedZeroVerified,false);
  f.invoice.status='cancel'; f.invoice.is_final=true;
  await assert.rejects(unpaidCryptoStep('inspect',input,f),e=>e.safeCode==='crypto_received_amount_guard');
});
test('real cancel evidence requires exact invoice and only own delivered callback', async() => {
  const f=fixture(); f.invoice.status='cancel'; f.invoice.is_final=true; f.payment.status='CANCELLED';
  f.logs.push({id:'own-log',createdAt:new Date(),rawPayload:{...f.invoice}},
    {id:'foreign-log',createdAt:new Date(),rawPayload:{...f.invoice,uuid:'foreign'}},
    {id:'partial-log',createdAt:new Date(),rawPayload:{...f.invoice,payment_amount:'1.00'}});
  f.events.push({id:'own-event',type:'payment.canceled',paymentVersion:2,deliveries:[{status:'delivered',statusCode:200,callbackUrl:'https://pay.waiwai.is/vds/api/v1/webhooks/wai-pay'}]},
    {id:'foreign-callback',type:'payment.canceled',paymentVersion:2,deliveries:[{status:'delivered',statusCode:200,callbackUrl:'https://example.invalid'}]});
  const result=await unpaidCryptoStep('inspect',input,f);
  assert.equal(result.cryptomus.expectedEvent,'payment.canceled'); assert.equal(result.cryptomus.naturalExpiryReached,true);
  assert.deepEqual(result.verifiedCryptomusTerminalEvents.map(e=>e.logId),['own-log']);
  assert.deepEqual(result.clientEvents.map(e=>e.deliveredToOwnApp),[true,false]); assert.equal(f.calls.length,1);
});
test('final networkless cancel with documented null amount is verified without claiming explicit zero', async() => {
  const f=fixture(); Object.assign(f.invoice,{status:'cancel',is_final:true,payment_amount:null,network:null,address:null,txid:null,from:null}); f.payment.status='CANCELLED';
  f.logs.push({id:'null-cancel',createdAt:new Date(),rawPayload:{...f.invoice}});
  const result=await unpaidCryptoStep('inspect',input,f);
  assert.equal(result.cryptomus.receivedZeroVerified,false);
  assert.equal(result.cryptomus.receivedAmountNull,true);
  assert.equal(result.cryptomus.uninitializedInvoice,true);
  assert.equal(result.cryptomus.cancellationUnpaidVerified,true);
  assert.equal(result.verifiedCryptomusTerminalEvents.length,1);
  assert.equal(result.verifiedCryptomusTerminalEvents[0].receivedZeroVerified,false);
  assert.equal(result.sources.nullableAmountSchema,'https://doc.cryptomus.com/merchant-api/payments/creating-invoice');
  assert.equal(f.calls.length,1);
});
test('null amount with any noncancel status, nonfinal cancel, network/address/transaction/sender fails closed', async() => {
  for(const mutate of [
    ...['new','process','check','expired','paid','paid_over'].map(status=>f=>{f.invoice.status=status;f.invoice.is_final=['expired','paid','paid_over'].includes(status);}),
    f=>f.invoice.is_final=false,
    ...['network','address','txid','from'].map(field=>f=>f.invoice[field]='present'),
  ]){
    const f=fixture();Object.assign(f.invoice,{status:'cancel',is_final:true,payment_amount:null});mutate(f);
    await assert.rejects(unpaidCryptoStep('inspect',input,f),e=>['crypto_received_amount_guard','crypto_invoice_unpaid_status_guard'].includes(e.safeCode));assert.equal(f.calls.length,1);
  }
});
test('nullable webhook evidence is rejected if it has payment route or transaction information', async() => {
  const f=fixture();Object.assign(f.invoice,{status:'cancel',is_final:true,payment_amount:null});
  for(const field of ['network','address','txid','from'])f.logs.push({id:field,createdAt:new Date(),rawPayload:{...f.invoice,[field]:'present'}});
  f.logs.push({id:'own-null-cancel',createdAt:new Date(),rawPayload:{...f.invoice}});
  const result=await unpaidCryptoStep('inspect',input,f);
  assert.deepEqual(result.verifiedCryptomusTerminalEvents.map(e=>e.logId),['own-null-cancel']);
});
test('HTTP error and unknown network outcomes are never retried', async() => {
  for (const fetcher of [async()=>{throw Error('network');},async()=>({ok:false,status:429})]) {
    const f=fixture(); let calls=0; f.fetcher=(...a)=>{calls++;return fetcher(...a);};
    await assert.rejects(unpaidCryptoStep('inspect',input,f)); assert.equal(calls,1);
  }
});
