import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {cloudFixture} from './openstrudel-fixture.mjs';
import {Service} from '../src/service.mjs';
import {snapshot,verifySnapshot} from '../scripts/production-backup.mjs';

test('restart resumes the saved Home installation without another invoice or VM',async t=>{
  const f=cloudFixture(t),{order}=f.make();await f.s.cloud.checkout(f.a.session,order.order_id);await f.pay();for(let i=0;i<4;i++)await f.s.tick();
  const config=f.s.c;f.s.db.close();const next=new Service(config,{now:f.s.now});
  // The payment poll is intentionally disabled: this check tests local durable
  // recovery only and is forbidden from reaching the real gateway.
  next.payments.real.reconcile=async()=>{};
  await next.tick();assert.equal(next.cloud.status(f.a.session,order.order_id).home_state,'ready');assert.equal((await next.provider.list()).length,1);assert.equal(next.db.get('SELECT count(*) n FROM wai_pay_attempts').n,1);assert.equal(next.cloud.installer.scheduled,0);
  f.s.db=next.db;
});
test('schema 9 backup validates sealed Home identity with the real master key',async t=>{
  const f=cloudFixture(t);f.make();const dir=join(f.dir,'snapshot'),env=join(f.dir,'runtime.env'),release=join(f.dir,'current-release');
  writeFileSync(env,'WAI_PROVIDER=emulator\nWAI_PAYMENTS=wai_pay\n');writeFileSync(release,'fixture-v10\n');
  const result=await snapshot({data:f.dir,env,release,output:dir});assert.equal(result.schema,9);assert.equal(result.encrypted_home_bootstraps_verified,1);assert.equal(verifySnapshot(dir).integrity,'ok');
});
test('production migration rehearsal preserves all old columns and rows',async t=>{
  const f=cloudFixture(t),{order}=f.make();await f.s.cloud.checkout(f.a.session,order.order_id);
  const {backup,DatabaseSync}=await import('node:sqlite'),path=join(f.dir,'migration-review.sqlite');await backup(f.s.db.db,path);
  const old=new DatabaseSync(path);old.exec('PRAGMA user_version=7; ALTER TABLE wai_pay_attempts DROP COLUMN expires_at; ALTER TABLE wai_pay_attempts DROP COLUMN verified_at; ALTER TABLE wai_pay_attempts DROP COLUMN refunded_amount');old.close();
  const result=JSON.parse(execFileSync(process.execPath,['scripts/check-migration.mjs',path],{encoding:'utf8'}));assert.equal(result.from,7);assert.equal(result.to,9);assert.equal(result.existing_rows_unchanged,true);
});
