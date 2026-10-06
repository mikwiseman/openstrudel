import test from 'node:test';
import assert from 'node:assert/strict';
import { Kamatera } from '../src/providers.mjs';
import { PRICE_SOURCE, PRICE_IMAGE, pricingCatalog, pricingBody } from './fixtures/kamatera-pricing.mjs';

const IMAGE='EU:'+PRICE_IMAGE;
const wire=Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from('ssh-ed25519'),Buffer.from([0,0,0,32]),Buffer.alloc(32,5)]);
const SERVER={id:'11111111-1111-4111-8111-111111111111',provider_name:'wai-vds-11111111111141118111111111111111',provider_id:null,public_key:'ssh-ed25519 '+wire.toString('base64')};
function fixture({ceiling=10,catalog=pricingCatalog(),priceReply,closed=false}={}) {
  const calls=[];
  const c={kamateraId:'fixture-client',kamateraSecret:'fixture-secret',region:'EU',approvedImage:IMAGE,maxServers:1,maxMonthly:ceiling,allowPaid:closed?'':'I_APPROVE_KAMATERA_SPEND'};
  const provider=new Kamatera(c,null,{fetcher:async(url,options)=>{
    calls.push({url,...options});
    if(url===PRICE_SOURCE) return priceReply?priceReply(options):new Response(pricingBody(catalog),{headers:{'Last-Modified':'Mon, 05 Oct 2026 03:11:41 GMT'}});
    assert.equal(new URL(url).origin,'https://console.kamatera.com');
    const path=new URL(url).pathname.slice('/service'.length);
    if(path==='/authenticate')return Response.json({authentication:'fixture-token'});
    if(path==='/servers')return Response.json([]);
    if(path.startsWith('/server/options/images/'))return Response.json([{id:IMAGE,minRequirements:{},sizeGB:10}]);
    if(path.startsWith('/server/options/image/'))return Response.json({datacenter:'EU',image:IMAGE,cpu:['1A'],ram:{A:[2048]},disk:[20],billing:['monthly'],traffic:[{name:'t5000'}],imageRequirements:{}});
    if(path==='/server'&&options.method==='POST')return Response.json(123);
    throw Error('Unexpected fixture request');
  }});
  return {provider,c,calls,catalog,creates:()=>calls.filter(x=>x.url==='https://console.kamatera.com/service/server').length};
}

test('official components bind the exact monthly image/profile; disabled backup adds no coefficient',async()=>{
  const f=fixture();const p=(await f.provider.preflight()).price;
  assert.equal(p.baseMonthlyUsd,6);assert.equal(p.administrationFeePercent,2);assert.equal(p.monthlyUsdWithAdministrationFee,6.12);
  assert.equal(p.kind,'public_estimate');assert.equal(p.accountPriceVerified,false);assert.equal(p.taxVerified,false);assert.equal(p.source,PRICE_SOURCE);
  assert.equal(p.profile.image,IMAGE);assert.equal(p.profile.datacenter,'EU');assert.equal(p.profile.billing,'monthly');assert.equal(p.profile.ipv4,1);assert.equal(p.profile.backup,false);assert.equal(p.profile.managed,false);
  assert(Number.isFinite(Date.parse(p.checkedAt)));assert.equal(p.lastModified,'2026-10-05T03:11:41.000Z');
  const request=f.calls.find(x=>x.url===PRICE_SOURCE);assert.equal(request.method,'GET');assert.equal(request.redirect,'error');assert.equal(request.cache,'no-store');assert(request.signal instanceof AbortSignal);assert.equal(request.headers.Authorization,undefined);
});

test('zero budget permits read-only pricing but never permits a create',async()=>{
  const f=fixture({ceiling:0,closed:true});assert.equal((await f.provider.preflight()).price.baseMonthlyUsd,6);
  await assert.rejects(f.provider.create(SERVER),e=>e.code==='budget_approval_required'&&e.definitive);assert.equal(f.creates(),0);
});

