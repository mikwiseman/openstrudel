import { createHmac, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

// Verified against wai-pay a22c979 and read-only production checks, 2026-10-04.
// The application must persist the request/key before createPayment, deduplicate
// envelope.id transactionally and only provision after assertWaiPayPayment.
export const WAI_PAY_BASE_URL='https://pay.waiwai.is';
export const WAI_PAY_CURRENCIES=Object.freeze({stripe:Object.freeze(['USD','EUR']),tbank:Object.freeze(['RUB']),cryptomus:Object.freeze(['USDT'])});
const STATUSES=['pending','processing','succeeded','failed','canceled','expired'];
const HOSTS={
  stripe:['checkout.stripe.com'],
  cryptomus:['pay.cryptomus.com'],
  tbank:['pay.tbank.ru','pay.tbank-online.com','securepay.tinkoff.ru','securepay.tbank.ru','rest-api-test.tinkoff.ru'],
};
const ERROR_CODES=new Set(['FORBIDDEN','UNAUTHORIZED','NOT_FOUND','VALIDATION_ERROR','MODE_MISMATCH','CONFLICT','RATE_LIMIT_EXCEEDED',
  'IDEMPOTENCY_KEY_REUSED','EXTERNAL_PAYMENT_ID_CONFLICT','PAYMENT_NOT_CANCELABLE','PROVIDER_CANCEL_UNSUPPORTED',
  'PROVIDER_ERROR','PAYMENT_NOT_REFUNDABLE','REFUND_AMOUNT_EXCEEDED','PROVIDER_ACCOUNT_MISMATCH',
  'NO_DEFAULT_PROVIDER_ACCOUNT','CURRENCY_NOT_SUPPORTED','INACTIVE_APP','INACTIVE_PROVIDER_ACCOUNT','DUPLICATE_ORDER',
  'IDEMPOTENCY_KEY_REQUIRED','PROVIDER_REFUND_UNSUPPORTED','TINKOFF_V2_TERMINAL_INVALID','FISCAL_SETTINGS_REQUIRED',
  'WEBHOOK_VERIFICATION_FAILED','INTERNAL_ERROR']);

export class WaiPayError extends Error {
  constructor(code,{status,definitive=false}={}) {super(code);this.name='WaiPayError';this.code=code;this.status=status;this.definitive=definitive;}
}
const invalid=()=>{throw new WaiPayError('wai_pay_invalid_request',{definitive:true});};
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=200&&value!=='.'&&value!=='..'&&!/[\x00-\x1f\x7f]/.test(value);
const money=value=>Number.isSafeInteger(value)&&value>=0&&value<=2147483647;
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const currency=(provider,value)=>typeof provider==='string'&&Object.hasOwn(WAI_PAY_CURRENCIES,provider)&&WAI_PAY_CURRENCIES[provider].includes(value);

export function safeWaiPayCheckoutUrl(value,provider) {
  try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&HOSTS[provider]?.includes(u.hostname)===true;}
  catch {return false;}
}

function validatePayment(p) {
  if(!p||typeof p!=='object'||!identifier(p.id)||!identifier(p.externalPaymentId)||!identifier(p.providerAccountId)||
      !currency(p.provider,p.currency)||!STATUSES.includes(p.status)||
      !['live','test'].includes(p.mode)||!money(p.requestedAmountMinor)||p.requestedAmountMinor===0||
      !money(p.paidAmountMinor)||!money(p.refundedAmountMinor)||p.refundedAmountMinor>p.paidAmountMinor||
      !Number.isSafeInteger(p.paymentVersion)||p.paymentVersion<1||
      p.checkoutUrl!==null&&!safeWaiPayCheckoutUrl(p.checkoutUrl,p.provider)||
      p.status==='succeeded'&&!date(p.paidAt))throw new WaiPayError('wai_pay_invalid_payment');
  return p;
}

