import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { WaiPayClient, WaiPayError, WAI_PAY_BASE_URL, safeWaiPayCheckoutUrl, verifyWaiPayEvent, assertWaiPayPayment } from '../src/wai-pay.mjs';

const API_KEY='wp_live_fixture_no_real_credentials_0123456789';
const SECRET='fixture_webhook_secret_no_real_credentials';
const DELIVERY='d24e2f7a-a3c2-4b44-9d45-04ad8ebf170d';
const intent=(patch={})=>({externalPaymentId:'wai-vds-order-1-g0',amountMinor:1200,currency:'USD',provider:'stripe',
  providerAccountId:'stripe-main',description:'WAI VDS, 30 days',customer:{email:'owner@example.test'},
  returnUrls:{success:'https://pay.waiwai.is/vds/?order=1&payment=success',failure:'https://pay.waiwai.is/vds/?order=1&payment=failed'},
  metadata:{order_id:'order-1',user_id:'user-1',generation:0},...patch});
function payment(input=intent(),patch={}) {
  const hosts={stripe:'checkout.stripe.com',cryptomus:'pay.cryptomus.com',tbank:'pay.tbank.ru'};
  return {id:'cmfxtestpayment0001',externalPaymentId:input.externalPaymentId,provider:input.provider,providerAccountId:input.providerAccountId,
    status:'pending',requestedAmountMinor:input.amountMinor,paidAmountMinor:0,refundedAmountMinor:0,currency:input.currency,
    description:input.description,checkoutUrl:'https://'+hosts[input.provider]+'/checkout/fixture',expiresAt:'2026-10-04T12:15:00.000Z',
    providerStatus:'NEW',mode:'live',paymentVersion:1,paidAt:null,canceledAt:null,metadata:input.metadata,
    createdAt:'2026-10-04T12:00:00.000Z',updatedAt:'2026-10-04T12:00:00.000Z',...patch};
}
const succeeded=(input=intent(),patch={})=>payment(input,{status:'succeeded',paidAmountMinor:input.amountMinor,paidAt:'2026-10-04T12:03:00.000Z',paymentVersion:2,...patch});
const expected=(input=intent(),patch={})=>({...input,mode:'live',...patch});
const client=(fetcher,options={})=>new WaiPayClient({apiKey:API_KEY,...options},{fetcher});
const code=wanted=>error=>error instanceof WaiPayError&&error.code===wanted;
function signed(event,raw=JSON.stringify(event)) {
  return {raw,headers:{'x-waipay-signature':'sha256='+createHmac('sha256',SECRET).update(raw).digest('hex'),
    'x-waipay-version':'2','x-waipay-event-id':event.id,'x-waipay-delivery-id':DELIVERY}};
}
const event=(patch={})=>({id:'cmfxevent0001',type:'payment.succeeded',apiVersion:2,paymentVersion:2,
  occurredAt:'2026-09-01T12:03:00.000Z',data:{payment:succeeded()},...patch});

test('v2 creation binds minor units, merchant, URLs and exact idempotency key for all three methods',async t=>{
  for(const input of [intent(),intent({currency:'USDT',provider:'cryptomus',providerAccountId:'cryptomus-main'}),
    intent({currency:'RUB',provider:'tbank',providerAccountId:'tinkoff-approved-vds',amountMinor:120000})]) {
    await t.test(input.provider,async()=>{
      const calls=[];const c=client(async(url,options)=>{calls.push({url,options});return Response.json({payment:payment(input)},{status:201});});
      const out=await c.createPayment(input,'wai-vds-order-1-g0');
      assert.equal(out.requestedAmountMinor,input.amountMinor);assert.equal(calls.length,1);
      assert.equal(calls[0].url,WAI_PAY_BASE_URL+'/api/v2/payments');
      assert.deepEqual(JSON.parse(calls[0].options.body),input);
      assert.equal(calls[0].options.headers.Authorization,'Bearer '+API_KEY);
      assert.equal(calls[0].options.headers['Idempotency-Key'],'wai-vds-order-1-g0');
      assert.equal(calls[0].options.redirect,'error');assert(calls[0].options.signal instanceof AbortSignal);
      assert.equal(Object.hasOwn(JSON.parse(calls[0].options.body),'callbackUrl'),false);
    });
  }
});

