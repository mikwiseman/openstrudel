/* Local assets and stable identities; choosing an appearance never changes instructions. */
const agentKinds = ['coil','fold','knot','curl','wave','pillow'];
const agentKindNames = ['Завиток','Конвертик','Узелок','Рогалик','Волна','Подушечка'];
const agentTones = ['Абрикос','Мёд','Фисташка','Мята','Небо','Черника','Сирень','Малина'];
const agentAngles = [0,32,72,125,180,215,255,315];
function agentAppearance(profile) {
  const value=profile.appearance;
  if(value?.version===1 && agentKinds.includes(value.kind) && Number.isInteger(value.tone) && value.tone>=0 && value.tone<8) return {...value};
  let hash=2166136261;
  for(const byte of new TextEncoder().encode(profile.id)) hash=Math.imul(hash^byte,16777619)>>>0;
  return {version:1,kind:agentKinds[hash%6],tone:Math.floor(hash/6)%8};
}
function characterImage(appearance, size=38) {
  const img=document.createElement('img'); img.src='/characters/'+appearance.kind+'.png';
  img.alt=''; img.width=img.height=size; img.className='agent-character'; img.draggable=false;
  img.style.cssText=`width:${size}px;height:${size}px;object-fit:contain;flex:none;filter:hue-rotate(${agentAngles[appearance.tone]}deg)`;
  return img;
}
function paintAgentAvatar(root, profile, size=38) {
  root.replaceChildren(); root.className=profile?'avatar character':'avatar mark';
  if(profile) root.append(characterImage(agentAppearance(profile),size));
}
function appearanceEditor(initial) {
  let selected={...initial};
  const root=document.createElement('section'); root.className='appearance-editor';
  root.setAttribute('aria-label','Образ сотрудника');
  const render=()=>{
    root.replaceChildren();
    const heading=document.createElement('div'); heading.className='appearance-heading';
    const name=document.createElement('strong'); name.textContent='Образ';
    const shuffle=document.createElement('button'); shuffle.className='secondary'; shuffle.textContent='Другой'; shuffle.setAttribute('aria-label','Случайный образ');
    shuffle.onclick=()=>{ const random=crypto.getRandomValues(new Uint32Array(1))[0]; const n=(agentKinds.indexOf(selected.kind)*8+selected.tone+1+random%47)%48; selected={version:1,kind:agentKinds[Math.floor(n/8)],tone:n%8}; render();root.querySelector('[aria-label="Случайный образ"]').focus(); };
    heading.append(name,shuffle); root.append(heading);
    const kinds=document.createElement('div'); kinds.className='character-choices'; kinds.setAttribute('role','group'); kinds.setAttribute('aria-label','Персонаж');
    agentKinds.forEach((kind,index)=>{
      const button=document.createElement('button'); button.className='character-choice'; button.setAttribute('aria-label',agentKindNames[index]);button.setAttribute('aria-pressed',String(selected.kind===kind));
      button.append(characterImage({...selected,kind},52));button.onclick=()=>{selected.kind=kind;render();root.querySelector(`[aria-label="${agentKindNames[index]}"]`).focus();}; kinds.append(button);
    }); root.append(kinds);
    const tones=document.createElement('div'); tones.className='tone-choices'; tones.setAttribute('role','group'); tones.setAttribute('aria-label','Цвет');
    agentTones.forEach((label,tone)=>{
      const button=document.createElement('button'); button.className='tone-choice'; button.setAttribute('aria-label',label);button.setAttribute('aria-pressed',String(selected.tone===tone));
      const swatch=document.createElement('span');swatch.className='tone-swatch'; swatch.style.filter=`hue-rotate(${agentAngles[tone]}deg)`;swatch.textContent=selected.tone===tone?'✓':'';
      button.append(swatch);button.onclick=()=>{selected.tone=tone;render();root.querySelector(`[aria-label="${label}"]`).focus();};tones.append(button);
    });root.append(tones);
  };render();return {root,value:()=>({...selected})};
}
