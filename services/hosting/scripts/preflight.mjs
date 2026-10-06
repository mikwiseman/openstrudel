import { config } from '../src/service.mjs';
import { Kamatera } from '../src/providers.mjs';
const c=config();
// READ ONLY: intentionally does not require or enable a spending switch.
c.approvedImage ||= 'EU:7a74bdc0c8034ce9a1fd28d8ed91f8f5';
try {
  const p=new Kamatera(c,null);
  const {price,...profile}=await p.preflight(),list=await p.list();
  console.log(JSON.stringify({checked_at:new Date().toISOString(),provider:'kamatera',authenticated:true,profile,existing_server_count:list.length,wai_vds_count:list.filter(x=>x.name?.startsWith('wai-vds-')).length,mutations:0,price,spending_enabled:c.allowPaid==='I_APPROVE_KAMATERA_SPEND'},null,2));
} catch(e) {console.error(JSON.stringify({authenticated:false,error:e.code||'preflight_failed',mutations:0}));process.exitCode=1;}
