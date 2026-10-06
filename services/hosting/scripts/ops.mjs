import { Service, config } from '../src/service.mjs';
const s=new Service(config()),[command='list',id]=process.argv.slice(2);
try {
  if(command==='list') {
    console.log(JSON.stringify({mode:{provider:s.c.provider,payments:s.c.payments},operations:s.db.all(`SELECT o.id,o.server_id,o.state,o.attempt,o.updated,o.error,s.provider_name,s.provider_id,s.ip,s.paid_until FROM operations o JOIN servers s ON s.id=o.server_id ORDER BY o.updated`),paid_unfulfilled:s.db.all("SELECT id,status,amount,currency,paid_at FROM orders WHERE paid_at IS NOT NULL AND status!='fulfilled'"),financial_attention:s.db.all("SELECT entity_id,action,created FROM audit WHERE action LIKE 'additional_payment_needs_refund:%' OR action LIKE 'refund_or_shortfall_needs_review:%' ORDER BY created DESC"),pending_checkouts:s.db.all("SELECT order_id,state,created FROM payments WHERE state!='paid'")},null,2));
  } else if(command==='reconcile') {
    const server=s.db.get('SELECT * FROM servers WHERE id=?',id||'');if(!server)throw Error('Use the exact WAI VDS server ID from ops list');
    const matches=await s.provider.find(server.provider_name);
    console.log(JSON.stringify({server_id:id,matches:matches.map(x=>({id:x.id,name:x.name})),action:'read-only; no create request sent'},null,2));
  } else if(command==='tick') {await s.tick();console.log('One durable worker pass completed.');}
  else throw Error('Commands: list | reconcile <server-id> | tick');
} catch(e) {console.error(JSON.stringify({error:e.code||e.message}));process.exitCode=1;}
finally {s.db.close();}
