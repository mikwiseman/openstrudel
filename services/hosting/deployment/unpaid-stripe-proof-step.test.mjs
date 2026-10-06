import test from 'node:test';
import assert from 'node:assert/strict';
import { unpaidStripeStep } from './unpaid-stripe-proof-step.mjs';
const input={orderId:'a7f963e1-e0ff-4950-b8fe-16e7c7647489',userId:'b7f963e1-e0ff-4950-b8fe-16e7c7647489',paymentId:'cmockpayment'};
input.externalId='wai-vds-'+input.orderId+'-g0';
function fixture(){
  const payment={id:input.paymentId,appId:'wai-vds',providerAccountId:'stripe-vds',provider:'STRIPE',mode:'LIVE',apiVersion:2,
    externalOrderId:input.externalId,requestedAmount:1200,currency:'USD',paidAmount:0,refundedAmount:0,paidAt:null,
    metadata:{wai_order_id:input.orderId,wai_user_id:input.userId},providerPaymentId:'cs_live_onlythisproof',status:'PENDING'};
  const session={id:payment.providerPaymentId,livemode:true,mode:'payment',client_reference_id:payment.id,metadata:{waiPayPaymentId:payment.id},
    amount_total:1200,currency:'usd',payment_status:'unpaid',status:'open'};
  const calls=[],logs=[],events=[];
  const prisma={payment:{findUnique:async()=>payment},providerAccount:{findUnique:async()=>({id:'stripe-vds',isActive:true,mode:'LIVE',provider:'STRIPE',envPrefix:'STRIPE_WAI_VDS'})},
    webhookLog:{findMany:async()=>logs},clientEvent:{findMany:async()=>events}};
  const fetcher=async(url,options)=>{calls.push([url,options]);assert.equal(options.redirect,'error');
    assert.ok(url==='https://api.stripe.com/v1/checkout/sessions/'+payment.providerPaymentId||url==='https://api.stripe.com/v1/checkout/sessions/'+payment.providerPaymentId+'/expire');
    if(options.method==='POST'){assert.ok(url.endsWith('/expire'));assert.equal(options.headers['Idempotency-Key'],'wai-vds-unpaid-expire-'+input.orderId);session.status='expired';}
    return{ok:true,status:200,json:async()=>({...session})};};
  return {payment,session,calls,logs,events,prisma,fetcher,env:{STRIPE_WAI_VDS_SECRET_KEY:'sk_live_mockonly'}};
}
test('expires only the exact own unpaid session; no charge endpoints or fake callbacks',async()=>{
  const f=fixture(),r=await unpaidStripeStep('expire',input,f);
  assert.equal(r.stripe.sessionStatus,'expired');assert.equal(r.chargesPerformed,0);assert.equal(r.fakePaymentCallbacksSent,0);
  assert.equal(f.calls.filter(c=>c[1].method==='POST').length,1);
});
test('already expired session is read without another write',async()=>{
  const f=fixture();f.session.status='expired';await unpaidStripeStep('expire',input,f);
  assert.equal(f.calls.filter(c=>c[1].method==='POST').length,0);
});
test('foreign provider account or altered order metadata fails before network',async()=>{
  for(const mutate of [f=>f.payment.providerAccountId='stripe-main',f=>f.payment.metadata.wai_order_id='foreign']){
    const f=fixture();mutate(f);await assert.rejects(unpaidStripeStep('expire',input,f),e=>e.safeCode==='payment_binding_or_unpaid_guard');assert.equal(f.calls.length,0);
  }
});
test('paid Stripe session and amount mismatch never receive expiry or refund requests',async()=>{
  for(const mutate of [f=>f.session.payment_status='paid',f=>f.session.amount_total=2400]){
    const f=fixture();mutate(f);await assert.rejects(unpaidStripeStep('expire',input,f),e=>e.safeCode==='stripe_session_binding_or_unpaid_guard');
    assert.equal(f.calls.filter(c=>c[1].method==='POST').length,0);
  }
});
test('inspection is read-only and retains only matching actual expiry event evidence',async()=>{
  const f=fixture();f.session.status='expired';
  f.logs.push({id:'log1',createdAt:new Date(),rawPayload:{id:'evt_actual',type:'checkout.session.expired',data:{object:{id:f.payment.providerPaymentId}}}},
    {id:'foreignlog',rawPayload:{id:'evt_foreign',type:'checkout.session.expired',data:{object:{id:'cs_live_foreign'}}}});
  f.events.push({id:'clientevent1',type:'payment.expired',paymentVersion:2,deliveries:[{status:'delivered',statusCode:200,callbackUrl:'https://pay.waiwai.is/vds/api/v1/webhooks/wai-pay'}]});
  const r=await unpaidStripeStep('inspect',input,f);
  assert.deepEqual(r.verifiedStripeExpiryEvents.map(e=>e.eventId),['evt_actual']);assert.equal(r.clientEvents[0].deliveredToOwnApp,true);
  assert.equal(f.calls.filter(c=>c[1].method==='POST').length,0);
});
