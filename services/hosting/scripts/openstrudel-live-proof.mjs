// Explicit free proof: synthetic owner login only. Never creates a quote,
// invoice, VM or crypto transfer. Tokens/passwords remain in memory and grants
// and browser sessions are revoked before exit. Do not log response bodies.
import {randomUUID,randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {pkceChallenge,NATIVE_CALLBACK} from '../src/openstrudel-auth.mjs';
if(process.argv[2]!=='--run-free-production-proof')throw Error('Explicit free proof flag required');
const origin='https://server.waiwai.is',checks=[];
async function call(path,{method='GET',body,headers={}}={}) {
  const r=await fetch(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(12000),headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=r.headers.get('content-type')?.includes('application/json')?await r.json():await r.text();return {status:r.status,data,cookies:r.headers.getSetCookie().map(x=>x.split(';')[0])};
}
function check(name,condition){if(!condition)throw Error('free_proof_failed:'+name);checks.push(name);}
let ownerCookie,csrf,access;
try {
  const catalog=await call('/api/v2/openstrudel/catalog');check('home_sales_closed',catalog.status===200&&catalog.data.purchase_enabled===false&&catalog.data.platforms.ios.purchase_enabled===false);
  const verifier=randomBytes(32).toString('base64url'),state=randomUUID(),q=new URLSearchParams({client_id:'openstrudel',response_type:'code',redirect_uri:NATIVE_CALLBACK,state,code_challenge_method:'S256',code_challenge:pkceChallenge(verifier)});
  const authorization=await call('/oauth/authorize?'+q);check('branded_authorization',authorization.status===200&&authorization.data.includes('Ваша команда.'));
  const account=await call('/api/v1/auth/register',{method:'POST',headers:{Origin:origin},body:{email:'native-proof-'+randomUUID()+'@example.invalid',password:randomBytes(32).toString('hex')}});
  check('synthetic_owner_created',account.status===200&&!!account.data.csrf);ownerCookie=account.cookies.join('; ');csrf=account.data.csrf;
  const cookies=authorization.cookies.concat(account.cookies).join('; '),request=await call('/oauth/request',{headers:{Cookie:cookies}});
  check('owner_confirmed_once',request.status===200&&!request.data.requires_login);
  const completed=await call('/oauth/complete',{method:'POST',headers:{Cookie:cookies,Origin:origin,'X-CSRF-Token':csrf},body:{request_id:request.data.request_id,approved:true}});
  check('authorization_completed',completed.status===200);const u=new URL(completed.data.redirect_uri);
  check('exact_callback_state_issuer',u.origin==='null'&&u.protocol==='openstrudel:'&&u.hostname==='oauth'&&u.pathname==='/wai-vds'&&u.searchParams.get('state')===state&&u.searchParams.get('iss')===origin);
  const tokenBody={client_id:'openstrudel',grant_type:'authorization_code',redirect_uri:NATIVE_CALLBACK,code:u.searchParams.get('code'),code_verifier:verifier};
  const wrong=await call('/oauth/token',{method:'POST',body:{...tokenBody,code_verifier:'B'.repeat(43)}});check('wrong_pkce_rejected',wrong.status===400&&wrong.data.error==='invalid_grant');
  const exchanged=await call('/oauth/token',{method:'POST',body:tokenBody});check('pkce_exchange',exchanged.status===200&&exchanged.data.expires_in===900);access=exchanged.data.access_token;
  const auth={Authorization:'Bearer '+access},orders=await call('/api/v2/openstrudel/orders',{headers:auth});check('only_synthetic_owners_orders',orders.status===200&&orders.data.orders.length===0);
  const missing=await call('/api/v2/openstrudel/orders/'+randomUUID(),{headers:auth});check('unknown_order_not_exposed',missing.status===404);
  const foreignOrigin=await call('/api/v2/openstrudel/orders',{headers:{...auth,Origin:'https://unregistered.example.invalid'}});check('unregistered_web_origin_rejected',foreignOrigin.status===403);
  const ios=await call('/api/v2/openstrudel/quotes',{method:'POST',headers:auth,body:{profile_id:'openstrudel-home-v1',platform:'ios',payment_method:'card'}});check('ios_purchase_rejected',ios.status===403&&ios.data.code==='platform_purchase_unavailable');
  const quote=await call('/api/v2/openstrudel/quotes',{method:'POST',headers:auth,body:{profile_id:'openstrudel-home-v1',platform:'mac',payment_method:'card'}});check('mac_home_purchase_stays_closed',quote.status===503&&quote.data.code==='home_purchase_unavailable');
  const replay=await call('/oauth/token',{method:'POST',body:tokenBody});check('code_replay_rejected',replay.status===400&&replay.data.error==='authorization_code_reused');
  const revoked=await call('/api/v2/openstrudel/orders',{headers:auth});check('replay_revokes_grant',revoked.status===401);access=null;
  const result={checked_at:new Date().toISOString(),origin,kind:'free_live_api',checks,new_vms:0,new_invoices:0,real_charges:0,crypto_transfers:0,synthetic_owners:1,credentials_saved:false,foreign_owner_order_test:'covered by emulation; live proof used nonexistent UUID only',home_infrastructure_tested:false};
  writeFileSync('outputs/openstrudel-live-proof.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
} finally {
  if(access)await call('/oauth/revoke',{method:'POST',headers:{Authorization:'Bearer '+access},body:{}});
  if(ownerCookie) {const r=await call('/api/v1/auth/logout',{method:'POST',headers:{Cookie:ownerCookie,Origin:origin,'X-CSRF-Token':csrf},body:{}});if(r.status!==200)throw Error('Synthetic session cleanup failed');}
}
