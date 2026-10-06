import {readFileSync} from 'node:fs';
import {safeEqual} from './security.mjs';
import {clientIP} from './client-ip.mjs';
import {openstrudelOpenAPI} from './openstrudel-openapi.mjs';

const asset=name=>readFileSync(new URL('../public/'+name,import.meta.url));
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cookie=(req,name)=>String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);
function input(raw,req,s) {
  if(!raw)return {};
  if(req.headers['content-type']?.split(';')[0]==='application/x-www-form-urlencoded') {
    const p=new URLSearchParams(raw);if([...p.keys()].some(k=>p.getAll(k).length!==1))throw s.cloud.error(400,'duplicate_parameter');return Object.fromEntries(p);
  }
  try{const v=JSON.parse(raw);if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v;}catch{throw s.cloud.error(400,'invalid_json');}
}
export async function openstrudelHTTP(s,req,res,u,raw,json) {
  const path=u.pathname,method=req.method,c=s.cloud;
  if(!path.startsWith('/oauth/')&&!path.startsWith('/openstrudel/')&&!path.startsWith('/api/v2/openstrudel/')&&path!=='/.well-known/oauth-authorization-server')return false;
  if([...u.searchParams.keys()].some(k=>u.searchParams.getAll(k).length!==1))throw c.error(400,'duplicate_parameter');
  const ip=clientIP(req,s.c.trustedProxies),origin=new URL(s.c.origin).origin;
  const webOrigins=(s.c.openstrudelRedirects||[]).filter(v=>v.startsWith('https:')).map(v=>new URL(v).origin);
  const nativeAPI=path.startsWith('/api/v2/openstrudel/')||['/oauth/token','/oauth/revoke'].includes(path);
  if(nativeAPI) {
    if(req.headers.origin&&req.headers.origin!==origin&&!webOrigins.includes(req.headers.origin))throw c.error(403,'origin_not_allowed');
    if(webOrigins.includes(req.headers.origin)){res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');}
    if(method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'});res.end();return true;}
  } else if(!['GET','HEAD'].includes(method)&&req.headers.origin!==origin)throw c.error(403,'origin_not_allowed');
  if(path==='/.well-known/oauth-authorization-server'&&method==='GET') {
    json(200,{issuer:s.c.origin,authorization_endpoint:s.c.origin+'/oauth/authorize',token_endpoint:s.c.origin+'/oauth/token',revocation_endpoint:s.c.origin+'/oauth/revoke',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],scopes_supported:['home:manage']});return true;
  }
  if(path==='/openstrudel/auth.js'&&method==='GET'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(asset('openstrudel-auth.js'));return true;}
  if(path==='/openstrudel/auth.css'&&method==='GET'){res.writeHead(200,{'Content-Type':'text/css'});res.end(asset('openstrudel-auth.css'));return true;}
  if(path==='/openstrudel/payment-return'&&method==='GET') {
    const link=c.paymentReturn(u.searchParams.get('order_id'),u.searchParams.get('state'));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вернуться в OpenStrudel</title><link rel="stylesheet" href="/openstrudel/auth.css"><main><p class="brand">OpenStrudel</p><h1>Продолжим<br>в приложении.</h1><p>OpenStrudel проверит результат оплаты и покажет ваш заказ.</p><a class="primary" href="${escape(link)}">Вернуться в OpenStrudel</a><p class="note">Если приложение уже открыто, вернитесь в него. Проверка оплаты продолжится автоматически.</p></main></html>`);return true;
  }
  if(path==='/oauth/authorize'&&method==='GET') {
    const auth=c.auth.begin(Object.fromEntries(u.searchParams),ip);
    res.setHeader('Set-Cookie',`os_authorization=${auth.id}.${auth.nonce}; HttpOnly; SameSite=Lax; Path=/oauth/; Max-Age=600${s.c.secure?'; Secure':''}`);
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(asset('openstrudel-auth.html'));return true;
  }
  if(path==='/api/v2/openstrudel/openapi.json'&&method==='GET'){json(200,openstrudelOpenAPI(s.c.origin));return true;}
  if(path==='/api/v2/openstrudel/catalog'&&method==='GET'){json(200,c.catalog());return true;}
  const b=input(raw,req,s);
  if(path==='/oauth/token'&&method==='POST'){try{json(200,c.auth.exchange(b,ip));}catch(e){json(e.status||400,{error:e.code||'invalid_request',error_description:e.message});}return true;}
  if(path==='/oauth/request'&&method==='GET'||path==='/oauth/complete'&&method==='POST') {
    const [id,nonce]=String(cookie(req,'os_authorization')||'').split('.'),request=c.auth.request(id,nonce);
    let session;try{session=s.auth(cookie(req,'wai_session'));}catch{}
    if(method==='GET') {
      json(200,{request_id:id,brand:'OpenStrudel',owner:session?s.user(session.user_id):null,requires_login:!session||s.now()-session.reauthed>300000||!!request.force_login&&session.reauthed<request.created,csrf:session?.csrf||null});return true;
    }
    if(b.request_id!==id||typeof b.approved!=='boolean')throw c.error(400,'invalid_authorization_request');
    if(b.approved&&(!session||!safeEqual(req.headers['x-csrf-token']||'',session.csrf)))throw c.error(403,'csrf_required');
    json(200,c.auth.complete(id,nonce,session,{approved:b.approved}));return true;
  }
  const bearer=req.headers.authorization?.match(/^Bearer (os_access_[a-f0-9]{64})$/)?.[1],session=c.auth.authenticate(bearer);
  if(path==='/oauth/revoke'&&method==='POST'){json(200,c.auth.revoke(session));return true;}
  if(path==='/api/v2/openstrudel/quotes'&&method==='POST'){json(201,c.quote(session,b));return true;}
  if(path==='/api/v2/openstrudel/orders') {
    if(method==='POST'){json(201,c.order(session,b));return true;}
    if(method==='GET'){json(200,c.list(session));return true;}
  }
  let match=path.match(/^\/api\/v2\/openstrudel\/orders\/([a-f0-9-]{36})(?:\/(checkout|sync|abandon))?$/);
  if(match) {
    if(method==='GET'&&!match[2]){json(200,c.status(session,match[1]));return true;}
    if(method==='POST'&&match[2]){json(200,await c[match[2]](session,match[1]));return true;}
  }
  if(path==='/api/v2/openstrudel/claims/consume'&&method==='POST'){json(200,await c.consumeClaim(session,b));return true;}
  match=path.match(/^\/api\/v2\/openstrudel\/installations\/([a-f0-9-]{36})\/(claims|cancellation|access|export|delete)$/);
  if(match&&method==='POST'){json(match[2]==='claims'?201:200,match[2]==='claims'?c.claim(session,match[1],b):c.manage(session,match[1],match[2],b));return true;}
  throw c.error(404,'not_found');
}
