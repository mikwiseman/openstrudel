// Operator-only bootstrap on the documented production runtime. Prints no secrets.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { Service, config } from '../src/service.mjs';
import { passwordHash, token } from '../src/security.mjs';

const s=new Service(config());
const dir=join(s.c.data,'integrations'),output=join(dir,'openstrudel.production.env');
try {
  if(s.c.provider!=='kamatera'||s.c.payments!=='wai_pay'||s.c.waiPayMode!=='live')throw Error('Production runtime required');
  mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
  if(existsSync(output)) {
    const raw=readFileSync(output,'utf8').match(/^WAI_VDS_API_KEY=(\S+)$/m)?.[1],session=s.auth(raw);
    if(session.kind!=='api_key'||session.scopes.includes('sandbox:provision'))throw Error('Unexpected key');
    console.log(JSON.stringify({ok:true,reused:true,key_file:output,expires:new Date(session.expires).toISOString(),scope:'own account; hosted payment required',secret_displayed:false}));
  } else {
    let uid=s.db.get("SELECT value FROM settings WHERE key='openstrudel_production_account'")?.value;
    if(!uid) {
      uid=randomUUID();
      // This service account cannot log in with a published or default password.
      // A dedicated API key is its sole integration credential.
      const password=passwordHash(token());
      s.db.tx(()=>{s.db.run('INSERT INTO users VALUES(?,?,?,?)',uid,'openstrudel+'+uid+'@example.invalid',password,s.now());s.db.run("INSERT INTO settings VALUES('openstrudel_production_account',?)",uid);});
    }
    const issued=s.agents.issue(uid,{name:'OpenStrudel · production',expires_days:30});
    try {writeFileSync(output,'WAI_VDS_BASE_URL='+s.c.origin+'\nWAI_VDS_API_KEY='+issued.token+'\n',{mode:0o600,flag:'wx'});}
    catch(e){s.agents.revoke(uid,issued.key.id);throw e;}
    console.log(JSON.stringify({ok:true,reused:false,key_file:output,key_id:issued.key.id,expires:new Date(issued.key.expires).toISOString(),scope:'own account; hosted payment required',secret_displayed:false}));
  }
} finally {s.db.close();}