test('bad requests fail before network: currencies, money, customer, callback override and unsafe returns',async()=>{
  let count=0;const c=client(async()=>{count++;throw Error('must not call');});
  const invalid=[{currency:'usd'},{provider:'cryptomus',currency:'USD'},{provider:'stripe',currency:'RUB'},
    {provider:'__proto__'},{amountMinor:NaN},{amountMinor:Infinity},{amountMinor:0},{amountMinor:-1},{amountMinor:12.01},{amountMinor:2147483648},
    {callbackUrl:'https://attacker.test/'},{customer:[]},{customer:{email:'not-an-email'}},
    {provider:'tbank',currency:'RUB',customer:{}},{providerAccountId:'x'.repeat(101)},
    {returnUrls:{success:'https://user:pass@example.test',failure:'https://pay.waiwai.is/vds/'}},
    {returnUrls:{success:'http://public.example.test',failure:'https://pay.waiwai.is/vds/'}}];
  for(const patch of invalid)await assert.rejects(()=>c.createPayment(intent(patch),'same-intent'),code('wai_pay_invalid_request'));
  for(const key of ['', 'bad\r\nkey','x'.repeat(256)])await assert.rejects(()=>c.createPayment(intent(),key),code('wai_pay_invalid_request'));
  for(const id of ['..','.','bad\nheader'])await assert.rejects(()=>c.getByExternal(id),code('wai_pay_invalid_request'));
  assert.equal(count,0);
});

test('only fixed wai-pay origin receives the app key; explicit TEST mode works with a wp_live key',async()=>{
  for(const bad of [undefined,{}, {apiKey:API_KEY,baseUrl:null},{apiKey:API_KEY,baseUrl:'https://pay.waiwai.is.evil.test'},
    {apiKey:API_KEY,baseUrl:'http://pay.waiwai.is'}, {apiKey:'sk_live_wrong'}, {apiKey:API_KEY,mode:'LIVE'}])
    assert.throws(()=>new WaiPayClient(bad),code('wai_pay_not_configured'));
  const c=client(async()=>Response.json({payment:payment(intent(),{mode:'test'})}),{mode:'test'});
  assert.equal((await c.createPayment(intent(),'test-intent')).mode,'test');
  const wrong=client(async()=>Response.json({payment:payment(intent(),{mode:'test'})}));
  await assert.rejects(()=>wrong.getPayment('cmfxtestpayment0001'),code('wai_pay_mode_mismatch'));
});

test('hosted checkout URLs accept actual provider hosts and reject lookalikes and credentials',()=>{
  for(const [provider,url] of [['stripe','https://checkout.stripe.com/c/pay/123'],['cryptomus','https://pay.cryptomus.com/pay/123'],
    ['tbank','https://pay.tbank-online.com/123'],['tbank','https://pay.tbank.ru/123']])assert(safeWaiPayCheckoutUrl(url,provider));
  for(const url of ['http://checkout.stripe.com/c/pay/1','https://checkout.stripe.com.evil.test/c/pay/1',
    'https://checkout.stripe.com@evil.test/c/pay/1','https://user:pass@checkout.stripe.com/c/pay/1',
    'https://checkout.stripe.com:444/c/pay/1','https://evil.test','javascript:alert(1)'])assert(!safeWaiPayCheckoutUrl(url,'stripe'));
  assert(!safeWaiPayCheckoutUrl('https://pay.cryptomus.com/1','stripe'));
});

