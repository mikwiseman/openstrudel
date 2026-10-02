import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { MobileAccess } from "./mobile.js";

/** Only issues invitations. The Home API remains private behind pinned TLS. */
export function createSetupServer(mobile: Pick<MobileAccess, "invite">, code: string) {
  if (!/^[a-f0-9]{64}$/.test(code)) throw new Error("OPENSTRUDEL_SETUP_CODE must contain 64 random hexadecimal characters");
  const credential = Buffer.from(code);
  return createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (req.method === "GET" && req.url === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8"); res.end(page); return;
    }
    if (req.method === "GET" && req.url === "/setup.js") {
      res.setHeader("content-type", "text/javascript; charset=utf-8"); res.end(script); return;
    }
    res.setHeader("content-type", "application/json; charset=utf-8");
    if (req.method === "GET" && req.url === "/healthz") { res.end('{"ok":true}'); return; }
    if (req.method !== "POST" || req.url !== "/pairing") { res.writeHead(404).end('{}'); return; }
    if (req.headers.origin && !["https://" + req.headers.host, "http://" + req.headers.host].includes(req.headers.origin)) {
      res.writeHead(403).end('{}'); return;
    }
    const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (given.length !== credential.length || !timingSafeEqual(given, credential)) {
      res.writeHead(401).end('{"error":"Откройте личную ссылку установки из Railway или введите код установки."}'); return;
    }
    try { res.writeHead(201).end(JSON.stringify(await mobile.invite(true))); }
    catch { res.writeHead(503).end('{"error":"Сервер ещё запускается. Повторите через несколько секунд."}'); }
  });
}

const page = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подключить OpenStrudel</title>
<style>:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:light-dark(#f6f5f3,#141417);color:light-dark(#202023,#f5f5f7)}*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:28px}main{width:min(100%,420px)}.brand{font-size:15px;letter-spacing:-.03em;margin-bottom:44px}h1{font-family:ui-serif,Georgia,serif;font-size:44px;font-weight:500;letter-spacing:-.04em;line-height:1.05;margin:0 0 22px}p{line-height:1.55;color:light-dark(#696970,#b2b2bc)}button,.primary,input{font:inherit;border:0;border-radius:16px;padding:16px;width:100%;margin-top:12px}.primary,button{background:light-dark(#262632,#f1f1f5);color:light-dark(#fff,#16161c);cursor:pointer;display:block;text-align:center;text-decoration:none}input{background:light-dark(#fff,#29292e);border:1px solid light-dark(#d6d6dc,#414149)}button:disabled{opacity:.45;cursor:wait}.quiet{background:none;color:inherit;border:1px solid light-dark(#d6d6dc,#414149)}small{font-size:13px}a{color:inherit}[hidden]{display:none!important}:focus-visible{outline:3px solid #9090ef;outline-offset:3px}</style>
<main><div class="brand">OpenStrudel</div><h1>Ваша команда<br>готова к знакомству.</h1><p>Подключите приложение к вашему серверу. Затем войдите в OpenAI — без ключей API.</p>
<div id="entry"><label for="code">Код установки</label><input id="code" type="password" autocomplete="off" spellcheck="false" placeholder="Из настроек вашей установки"><button id="connect">Создать приглашение</button></div>
<div id="result" hidden><a class="primary" id="open">Открыть OpenStrudel</a><button class="quiet" id="copy">Скопировать приглашение</button><p id="expiry"></p><button class="quiet" id="refresh">Новое приглашение</button></div>
<p id="status" role="status" aria-live="polite"></p><p><small>Ещё нет приложения? <a href="https://waiwai.is/openstrudel">Скачать OpenStrudel</a>.<br>Личная ссылка открывает доступ к вашим чатам. Не передавайте её другим.</small></p></main><script src="setup.js"></script></html>`;

const script = `const $=id=>document.getElementById(id);let code=location.hash.slice(1),invite=null;
history.replaceState(null,'',location.pathname);if(code){$('code').value=code;$('entry').hidden=true;}
async function connect(){code=$('code').value.trim();$('connect').disabled=true;$('refresh').disabled=true;$('status').textContent='Готовим приглашение…';
try{const r=await fetch('pairing',{method:'POST',headers:{Authorization:'Bearer '+code}});const data=await r.json();if(!r.ok)throw new Error(data.error||'Не удалось подключиться.');invite=data;$('open').href=data.url;$('open').hidden=false;$('copy').disabled=false;$('copy').textContent='Скопировать приглашение';$('entry').hidden=true;$('result').hidden=false;$('status').textContent='';tick();}
catch(e){$('status').textContent=e.message;$('entry').hidden=false;}finally{$('connect').disabled=false;$('refresh').disabled=false;}}
function tick(){if(!invite)return;const seconds=Math.max(0,Math.ceil((new Date(invite.expiresAt)-Date.now())/1000));$('expiry').textContent=seconds?'Действует ещё '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'):'Приглашение истекло. Создайте новое.';if(!seconds){$('open').hidden=true;$('copy').disabled=true;}}
$('connect').onclick=connect;$('refresh').onclick=connect;$('copy').onclick=async()=>{try{await navigator.clipboard.writeText(invite.url);$('copy').textContent='Скопировано';}catch{$('status').textContent='Откройте эту страницу на устройстве с OpenStrudel и нажмите «Открыть».';}};
setInterval(tick,1000);if(code)connect();`;