/** Bind both API snapshots and signed events to the persisted local payment attempt. */
export function assertWaiPayPayment(payment,expected,{requireSucceeded=false}={}) {
  const p=validatePayment(payment);
  if(!expected||!money(expected.amountMinor)||expected.amountMinor===0||!identifier(expected.externalPaymentId)||
      !currency(expected.provider,expected.currency)||!identifier(expected.providerAccountId)||
      !['live','test'].includes(expected.mode))invalid();
  if(p.externalPaymentId!==expected.externalPaymentId||p.requestedAmountMinor!==expected.amountMinor||
      p.currency!==expected.currency||p.provider!==expected.provider||p.providerAccountId!==expected.providerAccountId||
      p.mode!==expected.mode||expected.id!==undefined&&p.id!==expected.id)
    throw new WaiPayError('wai_pay_payment_mismatch');
  for(const [key,value] of Object.entries(expected.metadata||{})) {
    if(!p.metadata||!Object.hasOwn(p.metadata,key)||!isDeepStrictEqual(p.metadata[key],value))
      throw new WaiPayError('wai_pay_payment_mismatch');
  }
  if(requireSucceeded&&(p.status!=='succeeded'||p.paidAmountMinor-p.refundedAmountMinor<expected.amountMinor))
    throw new WaiPayError('wai_pay_payment_not_settled');
  return p;
}

function header(headers,name) {
  if(typeof headers?.get==='function')return headers.get(name);
  const keys=Object.keys(headers||{}).filter(k=>k.toLowerCase()===name.toLowerCase());
  return keys.length===1&&typeof headers[keys[0]]==='string'?headers[keys[0]]:null;
}

/**
 * Returns a verified v2 envelope or null. Delivery timestamps are not freshness
 * tokens: wai-pay retries for 30 days and supports later manual replay. Persist
 * envelope.id, not Delivery-Id, for replay protection. No fulfilment happens here.
 */
export function verifyWaiPayEvent(raw,headers,secret) {
  if(!['string','object'].includes(typeof raw)||typeof secret!=='string'||secret.length<32||
      !(typeof raw==='string'||Buffer.isBuffer(raw)))return null;
  const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw);
  if(bytes.length>1024*1024)return null;
  const signature=header(headers,'X-WaiPay-Signature');
  if(typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/.test(signature)||header(headers,'X-WaiPay-Version')!=='2')return null;
  const expected=createHmac('sha256',secret).update(bytes).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex')))return null;
  try {
    const event=JSON.parse(bytes.toString('utf8'));
    if(event.apiVersion!==2||!identifier(event.id)||header(headers,'X-WaiPay-Event-Id')!==event.id||
        !identifier(header(headers,'X-WaiPay-Delivery-Id'))||!date(event.occurredAt)||
        !Number.isSafeInteger(event.paymentVersion)||event.paymentVersion<1)return null;
    const payment=validatePayment(event.data?.payment);
    if(payment.paymentVersion!==event.paymentVersion)return null;
    const states={'payment.succeeded':'succeeded','payment.failed':'failed','payment.canceled':'canceled','payment.expired':'expired'};
    if(Object.hasOwn(states,event.type))return payment.status===states[event.type]?event:null;
    const refundStates={'refund.created':'pending','refund.succeeded':'succeeded','refund.failed':'failed'};
    const refund=event.data?.refund;
    if(!Object.hasOwn(refundStates,event.type)||payment.status!=='succeeded'||!refund||
        !identifier(refund.id)||refund.paymentId!==payment.id||refund.currency!==payment.currency||
        refund.status!==refundStates[event.type]||!money(refund.amountMinor)||refund.amountMinor===0)return null;
    return event;
  } catch {return null;}
}