test('timeout does not retry or start another invoice; same external ID recovers the existing payment',async()=>{
  const calls=[];const input=intent();const c=client(async(url,options)=>{
    calls.push({url,options});if(options.method==='POST')throw Error('connection closed after provider init');
    return Response.json({payment:payment(input)});
  });
  await assert.rejects(()=>c.createPayment(input,'persisted-idem'),e=>code('wai_pay_unknown_result')(e)&&!e.definitive);
  assert.equal(calls.length,1);
  const out=await c.getByExternal(input.externalPaymentId);
  assert.equal(out.id,'cmfxtestpayment0001');assert.equal(calls.length,2);
  assert.equal(calls[1].options.method,'GET');assert.match(calls[1].url,/\/by-external\/wai-vds-order-1-g0$/);
  assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
});

test('NOT_FOUND is the only absence result; malformed 404, throttling and transport errors cannot create a new attempt',async()=>{
  const absent=client(async()=>Response.json({error:{code:'NOT_FOUND',message:'Payment not found'}},{status:404}));
  assert.equal(await absent.getByExternal('external-id'),null);
  const variants=[
    [async()=>new Response('proxy failure',{status:404}),'wai_pay_unknown_response'],
    [async()=>Response.json({error:{code:'UNKNOWN'}},{status:404}),'wai_pay_http_404'],
    [async()=>Response.json({error:{code:'RATE_LIMIT_EXCEEDED'}},{status:429}),'wai_pay_rate_limit_exceeded'],
    [async()=>{throw Error('timeout');},'wai_pay_read_unavailable'],
    [async()=>Response.json({error:{code:'INTERNAL_ERROR'}},{status:500}),'wai_pay_internal_error'],
  ];
  for(const [fetcher,wanted] of variants)await assert.rejects(()=>client(fetcher).getByExternal('external-id'),code(wanted));
});

test('mismatched identities and invalid payment responses cannot be accepted as recovered state',async()=>{
  for(const patch of [{id:'different-id'},{provider:'__proto__'},{currency:'USDT'},{paidAmountMinor:-1},
    {refundedAmountMinor:1},{paymentVersion:0},{checkoutUrl:'https://attacker.test'},
    {status:'succeeded',paidAmountMinor:1200,paidAt:null}]) {
    await assert.rejects(()=>client(async()=>Response.json({payment:payment(intent(),patch)})).getPayment('cmfxtestpayment0001'),WaiPayError);
  }
  await assert.rejects(()=>client(async()=>Response.json({payment:payment()})).getByExternal('wrong-external'),code('wai_pay_payment_mismatch'));
});

test('sync queries the existing payment; unsupported Cryptomus cancellation never falls back to new checkout',async()=>{
  const calls=[];const c=client(async(url,options)=>{calls.push({url,options});
    return url.endsWith('/sync')?Response.json({payment:succeeded()}):Response.json({error:{code:'PROVIDER_CANCEL_UNSUPPORTED'}},{status:409});});
  assert.equal((await c.syncPayment('cmfxtestpayment0001')).status,'succeeded');
  await assert.rejects(()=>c.cancelPayment('cmfxtestpayment0001','cancel-idem'),e=>code('wai_pay_provider_cancel_unsupported')(e)&&e.definitive);
  assert.deepEqual(calls.map(c=>c.url),[WAI_PAY_BASE_URL+'/api/v2/payments/cmfxtestpayment0001/sync',WAI_PAY_BASE_URL+'/api/v2/payments/cmfxtestpayment0001/cancel']);
  assert(calls.every(c=>c.options.method==='POST'&&c.options.body===undefined));
  assert.equal(calls[0].options.headers['Idempotency-Key'],undefined);
  assert.equal(calls[1].options.headers['Idempotency-Key'],'cancel-idem');
});

test('provider error messages and arbitrary error codes never leak to caller',async()=>{
  const marker='secret_provider_token_or_email_do_not_echo';
  for(const status of [409,500]){
    const c=client(async()=>Response.json({error:{code:status===409?'IDEMPOTENCY_KEY_REUSED':marker,message:marker,details:{key:marker}}},{status}));
    await assert.rejects(()=>c.createPayment(intent(),'persisted-idem'),e=>{
      assert(!e.message.includes(marker));assert(!JSON.stringify(e).includes(marker));
      assert.equal(e.definitive,status===409);return true;
    });
  }
});

