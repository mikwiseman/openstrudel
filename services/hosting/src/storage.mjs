import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { MAGIC_SCHEMA } from './magic-links.mjs';
import { OPENSTRUDEL_SCHEMA } from './openstrudel-storage.mjs';

export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires INTEGER NOT NULL,reauthed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),idem TEXT NOT NULL,purpose TEXT NOT NULL,kind TEXT NOT NULL,server_id TEXT,amount INTEGER NOT NULL,currency TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',mode TEXT NOT NULL,created INTEGER NOT NULL,paid_at INTEGER, UNIQUE(user_id,idem));
      CREATE TABLE IF NOT EXISTS order_aliases(user_id TEXT NOT NULL REFERENCES users(id),idem TEXT NOT NULL,order_id TEXT NOT NULL REFERENCES orders(id),PRIMARY KEY(user_id,idem));
      CREATE UNIQUE INDEX IF NOT EXISTS one_draft ON orders(user_id,purpose) WHERE kind='initial' AND status IN ('draft','checkout','paid','fulfilling');
      CREATE UNIQUE INDEX IF NOT EXISTS one_renewal ON orders(server_id) WHERE kind='renewal' AND status IN ('draft','checkout','paid');
      CREATE TABLE IF NOT EXISTS payments(order_id TEXT PRIMARY KEY REFERENCES orders(id),session_id TEXT UNIQUE,url TEXT,state TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS payment_events(id TEXT PRIMARY KEY,digest TEXT NOT NULL,order_id TEXT,type TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS servers(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),order_id TEXT UNIQUE NOT NULL REFERENCES orders(id),purpose TEXT NOT NULL,state TEXT NOT NULL,provider_mode TEXT NOT NULL,provider_name TEXT UNIQUE NOT NULL,provider_id TEXT UNIQUE,ip TEXT,public_key TEXT NOT NULL,private_key TEXT NOT NULL,host_key TEXT,paid_until INTEGER,cancel_at_end INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,error TEXT,backup TEXT NOT NULL DEFAULT 'manual_export',ready_at INTEGER);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,server_id TEXT UNIQUE NOT NULL REFERENCES servers(id),state TEXT NOT NULL,command_id TEXT,attempt INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id),number INTEGER NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(server_id,number));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT,entity_id TEXT,action TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases(name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sim_machines(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,ip TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sim_payments(id TEXT PRIMARY KEY,order_id TEXT UNIQUE NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_keys(user_id TEXT PRIMARY KEY REFERENCES users(id),digest TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS capacity_reservations(order_id TEXT PRIMARY KEY REFERENCES orders(id),state TEXT NOT NULL CHECK(state IN('held','committed','released')),created INTEGER NOT NULL,updated INTEGER NOT NULL,reason TEXT);
      CREATE INDEX IF NOT EXISTS capacity_reservations_state ON capacity_reservations(state);
      CREATE TABLE IF NOT EXISTS wai_pay_attempts(order_id TEXT NOT NULL REFERENCES orders(id),generation INTEGER NOT NULL,external_id TEXT UNIQUE NOT NULL,request_json TEXT NOT NULL,payment_id TEXT UNIQUE,state TEXT NOT NULL,paid_amount INTEGER NOT NULL DEFAULT 0,payment_version INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(order_id,generation));
      CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),digest TEXT UNIQUE NOT NULL,name TEXT NOT NULL,prefix TEXT NOT NULL,scopes TEXT NOT NULL,mode TEXT NOT NULL,max_servers INTEGER,created INTEGER NOT NULL,expires INTEGER NOT NULL,last_used INTEGER,revoked INTEGER NOT NULL DEFAULT 0);
      PRAGMA user_version=1;`);
    this.tx(()=>{
      if(!this.all('PRAGMA table_info(payments)').some(x=>x.name==='generation'))
        this.db.exec('ALTER TABLE payments ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
      if(!this.all('PRAGMA table_info(orders)').some(x=>x.name==='payment_method'))
        this.db.exec('ALTER TABLE orders ADD COLUMN payment_method TEXT');
      if(!this.all('PRAGMA table_info(orders)').some(x=>x.name==='paid_payment_id'))
        this.db.exec('ALTER TABLE orders ADD COLUMN paid_payment_id TEXT');
      for(const [name,type] of [['expires_at','INTEGER'],['verified_at','INTEGER'],['refunded_amount','INTEGER NOT NULL DEFAULT 0']])
        if(!this.all('PRAGMA table_info(wai_pay_attempts)').some(x=>x.name===name))this.db.exec(`ALTER TABLE wai_pay_attempts ADD COLUMN ${name} ${type}`);
      this.db.exec(OPENSTRUDEL_SCHEMA);
      this.db.exec(MAGIC_SCHEMA);
      this.db.exec('PRAGMA user_version=9');
    });
  }
  get(sql, ...p) { return this.db.prepare(sql).get(...p); }
  all(sql, ...p) { return this.db.prepare(sql).all(...p); }
  run(sql, ...p) { return this.db.prepare(sql).run(...p); }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  audit(user, entity, action, now=Date.now()) { this.run('INSERT INTO audit(user_id,entity_id,action,created) VALUES(?,?,?,?)',user,entity,action,now); }
  close() { this.db.close(); }
}
