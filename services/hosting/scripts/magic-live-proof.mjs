// Explicit opt-in. Only Resend's documented simulated recipients are used.
// No order, checkout, provider VM or financial endpoint is called.
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';

if(process.argv[2]!=='--run-free-proof')throw Error('Explicit free proof argument required');
const origin=process.env.WAI_ORIGIN,key=process.env.WAI_RESEND_API_KEY;
if(origin!=='https://server.waiwai.is'||!key||process.env.WAI_MAGIC_LINK_ENABLED!=='1')throw Error('Expected documented production mail deployment');
const db=new DatabaseSync(join(process.env.WAI_DATA,'wai.sqlite'),{readOnly:true});
const check=(ok,name)=>{if(!ok)throw Error(name);};
const counts=()=>Object.fromEntries(['orders','servers','wai_pay_attempts','os_orders'].map(n=>[n,db.prepare('SELECT count(*) n FROM '+n).get().n]));
const before=counts(),proofs=[];
for(const native of [false,true]) {
  const cookies=new Map(),email='delivered+wai-'+(native?'native-':'web-')+randomUUID()+'@resend.dev';
  const call=async(path,body,extras={})=>{
    const r=await fetch(origin+path,{method:body?'POST':'GET',redirect:'error',headers:{...(body?{Origin:origin,'Content-Type':'application/json'}:{}),Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...extras},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
    for(const value of r.headers.getSetCookie()){const [name,...parts]=value.split(';')[0].split('=');if(parts.join('='))cookies.set(name,parts.join('='));else cookies.delete(name);}
    return r;
  };
  const verifier='v'+randomUUID().replaceAll('-','')+randomUUID().replaceAll('-',''),state=randomUUID(),callback='openstrudel://oauth/wai-vds';
  if(native){const params=new URLSearchParams({client_id:'openstrudel',response_type:'code',redirect_uri:callback,state,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')});check((await call('/oauth/authorize?'+params)).status===200,'authorize_status');}
  const options=await (await call('/api/v1/auth/options')).json();check(options.magic_link===true,'mail_not_enabled');
  const requested=await call(native?'/oauth/magic-link/request':'/api/v1/auth/magic-link/request',{email,context:native?'oauth':'login'});check(requested.status===202,'mail_request_status');
  check(cookies.has('__Host-wai_magic'),'host_cookie_missing');
  const sent=db.prepare('SELECT provider_id FROM magic_links WHERE email=?').get(email);check(!!sent?.provider_id,'missing_email_id');
  const readMail=async()=>{
    const r=await fetch('https://api.resend.com/emails/'+sent.provider_id,{headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(15000)});check(r.ok,'resend_read_status');return r.json();
  };
  let delivery=await readMail();
  for(let attempt=0;attempt<3&&delivery.last_event!=='delivered';attempt++){await new Promise(r=>setTimeout(r,3000));delivery=await readMail();}
  const url=String(delivery.text||'').match(/^https:\/\/server\.waiwai\.is\/auth\/email#[a-f0-9-]{36}\.[a-f0-9]{64}$/m)?.[0];check(!!url,'missing_exact_email_link');
  const raw=new URL(url).hash.slice(1);
  check((await call('/auth/email')).status===200,'landing_status');
  const otherBrowser=await fetch(origin+'/oauth/magic-link/consume',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token:raw}),signal:AbortSignal.timeout(15000)});check(otherBrowser.status===409,'browser_binding');
  const inspected=await call('/oauth/magic-link/inspect',{token:raw});check(inspected.status===200,'inspection_status');
  const consumed=await call('/oauth/magic-link/consume',{token:raw});check(consumed.status===200,'consume_status');const result=await consumed.json();check(!result.token,'session_token_in_json');
  check((await call('/oauth/magic-link/consume',{token:raw})).status===400,'replay_not_rejected');
  let nativeChecked=false;
  if(native){
    const returned=new URL(result.redirect_uri);check(returned.protocol==='openstrudel:'&&returned.hostname==='oauth'&&returned.pathname==='/wai-vds'&&returned.searchParams.get('state')===state&&returned.searchParams.get('iss')===origin,'native_callback');
    const body={grant_type:'authorization_code',client_id:'openstrudel',code:returned.searchParams.get('code'),redirect_uri:callback,code_verifier:'z'.repeat(43)};
    check((await call('/oauth/token',body)).status===400,'bad_pkce_accepted');body.code_verifier=verifier;
    const tokenResponse=await call('/oauth/token',body);check(tokenResponse.status===200,'token_exchange');const credentials=await tokenResponse.json();
    check((await call('/oauth/revoke',{}, {Authorization:'Bearer '+credentials.access_token})).status===200,'native_revoke');nativeChecked=true;
  }else check(result.redirect_uri===origin+'/?view=servers','web_return');
  const meResponse=await call('/api/v1/me');check(meResponse.status===200,'owner_session');const me=await meResponse.json();check(me.user.email===email&&me.orders.length===0&&me.servers.length===0,'unexpected_owner_data');
  check((await call('/api/v1/auth/logout',{}, {'X-CSRF-Token':me.csrf})).status===200,'logout');
  check((await call('/api/v1/me')).status===401,'logged_out_session');
  proofs.push({flow:native?'openstrudel':'web',resend_email_id:sent.provider_id,recipient:'Resend simulated delivered address',last_event:delivery.last_event,scanner_safe:true,browser_bound:true,replay_rejected:true,pkce_verified:nativeChecked,session_logged_out:true});
}
check(JSON.stringify(before)===JSON.stringify(counts()),'business_side_effects');db.close();
console.log(JSON.stringify({ok:true,checked_at:new Date().toISOString(),kind:'live_resend_simulated_delivery_and_real_auth',human_inbox_tested:false,new_invoices:0,new_vms:0,new_charges:0,proofs}));
