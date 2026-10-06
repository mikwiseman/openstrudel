const $=id=>document.getElementById(id);let attempt,csrf,mode='login',busy=false,magic=false;
async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})}:{},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw Error(data.error||'Не удалось продолжить. Попробуйте ещё раз.');return data;}
function notice(text){$('notice').textContent=text;}
function lock(value){busy=value;document.querySelectorAll('button').forEach(b=>b.disabled=value);}
async function run(fn){if(busy)return;lock(true);notice('');try{await fn();}catch(e){notice(e.message);}finally{lock(false);}}
async function complete(approved=true){const r=await api('/oauth/complete',{request_id:attempt,approved});location.assign(r.redirect_uri);}
function showForm(next){
 mode=next;$('remembered').hidden=true;$('recovery').hidden=true;$('email-sent').hidden=true;$('login').hidden=false;
 $('recovery-label').hidden=mode!=='recover';$('password-label').hidden=mode==='email';
 $('password-caption').textContent=mode==='recover'?'Новый пароль':'Пароль';$('password-help').hidden=['email','login'].includes(mode);
 $('intro').textContent=mode==='email'?'Укажите email. Пришлём ссылку для входа — пароль не нужен.':mode==='recover'?'Введите сохранённый код и придумайте новый пароль. Размещение останется за вами.':'Войдите, чтобы сохранить размещение за собой и вернуться к нему с любого устройства.';
 $('login').elements.recovery_code.required=mode==='recover';$('login').elements.password.required=mode!=='email';$('login').elements.password.disabled=mode==='email';
 $('login').elements.password.autocomplete=mode==='login'?'current-password':'new-password';$('login').elements.password.minLength=mode==='login'?1:12;
 $('submit').textContent=mode==='email'?'Получить ссылку':mode==='register'?'Создать аккаунт':mode==='recover'?'Восстановить доступ':'Войти';
 $('switch-mode').textContent=mode==='email'?'Войти с паролем':mode==='login'?'Создать аккаунт':'Уже есть аккаунт';$('recover').hidden=['recover','email'].includes(mode);$('email-mode').hidden=!magic||mode==='email';
 $('login').elements.email.focus();
}
$('switch-mode').onclick=()=>showForm(mode==='email'?'login':mode==='login'?'register':'login');$('email-mode').onclick=()=>showForm('email');$('send-again').onclick=()=>showForm('email');$('switch-owner').onclick=()=>showForm(magic?'email':'login');$('recover').onclick=()=>showForm('recover');$('continue').onclick=()=>run(()=>complete());$('cancel').onclick=()=>run(()=>complete(false));$('saved').onclick=()=>run(()=>complete());
$('login').onsubmit=e=>{e.preventDefault();run(async()=>{const form=$('login'),email=form.elements.email.value,password=form.elements.password.value;
 if(mode==='email'){await api('/oauth/magic-link/request',{email,context:'oauth'});$('login').hidden=true;$('email-sent').hidden=false;$('sent-email').textContent=email;return;}
 if(mode==='recover'){const r=await api('/api/v1/auth/recover',{email,password,recovery_code:form.elements.recovery_code.value});form.elements.recovery_code.value='';const a=await api('/api/v1/auth/login',{email,password});csrf=a.csrf;form.elements.password.value='';$('login').hidden=true;$('recovery').hidden=false;$('recovery-code').textContent=r.recovery_code;return;}
 const a=await api('/api/v1/auth/'+mode,{email,password});csrf=a.csrf;form.elements.password.value='';
 if(a.recovery_code){$('login').hidden=true;$('recovery').hidden=false;$('recovery-code').textContent=a.recovery_code;}else await complete();});};
run(async()=>{const [options,r]=await Promise.all([api('/api/v1/auth/options'),api('/oauth/request')]);magic=options.magic_link;attempt=r.request_id;csrf=r.csrf;if(r.owner)$('login').elements.email.value=r.owner.email;if(r.requires_login)showForm(magic?'email':'login');else{$('owner').textContent=r.owner.email;$('remembered').hidden=false;}});
