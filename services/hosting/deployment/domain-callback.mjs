// Run inside waipay-backend. Changes only this App's callback; never credentials.
import {PrismaClient} from '@prisma/client';
const p=new PrismaClient(),oldURL='https://pay.waiwai.is/vds/api/v1/webhooks/wai-pay',newURL='https://server.waiwai.is/api/v1/webhooks/wai-pay';
try {
  const phase=process.argv[2],a=await p.app.findUnique({where:{id:'wai-vds'}});
  if(!a||a.mode!=='LIVE'||!a.isActive||JSON.stringify(a.apiScopes)!=='["payments:v2"]'||a.defaultProviderAccounts?.STRIPE!=='stripe-vds'||a.defaultProviderAccounts?.CRYPTOMUS!=='cryptomus-main')throw Error();
  const from=phase==='rollback'?newURL:oldURL,to=phase==='rollback'?oldURL:newURL;
  const alreadyRestored=phase==='rollback'&&a.callbackUrl===oldURL;
  if(!['inspect','apply','rollback'].includes(phase)||a.callbackUrl!==from&&!alreadyRestored)throw Error();
  if(phase!=='inspect'&&!alreadyRestored) {
    const changed=await p.app.updateMany({where:{id:a.id,updatedAt:a.updatedAt,callbackUrl:from},data:{callbackUrl:to}});
    if(changed.count!==1)throw Error();
    const b=await p.app.findUnique({where:{id:a.id}});
    for(const k of Object.keys(a))if(!['callbackUrl','updatedAt'].includes(k)&&JSON.stringify(a[k])!==JSON.stringify(b[k]))throw Error();
    if(b.callbackUrl!==to)throw Error();
  }
  console.log(JSON.stringify({ok:true,phase,appId:a.id,callback:phase==='inspect'?from:to,credentialsUnchanged:true}));
} catch {console.log(JSON.stringify({ok:false,code:'callback_update_stopped'}));process.exitCode=1;}
finally {await p.$disconnect();}
