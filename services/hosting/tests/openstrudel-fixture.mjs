import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,generateKeyPairSync,createHmac} from 'node:crypto';
import {Service,config} from '../src/service.mjs';
import {pkceChallenge,NATIVE_CALLBACK} from '../src/openstrudel-auth.mjs';
import {HOME_PROFILE,PAYMENT_CALLBACK} from '../src/openstrudel.mjs';
import {hash} from '../src/security.mjs';

export function cloudFixture(t,options={}) {
  const dir=mkdtempSync(join(tmpdir(),'wai-cloud-'));let now=Date.now(),timeout=false,readsFail=false;
  const invoices=new Map(),calls=[];
  const fetcher=async(url,init)=>{
    const path=new URL(url).pathname.slice('/api/v2/payments'.length);calls.push({path,method:init.method,body:init.body});let p;
    if(readsFail&&!(path===''&&init.method==='POST'))throw Error('offline');
    if(path===''&&init.method==='POST') {
      const body=JSON.parse(init.body);p=[...invoices.values()].find(x=>x.externalPaymentId===body.externalPaymentId);
      if(!p){p={...body,id:randomUUID(),status:'pending',mode:'test',requestedAmountMinor:body.amountMinor,paidAmountMinor:0,refundedAmountMinor:0,paymentVersion:1,paidAt:null,expiresAt:new Date(now+1800000).toISOString(),checkoutUrl:body.provider==='stripe'?'https://checkout.stripe.com/c/pay/cs_cloud_fixture':'https://pay.cryptomus.com/pay/cloud-fixture'};invoices.set(p.id,p);}
      if(timeout){timeout=false;throw Error('lost create response');}
    } else if(path.startsWith('/by-external/'))p=[...invoices.values()].find(x=>x.externalPaymentId===decodeURIComponent(path.slice('/by-external/'.length)));
    else p=invoices.get(path.split('/')[1]);
    return new Response(JSON.stringify(p?{payment:p}:{error:{code:'NOT_FOUND'}}),{status:p?200:404});
  };
  const s=new Service(config({WAI_DATA:dir,WAI_HOME_AMOUNT_MINOR:'2400',WAI_PAYMENTS:'wai_pay',WAI_PAY_MODE:'test',WAI_PAY_API_KEY:'wp_live_'+'fixture'.repeat(8),WAI_PAY_WEBHOOK_SECRET:'h'.repeat(64),WAI_PAY_CARD_ENABLED:'1',WAI_PAY_CRYPTO_ENABLED:'1',WAI_PAY_STRIPE_ACCOUNT_ID:'stripe-test',WAI_PAY_CRYPTO_ACCOUNT_ID:'crypto-test',...options}),{now:()=>now,fetcher});
  const password='test owner has a long password';
  const owner=s.register('owner@example.test',password,'owner'),other=s.register('other@example.test',password,'other');
  const grant=(account=owner)=>{
    const verifier='A'.repeat(43),r=s.cloud.auth.begin({client_id:'openstrudel',redirect_uri:NATIVE_CALLBACK,response_type:'code',code_challenge:pkceChallenge(verifier),code_challenge_method:'S256',state:randomUUID()},'auth-ip');
    const code=new URL(s.cloud.auth.complete(r.id,r.nonce,s.auth(account.token)).redirect_uri).searchParams.get('code');
    const credentials=s.cloud.auth.exchange({client_id:'openstrudel',grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:NATIVE_CALLBACK},'token-ip');
    return {...credentials,session:s.cloud.auth.authenticate(credentials.access_token)};
  };
  const a=grant(),b=grant(other);
  const bootstrap=()=>({installationId:randomUUID(),privateKeyPEM:String(generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'})),ownerTokenHash:hash('owner-token-retained-on-device-'+randomUUID())});
  const make=(session=a.session,overrides={})=>{
    const quote=s.cloud.quote(session,{profile_id:HOME_PROFILE,platform:'mac',payment_method:'card',...overrides});
    const input={quote_id:quote.quote_id,quote_digest:quote.quote_digest,idempotency_key:randomUUID(),consent:true,return_uri:PAYMENT_CALLBACK,return_state:randomUUID(),...(quote.kind==='initial'?{bootstrap:bootstrap()}:{})};
    return {quote,input,order:s.cloud.order(session,input)};
  };
  const event=async(p,type='payment.succeeded')=>{
    const e={id:randomUUID(),apiVersion:2,occurredAt:new Date(now).toISOString(),paymentVersion:p.paymentVersion,type,data:{payment:structuredClone(p)}};
    if(type.startsWith('refund.'))e.data.refund={id:randomUUID(),paymentId:p.id,currency:p.currency,status:'succeeded',amountMinor:p.refundedAmountMinor};
    const raw=JSON.stringify(e),headers={'X-WaiPay-Version':'2','X-WaiPay-Event-Id':e.id,'X-WaiPay-Delivery-Id':randomUUID(),'X-WaiPay-Signature':'sha256='+createHmac('sha256',s.c.waiPayWebhook).update(raw).digest('hex')};
    await s.payments.real.webhook(raw,headers);return {raw,headers};
  };
  const pay=async(p=[...invoices.values()].at(-1))=>{Object.assign(p,{status:'succeeded',paidAt:new Date(now).toISOString(),paidAmountMinor:p.requestedAmountMinor,paymentVersion:p.paymentVersion+1});return event(p);};
  const advance=ms=>now+=ms;
  const ready=async(order)=>{await s.cloud.checkout(a.session,order.order_id);await pay();for(let i=0;i<5;i++){advance(10);await s.tick();}return s.cloud.status(a.session,order.order_id);};
  t.after(()=>{s.db.close();rmSync(dir,{recursive:true,force:true});});
  return {s,dir,owner,other,password,a,b,grant,bootstrap,make,pay,event,advance,ready,invoices,calls,timeout:()=>timeout=true,failReads:v=>readsFail=v};
}
