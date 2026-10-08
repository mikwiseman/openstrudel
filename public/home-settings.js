/* Served by the user's Home. No CDN, vendor sign-in, telemetry or external catalogue. */
function element(tag, text, className) { const e = document.createElement(tag); if (text) e.textContent = text; if (className) e.className = className; return e; }
function modalPage(title, description) {
  const box = element('div'); box.append(element('h2', title)); if (description) box.append(element('p', description));
  const error = element('p'); error.setAttribute('role','alert'); box.append(error);
  const content = element('div'); box.append(content);
  const actions = element('div', '', 'modal-actions'); const close = element('button','Готово','secondary'); close.onclick = closeModal; actions.append(close); box.append(actions);
  showModal(box); close.focus();
  return { box, content, actions, error, report: e => { error.textContent = e.message; } };
}
function action(page, title, work, primary = false) {
  const button = element('button', title, primary ? 'primary' : 'secondary');
  button.onclick = async () => { button.disabled = true; page.error.textContent = ''; try { await work(); } catch(e) { page.report(e); } finally { button.disabled = false; } };
  page.actions.prepend(button); return button;
}
function field(parent, label, type = 'text') {
  const wrapper = element('label',label); const input = element('input','','field'); input.type = type; if(type === 'password') input.autocomplete = 'new-password'; wrapper.append(input); parent.append(wrapper); return input;
}
function download(data, name, type='application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data],{type})); const link = element('a'); link.href=url; link.download=name; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function controlsKey() { return 'openstrudel.control.'+(state.homeId||location.origin); }
function rememberControl(id,pending) {
  const values=JSON.parse(localStorage.getItem(controlsKey())||'[]').filter(v=>v!==id);
  if(pending) values.push(id);
  localStorage.setItem(controlsKey(),JSON.stringify(values));
}
async function checkControls(page) {
  let completed=0,waiting=0;
  for(const id of JSON.parse(localStorage.getItem(controlsKey())||'[]')) {
    const result=await api('/v1/home/requests/'+encodeURIComponent(id));
    if(result.status==='canceled') { rememberControl(id,false); continue; }
    if(result.response) {
      rememberControl(id,false);
      if(result.response.status>=400) throw new Error(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(result.response.body),c=>c.charCodeAt(0)))).error || 'Проверьте результат действия.');
      completed++;
    } else waiting++;
  }
  page.content.append(element('p',`Завершено: ${completed}. Ожидают устройства: ${waiting}.`));
}
async function openTelegramSettings() {
  const page=modalPage('Telegram','Один бот для личного чата и групп сотрудников на этом устройстве.');
  const profile=state.profiles.find(p=>p.id===state.selected), suffix=profile?.deviceId?'?deviceId='+encodeURIComponent(profile.deviceId):'';
  const status=element('p','Проверяем подключение…');status.setAttribute('role','status');page.content.append(status);
  try {
    const read=async()=>{const result=await api('/v1/integrations'+suffix);return result.telegram;};
    const telegram=await read();
    status.textContent=telegram.configured?'Бот @'+telegram.botUsername+' подключён':'1. Создайте бота в BotFather командой /newbot.';
    if(!state.owner) return;
    if(!telegram.configured) {
      const help=element('a','Открыть BotFather');help.href='https://t.me/BotFather';help.target='_blank';help.rel='noreferrer';page.content.append(help);
      const token=field(page.content,'2. Вставьте ключ бота','password');
      action(page,'Подключить бота',async()=>{
        status.textContent='Проверяем ключ…';
        try {await api('/v1/integrations/telegram'+suffix,{method:'POST',body:JSON.stringify({token:token.value.trim()})});token.value='';await openTelegramSettings();}
        catch(e){status.textContent='Подключение не завершено.';throw e;}
      },true);
    } else {
      if(telegram.lastError) page.error.textContent=telegram.lastError;
      for (const chat of (telegram.chats||[]).filter(c=>c.chatId.startsWith('-')&&(!profile||c.profileId===profile.id))) {
        page.content.append(element('p',chat.title+' · '+(chat.replies==='mentions'?'По @упоминанию или ответу':'По правилам сотрудника')));
      }
      const paired=(telegram.chats||[]).some(chat=>!chat.chatId.startsWith('-')&&chat.allowedSenders.includes(chat.chatId));
      if(paired) page.content.append(element('p','Личный Telegram подключён.'));
      action(page,paired?'Открыть Telegram':'Связать личный чат',async()=>{
        const result=paired?{url:'https://t.me/'+telegram.botUsername}:await api('/v1/integrations/telegram/link'+suffix,{method:'POST',body:JSON.stringify({})});
        const link=element('a','Открыть чат в Telegram');link.href=result.url;link.target='_blank';link.rel='noreferrer';page.content.replaceChildren(link,element('p','Нажмите «Начать» в Telegram.'));
        for(let i=0;!paired&&i<300&&$('modal-content').contains(page.box);i++) {
          await new Promise(resolve=>setTimeout(resolve,2000));
          const value=await read();if((value.chats||[]).some(chat=>!chat.chatId.startsWith('-')&&chat.allowedSenders.includes(chat.chatId))){page.content.append(element('p','Чат подключён. Можно писать боту.'));break;}
        }
      },true);
      if(paired&&profile) {
        page.content.append(element('p','Добавьте «'+profile.name+'» в группу. Все участники смогут обращаться к сотруднику через @упоминание бота или ответ ему. Личная переписка останется отдельно.'));
        action(page,'Добавить в группу…',async()=>{
          const invite=await api('/v1/integrations/telegram/link'+suffix,{method:'POST',body:JSON.stringify({kind:'group',profileId:profile.id})});
          const url=invite.url?new URL(invite.url):null;
          if(url?.origin!=='https://t.me'||url.searchParams.get('startgroup')!==invite.code) throw new Error('Обновите OpenStrudel на устройстве этого сотрудника, чтобы подключить группу.');
          const link=element('a','Выбрать группу в Telegram');link.href=invite.url;link.target='_blank';link.rel='noreferrer';page.content.append(link);
          page.content.append(element('p','Ссылка действует 10 минут. После выбора группы нажмите «Обновить».'));
        },true);
        action(page,'Обновить',()=>openTelegramSettings());
      }
    }
  } catch(e) {status.textContent='';page.report(e);}
}
async function bootstrapWeb() {
  clearInterval(state.refreshTimer);
  const key = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (key) history.replaceState(null,'',location.pathname);
  try {
    const session = key ? await api('/auth/session',{method:'POST',body:JSON.stringify({key})}) : await api('/auth/session');
    state.csrf=session.csrf; state.owner=session.owner; await refresh();
    restoreDraft();
    const transfer = JSON.parse(localStorage.getItem('openstrudel.transfer') || 'null');
    if (transfer) await watchTransfer(transfer);
    state.refreshTimer=setInterval(()=>{ if(!document.hidden && !state.loading) void refresh(); },5000);
  } catch(e) {
    $('status').textContent='Нужно приглашение';
    const page=modalPage('Подключитесь к своей команде','Откройте приглашение для браузера из настроек OpenStrudel на Mac или сервере с вашими сотрудниками.');
    const input=field(page.content,'Ссылка с приглашением');
    if(key) page.report(e);
    action(page,'Подключиться',async()=>{
      const url=new URL(input.value.trim());
      if(url.origin!==location.origin) throw new Error('Это приглашение для другого устройства. Откройте его адрес в браузере.');
      const invite=new URLSearchParams(url.hash.slice(1)).get('invite'); if(!invite) throw new Error('В ссылке нет приглашения.');
      const session=await api('/auth/session',{method:'POST',body:JSON.stringify({key:invite})});
      state.csrf=session.csrf; state.owner=session.owner; closeModal(); await bootstrapWeb();
    },true);
  }
}
window.addEventListener('hashchange',()=>{ if(new URLSearchParams(location.hash.slice(1)).has('invite')) void bootstrapWeb(); });
async function openHomeSettings() {
  const page=modalPage('Настройки','Сотрудники и переписка находятся на этом устройстве.');
    const entries=state.owner ? [['Устройства',openDevices],['Настройки сотрудника',openCurrentAgent],['Аккаунты и лимиты',openAccounts],['Резервная копия',openSettings],['Telegram',openTelegramSettings]] : [['Аккаунты и лимиты',openAccounts]];
  for(const [label,fn] of entries) { const button=element('button',label,'secondary'); button.style.cssText='display:block;width:100%;text-align:left;margin:6px 0'; button.onclick=()=>void fn(); page.content.append(button); }
  if(state.hostingOrigin) {
    const link=element('a','Серверы: создание и продление','secondary');
    link.href=state.hostingOrigin; link.target='_blank'; link.rel='noopener noreferrer';
    link.style.cssText='display:block;margin:12px 0'; page.content.append(link);
  }
  action(page,'Выйти на этом устройстве',openDeviceSignOut);
}
async function openDevices() {
  const page=modalPage('Устройства','Сотрудники остаются на устройстве, где созданы. Для работы с несколькими устройствами откройте приложение OpenStrudel.');
  try {
    const data=await api('/v1/devices'); state.devices=data.devices;
    if(JSON.parse(localStorage.getItem(controlsKey())||'[]').length) action(page,'Проверить сохранённые действия',()=>checkControls(page));
    const control=await api('/v1/home');
    for(const operation of control.operations||[]) {
      const button=element('button','Проверить перенос сотрудника','secondary'); button.onclick=()=>void watchAgentMove(operation.id); page.content.append(button);
    }
    for(const device of data.devices) {
      const row=element('div'); row.style.cssText='padding:14px 0;border-bottom:1px solid var(--line)';
      row.append(element('strong',device.name)); row.append(element('p',`${device.online?'На связи':'Не на связи'} · Сотрудников: ${device.agents}`));
      page.content.append(row);
    }
    if(state.owner) {
      action(page,'Открыть на другом устройстве',async()=>{
        const invite=await api('/v1/mobile/pairing',{method:'POST',body:JSON.stringify({owner:true})});
        const next=modalPage('Подключение устройства','На другом Mac откройте Настройки → Устройства → Подключить устройство и вставьте эту ссылку. Она действует пять минут.');
        const text=field(next.content,'Личная ссылка подключения','password'); text.value=invite.url; text.readOnly=true;
        action(next,'Скопировать ссылку',async()=>{await navigator.clipboard.writeText(invite.url);next.error.textContent='Ссылка скопирована. Продолжите на другом устройстве.';},true);
      });
    }
  } catch(e) { page.report(e); }
}
async function openCurrentAgent() {
  const agent=state.selected||'main', profile=state.profiles.find(p=>p.id===agent), name=profile?.name||'OpenStrudel';
  const page=modalPage(name,'Настройки изменят новые поручения. Уже начатая работа продолжится с прежним аккаунтом.');
  if(profile && state.appearanceVersion===1) {
    const editor=appearanceEditor(agentAppearance(profile)); page.content.append(editor.root);
    action(page,'Сохранить образ',async()=>{
      const result=await api('/v1/profiles/'+encodeURIComponent(profile.id),{method:'PATCH',body:JSON.stringify({name:profile.name,instructions:profile.instructions,appearance:editor.value()})});
      if(JSON.stringify(result.profile?.appearance)!==JSON.stringify(editor.value())) throw new Error('Обновите OpenStrudel на устройстве этого сотрудника, чтобы сохранить образ.');
      closeModal();await refresh();
    },true);
  }
  try {
    const control=await api('/v1/home'), deviceId=profile?.deviceId||control.home.mainNodeId;
    const device=control.devices.find(d=>d.id===deviceId);
    page.content.append(element('p','Работает на «'+(device?.name||'вашем устройстве')+'».'));
    const data=await api('/v1/accounts?deviceId='+encodeURIComponent(deviceId)), policy=await api('/v1/agents/'+agent+'/accounts');
    const label=element('label','Аккаунт OpenAI'), select=element('select','','field'); label.append(select); page.content.append(label);
    const defaultOption=element('option','По умолчанию'); defaultOption.value=''; select.append(defaultOption);
    for(const account of data.accounts) { const option=element('option',account.account.email||account.name); option.value=account.id; select.append(option); }
    if(policy.accountIds?.length===1) select.value=policy.accountIds[0];
    else if(policy.accountIds?.length>1) page.content.append(element('p','Выбран отдельный порядок аккаунтов. Новый выбор заменит его.'));
    action(page,'Сохранить аккаунт',async()=>{ await api('/v1/agents/'+agent+'/accounts',{method:'POST',body:JSON.stringify({accountIds:select.value?[select.value]:null})}); closeModal(); },true);

  } catch(e) { page.report(e); }
}
async function watchAgentMove(id) {
  const page=modalPage('Перенос сотрудника','Можно закрыть окно. Состояние операции сохранено.');
  let retry;
  const labels={waiting:'Ждём завершения принятых поручений',preparing:'Готовим копию',staging:'Проверяем копию',releasing:'Останавливаем прежнюю копию',activating:'Включаем новую копию',canceling:'Отменяем подготовку',canceled:'Подготовка отменена',completed:'Сотрудник перенесён',attention:'Нужна проверка устройств'};
  const check=async()=>{
    const result=await api('/v1/home/operations/'+encodeURIComponent(id));
    page.content.replaceChildren(element('p',labels[result.phase]||'Проверяем перенос'));
    page.error.textContent=result.error||'';
    for(const warning of result.warnings||[]) page.content.append(element('p',warning));
    if(result.phase==='attention'&&!retry) retry=action(page,'Продолжить перенос',async()=>{await api('/v1/home/operations/'+id+'/retry',{method:'POST',body:'{}'});await check();});
    if(retry) retry.hidden=result.phase!=='attention';
    if(result.phase==='completed') { await refresh(); return true; }
    return ['canceled','attention'].includes(result.phase);
  };
  action(page,'Проверить состояние',check);
  try { for(let n=0;n<30 && $('modal-content').contains(page.box);n++) { if(await check()) break; await new Promise(r=>setTimeout(r,1000)); } } catch(e) { page.report(e); }
}
async function watchTransfer(value) {
  const page = modalPage('Передача управления','Проверяем подтверждение нового подключения. Закрытие окна не отменяет передачу.');
  const check = async () => {
    const result = await api('/v1/home/operations/' + encodeURIComponent(value.operationId));
    if (result.phase === 'completed' || result.phase === 'active') {
      localStorage.removeItem('openstrudel.transfer');
      page.content.replaceChildren(element('p','Подключение изменилось. Создайте ссылку для браузера на новом устройстве.'));
      const link=element('a','Открыть устройство'); link.href=value.url; link.rel='noreferrer'; page.content.append(link);
      return true;
    }
    if (result.phase === 'canceled' || result.phase === 'activation_failed') throw new Error(result.error || 'Передача не завершена. Проверьте состояние устройств.');
    return false;
  };
  action(page,'Проверить состояние',check,true);
  try { for(let i=0;i<20;i++) { if(await check()) return; if(!$('modal-content').contains(page.box)) return; await new Promise(r=>setTimeout(r,1000)); } }
  catch(e) { page.report(e); }
}
async function openAccounts(deviceId) {
  const page=modalPage('Аккаунты и лимиты','Подписка OpenAI и отдельный баланс кредитов.');
  const loading=element('p','Загружаем аккаунты и лимиты…');loading.setAttribute('role','status');page.content.append(loading);
  try {
    const devices=state.devices || (await api('/v1/devices')).devices;
    const selector=element('select','','field'); selector.setAttribute('aria-label','Устройство');
    for(const device of devices) { const option=element('option',device.name); option.value=device.id; selector.append(option); }
    selector.value=deviceId || state.nodeId||devices[0]?.id; deviceId=selector.value;
    selector.onchange=()=>void openAccounts(selector.value); page.content.append(selector);
    const suffix='?deviceId='+encodeURIComponent(deviceId);
    const data=await api('/v1/accounts'+suffix+'&refresh=true');loading.remove();
    for(const [i,entry] of data.accounts.entries()) {
      const row=element('div'); row.style.cssText='padding:14px 0;border-bottom:1px solid var(--line)';
      row.append(element('strong',entry.account.email || entry.name));
      row.append(element('p',`${i===0?'Первый по приоритету · ':''}${entry.account.connected?({plus:'ChatGPT Plus',pro:'ChatGPT Pro',business:'ChatGPT Business',team:'ChatGPT Business',enterprise:'ChatGPT Enterprise',free:'ChatGPT Free'})[entry.account.planType] || 'OpenAI подключён':'Нужен вход'}`));
      if(entry.usage.windows.length) for(const window of entry.usage.windows) row.append(element('p',`${window.name}: ${window.remainingPercent==null?'пока неизвестно':'осталось '+Math.round(window.remainingPercent)+'%'}${window.resetsAt?' · сброс '+new Date(window.resetsAt*1000).toLocaleString('ru-RU'):''}`));
      else row.append(element('p',entry.usage.unavailable?'Не удалось получить остатки. Обновите список.':'OpenAI не передал лимиты подписки.'));
      const credits=entry.usage.credits;row.append(element('p','Кредиты: '+(credits?.unlimited?'без ограничений':credits?.balance??(credits?.hasCredits?'доступны, баланс не передан':'баланс не передан'))));
      if(entry.usage.checkedAt) row.append(element('small','Проверено '+new Date(entry.usage.checkedAt).toLocaleTimeString()));
      if(data.canManage) {
        const login=element('button',entry.account.connected?'Войти заново':'Войти в OpenAI','secondary');
        login.onclick=()=>void startAccountLogin(entry.id,deviceId); row.append(login);
        if(i>0) { const use=element('button','Использовать первым','secondary'); use.onclick=async()=>{try{await api(`/v1/accounts/${entry.id}/priority`+suffix,{method:'POST',body:'{}'}); await openAccounts(deviceId);}catch(e){page.report(e);}}; row.append(use); }
      }
      page.content.append(row);
    }
    action(page,'Обновить остатки',()=>openAccounts(deviceId));
    if(data.canManage) action(page,'Добавить аккаунт',async()=>{ const entry=await api('/v1/accounts'+suffix,{method:'POST',body:JSON.stringify({name:'Аккаунт'})}); await startAccountLogin(entry.id,deviceId); });
  } catch(e) { page.report(e); action(page,'Повторить',()=>openAccounts(deviceId)); }
  finally { loading.remove(); }
}
async function startAccountLogin(accountId,deviceId) {
  const page=modalPage('Вход в OpenAI','Войдите в свой аккаунт на сайте OpenAI и подтвердите подключение этого устройства.');
  const base=`/v1/accounts/${encodeURIComponent(accountId)}/login`, suffix='?deviceId='+encodeURIComponent(deviceId);
  try {
    const login=await api(base+suffix,{method:'POST',body:'{}'});
    const code=element('p',login.userCode); code.style.cssText='font-size:24px;font-family:monospace;user-select:all'; page.content.append(code);
    const link=element('a','Открыть OpenAI'); const url=new URL(login.verificationUrl); if(url.protocol!=='https:' || url.hostname!=='auth.openai.com') throw new Error('OpenAI вернул неизвестный адрес входа.');
    link.href=url.href; link.target='_blank'; link.rel='noopener noreferrer'; page.content.append(link);
    action(page,'Проверить вход',async()=>{ const result=await api(base+'/'+encodeURIComponent(login.loginId)+suffix); if(result.status==='completed') await openAccounts(deviceId); else if(result.status==='failed'||result.status==='canceled') throw new Error(result.error || 'Вход отменён. Начните снова.'); else page.error.textContent='Завершите вход на сайте OpenAI.'; },true);
    action(page,'Отменить вход',async()=>{await api(base+'/'+encodeURIComponent(login.loginId)+suffix,{method:'DELETE'}); await openAccounts(deviceId);});
  } catch(e) { page.report(e); }
}
async function openCreateAgent() {
  const page=modalPage('Новый сотрудник','Дайте имя и опишите его задачу.');
  const name=field(page.content,'Имя'); const description=element('textarea','','field'); description.rows=4; description.setAttribute('aria-label','Инструкции'); page.content.append(description);
  const selector=element('select','','field'); selector.setAttribute('aria-label','Где работает'); page.content.append(selector);
  try {
    const data=await api('/v1/devices'); state.devices=data.devices;
    for(const device of data.devices) { const option=element('option',device.name); option.value=device.id; option.disabled=!device.online; selector.append(option); }
    selector.value=state.nodeId||data.devices[0]?.id;
  } catch(e) { page.report(e); }
  const creationId=crypto.randomUUID();

  action(page,'Создать',async()=>{
    const result=await api('/v1/profiles',{method:'POST',headers:{'idempotency-key':creationId},body:JSON.stringify({name:name.value,instructions:description.value,deviceId:selector.value,creationId})});
    if(!result.profile) throw new Error('Создание ещё выполняется. Проверьте список сотрудников после подключения устройства.');
    closeModal(); await refresh(); await selectAgent(result.profile.id);
  },true);
}
function openNavigation() {
  const page=modalPage('OpenStrudel');
  for(const profile of [{id:null,name:'OpenStrudel'},...state.profiles]) { const button=element('button','','secondary'); if(profile.id) button.append(characterImage(agentAppearance(profile),32)); button.append(element('span',profile.name)); button.style.cssText='display:flex;align-items:center;gap:10px;width:100%;margin:6px 0;text-align:left'; button.onclick=async()=>{closeModal();try{await selectAgent(profile.id);}catch(e){$('status').textContent=e.message;}}; page.content.append(button); }
  action(page,'Настройки',openHomeSettings); action(page,'Новый сотрудник',openCreateAgent);
}
async function sendDraft(event) {
  event.preventDefault(); const text=$('draft').value.trim(); if(!text||state.loading) return;
  let draft; try { draft = saveDraft(); } catch(e) { $('status').textContent=e.message; return; }
  state.loading=true; $('send').disabled=true;
  try {
    const result=await api('/v1/messages?async=true',{method:'POST',body:JSON.stringify({...draft,channel:'api',externalChatId:'home'})});
    if (result.operationId) {
      const queue=readOutbox(); if(!queue.some(item=>item.externalId===draft.externalId)) queue.push({...draft,operationId:result.operationId}); saveOutbox(queue);
    }
    localStorage.removeItem(draftKey()); $('draft').value=''; state.pendingDraft=null;
    $('status').textContent=result.deliveryState==='waiting_for_device'?'Ждёт подключения устройства':'Поручение принято';
    renderMessages();renderExtraMessages();
    await refresh();
  } catch(e) { $('status').textContent=e.message; }
  finally {state.loading=false;$('draft').dispatchEvent(new Event('input'));}
}
function draftKey() { return 'openstrudel.draft.' + (state.homeId || location.origin) + '.' + (state.chat || state.selected || 'main'); }
function saveDraft() {
  const text=$('draft').value;
  const previous=JSON.parse(localStorage.getItem(draftKey()) || 'null');
  const draft=previous?.text===text ? previous : { text, profile:state.selected, conversationId:state.chat, externalId:crypto.randomUUID() };
  try { localStorage.setItem(draftKey(),JSON.stringify(draft)); } catch { throw new Error('Не удалось сохранить черновик в браузере. Освободите место перед отправкой.'); }
  return draft;
}
function restoreDraft() {
  const draft=JSON.parse(localStorage.getItem(draftKey()) || 'null'); $('draft').value=draft?.text || '';
  $('send').disabled=!$('draft').value.trim();
}
function outboxKey() { return 'openstrudel.outbox.' + (state.homeId || location.origin); }
function readOutbox() { return JSON.parse(localStorage.getItem(outboxKey()) || '[]'); }
function saveOutbox(items) { localStorage.setItem(outboxKey(),JSON.stringify(items)); }
async function checkOutbox() {
  const queue=readOutbox(), delivered=new Set(state.messages.map(m=>m.externalId));
  for(const item of queue) {
    if(delivered.has(item.externalId)) continue;
    try {
      const result=await api('/v1/home/requests/' + encodeURIComponent(item.operationId));
      if(result.status==='canceled') item.error='Отменено до отправки устройству';
      else if(result.response?.status>=400 && result.response.status!==410) {
        const bytes=Uint8Array.from(atob(result.response.body),c=>c.charCodeAt(0));
        item.error=JSON.parse(new TextDecoder().decode(bytes)).error || 'Проверьте результат в чате перед новой отправкой';
      }
    } catch { /* Receipt remains durable while Home reconnects. */ }
  }
  const updated=new Map(queue.map(item=>[item.operationId,item]));
  saveOutbox(readOutbox().filter(item=>!delivered.has(item.externalId)).map(item=>updated.get(item.operationId)||item));
}
$('draft').addEventListener('input',()=>{try{saveDraft();}catch(e){$('status').textContent=e.message;$('send').disabled=true;}});
function renderExtraMessages() {
  for(const [index,message] of state.messages.entries()) {
    const bubble=$('messages').children[index]?.querySelector('.bubble'); if(!bubble) continue;
    for(const attachment of message.attachments || []) {
      const button=element('button',attachment.name,'secondary'); button.onclick=async()=>{try{const blob=await api('/v1/files/'+encodeURIComponent(attachment.id),{},true);download(blob,attachment.name,attachment.mimeType);}catch(e){$('status').textContent=e.message;}}; bubble.append(document.createElement('br'),button);
    }
    if(message.status==='queued'||message.status==='running'||message.status==='failed') bubble.append(element('p',message.error || (message.status==='queued'?'Ждёт выполнения':'Выполняется')));
  }
  for(const item of readOutbox().filter(p=>(p.profile||null)===(state.selected||null)&&(p.conversationId||null)===(state.chat||null))) {
    const row=element('div','','message-row user'), bubble=element('div',item.text,'bubble');
    bubble.append(element('p',item.error || 'Сообщение сохранено. Ждём подключения устройства.'));
    if(!item.error && state.owner) {
      const cancel=element('button','Отменить доставку','secondary'); cancel.onclick=async()=>{try{await api('/v1/home/requests/'+encodeURIComponent(item.operationId),{method:'DELETE'});await checkOutbox();renderMessages();renderExtraMessages();}catch(e){$('status').textContent=e.message;}}; bubble.append(cancel);
    }
    row.append(bubble); $('messages').append(row);
  }
  for(const interaction of state.interactions || []) {
    const box=element('div'); box.append(element('strong',interaction.title)); if(interaction.detail) box.append(element('p',interaction.detail));
    const answers={};
    for(const q of interaction.questions || []) { const input=field(box,q.question); if(q.options?.length){ const list=element('datalist');list.id='answers-'+crypto.randomUUID();for(const option of q.options)list.append(new Option(option,option));box.append(list);input.setAttribute('list',list.id);} input.oninput=()=>{answers[q.id]=input.value;}; }
    const button=element('button','Отправить ответ','primary');button.onclick=async()=>{try{await api('/v1/interactions/'+encodeURIComponent(interaction.id),{method:'POST',body:JSON.stringify({conversationId:state.conversationID,answers})});await loadConversation();}catch(e){$('status').textContent=e.message;}};box.append(button);$('messages').append(box);
  }
}
void bootstrapWeb();

async function openDeviceSignOut() {
  const page=modalPage('Выйти на этом устройстве?','Сотрудники, переписка, файлы и расписания сохранятся на ваших устройствах. Команда продолжит работать, пока её Mac или сервер включён. Для возвращения понадобится новое приглашение.');
  page.actions.lastChild.textContent='Отмена';
  if($('draft').value.trim()) page.content.append(element('p','Черновик останется в этом браузере для повторного подключения к этой команде.'));
  const leave=action(page,'Выйти',async()=>{ saveDraft(); await api('/auth/logout',{method:'POST'}); clearInterval(state.refreshTimer); location.reload(); });
  if(state.owner && state.archiveVersion===1) action(page,'Сначала сохранить копию…',openSettings);
}
