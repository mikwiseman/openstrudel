// Run only on a separate SQLite snapshot. No Service, provider, or network calls.
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage.mjs';
import { createHash } from 'node:crypto';

const file=process.argv[2];
if(!file || !file.endsWith('migration-review.sqlite'))throw Error('Dedicated review snapshot required');
const old=new DatabaseSync(file);
const version=old.prepare('PRAGMA user_version').get().user_version;
if(![6,7,8,9].includes(version))throw Error('Unexpected source schema');
const tables=old.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name);
const columns=new Map(tables.map(name=>[name,old.prepare('PRAGMA table_info("'+name+'")').all().map(c=>'"'+c.name+'"').join(',')]));
const signature=db=>tables.map(name=>({name,rows:db.prepare('SELECT '+columns.get(name)+' FROM "'+name+'" ORDER BY rowid').all()}));
const digest=x=>createHash('sha256').update(JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v)).digest('hex');
const before=digest(signature(old));old.close();
const next=new Store(file);
if(next.get('PRAGMA user_version').user_version!==9 || before!==digest(signature(next.db)))throw Error('Migration changed existing rows');
if(next.get('PRAGMA integrity_check').integrity_check!=='ok'||next.all('PRAGMA foreign_key_check').length)throw Error('Invalid migrated database');
for(const name of ['os_authorizations','os_grants','os_orders','os_quotes','os_installations','os_claims','magic_links','email_verifications','magic_sessions'])if(!next.get('SELECT name FROM sqlite_schema WHERE type=\'table\' AND name=?',name))throw Error('New table missing');
next.close();
console.log(JSON.stringify({ok:true,from:version,to:9,existing_tables:tables.length,existing_rows_unchanged:true,integrity:'ok',foreign_keys:'ok',network_calls:0}));
