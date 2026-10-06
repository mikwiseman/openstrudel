const $=id=>document.getElementById(id);
let link=location.hash.slice(1);
// The secret never reaches server/proxy access logs or the next URL.
history.replaceState(null,'',location.pathname);
async function call(action){const r=await fetch('/oauth/magic-link/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:link})});const data=await r.json();if(!r.ok)throw Error(data.error||'Не удалось подтвердить вход.');return data;}
function failed(e){$('notice').textContent=e.message;$('confirm').hidden=true;$('restart').hidden=false;$('hint').hidden=true;}
async function init(){try{const r=await call('inspect');$('brand').textContent=r.brand;$('email').textContent=r.email;$('description').textContent=r.context==='reauth'?'Подтвердите, что это вы. Затем вернитесь на вкладку с сервером.':'Подтвердите вход в свой аккаунт.';$('confirm').hidden=false;}catch(e){failed(e);}}
$('confirm').onclick=async()=>{const button=$('confirm');button.disabled=true;$('notice').textContent='';try{const r=await call('consume');link='';$('heading').textContent='Готово.';button.hidden=true;$('hint').hidden=true;const next=$('continue');next.href=r.redirect_uri;next.textContent=r.context==='oauth'?'Вернуться в OpenStrudel':'К моим серверам';next.hidden=false;$('description').textContent=r.context==='reauth'?'Вход подтверждён. Вернитесь на прежнюю вкладку и продолжите действие.':'Вы вошли в свой аккаунт.';if(r.context!=='reauth')location.assign(r.redirect_uri);}catch(e){failed(e);}finally{button.disabled=false;}};
init();