export class WaiPayClient {
  constructor({apiKey,mode='live',baseUrl=WAI_PAY_BASE_URL}={},{fetcher=fetch,timeout=20000}={}) {
    // TEST and LIVE both use wp_live_ keys in the current wai-pay auth middleware;
    // trust the explicit app/payment mode, never infer it from the key prefix.
    if(typeof apiKey!=='string'||!/^wp_live_[A-Za-z0-9_-]{16,}$/.test(apiKey)||!['live','test'].includes(mode)||
        typeof baseUrl!=='string'||baseUrl.replace(/\/$/,'')!==WAI_PAY_BASE_URL||typeof fetcher!=='function'||
        !Number.isSafeInteger(timeout)||timeout<1||timeout>60000)throw new WaiPayError('wai_pay_not_configured',{definitive:true});
    this.apiKey=apiKey;this.mode=mode;this.fetcher=fetcher;this.timeout=timeout;
  }
  async request(method,path,{body,idempotencyKey}={}) {
    const options={method,redirect:'error',signal:AbortSignal.timeout(this.timeout),
      headers:{Authorization:'Bearer '+this.apiKey,'Content-Type':'application/json',
        ...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},
      ...(body!==undefined?{body:JSON.stringify(body)}:{})};
    let response;
    try {response=await this.fetcher(WAI_PAY_BASE_URL+'/api/v2/payments'+path,options);}
    catch {throw new WaiPayError(method==='GET'?'wai_pay_read_unavailable':'wai_pay_unknown_result');}
    let result;try {result=await response.json();}catch {throw new WaiPayError('wai_pay_unknown_response',{status:response.status});}
    if(!response.ok) {
      const code=ERROR_CODES.has(result?.error?.code)?'wai_pay_'+result.error.code.toLowerCase():'wai_pay_http_'+response.status;
      throw new WaiPayError(code,{status:response.status,definitive:[400,401,403,404,409,422].includes(response.status)});
    }
    const payment=validatePayment(result?.payment);
    if(payment.mode!==this.mode)throw new WaiPayError('wai_pay_mode_mismatch');
    return payment;
  }
  async createPayment(input,idempotencyKey) {
    if(typeof idempotencyKey!=='string'||idempotencyKey.length<1||idempotencyKey.length>255||/[\r\n]/.test(idempotencyKey)||
        !identifier(input?.externalPaymentId)||!money(input.amountMinor)||input.amountMinor===0||
        !currency(input.provider,input.currency)||!identifier(input.providerAccountId)||input.providerAccountId.length>100||
        typeof input.description!=='string'||input.description.length<1||input.description.length>500||
        !input.customer||typeof input.customer!=='object'||Array.isArray(input.customer)||Object.hasOwn(input,'callbackUrl'))invalid();
    if(input.customer.email!==undefined&&(typeof input.customer.email!=='string'||input.customer.email.length>200||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.customer.email)))invalid();
    if(input.provider==='tbank'&&!input.customer.email)invalid();
    for(const value of [input.returnUrls?.success,input.returnUrls?.failure]) {
      let u;try {u=new URL(value);}catch {invalid();}
      if(u.username||u.password||!(u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))invalid();
    }
    // Persist this exact input and key first. After a timeout, reconcile by the
    // SAME external ID. Never invent a new payment attempt automatically.
    const payment=await this.request('POST','',{body:input,idempotencyKey});
    return assertWaiPayPayment(payment,{...input,mode:this.mode});
  }
  async getPayment(id) {
    if(!identifier(id))invalid();
    const payment=await this.request('GET','/'+encodeURIComponent(id));
    if(payment.id!==id)throw new WaiPayError('wai_pay_payment_mismatch');return payment;
  }
  async getByExternal(externalPaymentId) {
    if(!identifier(externalPaymentId))invalid();
    try {
      const payment=await this.request('GET','/by-external/'+encodeURIComponent(externalPaymentId));
      if(payment.externalPaymentId!==externalPaymentId)throw new WaiPayError('wai_pay_payment_mismatch');return payment;
    } catch(error) {if(error instanceof WaiPayError&&error.status===404&&error.code==='wai_pay_not_found')return null;throw error;}
  }
  async syncPayment(id) {
    if(!identifier(id))invalid();
    // This endpoint reads the upstream provider and updates wai-pay's status;
    // it cannot charge a card, create another invoice, or issue a refund.
    const payment=await this.request('POST','/'+encodeURIComponent(id)+'/sync');
    if(payment.id!==id)throw new WaiPayError('wai_pay_payment_mismatch');return payment;
  }
  async cancelPayment(id,idempotencyKey) {
    if(!identifier(id)||typeof idempotencyKey!=='string'||!idempotencyKey||idempotencyKey.length>255||/[\r\n]/.test(idempotencyKey))invalid();
    // Cryptomus returns PROVIDER_CANCEL_UNSUPPORTED; keep its invoice locked
    // until a verified success/expiry rather than silently replacing it.
    const payment=await this.request('POST','/'+encodeURIComponent(id)+'/cancel',{idempotencyKey});
    if(payment.id!==id)throw new WaiPayError('wai_pay_payment_mismatch');return payment;
  }
}
