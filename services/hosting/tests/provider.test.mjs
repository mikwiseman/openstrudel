import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Kamatera, ProviderError, bootstrapScript, commandId, publicIPv4, runCommand } from '../src/providers.mjs';
import { PRICE_SOURCE, pricingCatalog, pricingBody } from './fixtures/kamatera-pricing.mjs';

// Shapes captured from the production read-only API on 2026-10-04.
// Every network call in this file is mocked. No real credentials are loaded.
const IMAGE='EU:7a74bdc0c8034ce9a1fd28d8ed91f8f5';
const LOCAL_ID='11111111-1111-4111-8111-111111111111';
const PROVIDER_ID='22222222-2222-4222-8222-222222222222';
const NAME='wai-vds-'+LOCAL_ID.replaceAll('-','');
const IP='93.184.216.34';
const wireKey=Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from('ssh-ed25519'),Buffer.from([0,0,0,32]),Buffer.alloc(32,7)]);
const PUBLIC_KEY='ssh-ed25519 '+wireKey.toString('base64');
const SERVER={id:LOCAL_ID,provider_name:NAME,provider_id:PROVIDER_ID,public_key:PUBLIC_KEY+' wai-vds',
  private_key:'encrypted-test-fixture',ip:IP,purpose:'clean',host_key:null};
const IMAGE_LIST=[{id:IMAGE,description:'ubuntu_server_26.04_64-bit',sizeGB:10,additionalDisks:[],
  minRequirements:{minCpu:1,minRamMB:1024,minDiskSize:5}}];
const OPTIONS={datacenter:'EU',image:IMAGE,cpu:['1A','2A','1B'],ram:{A:[1024,2048,4096]},disk:[10,15,20,30],
  billing:['monthly','hourly'],traffic:[{id:49,info:'50Mbit/Sec, Unmetered',name:'b50'},{id:3,info:'5000GB of traffic',name:'t5000'}],
  imageRequirements:{minCpu:1,minRamMb:1024,minDiskSize:10,lanAssignment:false,wanAssignment:false}};
const DETAILS={id:PROVIDER_ID,datacenter:'EU',name:NAME,cpu:'1A',ram:2048,power:'on',diskSizes:[20],
  networks:[{network:'wan-eu',ips:[IP]}],billing:'monthly',traffic:'t5000',managed:'0',backup:'0'};
const CONFIG={kamateraId:'test-client-id',kamateraSecret:'test-secret-not-real',region:'EU',approvedImage:IMAGE,
  allowPaid:'I_APPROVE_KAMATERA_SPEND',maxMonthly:10,maxServers:1};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
const code=(name,definitive)=>error=>error instanceof ProviderError&&error.code===name&&
  (definitive===undefined||error.definitive===definitive);

function fixture(t,{config={},routes={},vault={},runner,owned=false}={}) {
  const calls=[],unexpected=[];
  const handlers={
    'POST /authenticate':()=>response({authentication:'test-bearer-not-real'}),
    'GET /server/options/images/EU':()=>response(IMAGE_LIST),
    ['GET /server/options/image/'+encodeURIComponent(IMAGE)]:()=>response(OPTIONS),
    'GET /servers':()=>response(owned?[{id:PROVIDER_ID,name:NAME,datacenter:'EU',power:'on'}]:[]),
    ['GET /server/'+PROVIDER_ID]:()=>response(DETAILS),
    ...routes,
  };
  const fetcher=async(url,options)=>{
    if(url===PRICE_SOURCE)return new Response(pricingBody(pricingCatalog()));
    assert.equal(new URL(url).origin,'https://console.kamatera.com');
    const path=new URL(url).pathname.slice('/service'.length);
    const call={path,...options};calls.push(call);
    const handler=handlers[options.method+' '+path];
    if(!handler){unexpected.push(options.method+' '+path);throw Error('Unexpected mock request');}
    return handler(call);
  };
  t.after(()=>assert.deepEqual(unexpected,[],'No undocumented endpoint or verb may be called'));
  return {provider:new Kamatera({...CONFIG,...config},vault,{fetcher,runner}),calls,handlers};
}