test('fulfillment binds local order, user, merchant, payment id, amount, currency and explicit mode',()=>{
  const p=succeeded();assert.equal(assertWaiPayPayment(p,expected({ ...intent() },{id:p.id}),{requireSucceeded:true}),p);
  for(const patch of [{id:'another-payment'},{externalPaymentId:'another-order'},{amountMinor:1201},{currency:'EUR'},
    {provider:'cryptomus',currency:'USDT'},{providerAccountId:'another-merchant'},{mode:'test'},
    {metadata:{user_id:'another-user'}},{metadata:{generation:1}}])
    assert.throws(()=>assertWaiPayPayment(p,expected(intent(),patch),{requireSucceeded:true}),code('wai_pay_payment_mismatch'));
  for(const p of [payment(),succeeded(intent(),{paidAmountMinor:1199}),succeeded(intent(),{refundedAmountMinor:1})])
    assert.throws(()=>assertWaiPayPayment(p,expected(),{requireSucceeded:true}),code('wai_pay_payment_not_settled'));
  assert.equal(assertWaiPayPayment(succeeded(intent(),{paidAmountMinor:1300}),expected(),{requireSucceeded:true}).status,'succeeded');
});

test('raw HMAC supports legitimate delayed/replayed events; event id stays stable across delivery ids',()=>{
  const e=event();e.data.payment.description='Сервер: 30 дней';
  const {raw,headers}=signed(e);assert.deepEqual(verifyWaiPayEvent(Buffer.from(raw),headers,SECRET),e);
  const replay={...headers,'x-waipay-delivery-id':'3f5b7e6e-e03c-44fb-929a-5ab32051c668'};
  assert.equal(verifyWaiPayEvent(raw,replay,SECRET).id,e.id);
  assert.deepEqual(verifyWaiPayEvent(raw,new Headers(headers),SECRET),e);
  assert.equal(verifyWaiPayEvent(JSON.stringify(e,null,2),headers,SECRET),null);
  assert.equal(verifyWaiPayEvent(raw+' ',headers,SECRET),null);
  assert.equal(verifyWaiPayEvent(raw,headers,SECRET+'wrong'),null);
  assert.equal(verifyWaiPayEvent('x'.repeat(1024*1024+1),headers,SECRET),null);
});

test('signed webhook rejects altered headers, mismatched versions/ids/states and malformed events',()=>{
  const {raw,headers}=signed(event());
  for(const patch of [{'x-waipay-signature':'sha256=00'},{'x-waipay-event-id':'other-event'},
    {'x-waipay-version':'1'},{'x-waipay-delivery-id':''},{'x-waipay-signature':[headers['x-waipay-signature']]},
    {'X-WaiPay-Signature':headers['x-waipay-signature']}])assert.equal(verifyWaiPayEvent(raw,{...headers,...patch},SECRET),null);
  for(const e of [event({apiVersion:1}),event({paymentVersion:3}),event({type:'payment.created'}),event({type:'payment.failed'}),
    event({occurredAt:'not a date'}),event({data:{payment:{...succeeded(),provider:'__proto__'}}}),event({data:{payment:null}})]){
    const s=signed(e);assert.equal(verifyWaiPayEvent(s.raw,s.headers,SECRET),null);
  }
});

test('actual refund envelope retains succeeded payment; refund identity and currency must match',()=>{
  const e=event({type:'refund.created',data:{payment:succeeded(),refund:{id:'cmfxrefund0001',paymentId:'cmfxtestpayment0001',
    amountMinor:100,currency:'USD',status:'pending',providerRefundId:null,providerStatus:null}}});
  let s=signed(e);assert.deepEqual(verifyWaiPayEvent(s.raw,s.headers,SECRET),e);
  for(const patch of [{paymentId:'another-payment'},{currency:'EUR'},{status:'succeeded'},{amountMinor:0}]){
    const bad={...e,data:{...e.data,refund:{...e.data.refund,...patch}}};s=signed(bad);assert.equal(verifyWaiPayEvent(s.raw,s.headers,SECRET),null);
  }
});