test('ceiling includes the known administration fee and rounding is conservative',async()=>{
  for(const ceiling of [6,6.11]) {
    const f=fixture({ceiling});await assert.rejects(f.provider.create(SERVER),e=>e.code==='budget_approval_required'&&e.definitive);assert.equal(f.creates(),0);
  }
  const f=fixture({ceiling:6.12});await f.provider.create(SERVER);assert.equal(f.creates(),1);
  const catalog=pricingCatalog();catalog.diskGB[0].options[0].price=6.000001;
  const fractional=fixture({ceiling:6.12,catalog});await assert.rejects(fractional.provider.create(SERVER),e=>e.code==='budget_approval_required');assert.equal(fractional.creates(),0);
});

test('a lower current price is compared to the budget without a hardcoded six-dollar floor',async()=>{
  const catalog=pricingCatalog();catalog.diskGB[0].options[0].price=4;
  const f=fixture({ceiling:5,catalog});await f.provider.create(SERVER);assert.equal(f.creates(),1);
});

test('a fresh price is fetched again for create and a rise since checkout blocks the paid POST',async()=>{
  const f=fixture();await f.provider.preflight();f.catalog.diskGB[0].options[0].price=11;
  await assert.rejects(f.provider.create(SERVER),e=>e.code==='budget_approval_required'&&e.definitive);
  assert.equal(f.calls.filter(x=>x.url===PRICE_SOURCE).length,2);assert.equal(f.creates(),0);
});

test('changed budget during create auth refresh is checked immediately before the paid POST',async()=>{
  const f=fixture();const fetcher=f.provider.fetcher;
  f.provider.fetcher=async(url,options)=>{
    const r=await fetcher(url,options);
    if(url===PRICE_SOURCE)f.provider.auth=null;
    else if(url.endsWith('/authenticate')&&f.calls.some(x=>x.url===PRICE_SOURCE))f.c.maxMonthly=5;
    return r;
  };
  await assert.rejects(f.provider.create(SERVER),e=>e.code==='budget_approval_required'&&e.definitive);assert.equal(f.creates(),0);
});

test('missing, ambiguous and malformed selected pricing components fail closed',async t=>{
  for(const [name,change] of [
    ['CPU absent',c=>c.cpu[0].options=[]],['RAM absent',c=>delete c['ramMB.A']],['disk duplicate',c=>c.diskGB[0].options.push({...c.diskGB[0].options[0]})],
    ['IP string price',c=>c.wan[0].options[0].price='0'],['traffic null price',c=>c['netPck.EU'][0].options[0].price=null],
    ['negative base',c=>c.base[0].options[0].price=-1],['managed absent',c=>delete c.managed],['wrong datacenter',c=>c.datacenters=['US']],
    ['wrong OS',c=>c.os[0].id='other'],['OS duplicate',c=>c.os.push({...c.os[0]})],['OS wrong region',c=>c.os[0].datacenters=['US']],
    ['OS missing price',c=>delete c.os[0].price]
  ])await t.test(name,async()=>{const catalog=pricingCatalog();change(catalog);const f=fixture({catalog});await assert.rejects(f.provider.create(SERVER),e=>e.code==='price_unverified'&&e.definitive);assert.equal(f.creates(),0);});
});

test('executable JavaScript is never evaluated and unknown response formats are rejected',async()=>{
  globalThis.waiPriceExecuted=false;
  const f=fixture({priceReply:()=>new Response(pricingBody(pricingCatalog())+' globalThis.waiPriceExecuted=true;')});
  await assert.rejects(f.provider.preflight(),e=>e.code==='price_unverified');assert.equal(globalThis.waiPriceExecuted,false);delete globalThis.waiPriceExecuted;
});

test('price failure, redirects and oversized streamed or declared bodies never fall back to an old estimate',async t=>{
  for(const [name,reply] of [
    ['offline',()=>{throw Error('secret diagnostic must not escape');}],
    ['redirect',()=>new Response('',{status:302,headers:{Location:'https://example.test/'}})],
    ['HTTP error',()=>new Response('private diagnostic',{status:500})],
    ['declared size',()=>new Response(pricingBody(pricingCatalog()),{headers:{'Content-Length':'999999999'}})],
    ['streamed size',()=>new Response(' '.repeat(1024*1024))],
    ['truncated JSON',()=>new Response("var prd_prices = '{';")]
  ])await t.test(name,async()=>{const f=fixture({priceReply:reply});await assert.rejects(f.provider.create(SERVER),e=>e.code==='price_unverified'&&e.message==='price_unverified'&&e.definitive);assert.equal(f.creates(),0);});
});
