// Run only through register-app.sh on the documented host. Its stdout is captured
// in host process memory, never a terminal/log. Phase 1 carries the new secrets;
// the host persists them before phase 2 changes ONLY the newly created App.
import { PrismaClient } from '@prisma/client';
import { verifyApiKey } from './dist/utils/api-key.js';

const APP_ID='wai-vds';
const CALLBACK='https://pay.waiwai.is/vds/api/v1/webhooks/wai-pay';
const DEFAULTS={STRIPE:'stripe-main',CRYPTOMUS:'cryptomus-main'};
const prisma=new PrismaClient();
const fail=code=>{const error=new Error('Registration step failed');error.safeCode=code;throw error;};
const publicSelect={id:true,name:true,callbackUrl:true,defaultProviderAccounts:true,mode:true,apiScopes:true,isActive:true};
const validKey=value=>typeof value==='string'&&/^wp_live_[A-Za-z0-9_-]{32}$/.test(value);
const validSecret=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
function configured(app) {
  return app?.id===APP_ID&&app.name==='WAI VDS'&&app.callbackUrl===CALLBACK&&app.isActive&&app.mode==='LIVE'&&
    Object.keys(app.defaultProviderAccounts||{}).length===2&&
    Object.entries(DEFAULTS).every(([k,v])=>app.defaultProviderAccounts[k]===v);
}

try {
  if(process.env.WAI_REGISTER_SECRET_PIPE!=='1'||process.stdout.isTTY)fail('wrapper_required');
  const phase=process.argv[2];
  if(phase==='create') {
    if(await prisma.app.findUnique({where:{id:APP_ID},select:{id:true}}))fail('app_exists');
    for(const [provider,id] of Object.entries(DEFAULTS)) {
      const account=await prisma.providerAccount.findUnique({where:{id},select:{id:true,provider:true,isActive:true,mode:true}});
      if(!account||account.provider!==provider||!account.isActive||account.mode!=='LIVE')fail('provider_account_not_ready');
    }
    const password=process.env.ADMIN_PASSWORD;
    if(typeof password!=='string'||password.length<16)fail('admin_auth_missing');
    let response;
    try {
      response=await fetch('http://127.0.0.1:8000/admin/api/apps',{method:'POST',redirect:'error',
        signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json','X-Admin-Password':password},
        body:JSON.stringify({id:APP_ID,name:'WAI VDS',callbackUrl:CALLBACK,defaultProviderAccounts:DEFAULTS})});
    } catch {fail('create_outcome_unknown');}
    if(response.status===409)fail('app_exists');
    if(!response.ok)fail('create_http_'+response.status);
    let data;try {data=await response.json();}catch {fail('create_outcome_unknown');}
    if(!data?.success||data.app?.id!==APP_ID||!validKey(data.apiKey)||!validSecret(data.webhookSecret))fail('create_outcome_unknown');
    process.stdout.write(JSON.stringify({ok:true,phase:'created',appId:APP_ID,apiKey:data.apiKey,webhookSecret:data.webhookSecret}));
  } else if(phase==='activate-own-app') {
    // The wrapper injects this object into stdin, never argv or process env.
    const own=globalThis.__WAI_OWN_APP;
    if(own?.appId!==APP_ID||!validKey(own.apiKey)||!validSecret(own.webhookSecret))fail('own_credentials_required');
    const app=await prisma.app.findUnique({where:{id:APP_ID}});
    if(!configured(app)||!(await verifyApiKey(own.apiKey,app.apiKeyHash))||own.webhookSecret!==app.webhookSecret)fail('own_app_mismatch');
    const scopes=app.apiScopes;
    if(scopes.length===0) {
      // Optimistic row guard prevents overwriting concurrent configuration.
      const result=await prisma.app.updateMany({where:{id:APP_ID,apiKeyHash:app.apiKeyHash,updatedAt:app.updatedAt,
        callbackUrl:CALLBACK,mode:'LIVE',apiScopes:{equals:[]}},data:{mode:'LIVE',apiScopes:['payments:v2']}});
      if(result.count!==1)fail('own_app_changed');
    } else if(scopes.length!==1||scopes[0]!=='payments:v2')fail('unexpected_scopes');
    const verified=await prisma.app.findUnique({where:{id:APP_ID},select:publicSelect});
    if(!configured(verified)||verified.apiScopes.length!==1||verified.apiScopes[0]!=='payments:v2')fail('app_verification_failed');
    // Authentication/status read only: this does not create an invoice.
    let response;
    try {response=await fetch('http://127.0.0.1:8000/api/v2/payments/by-external/__wai_vds_preflight_no_invoice__',
      {headers:{Authorization:'Bearer '+own.apiKey},redirect:'error',signal:AbortSignal.timeout(10000)});}catch {fail('app_auth_read_failed');}
    let data;try {data=await response.json();}catch {fail('app_auth_read_failed');}
    if(response.status!==404||data?.error?.code!=='NOT_FOUND')fail('app_auth_read_failed');
    process.stdout.write(JSON.stringify({ok:true,phase:'ready',app:verified,authenticatedRead:'NOT_FOUND',invoicesCreated:0}));
  } else fail('invalid_phase');
} catch(error) {
  // Do not echo provider/admin error bodies, headers, config or stack traces.
  process.stdout.write(JSON.stringify({ok:false,code:error.safeCode||'registration_failed'}));
  process.exitCode=1;
} finally {await prisma.$disconnect();}
