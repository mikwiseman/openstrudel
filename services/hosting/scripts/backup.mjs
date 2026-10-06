import { backup, DatabaseSync } from 'node:sqlite';
import { mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { config } from '../src/service.mjs';
const c=config(),stamp=new Date().toISOString().replaceAll(':','-'),dest=resolve('work/backups',stamp);
mkdirSync(dest,{recursive:true,mode:0o700});
const db=new DatabaseSync(join(c.data,'wai.sqlite'),{readOnly:true});
try {
  await backup(db,join(dest,'wai.sqlite'));
  for(const name of ['master.key','bootstrap-signing.pem']) {copyFileSync(join(c.data,name),join(dest,name));chmodSync(join(dest,name),0o600);}
  chmodSync(join(dest,'wai.sqlite'),0o600);
  const check=new DatabaseSync(join(dest,'wai.sqlite'),{readOnly:true});const result=check.prepare('PRAGMA integrity_check').get();check.close();
  if(result.integrity_check!=='ok')throw Error('Backup integrity failed');
  console.log(JSON.stringify({backup:dest,integrity:'ok',contains_secrets:true,handling:'keep private; copy to encrypted offsite storage under operator control'}));
} finally {db.close();}
