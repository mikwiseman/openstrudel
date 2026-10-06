import {readFileSync} from 'node:fs';
import {token,safeEqual} from './security.mjs';
import {clientIP} from './client-ip.mjs';

const cookie=(req,name)=>String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);
const asset=name=>readFileSync(new URL('../public/'+name,import.meta.url));
export async function magicHTTP(s,req,res,u,raw,json) {
  const path=u.pathname,method=req.method;
  if(!['/auth/email','/magic-link.js','/api/v1/auth/options','/api/v1/auth/password','/api/v1/auth/magic-link/request','/oauth/magic-link/request','/oauth/magic-link/inspect','/oauth/magic-link/consume'].includes(path))return false;
  if(method==='GET'&&['/auth/email','/magic-link.js'].includes(path)) {
    res.setHeader('X-Robots-Tag','noindex, nofollow');
    res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript':'text/html; charset=utf-8'});res.end(asset(path.endsWith('.js')?'magic-link.js':'magic-link.html'));return true;
  }
  let session;try{session=s.auth(cookie(req,'wai_session'));}catch{}
  if(method==='GET'&&path==='/api/v1/auth/options'){json(200,s.magic.options(session));return true;}
  if(method!=='POST')throw s.err(405,'Метод недоступен.');
  if(req.headers.origin!==new URL(s.c.origin).origin||req.headers['content-type']?.split(';')[0]!=='application/json')throw s.err(403,'Начните вход со страницы сервиса.');
  let b;try{b=JSON.parse(raw);if(!b||typeof b!=='object'||Array.isArray(b))throw Error();}catch{throw s.err(400,'Некорректный JSON.');}
  const ip=clientIP(req,s.c.trustedProxies);
  let authorization;
  const [id,authNonce]=String(cookie(req,'os_authorization')||'').split('.');
  if(id)try{authorization={...s.cloud.auth.request(id,authNonce),nonce:authNonce};}catch{}
  const magicCookie=s.c.secure?'__Host-wai_magic':'wai_magic';
  const context={nonce:cookie(req,magicCookie),session,authorization,ip};
  const csrf=()=>{if(!session||!safeEqual(req.headers['x-csrf-token']||'',session.csrf))throw s.err(403,'Обновите страницу и подтвердите вход.');};
  const setCookie=value=>res.setHeader('Set-Cookie',[...(res.getHeader('Set-Cookie')||[]),value]);
  if(path==='/api/v1/auth/password'){csrf();json(200,s.magic.setPassword(session,b.password));return true;}
  if(path.endsWith('/request')) {
    if(b.context==='reauth')csrf();
    if(b.context==='oauth'&&path!=='/oauth/magic-link/request')throw s.err(400,'Начните вход из OpenStrudel.');
    if(!/^[a-f0-9]{64}$/.test(context.nonce||''))context.nonce=token();
    setCookie(`${magicCookie}=${context.nonce}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${s.c.secure?'; Secure':''}`);
    json(202,await s.magic.request(b,context));return true;
  }
  if(Object.keys(b).some(k=>k!=='token'))throw s.err(400,'Некорректный запрос входа.');
  if(path.endsWith('/inspect')) {
    const link=s.magic.inspect(b.token,context);
    json(200,{email:link.email,context:link.context,brand:link.context==='oauth'?'OpenStrudel':'WAI Server'});return true;
  }
  const result=s.magic.consume(b.token,context),{token:sessionToken,...response}=result;
  if(sessionToken)setCookie(`wai_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=${s.c.basePath||'/'}; Max-Age=86400${s.c.secure?'; Secure':''}`);
  json(200,response);return true;
}
