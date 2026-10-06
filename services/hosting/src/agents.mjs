import { randomUUID } from 'node:crypto';
import { hash, token } from './security.mjs';

const DAY = 86400e3;
const SCOPES = ['account:read', 'orders:write', 'servers:read', 'servers:access', 'servers:manage'];

export class AgentAccess {
  constructor(service) { this.s = service; this.db = service.db; }
  mode() { return this.s.c.provider + ':' + this.s.c.payments + (this.s.c.payments === 'wai_pay' ? ':' + this.s.c.waiPayMode : ''); }
  sandbox() { return this.mode() === 'emulator:emulator'; }
  view(row) {
    if (!row) return null;
    const { digest, user_id, ...visible } = row;
    return { ...visible, scopes: JSON.parse(row.scopes), revoked: !!row.revoked };
  }
  list(user) {
    return this.db.all('SELECT * FROM api_keys WHERE user_id=? ORDER BY created DESC', user).map(x => this.view(x));
  }
  issue(user, { name = 'Мой агент', expires_days = 30, sandbox = false, max_servers = 10 } = {}) {
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw this.s.err(400, 'Название ключа должно содержать от 1 до 80 символов.');
    if (!Number.isInteger(expires_days) || expires_days < 1 || expires_days > 30) throw this.s.err(400, 'Срок ключа: от 1 до 30 дней.');
    if (sandbox && (!this.sandbox() || !Number.isInteger(max_servers) || max_servers < 1 || max_servers > 50)) throw this.s.err(409, 'Тестовый доступ требует эмулятора и лимита от 1 до 50 серверов.');
    if (this.db.get('SELECT count(*) n FROM api_keys WHERE user_id=? AND revoked=0 AND expires>?', user, this.s.now()).n >= 10) throw this.s.err(409, 'Отзовите неиспользуемый ключ перед созданием нового.');
    const id = randomUUID(), raw = (this.sandbox() ? 'wai_test_' : 'wai_live_') + token();
    const scopes = sandbox ? [...SCOPES, 'sandbox:provision'] : SCOPES;
    this.db.run('INSERT INTO api_keys(id,user_id,digest,name,prefix,scopes,mode,max_servers,created,expires) VALUES(?,?,?,?,?,?,?,?,?,?)', id, user, hash(raw), name.trim(), raw.slice(0, 17), JSON.stringify(scopes), this.mode(), sandbox ? max_servers : null, this.s.now(), this.s.now() + expires_days * DAY);
    this.db.audit(user, id, sandbox ? 'sandbox_key_issued' : 'api_key_issued', this.s.now());
    return { token: raw, key: this.view(this.db.get('SELECT * FROM api_keys WHERE id=?', id)) };
  }
  revoke(user, id) {
    const row = this.db.get('SELECT * FROM api_keys WHERE id=? AND user_id=?', id, user);
    if (!row) throw this.s.err(404, 'Ключ не найден.');
    this.db.run('UPDATE api_keys SET revoked=1 WHERE id=?', id);
    this.db.audit(user, id, 'api_key_revoked', this.s.now());
  }
  auth(raw) {
    const key = this.db.get('SELECT * FROM api_keys WHERE digest=? AND revoked=0 AND expires>?', hash(raw), this.s.now());
    if (!key || key.mode !== this.mode()) throw this.s.err(401, 'Ключ недействителен, отозван или истёк.');
    this.db.run('UPDATE api_keys SET last_used=? WHERE id=?', this.s.now(), key.id);
    return { user_id: key.user_id, token: key.digest, csrf: null, reauthed: this.s.now(), expires: key.expires, kind: 'api_key', key_id: key.id, scopes: JSON.parse(key.scopes), max_servers: key.max_servers };
  }
  authorize(session, method, path) {
    if (session.kind !== 'api_key') return;
    let scope;
    if (method === 'GET' && ['/api/v1/me', '/api/v1/account/export'].includes(path)) scope = 'account:read';
    else if (method === 'POST' && path === '/api/v1/agent/servers') scope = 'sandbox:provision';
    else if (path === '/api/v1/orders' && method === 'POST') scope = 'orders:write';
    else if (/^\/api\/v1\/orders\/[-a-f0-9]{36}(?:\/checkout)?$/.test(path)) scope = 'orders:write';
    else if (/^\/api\/v1\/servers\/[-a-f0-9]{36}$/.test(path) && method === 'GET') scope = 'servers:read';
    else if (/^\/api\/v1\/servers\/[-a-f0-9]{36}\/access$/.test(path) && method === 'POST') scope = 'servers:access';
    else if (/^\/api\/v1\/servers\/[-a-f0-9]{36}\/(renewals|cancellation|retry|delete)$/.test(path) && method === 'POST') scope = 'servers:manage';
    if (!scope || !session.scopes.includes(scope)) throw this.s.err(403, 'У ключа нет права на это действие.');
  }
  provision(session, body) {
    if (session.kind !== 'api_key' || !session.scopes.includes('sandbox:provision')) throw this.s.err(403, 'Нужен отдельный ключ тестового запуска.');
    if (!this.sandbox()) throw this.s.err(409, 'Бесплатный тестовый запуск доступен только в эмуляторе.');
    this.s.limit('agent-create:' + session.key_id, 60, 3600e3);
    const order = this.s.order(session.user_id, body);
    this.db.tx(() => {
      const current = this.s.ownOrder(session.user_id, order.id);
      if (current.paid_at) return;
      const active = this.db.get("SELECT count(*) n FROM servers WHERE user_id=? AND state!='deleted'", session.user_id).n;
      if (active >= session.max_servers) throw this.s.err(409, 'Достигнут лимит тестовых серверов. Удалите завершённый тест.');
      this.s.acceptPayment(order.id);
      this.db.audit(session.user_id, order.id, 'sandbox_granted_by_key:' + session.key_id, this.s.now());
    });
    const current = this.s.ownOrder(session.user_id, order.id);
    return { order: current, server: this.s.serverView(this.s.ownServer(session.user_id, current.server_id)), poll_url: '/api/v1/servers/' + current.server_id, mode: 'emulator', billable: false };
  }
}