function vaultFixture(t) {
  const base=resolve('work');mkdirSync(base,{recursive:true});
  const dir=mkdtempSync(join(base,'provider-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const {privateKey}=generateKeyPairSync('ed25519');
  return {dir,signing:privateKey,signature:script=>sign(null,Buffer.from(script),privateKey),
    open:(encrypted,aad)=>{assert.equal(encrypted,SERVER.private_key);assert.equal(aad,LOCAL_ID);return 'TEST PRIVATE KEY, NOT A REAL CREDENTIAL';}};
}

test('current native image options admit the intended profile and cache one authentication',async t=>{
  const {provider,calls}=fixture(t);
  const {price,...availability}=await provider.preflight();
  assert.deepEqual(availability,{available:true,mode:'kamatera',image:IMAGE,capacityGuaranteed:false});
  assert.equal(price.baseMonthlyUsd,6);assert.equal(price.monthlyUsdWithAdministrationFee,6.12);
  await provider.list();
  assert.equal(calls.filter(c=>c.path==='/authenticate').length,1);
  assert.ok(calls.slice(1).every(c=>c.headers.Authorization==='Bearer test-bearer-not-real'));
  assert.ok(calls.every(c=>c.redirect==='error'&&c.signal instanceof AbortSignal));
  assert.equal(calls[0].headers.Authorization,undefined);
  assert.deepEqual(JSON.parse(calls[0].body),{clientId:CONFIG.kamateraId,secret:CONFIG.kamateraSecret});
});

test('Home profile uses its own 4/30 price, canonical image and separate before-POST approval',async t=>{
  const HOME='EU:6000c29549da189eaef6ea8a31001a34',catalog=pricingCatalog(HOME.slice(3));
  catalog['ramMB.A'][0].options=[{value:'4096',price:6}];catalog.diskGB[0].options=[{value:'30',price:8}];
  const calls=[];const c={...CONFIG,homeImage:HOME,homeLiveApproval:'',maxMonthly:15};
  const p=new Kamatera(c,{}, {fetcher:async(url,o)=>{
    calls.push({url,method:o.method,body:o.body});
    if(url===PRICE_SOURCE)return new Response(pricingBody(catalog));
    if(url.endsWith('/authenticate'))return response({authentication:'mock-home-auth'});
    if(url.endsWith('/servers'))return response([]);
    if(url.endsWith('/server/options/images/EU'))return response([{...IMAGE_LIST[0],id:'EU:6000C29549da189eaef6ea8a31001a34',description:'ubuntu_server_24.04_64-bit'}]);
    if(url.includes('/server/options/image/'))return response({...OPTIONS,image:HOME});
    if(url.endsWith('/server')&&o.method==='POST')return response(12345);
    throw Error('unexpected');
  }});
  const server={...SERVER,provider_id:null,purpose:'openstrudel_home'};
  await assert.rejects(p.create(server),code('home_launch_not_approved',true));assert.equal(calls.length,0);
  const estimate=await p.preflight('openstrudel-home-v1');assert.equal(estimate.price.monthlyUsdWithAdministrationFee,14.28);assert.equal(estimate.price.profile.ramMb,4096);assert.equal(estimate.price.profile.diskGb,30);
  c.homeLiveApproval='I_APPROVE_OPENSTRUDEL_HOME_SPEND';c.maxMonthly=10;await assert.rejects(p.create(server),code('budget_approval_required',true));
  c.maxMonthly=15;await p.create(server);const writes=calls.filter(x=>x.method==='POST'&&x.url.endsWith('/server'));assert.equal(writes.length,1);const body=JSON.parse(writes[0].body);assert.equal(body.ram,4096);assert.equal(body.disk_size_0,30);assert.equal(body.disk_src_0,HOME);
  await assert.rejects(p.create(server,{beforePost:()=>{throw new ProviderError('home_launch_not_approved',true);}}));assert.equal(calls.filter(x=>x.url.endsWith('/server')).length,1);
});

test('both native RAM minimum spellings and image disk size prevent incompatible provisioning',async t=>{
  for(const [label,patch] of [
    ['list minRamMB',{list:{minRequirements:{minCpu:1,minRamMB:4096,minDiskSize:5}}}],
    ['option minRamMb',{options:{imageRequirements:{minCpu:1,minRamMb:4096,minDiskSize:10}}}],
    ['image disk size',{list:{sizeGB:40}}],
    ['extra image disks',{list:{additionalDisks:[20]}}],
    ['malformed minimum',{options:{imageRequirements:{minCpu:'unknown'}}}],
  ])await t.test(label,async st=>{
    const {provider,calls}=fixture(st,{routes:{
      'GET /server/options/images/EU':()=>response([{...IMAGE_LIST[0],...patch.list}]),
      ['GET /server/options/image/'+encodeURIComponent(IMAGE)]:()=>response({...OPTIONS,...patch.options}),
    }});
    await assert.rejects(provider.preflight(),code('image_requirements_changed',true));
    assert.ok(!calls.some(c=>c.path==='/server'));
  });
});

test('real profile choices must include RAM, storage, monthly billing and the named traffic package',async t=>{
  for(const [label,patch] of [
    ['CPU',{cpu:['1B']}],['RAM',{ram:{A:[1024]}}],['disk',{disk:[10,15]}],
    ['billing',{billing:['hourly']}],['traffic',{traffic:[{id:3,name:'t1000'}]}],
    ['wrong region',{datacenter:'US-NY2'}],['wrong image',{image:'EU:wrong'}],
  ])await t.test(label,async st=>{
    const {provider}=fixture(st,{routes:{['GET /server/options/image/'+encodeURIComponent(IMAGE)]:()=>response({...OPTIONS,...patch})}});
    await assert.rejects(provider.preflight(),code('profile_unavailable',true));
  });
});

test('unapproved or cross-region images are refused before authentication',async t=>{
  for(const approvedImage of [undefined,'US-NY2:other'])await t.test(String(approvedImage),async st=>{
    const {provider,calls}=fixture(st,{config:{approvedImage}});
    await assert.rejects(provider.preflight(),code('image_not_approved',true));assert.equal(calls.length,0);
  });
});

test('the explicitly approved create sends exactly one native paid POST with real schema fields',async t=>{
  const {provider,calls}=fixture(t,{routes:{'POST /server':()=>response(210910168)}});
  assert.deepEqual(await provider.create({...SERVER,provider_id:null}),{commandId:'210910168'});
  const writes=calls.filter(c=>c.path==='/server');assert.equal(writes.length,1);
  const body=JSON.parse(writes[0].body);
  assert.deepEqual({...body,password:'redacted'},
    {name:NAME,datacenter:'EU',disk_src_0:IMAGE,cpu:'1A',ram:2048,disk_size_0:20,network_name_0:'wan',
      selectedSSHKeyValue:SERVER.public_key+'\n',password:'redacted',billing:'monthly',traffic:'t5000',power:true,backup:false,managed:false});
  assert.ok(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z\d]{14,32}$/.test(body.password));
});

test('missing approval, invalid budget, invalid cap and invalid SSH keys cannot make a paid request',async t=>{
  for(const [label,config,server,expected] of [
    ['approval',{allowPaid:''},{},'budget_approval_required'],
    ['NaN budget',{maxMonthly:NaN},{},'budget_approval_required'],
    ['infinite budget',{maxMonthly:Infinity},{},'budget_approval_required'],
    ['zero budget',{maxMonthly:0},{},'budget_approval_required'],
    ['invalid cap',{maxServers:NaN},{},'server_limit'],
    ['multiple keys',{}, {public_key:PUBLIC_KEY+'\n'+PUBLIC_KEY},'invalid_ssh_key'],
    ['malformed key',{}, {public_key:'ssh-ed25519 AAAA'},'invalid_ssh_key'],
  ])await t.test(label,async st=>{
    const {provider,calls}=fixture(st,{config});
    await assert.rejects(provider.create({...SERVER,provider_id:null,...server}),code(expected,true));
    assert.equal(calls.length,0);
  });
});

test('an existing exact name enters reconciliation even at the cap; unrelated VPN machines are not counted',async t=>{
  const {provider,calls,handlers}=fixture(t,{owned:true});
  await assert.rejects(provider.create({...SERVER,provider_id:null}),code('provider_name_exists',false));
  assert.ok(!calls.some(c=>c.path==='/server'));
  handlers['GET /servers']=()=>response([{name:'wai-vpn-amsterdam',id:PROVIDER_ID}]);
  handlers['POST /server']=()=>response('210910168');
  await provider.create({...SERVER,provider_id:null});
  assert.equal(calls.filter(c=>c.path==='/server').length,1);
});

test('server cap blocks another WAI VDS machine without blocking or mutating VPN inventory',async t=>{
  const {provider,calls}=fixture(t,{routes:{'GET /servers':()=>response([{name:'wai-vds-other',id:PROVIDER_ID}])}});
  await assert.rejects(provider.create({...SERVER,provider_id:null}),code('server_limit',true));
  assert.ok(!calls.some(c=>['PUT','DELETE'].includes(c.method)||c.path==='/server'));
});

test('create transport failure, malformed response, redirect and server error never retry the POST',async t=>{
  for(const [label,handler,expected] of [
    ['timeout',()=>{throw Error('contains an imaginary provider secret');},'unknown_result'],
    ['redirect',()=>{throw new TypeError('fetch failed: unexpected redirect');},'unknown_result'],
    ['bad JSON',()=>new Response('private provider diagnostic',{status:200}),'unknown_response'],
    ['HTTP 500',()=>response({password:'never surface this'},500),'provider_http_500'],
    ['multiple command IDs',()=>response([1,2]),'unknown_response'],
  ])await t.test(label,async st=>{
    const {provider,calls}=fixture(st,{routes:{'POST /server':handler}});
    let error;try{await provider.create({...SERVER,provider_id:null});}catch(e){error=e;}
    assert.ok(code(expected,false)(error));assert.equal(error.message,expected);
    assert.equal(calls.filter(c=>c.method==='POST'&&c.path==='/server').length,1);
  });
});

test('balance and authentication failures are definitive but never disclose response bodies',async t=>{
  const {provider,calls,handlers}=fixture(t,{routes:{'POST /server':()=>response({secret:'redact this'},402)}});
  await assert.rejects(provider.create({...SERVER,provider_id:null}),code('balance',true));
  handlers['GET /servers']=()=>response({error:'private-account-error'},401);
  await assert.rejects(provider.list(),code('provider_http_401',true));
  assert.equal(provider.auth,null);
  handlers['GET /servers']=()=>response([]);await provider.list();
  assert.equal(calls.filter(c=>c.path==='/authenticate').length,2);
});

test('read timeouts are retryable reads, not a definitive empty inventory',async t=>{
  const {provider,calls}=fixture(t,{routes:{'GET /servers':()=>{throw Error('connection timed out');}}});
  await assert.rejects(provider.list(),code('read_unavailable',false));
  assert.equal(calls.filter(c=>c.path==='/servers').length,1);
});

test('ownership requires a canonical provider UUID and a name derived from the persisted local UUID',async t=>{
  for(const bad of [
    {...SERVER,provider_id:'------------------------------------'},
    {...SERVER,provider_name:'wai-vpn-amsterdam'},
    {...SERVER,id:'33333333-3333-4333-8333-333333333333'},
    {...SERVER,provider_id:PROVIDER_ID+'/terminate'},
  ])await t.test(JSON.stringify({id:bad.id,name:bad.provider_name,provider:bad.provider_id}),async st=>{
    const {provider,calls}=fixture(st,{owned:true});
    await assert.rejects(provider.remove(bad),code('ownership_guard',true));assert.equal(calls.length,0);
  });
});

test('same-name duplicates and mismatched inventory UUIDs refuse every mutation',async t=>{
  for(const inventory of [
    [{name:NAME,id:'33333333-3333-4333-8333-333333333333'}],
    [{name:NAME,id:PROVIDER_ID},{name:NAME,id:PROVIDER_ID}],[],
  ])await t.test(String(inventory.length)+' records',async st=>{
    const {provider,calls}=fixture(st,{routes:{'GET /servers':()=>response(inventory)}});
    await assert.rejects(provider.poweroff(SERVER),code('ownership_guard',true));
    assert.ok(!calls.some(c=>['PUT','DELETE'].includes(c.method)));
  });
});

test('details parse the native networks[].ips[] shape and require matching identity',async t=>{
  const {provider,handlers}=fixture(t,{owned:true});
  assert.deepEqual(await provider.details(SERVER),{id:PROVIDER_ID,name:NAME,ip:IP,state:'running'});
  handlers['GET /server/'+PROVIDER_ID]=()=>response({...DETAILS,networks:[{network:'private',ips:['8.8.8.8']},{network:'wan-eu',ips:['10.0.0.1',IP]}]});
  assert.equal((await provider.details(SERVER)).ip,IP);
  handlers['GET /server/'+PROVIDER_ID]=()=>response({...DETAILS,networks:[{network:'wan-eu',ips:IP}]});
  assert.equal((await provider.details(SERVER)).ip,undefined,'A string is not a list of provider IPs');
  handlers['GET /server/'+PROVIDER_ID]=()=>response({...DETAILS,id:'33333333-3333-4333-8333-333333333333'});
  await assert.rejects(provider.details(SERVER),code('details_invalid'));
});

test('poweroff uses native PUT and does not send a no-op when already off',async t=>{
  const {provider,calls,handlers}=fixture(t,{owned:true,routes:{['PUT /server/'+PROVIDER_ID+'/power']:()=>response(210911605)}});
  await provider.poweroff(SERVER);
  const write=calls.find(c=>c.method==='PUT');assert.deepEqual(JSON.parse(write.body),{power:'off'});
  handlers['GET /server/'+PROVIDER_ID]=()=>response({...DETAILS,power:'off'});
  assert.equal(await provider.poweroff(SERVER),null);
  assert.equal(calls.filter(c=>c.method==='PUT').length,1);
});

test('terminate uses DELETE with confirm=1 only after fresh off-state verification',async t=>{
  const {provider,calls,handlers}=fixture(t,{owned:true,routes:{['DELETE /server/'+PROVIDER_ID+'/terminate']:()=>response(210912241)}});
  await assert.rejects(provider.remove(SERVER),code('server_must_be_off',true));
  assert.equal(calls.filter(c=>c.method==='DELETE').length,0);
  handlers['GET /server/'+PROVIDER_ID]=()=>response({...DETAILS,power:'off'});
  await provider.remove(SERVER);
  assert.deepEqual(JSON.parse(calls.find(c=>c.method==='DELETE').body),{confirm:1});
  handlers['DELETE /server/'+PROVIDER_ID+'/terminate']=()=>{throw Error('timeout after acceptance');};
  await assert.rejects(provider.remove(SERVER),code('unknown_result',false));
  assert.equal(calls.filter(c=>c.method==='DELETE').length,2,'One request for each explicit call, no retries');
});

test('unknown power state does not justify power or delete mutations',async t=>{
  const {provider,calls}=fixture(t,{owned:true,routes:{['GET /server/'+PROVIDER_ID]:()=>response({...DETAILS,power:'provisioning'})}});
  await assert.rejects(provider.poweroff(SERVER),code('power_state_unknown'));
  await assert.rejects(provider.remove(SERVER),code('server_must_be_off',true));
  assert.ok(!calls.some(c=>['PUT','DELETE'].includes(c.method)));
});

test('SSH refuses nonpublic addresses and stale IPs before key extraction or process execution',async t=>{
  let executions=0;const vault={open:()=>{throw Error('Key must not be decrypted');}};
  const {provider,calls}=fixture(t,{owned:true,vault,runner:()=>{executions++;}});
  for(const ip of ['127.0.0.1','169.254.169.254','10.0.0.1','192.0.2.15','100.64.0.1','::1','example.com'])
    await assert.rejects(provider.ssh({...SERVER,ip},'true'),code('invalid_public_ip'));
  assert.equal(calls.length,0);
  await assert.rejects(provider.ssh({...SERVER,ip:'8.8.8.8'},'true'),code('provider_ip_changed'));
  assert.equal(executions,0);
});

test('SSH pins the API-bound host and uses only the per-server key, without user SSH configuration or agent',async t=>{
  const vault=vaultFixture(t),executions=[];
  const runner=async(file,args,options)=>{
    executions.push({file,args,options});
    if(file==='ssh-keyscan')return {stdout:IP+' '+PUBLIC_KEY+'\n'};
    assert.equal(file,'ssh');
    const key=args[args.indexOf('-i')+1];
    assert.equal(statSync(key).mode&0o777,0o600);
    assert.ok(readFileSync(key,'utf8')==='TEST PRIVATE KEY, NOT A REAL CREDENTIAL');
    assert.ok(dirname(key).startsWith(vault.dir));
    const known=args.find(x=>x.startsWith('UserKnownHostsFile=')).split('=')[1];
    assert.equal(readFileSync(known,'utf8'),IP+' '+PUBLIC_KEY+'\n');
    assert.equal(options.input,'printf fixture');
    return {stdout:'fixture'};
  };
  const {provider}=fixture(t,{owned:true,vault,runner});
  const first=await provider.ssh(SERVER,'printf fixture');
  assert.equal(first.hostKey,IP+' '+PUBLIC_KEY);
  const args=executions.find(x=>x.file==='ssh').args;
  assert.deepEqual(args.slice(0,2),['-F','/dev/null']);
  for(const option of ['IdentityAgent=none','IdentitiesOnly=yes','ForwardAgent=no','BatchMode=yes','StrictHostKeyChecking=yes','GlobalKnownHostsFile=/dev/null'])
    assert.ok(args.includes(option));
  assert.deepEqual(args.slice(-3),['root@'+IP,'sh','-s']);
  await provider.ssh({...SERVER,host_key:first.hostKey},'printf fixture');
  assert.equal(executions.filter(x=>x.file==='ssh-keyscan').length,1,'Pinned keys are not silently replaced');
  assert.deepEqual(readdirSync(vault.dir),[],'Decrypted temporary keys are removed after both sessions');
});

test('invalid host-key records and SSH failure remove temporary key files',async t=>{
  const vault=vaultFixture(t);
  const {provider}=fixture(t,{owned:true,vault,runner:async()=>{throw new ProviderError('ssh_or_setup_failed');}});
  await assert.rejects(provider.ssh({...SERVER,host_key:'* '+PUBLIC_KEY},'true'),code('ssh_host_key_invalid'));
  assert.deepEqual(readdirSync(vault.dir),[]);
  await assert.rejects(provider.ssh({...SERVER,host_key:IP+' '+PUBLIC_KEY},'true'),code('ssh_or_setup_failed'));
  assert.deepEqual(readdirSync(vault.dir),[]);
});

test('bootstrap envelope signature covers the exact selected script before execution',async t=>{
  const vault=vaultFixture(t);let envelope;
  const {provider}=fixture(t,{owned:true,vault,runner:async(file,args,options)=>{assert.equal(file,'ssh');envelope=options.input;return {stdout:'WAI_SETUP_OK'};}});
  await provider.setup({...SERVER,purpose:'site',host_key:IP+' '+PUBLIC_KEY});
  const encoded=[...envelope.matchAll(/printf '%s' '([^']+)' \| base64 -d/g)].map(x=>Buffer.from(x[1],'base64'));
  assert.equal(encoded.length,3);
  assert.equal(encoded[0].toString(),bootstrapScript('site'));
  assert.ok(verify(null,encoded[0],createPublicKey(encoded[2]),encoded[1]));
  const altered=Buffer.concat([encoded[0],Buffer.from('\nfalse')]);
  assert.equal(verify(null,altered,createPublicKey(encoded[2]),encoded[1]),false);
  assert.ok(envelope.indexOf('openssl pkeyutl -verify')<envelope.indexOf('sh "$d/setup"'));
  assert.deepEqual(readdirSync(vault.dir),[]);
  assert.throws(()=>bootstrapScript('site; touch /tmp/pwned'));
});

test('root readiness requires the remote marker, not just a successful SSH exit',async t=>{
  const vault=vaultFixture(t);
  const {provider}=fixture(t,{owned:true,vault,runner:async()=>({stdout:'setup still running'})});
  await assert.rejects(provider.check({...SERVER,host_key:IP+' '+PUBLIC_KEY}),code('readiness_failed'));
});

test('every generated bootstrap is valid POSIX shell without executing it',()=>{
  for(const purpose of ['clean','site','agent'])execFileSync('sh',['-n'],{input:bootstrapScript(purpose),stdio:['pipe','ignore','pipe']});
});

test('process failures are sanitized and output stays bounded',async()=>{
  const output=await runCommand(process.execPath,['-e',"process.stdout.write('x'.repeat(200000))"]);
  assert.equal(output.stdout.length,65536);
  await assert.rejects(runCommand(process.execPath,['-e',"process.stderr.write('imaginary private provider diagnostic');process.exit(9)"]),code('ssh_or_setup_failed'));
});

test('a timed-out SSH child is terminated even if it ignores SIGTERM', {timeout:5000},async()=>{
  const started=Date.now();
  await assert.rejects(runCommand(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{timeout:100}),code('command_timeout'));
  assert.ok(Date.now()-started<4500);
});

test('ambiguous command lists and special-use IP addresses cannot cross acceptance boundaries',()=>{
  for(const result of [17,'17',[17],{command_ids:[17]},{command_ids:'17'}])assert.equal(commandId(result),'17');
  for(const result of [0,-1,true,{},[],[1,2],{command_ids:[]},Number.MAX_SAFE_INTEGER+1])assert.throws(()=>commandId(result),code('unknown_response'));
  for(const ip of ['0.0.0.0','10.1.2.3','127.0.0.1','169.254.169.254','172.16.0.1','172.31.255.255','192.168.1.1',
    '100.64.0.1','100.127.255.255','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255',undefined])
    assert.equal(publicIPv4(ip),false);
  for(const ip of [IP,'1.1.1.1','172.32.0.1'])assert.equal(publicIPv4(ip),true);
});
