import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Service, config } from './service.mjs';
import { hash, safeEqual } from './security.mjs';
import { agentGuide, openapi } from './api-docs.mjs';
import { clientIP } from './client-ip.mjs';
import { magicHTTP } from './magic-http.mjs';
import { openstrudelHTTP } from './openstrudel-http.mjs';

const PUBLIC=fileURLToPath(new URL('../public/',import.meta.url));
export function createServer(service) {
  const s=service;
  const html=()=>readFileSync(join(PUBLIC,'index.html'),'utf8').replaceAll('__WAI_BASE__',s.c.basePath||'');
  const server=http.createServer(async(req,res)=>{
    const requestId=crypto.randomUUID();
    res.setHeader('X-Request-ID',requestId);res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(s.c.secure)res.setHeader('Strict-Transport-Security','max-age=31536000');
    const json=(code,body)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
    try {
      const u=new URL(req.url,'http://localhost'),method=req.method;
      const base=s.c.basePath||'';
      const path=base&&u.pathname.startsWith(base+'/')?u.pathname.slice(base.length):u.pathname;
      if(req.headers.host!==new URL(s.c.origin).host)throw s.err(400,'Неверный адрес сервиса.');
      let raw='';if(!['GET','HEAD'].includes(method)){for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>65536)throw s.err(413,'Запрос слишком большой.');}}
      if(await magicHTTP(s,req,res,u,raw,json))return;
      if(await openstrudelHTTP(s,req,res,u,raw,json))return;
      if(path==='/api/v1/webhooks/wai-pay'&&method==='POST'){if(!s.payments.real)throw s.err(404,'WAI Pay не подключён.');json(200,await s.payments.real.webhook(raw,req.headers));return;}
      if(path==='/api/v1/webhooks/payment'&&method==='POST'){json(200,await s.payments.webhook(raw,req.headers['stripe-signature']));return;}
      const cookie=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('wai_session='))?.slice(12);
      const bearer=req.headers.authorization?.match(/^Bearer ((?:wai_(?:test|live)_)?[a-f0-9]{64})$/)?.[1];
      if(!['GET','HEAD'].includes(method)&&!bearer&&req.headers.origin!==new URL(s.c.origin).origin)throw s.err(403,'Запрос должен исходить со страницы OpenStrudel.');
      let body={};if(raw){try{body=JSON.parse(raw);}catch{throw s.err(400,'Некорректный JSON.');}}
      const setCookie=t=>res.setHeader('Set-Cookie',`wai_session=${t}; HttpOnly; Path=${s.c.basePath||'/'}; SameSite=Strict; Max-Age=86400${s.c.secure?'; Secure':''}`);
      const ip=clientIP(req,s.c.trustedProxies);
      if(path==='/openapi.json'&&method==='GET'){json(200,openapi(s.c.origin));return;}
      if(path==='/llms.txt'&&method==='GET'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end(agentGuide(s.c.origin));return;}
      if(path==='/healthz'&&method==='GET'){s.db.get('SELECT 1');json(200,{ok:true,service:'wai-vds',provider:s.c.provider,payments:s.c.payments});return;}
      if(path==='/api/v1/catalog'&&method==='GET'){json(200,s.catalog());return;}
      if(path==='/api/v1/auth/recover'&&method==='POST'){json(200,s.recovery.recover(body.email,body.recovery_code,body.password,ip));return;}
      if(method==='POST'&&['/api/v1/auth/register','/api/v1/auth/login'].includes(path)){
        const a=path.endsWith('register')?s.register(body.email,body.password,ip):s.login(body.email,body.password,ip);setCookie(a.token);json(200,{user:a.user,csrf:a.csrf,...(a.recovery_code?{recovery_code:a.recovery_code}:{})});return;
      }
      if(path.startsWith('/api/')||path.startsWith('/checkout/')) {
        const session=s.auth(bearer||cookie),uid=session.user_id;
        s.agents.authorize(session,method,path);
        if(!['GET','HEAD'].includes(method)&&!bearer&&!safeEqual(req.headers['x-csrf-token']||'',session.csrf))throw s.err(403,'Обновите страницу: проверка сессии не прошла.');
        if(path==='/api/v1/api-keys'&&method==='GET'){json(200,{keys:s.agents.list(uid)});return;}
        if(path==='/api/v1/api-keys'&&method==='POST'){s.reauth(session,body.password);json(201,s.agents.issue(uid,{name:body.name,expires_days:body.expires_days}));return;}
        const keyMatch=path.match(/^\/api\/v1\/api-keys\/([-a-f0-9]{36})$/);
        if(keyMatch&&method==='DELETE'){s.agents.revoke(uid,keyMatch[1]);json(200,{ok:true});return;}
        if(path==='/api/v1/agent/servers'&&method==='POST'){json(202,s.agents.provision(session,body));return;}
        if(path==='/api/v1/me'&&method==='GET'){json(200,{...s.dashboard(uid),csrf:session.csrf,auth:s.magic.options(session)});return;}
        if(path==='/api/v1/auth/logout'&&method==='POST'){s.db.run('DELETE FROM sessions WHERE token=?',session.token);res.setHeader('Set-Cookie',`wai_session=; HttpOnly; SameSite=Strict; Path=${s.c.basePath||'/'}; Max-Age=0`);json(200,{ok:true});return;}
        if(path==='/api/v1/auth/reauth'&&method==='POST'){s.reauth(session,body.password);json(200,{ok:true});return;}
        if(path==='/api/v1/auth/recovery-code'&&method==='POST'){json(200,s.recovery.rotate(session,body.password));return;}
        if(path==='/api/v1/auth/api-token'&&method==='POST'){s.reauth(session,body.password);const a=s.session(uid);s.db.run('UPDATE sessions SET expires=? WHERE token=?',s.now()+3600e3,hash(a.token));s.db.audit(uid,null,'api_session_issued',s.now());json(201,{token:a.token,expires_in:3600,scope:'own orders/status/access/cancel',warning:'Доступ к вашим серверам. Передавайте только доверенному приложению.'});return;}
        if(path==='/api/v1/account/export'&&method==='GET'){res.setHeader('Content-Disposition','attachment; filename="openstrudel-servers.json"');json(200,s.dashboard(uid));return;}
        if(path==='/api/v1/orders'&&method==='POST'){s.limit('order:'+uid,20);json(201,s.order(uid,body));return;}
        let match=path.match(/^\/api\/v1\/orders\/([-a-f0-9]{36})(?:\/(checkout))?$/);
        if(match){if(method==='GET'&&!match[2]){json(200,s.ownOrder(uid,match[1]));return;}if(method==='POST'&&match[2]==='checkout'){json(200,await s.checkout(uid,match[1],body));return;}}
        match=path.match(/^\/api\/v1\/servers\/([-a-f0-9]{36})(?:\/(access|renewals|cancellation|retry|delete))?$/);
        if(match){const id=match[1],action=match[2];s.ownServer(uid,id);
          if(method==='GET'&&!action){json(200,s.serverView(s.ownServer(uid,id)));return;}
          if(method==='POST'&&action==='access'){const key=s.access(uid,id,session);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="openstrudel-server-${id.slice(0,8)}"`});res.end(key);return;}
          if(method==='POST'&&action==='renewals'){json(201,s.renewal(uid,id,body));return;}
          if(method==='POST'&&action==='cancellation'){json(200,s.cancel(uid,id,body));return;}
          if(method==='POST'&&action==='retry'){s.retry(uid,id);json(202,{ok:true});return;}
          if(method==='POST'&&action==='delete'){s.remove(uid,id,body,session);json(202,{ok:true});return;}
        }
        match=path.match(/^\/checkout\/(cs_test_[-a-f0-9]{36}(?:_g\d{1,6})?)(?:\/(result))?$/);
        if(match&&s.c.payments==='emulator') {
          const pay=s.db.get('SELECT * FROM sim_payments WHERE id=?',match[1]);if(!pay)throw s.err(404,'Платёж не найден.');const order=s.ownOrder(uid,pay.order_id);
          if(method==='GET'&&!match[2]){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html());return;}
          if(method==='POST'&&match[2]==='result') {if(!['success','cancel','fail'].includes(body.result))throw s.err(400,'Неизвестный результат.');const e=s.payments.localEvent(match[1],body.result);
            // Real HTTP delivery: the browser never receives the signing secret.
            const delivery=await fetch(s.c.origin+'/api/v1/webhooks/payment',{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':e.signature},body:e.raw,signal:AbortSignal.timeout(10000)});
            if(!delivery.ok)throw s.err(503,'Платёж сохранён. Повторите отправку подтверждения.');json(200,{return_url:s.c.origin+'/?order='+order.id+'&payment='+body.result});return;}
        }
        throw s.err(404,'Не найдено.');
      }
      if(method==='GET'&&['/','/app.js','/styles.css','/favicon.svg','/strudel-cream.png','/strudel-graphite.png'].includes(path)) {
        const file=path==='/'?'index.html':path.slice(1);res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':'text/html; charset=utf-8'});res.end(file==='index.html'?html():readFileSync(join(PUBLIC,file)));return;
      }
      throw s.err(404,'Страница не найдена.');
    } catch(e) {
      const status=e.status||503;
      // Intentionally omit request body, query, provider body and raw exception.
      if(status>=500)console.error(JSON.stringify({event:'request_failed',request_id:requestId,code:e.code||'internal'}));
      json(status,{error:e.status?e.message:'Сервис временно недоступен. Заказ сохранён. Повторите проверку позже.',code:e.code||null,request_id:requestId});
    }
  });
  server.requestTimeout=30000;server.headersTimeout=10000;return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const s=new Service(config()),server=createServer(s);let shutting=false;
  server.listen(s.c.port,s.c.host,()=>console.log(JSON.stringify({event:'listening',url:s.c.origin,provider:s.c.provider,payments:s.c.payments})));
  const timer=setInterval(()=>s.tick().catch(()=>console.error('{"event":"worker_failed"}')),s.c.provider==='emulator'?1200:15000);timer.unref();
  const stop=()=>{if(shutting)return;shutting=true;clearInterval(timer);server.close(()=>{s.db.close();process.exit(0);});setTimeout(()=>process.exit(1),15000).unref();};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
