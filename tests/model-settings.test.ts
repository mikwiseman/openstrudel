import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { MessageService } from '../src/messages.js';
import { normalizeModels, readModelSelection, saveModelSelection, readConversationModelSelection, saveConversationModelSelection, resolveModelSelection, validateModelSelection, recommendedModel, parseModelSelection, restrictedModelSelection } from '../src/model-settings.js';
const catalog = normalizeModels([
 {model:'m1',displayName:'Model One',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],serviceTiers:[{id:'priority',name:'Fast',description:'Increased usage'}]},
 {model:'m2',displayName:'Model Two',supportedReasoningEfforts:[{reasoningEffort:'medium'}],serviceTiers:[{id:'priority',name:'Fast'},{id:'ultra',name:'Ultra Fast'}]},
 {model:'hidden',hidden:true},
],null);
it('follows the account recommendation and falls back to GPT-6.1 Sol with Medium reasoning',()=>{
 const recommended=normalizeModels([{model:'preferred',isDefault:true,defaultReasoningEffort:'high'}],null);
 expect(recommendedModel(recommended)).toMatchObject({id:'preferred',defaultReasoningEffort:'high'});
 const unmarked=normalizeModels([{model:'other'},{model:'gpt-6.1-sol',defaultReasoningEffort:'low'}],null);
 expect(recommendedModel(unmarked)).toMatchObject({id:'gpt-6.1-sol',defaultReasoningEffort:'medium',isDefault:false});
 expect(recommendedModel([])).toMatchObject({id:'gpt-6.1-sol',defaultReasoningEffort:'medium'});
 const store=new Store(':memory:');
 try {
  expect(readModelSelection(store)).toEqual({provider:null,model:null,serviceTier:'default'});
  expect(resolveModelSelection(store,undefined,recommended)).toEqual({provider:'chatgpt',model:'preferred',serviceTier:'default'});
  saveModelSelection(store,{provider:'chatgpt',model:'chosen',serviceTier:'default'});
  expect(resolveModelSelection(store,undefined,recommended).model).toBe('chosen');
  expect(parseModelSelection({model:null,serviceTier:'default'},false)).toEqual({provider:null,model:null,serviceTier:'default'});
  saveModelSelection(store,{provider:null,model:null,serviceTier:'default'});
  expect(resolveModelSelection(store,undefined,[]).model).toBe('gpt-6.1-sol');
 } finally {store.close();}
});
it('uses the live catalog and managed speed restrictions, without inventing Ultra Fast',()=>{
 expect(catalog.map(m=>m.id)).toEqual(['m1','m2']);
 expect(catalog[0].speeds.map(s=>s.id)).toEqual(['default','priority']);
 expect(normalizeModels([{model:'m',serviceTiers:[{id:'priority',name:'Fast'},{id:'ultra',name:'Ultra Fast'}]}],{featureRequirements:{fast_mode:false}})[0].speeds.map(s=>s.id)).toEqual(['default']);
 expect(()=>validateModelSelection({model:'m1',serviceTier:'ultra'},catalog)).toThrow('скорость');
 expect(()=>validateModelSelection({model:'missing',serviceTier:'default'},catalog)).toThrow('модель');
});
it('reads a stored model without a provider as ChatGPT and resolves automatic to who is connected',()=>{
 const store=new Store(':memory:');
 try {
 store.setSetting('models.defaults',JSON.stringify({model:'gpt-6-sol',serviceTier:'priority'}));
 const legacy=store.createProfile({name:'Legacy',model:'gpt-6-luna'});
 expect(readModelSelection(store)).toEqual({provider:'chatgpt',model:'gpt-6-sol',serviceTier:'priority'});
 expect(readModelSelection(store,legacy.id)).toEqual({provider:'chatgpt',model:'gpt-6-luna',serviceTier:'default'});
 expect(resolveModelSelection(store,'main')).toEqual({provider:'chatgpt',model:'gpt-6-sol',serviceTier:'priority'});
 saveModelSelection(store,{provider:null,model:null,serviceTier:'priority'});
 expect(resolveModelSelection(store,'main')).toEqual({provider:'chatgpt',model:null,serviceTier:'priority'});
 store.setSetting('providers.kimi.key','kimi-key');store.setSetting('providers.xai.key','xai-key');
 expect(resolveModelSelection(store,'main')).toEqual({provider:'xai',model:'grok-4.7',serviceTier:'default'});
 store.setSetting('codex.auth.mode','managed');
 expect(resolveModelSelection(store,'main',catalog)).toEqual({provider:'chatgpt',model:'m1',serviceTier:'priority'});
 saveModelSelection(store,{provider:'kimi',model:'kimi-k2.7-code',serviceTier:'default'},legacy.id);
 expect(store.getProfile(legacy.id)).toMatchObject({provider:'kimi',model:'kimi-k2.7-code'});
 expect(resolveModelSelection(store,legacy.id)).toEqual({provider:'kimi',model:'kimi-k2.7-code',serviceTier:'default'});
 expect(parseModelSelection({provider:'xai',model:'grok-4.5',serviceTier:'default'},true)).toEqual({provider:'xai',model:'grok-4.5',serviceTier:'default'});
 expect(parseModelSelection({model:'gpt-6-sol',serviceTier:'default'},true)).toEqual({provider:'chatgpt',model:'gpt-6-sol',serviceTier:'default'});
 expect(parseModelSelection({provider:null,model:null,serviceTier:null},true)).toEqual({provider:null,model:null,serviceTier:null});
 expect(()=>parseModelSelection({provider:'elsewhere',model:'x',serviceTier:'default'},true)).toThrow();
 expect(()=>parseModelSelection({provider:'xai',model:null,serviceTier:'default'},false)).toThrow();
 }finally{store.close();}
});
it('inherits device defaults, keeps employee overrides and restores inheritance',()=>{
 const store=new Store(':memory:');
 try {
 const employee=store.createProfile({name:'Editor'});
 saveModelSelection(store,{provider:'chatgpt',model:'m1',serviceTier:'priority'});
 expect(resolveModelSelection(store,employee.id)).toEqual({provider:'chatgpt',model:'m1',serviceTier:'priority'});
 saveModelSelection(store,{provider:'chatgpt',model:'m2',serviceTier:'ultra'},employee.id);
 saveModelSelection(store,{provider:'chatgpt',model:'m1',serviceTier:'default'});
 expect(resolveModelSelection(store,employee.id)).toEqual({provider:'chatgpt',model:'m2',serviceTier:'ultra'});
 expect(store.getProfile(employee.id)).toMatchObject({model:'m2',serviceTier:'ultra'});
 saveModelSelection(store,{provider:null,model:null,serviceTier:null},employee.id);
 expect(readModelSelection(store,employee.id)).toEqual({provider:null,model:null,serviceTier:null});
 expect(resolveModelSelection(store,employee.id)).toEqual({provider:'chatgpt',model:'m1',serviceTier:'default'});
 expect(()=>saveModelSelection(store,{provider:'chatgpt',model:'m2',serviceTier:'default'},'missing')).toThrow();
 }finally{store.close();}
});
it('keeps a conversation override independent of the employee, sibling chats and device default',()=>{
 const store=new Store(':memory:');
 try {
  const employee=store.createProfile({name:'Editor'}),chat=store.profileConversation(employee.id);
  store.linkTelegramChat({chatId:'-42',title:'Team',allowedSenders:['42']});
  const sibling=store.bindTelegramChat('-42',employee.id);
  saveModelSelection(store,{provider:'chatgpt',model:'m1',serviceTier:'default'});
  saveModelSelection(store,{provider:'chatgpt',model:'m2',serviceTier:'ultra'},employee.id);
  expect(resolveModelSelection(store,employee.id,catalog,chat.id).model).toBe('m2');
  saveConversationModelSelection(store,chat.id,{provider:'chatgpt',model:'m1',serviceTier:'priority',reasoningEffort:'high'});
  expect(resolveModelSelection(store,employee.id,catalog,chat.id)).toMatchObject({model:'m1',serviceTier:'priority',reasoningEffort:'high'});
  expect(resolveModelSelection(store,employee.id,catalog,sibling.conversationId!)).toMatchObject({model:'m2',serviceTier:'ultra'});
  expect(readModelSelection(store,employee.id).model).toBe('m2');
  saveModelSelection(store,{provider:'chatgpt',model:'m2',serviceTier:'default'},employee.id);
  expect(resolveModelSelection(store,employee.id,catalog,chat.id).serviceTier).toBe('priority');
  saveConversationModelSelection(store,chat.id,{provider:null,model:null,serviceTier:null});
  expect(readConversationModelSelection(store,chat.id).model).toBeNull();
  expect(resolveModelSelection(store,employee.id,catalog,chat.id)).toMatchObject({model:'m2',serviceTier:'default'});
 } finally {store.close();}
});
it('upgrades an existing conversation database and keeps its choice after reopening',()=>{
 const directory=mkdtempSync(join(tmpdir(),'strudel-chat-model-')),path=join(directory,'home.db');
 let store=new Store(path);
 try {
  const id=store.primaryConversation().id;
  store.db.exec('ALTER TABLE conversations DROP COLUMN model_selection');store.close();
  store=new Store(path);
  expect(readConversationModelSelection(store,id).model).toBeNull();
  saveConversationModelSelection(store,id,{provider:'chatgpt',model:'m2',serviceTier:'ultra',reasoningEffort:'medium'});
  store.close();store=new Store(path);
  expect(resolveModelSelection(store,'main',catalog,id)).toEqual({provider:'chatgpt',model:'m2',serviceTier:'ultra',reasoningEffort:'medium'});
 } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

it('offers group chats only models their engine permits in groups',async()=>{
 const {OpenStrudelRuntime}=await import('../src/runtime.js');
 const subscription={...catalog[0],id:'grok-personal',provider:'grok',speeds:[{id:'default',name:'Standard',description:''}]};
 const runtime=new OpenStrudelRuntime({dbPath:':memory:',startTelegram:false,apiToken:'owner',engine:{models:async()=>[...catalog,subscription],run:async()=>({threadId:'t',response:'OK',events:[]})}});
 const addr=await runtime.api.listen('127.0.0.1',0);
 const call=(id:string,body?:any)=>fetch(`http://127.0.0.1:${addr.port}/v1/settings/models?conversationId=${id}`,{method:body?'POST':'GET',headers:{authorization:'Bearer owner','content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 try {
  runtime.store.setSetting('providers.grok.signedIn','yes');
  runtime.store.setSetting('providers.grok.models',JSON.stringify([subscription]));
  const group=runtime.store.getOrCreateConversation({channel:'telegram',externalId:'-42',title:'QA group'});
  const personal=runtime.store.primaryConversation();
  expect((await (await call(group.id)).json()).models.map((m:any)=>m.provider)).not.toContain('grok');
  expect((await (await call(personal.id)).json()).models.map((m:any)=>m.provider)).toContain('grok');
  expect((await call(group.id,{provider:'grok',model:'grok-personal',serviceTier:'default'})).status).toBe(409);
  expect(readConversationModelSelection(runtime.store,group.id).model).toBeNull();
 } finally {await runtime.stop();}
});
it('changes the next queued conversation turn and the Telegram turn, while leaving the running turn unchanged',async()=>{
 const store=new Store(':memory:'); let finish!:()=>void;const seen:any[]=[];
 const messages=new MessageService(store,{run:async(_input,options)=>{seen.push(options);if(seen.length===1)await new Promise<void>(r=>finish=r);return {threadId:'same-thread',response:'OK',events:[]};}});
 try {
  saveModelSelection(store,{provider:'chatgpt',model:'m1',serviceTier:'default'});
  const chat=store.primaryConversation();
  const first=await messages.submit({channel:'api',conversationId:chat.id,text:'First'});
  await vi.waitFor(()=>expect(seen).toHaveLength(1));
  saveConversationModelSelection(store,chat.id,{provider:'chatgpt',model:'m2',serviceTier:'ultra',reasoningEffort:'medium'});
  const next=await messages.submit({channel:'api',conversationId:chat.id,text:'Next'});
  finish();await Promise.all([first.completion,next.completion]);
  expect(seen[0]).toMatchObject({model:'m1',serviceTier:'default'});
  expect(seen[1]).toMatchObject({model:'m2',serviceTier:'ultra',threadId:'same-thread'});
  store.linkTelegramChat({chatId:'42',title:'Owner',allowedSenders:['42']});
  const telegram=store.getOrCreateConversation({channel:'telegram',externalId:'42',title:'Owner'});
  saveConversationModelSelection(store,telegram.id,{provider:'chatgpt',model:'m1',serviceTier:'priority'});
  await messages.handle({channel:'telegram',conversationId:telegram.id,text:'Hello',externalChatId:'42',telegramSenderId:'42',externalId:'42:one'});
  expect(seen[2]).toMatchObject({model:'m1',serviceTier:'priority'});
 } finally {await messages.close();store.close();}
});
it('validates conversation model writes and derives the employee from the chat',async()=>{
 const {OpenStrudelRuntime}=await import('../src/runtime.js');
 const runtime=new OpenStrudelRuntime({dbPath:':memory:',startTelegram:false,apiToken:'owner',engine:{models:async()=>catalog,run:async()=>({threadId:'t',response:'OK',events:[]})}});
 const addr=await runtime.api.listen('127.0.0.1',0);
 const call=(path:string,method='GET',body?:any,headers:any={authorization:'Bearer owner'})=>fetch(`http://127.0.0.1:${addr.port}${path}`,{method,headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
 try {
  const employee=runtime.store.createProfile({name:'QA'}),chat=runtime.store.profileConversation(employee.id),path='/v1/conversations/'+chat.id+'/model';
  saveModelSelection(runtime.store,{provider:'chatgpt',model:'m2',serviceTier:'ultra'},employee.id);
  expect((await (await call(path)).json()).defaults).toMatchObject({model:'m2',serviceTier:'ultra'});
  expect((await call(path,'POST',{model:'m1',serviceTier:'ultra'})).status).toBe(409);
  expect((await call(path,'POST',{model:'m1',serviceTier:'priority'})).status).toBe(200);
  expect((await call(path+'?agentId=main')).status).toBe(409);
  expect((await call(path+'?conversationId=other')).status).toBe(400);
  expect((await call('/v1/settings/models?conversationId=missing')).status).toBe(404);
  const session=await call('/auth/session','POST',{key:runtime.api.web.invite(false).key}),{csrf}=await session.json();
  const headers={cookie:session.headers.get('set-cookie')!.split(';')[0],'x-openstrudel-csrf':csrf};
  expect((await call(path,'POST',{model:null,serviceTier:null},headers)).status).toBe(403);
  expect((await call(path,'POST',{model:null,serviceTier:null})).status).toBe(200);
  expect((await (await call(path)).json()).effective).toMatchObject({model:'m2',serviceTier:'ultra'});
 } finally {await runtime.stop();}
});
it('applies the choice to the next queued turn, preserves the thread and covers Telegram',async()=>{
 const store=new Store(':memory:');let finish!:()=>void;const seen:any[]=[];
 const messages=new MessageService(store,{run:async(_input,options)=>{seen.push(options);if(seen.length===1)await new Promise<void>(r=>finish=r);return {threadId:'same-thread',response:'OK',events:[]};}});
 try {
 saveModelSelection(store,{provider:'chatgpt',model:'m1',serviceTier:'priority',reasoningEffort:'low'});
 const first=await messages.submit({channel:'api',text:'First',externalChatId:'home'});
 await vi.waitFor(()=>expect(seen).toHaveLength(1));
 saveModelSelection(store,{provider:'chatgpt',model:'m2',serviceTier:'default',reasoningEffort:'medium'});
 const next=await messages.submit({channel:'api',text:'Next',externalChatId:'home'});
 finish();await Promise.all([first.completion,next.completion]);
 expect(seen[0]).toMatchObject({model:'m1',serviceTier:'priority',reasoningEffort:'low'});
 expect(seen[1]).toMatchObject({model:'m2',serviceTier:'default',reasoningEffort:'medium',threadId:'same-thread'});
 await messages.handle({channel:'telegram',text:'Hi',externalChatId:'42',telegramSenderId:'42',externalId:'42:1'});
 expect(seen[2]).toMatchObject({model:'m2',serviceTier:'default',reasoningEffort:'medium'});
 }finally{store.close();}
});

it('delegated employees use their device defaults even when the main assistant has an override',async()=>{
 const store=new Store(':memory:');let seen:any;
 const messages=new MessageService(store,{run:async(_input,options)=>{seen=options;return {threadId:'t',response:'OK',events:[]};}});
 try {
 const employee=store.createProfile({name:'Editor'});
 saveModelSelection(store,{provider:'chatgpt',model:'m1',serviceTier:'priority'});
 saveModelSelection(store,{provider:'chatgpt',model:'m2',serviceTier:'default'},'main');
 await messages.handle({channel:'api',text:'Ask Editor',externalChatId:'home'});
 expect(seen).toMatchObject({model:'m2',serviceTier:'default'});
 expect(seen.employees.find((p:any)=>p.id===employee.id)).toMatchObject({model:'m1',serviceTier:'priority'});
 }finally{store.close();}
});

it('serves account capabilities, validates writes and denies members before changing preferences',async()=>{
 const {OpenStrudelRuntime}=await import('../src/runtime.js');
 const runtime=new OpenStrudelRuntime({dbPath:':memory:',startTelegram:false,apiToken:'owner',engine:{models:async()=>catalog,run:async()=>({threadId:'t',response:'OK',events:[]})}});
 const addr=await runtime.api.listen('127.0.0.1',0);
 const call=(path:string,method='GET',body?:any,headers:any={authorization:'Bearer owner'})=>fetch(`http://127.0.0.1:${addr.port}${path}`,{method,headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
 try{
 const employee=runtime.store.createProfile({name:'QA'});
 const defaults='/v1/settings/models',override=defaults+'?agentId='+employee.id;
 const initial=await (await call(defaults)).json();
 expect(initial.models).toEqual(catalog);
 expect(initial.selection).toEqual({provider:null,model:null,serviceTier:'default'});
 expect(initial.effective).toEqual({provider:'chatgpt',model:'m1',serviceTier:'default'});
 expect((await call(defaults,'POST',{model:'m1',serviceTier:'ultra'})).status).toBe(409);
 expect((await call(defaults,'POST',{model:'m1',serviceTier:'priority'})).status).toBe(200);
 expect((await (await call(override)).json()).effective).toEqual({provider:'chatgpt',model:'m1',serviceTier:'priority'});
 expect((await call(override,'POST',{model:'m2',serviceTier:'ultra'})).status).toBe(200);
 const session=await call('/auth/session','POST',{key:runtime.api.web.invite(false).key});const {csrf}=await session.json();
 const headers={cookie:session.headers.get('set-cookie')!.split(';')[0],'x-openstrudel-csrf':csrf};
 expect((await (await call(override,'GET',undefined,headers)).json()).canManage).toBe(false);
 expect((await call(override,'POST',{model:null,serviceTier:null},headers)).status).toBe(403);
 expect((await call(override,'POST',{model:null,serviceTier:null})).status).toBe(200);
 expect((await (await call(override)).json()).effective).toEqual({provider:'chatgpt',model:'m1',serviceTier:'priority'});
 expect((await call(defaults+'?agentId=missing')).status).toBe(404);
 expect((await call(defaults,'POST',{model:null,serviceTier:'priority'})).status).toBe(200);
 expect((await (await call(override)).json()).effective).toEqual({provider:'chatgpt',model:'m1',serviceTier:'priority'});
 expect((await call(defaults,'POST',{model:null,serviceTier:'ultra'})).status).toBe(409);
 }finally{await runtime.stop();}
});

it('lets an employee follow an automatic device default saved with a speed the automatic key provider lacks',async()=>{
 const {OpenStrudelRuntime}=await import('../src/runtime.js');
 const {providerInfo,providerModels}=await import('../src/providers.js');
 const runtime=new OpenStrudelRuntime({dbPath:':memory:',startTelegram:false,apiToken:'owner',engine:{models:async()=>[...catalog,...providerModels(providerInfo('anthropic')!)],run:async()=>({threadId:'t',response:'OK',events:[]})}});
 const addr=await runtime.api.listen('127.0.0.1',0);
 const call=(path:string,method='GET',body?:any)=>fetch(`http://127.0.0.1:${addr.port}${path}`,{method,headers:{'content-type':'application/json',authorization:'Bearer owner'},body:body===undefined?undefined:JSON.stringify(body)});
 try{
  // Saved as Automatic + Fast while ChatGPT was automatic; ChatGPT is gone and Anthropic is automatic now.
  saveModelSelection(runtime.store,{provider:null,model:null,serviceTier:'priority'});
  runtime.store.setSetting('providers.anthropic.key','ant-key');
  const employee=runtime.store.createProfile({name:'QA'}),override='/v1/settings/models?agentId='+employee.id;
  const inherited=await call(override,'POST',{provider:null,model:null,serviceTier:null});
  expect(inherited.status).toBe(200);
  expect((await inherited.json()).effective).toEqual({provider:'anthropic',model:'claude-fable-5-1',serviceTier:'default'});
  expect((await call('/v1/settings/models?agentId=main','POST',{provider:null,model:null,serviceTier:null})).status).toBe(200);
 }finally{await runtime.stop();}
});

it('validates reasoning against the chosen model and persists independent employee choices',()=>{
 const store=new Store(':memory:');
 try {
  const e=store.createProfile({name:'Analyst'});
  expect(catalog[0].reasoningEfforts?.map(e=>e.id)).toEqual(['low','high']);
  expect(()=>validateModelSelection({model:'m2',serviceTier:'default',reasoningEffort:'high'},catalog)).toThrow('обдумывания');
  expect(()=>validateModelSelection({model:'m1',serviceTier:'default',reasoningEffort:'high'},catalog)).not.toThrow();
  expect(()=>parseModelSelection({model:'m1',serviceTier:'default',reasoningEffort:123},false)).toThrow();
  expect(normalizeModels([{model:'no-support'}],null)[0].reasoningEfforts).toEqual([]);
  saveModelSelection(store,{provider:'chatgpt',model:'m1',serviceTier:'default',reasoningEffort:'low'});
  expect(resolveModelSelection(store,e.id).reasoningEffort).toBe('low');
  const override=parseModelSelection({provider:'chatgpt',model:'m1',serviceTier:'default',reasoningEffort:'high'},true);
  saveModelSelection(store,override,e.id);
  expect(readModelSelection(store,e.id)).toEqual(override);
  expect(store.getProfile(e.id)?.reasoningEffort).toBe('high');
  saveModelSelection(store,{provider:null,model:null,serviceTier:null},e.id);
  expect(store.getProfile(e.id)?.reasoningEffort).toBeUndefined();
  expect(resolveModelSelection(store,e.id).reasoningEffort).toBe('low');
 } finally {store.close();}
});

it('saves an ordered device reserve, validates atomically, and preserves it for older clients', async()=>{
 const {OpenStrudelRuntime}=await import('../src/runtime.js');
 const {providerModels,providerInfo}=await import('../src/providers.js');
 const runtime=new OpenStrudelRuntime({dbPath:':memory:',startTelegram:false,apiToken:'owner',engine:{models:async()=>[...catalog,...providerModels(providerInfo('xai')!)],run:async()=>({threadId:'t',response:'OK',events:[]})}});
 runtime.store.setSetting('providers.xai.key','xai-key');
 const addr=await runtime.api.listen('127.0.0.1',0);
 const call=(body?:any,path='/v1/settings/models')=>fetch(`http://127.0.0.1:${addr.port}${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json',authorization:'Bearer owner'},body:body&&JSON.stringify(body)});
 const first={provider:'chatgpt',model:'m1',serviceTier:'default'}, reserve={provider:'xai',model:'grok-4.7',serviceTier:'default'};
 try {
  let response=await call({...first,fallbacks:[reserve]});expect(response.status).toBe(200);
  expect((await response.json()).fallbacks).toEqual([reserve]);
  response=await call({...first,model:'m2',fallbacks:[{...reserve,model:'missing'}]});expect(response.status).toBe(409);
  expect((await (await call()).json()).selection.model).toBe('m1');
  expect((await call({...first,fallbacks:[reserve,reserve]})).status).toBe(400);
  expect((await call({...first,fallbacks:[first]})).status).toBe(400);
  expect((await call({...first,fallbacks:[reserve]},'/v1/settings/models?agentId=main')).status).toBe(400);
  await call({...first,model:'m2'});
  expect((await (await call()).json()).fallbacks).toEqual([reserve]);
  await call({...first,fallbacks:[]});expect((await (await call()).json()).fallbacks).toEqual([]);
 }finally{await runtime.stop();}
});

it('keeps Fast for direct chats on by default, saves the switch on the device only, and shows it in direct chats', async()=>{
 const {OpenStrudelRuntime}=await import('../src/runtime.js');
 const runtime=new OpenStrudelRuntime({dbPath:':memory:',startTelegram:false,apiToken:'owner',engine:{models:async()=>catalog,run:async()=>({threadId:'t',response:'OK',events:[]})}});
 const addr=await runtime.api.listen('127.0.0.1',0);
 const call=(path:string,body?:any)=>fetch(`http://127.0.0.1:${addr.port}${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json',authorization:'Bearer owner'},body:body&&JSON.stringify(body)});
 const device={provider:'chatgpt',model:'m1',serviceTier:'default'};
 try {
  const direct=runtime.store.primaryConversation().id, group=runtime.store.getOrCreateConversation({channel:'telegram',externalId:'-42',title:'QA group'}).id;
  expect((await (await call('/v1/settings/models')).json()).directFast).toBe(true);
  await call('/v1/settings/models',device);
  const tier=async(id:string)=>(await (await call('/v1/conversations/'+id+'/model')).json()).effective.serviceTier;
  expect([await tier(direct),await tier(group)]).toEqual(['priority','default']);
  // The chat envelope's model is the clients' cue to refresh the model control.
  const envelope=async()=>(await (await call('/v1/conversation')).json()).conversation.effectiveModel.serviceTier;
  expect(await envelope()).toBe('priority');
  expect((await call('/v1/settings/models?agentId=main',{provider:null,model:null,serviceTier:null,directFast:false})).status).toBe(400);
  expect((await call('/v1/settings/models',{...device,directFast:'no'})).status).toBe(400);
  const saved=await (await call('/v1/settings/models',{...device,directFast:false})).json();
  expect([saved.directFast,saved.selection]).toEqual([false,device]);
  expect([await tier(direct),await envelope()]).toEqual(['default','default']);
  expect((await (await call('/v1/settings/models',{...device,directFast:true})).json()).directFast).toBe(true);
 }finally{await runtime.stop();}
});

it('runs restricted chats at the device level and Fast by default; the device owner can change or reset it', async()=>{
 const {OpenStrudelRuntime}=await import('../src/runtime.js');
 const runtime=new OpenStrudelRuntime({dbPath:':memory:',startTelegram:false,apiToken:'owner',engine:{models:async()=>catalog,run:async()=>({threadId:'t',response:'OK',events:[]})}});
 const addr=await runtime.api.listen('127.0.0.1',0);
 const call=(path:string,body?:any)=>fetch(`http://127.0.0.1:${addr.port}${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json',authorization:'Bearer owner'},body:body&&JSON.stringify(body)});
 const device={provider:'chatgpt',model:'m1',serviceTier:'default'};
 try {
  const family=runtime.store.getOrCreateConversation({channel:'telegram',externalId:'-42::restricted',title:'Family'}).id;
  expect((await (await call('/v1/settings/models')).json()).restricted).toEqual({reasoningEffort:null,fast:true});
  expect((await call('/v1/settings/models?agentId=main',{provider:null,model:null,serviceTier:null,restricted:{reasoningEffort:'high',fast:false}})).status).toBe(400);
  for (const restricted of [{reasoningEffort:'LOW',fast:true},{reasoningEffort:'low'},{fast:true},'fast'])
   expect((await call('/v1/settings/models',{...device,restricted})).status).toBe(400);
  // The level must exist for the device model: m1 offers Low and High only.
  expect((await call('/v1/settings/models',{...device,restricted:{reasoningEffort:'medium',fast:true}})).status).toBe(409);
  const saved=await (await call('/v1/settings/models',{...device,restricted:{reasoningEffort:'high',fast:false}})).json();
  expect(saved.restricted).toEqual({reasoningEffort:'high',fast:false});
  expect(restrictedModelSelection(runtime.store,family)).toMatchObject({provider:'chatgpt',model:'m1',reasoningEffort:'high',fast:false});
  // The device's own level stays when the restricted level is null.
  await call('/v1/settings/models',{...device,reasoningEffort:'low',restricted:{reasoningEffort:null,fast:true}});
  expect(restrictedModelSelection(runtime.store,family)).toMatchObject({model:'m1',reasoningEffort:'low',fast:true});
  expect((await (await call('/v1/settings/models',{...device,restricted:null})).json()).restricted).toEqual({reasoningEffort:null,fast:true});
  expect(runtime.store.getSetting('models.restricted')).toBeNull();
 }finally{await runtime.stop();}
});
