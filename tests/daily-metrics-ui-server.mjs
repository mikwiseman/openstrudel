// Disposable local fixture server. Uses the real HttpApi, HMAC and SQLite journal.
// Never connects to an installed Home, Telegram or any production database.
import { Store } from '../dist/store.js';
import { Scheduler } from '../dist/scheduler.js';
import { MessageService } from '../dist/messages.js';
import { TelegramAdapter } from '../dist/telegram.js';
import { HttpApi } from '../dist/server.js';
import { recordPoll, recordAnswer } from '../dist/check-ins.js';
const RealDate = Date;
const timestamp = RealDate.parse(process.env.METRICS_TEST_DATE || '2026-11-08T10:00:00Z');
globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [timestamp])); } static now() { return timestamp; } };
const now = new Date();
const store = new Store(':memory:');
const messages = new MessageService(store, { async run() { return { threadId: 'test', response: '', events: [] }; } });
const scheduler = new Scheduler(store, messages);
store.linkTelegramChat({ chatId: '-100', title: 'Fixture team', allowedSenders: ['1001', '1002'] });
const conversationId = store.connectTelegramGroup('-100').conversationId;
const metrics = ['calm', 'focus', 'energy', 'mood'];
const ids = Object.fromEntries([...metrics, 'legacy'].map(name => [name, scheduler.save({ conversationId, name, prompt: '', cron: '0 18 * * *', timezone: 'Europe/Moscow', delivery: 'bound', poll: { question: name, options: Array.from({ length: 10 }, (_, i) => String(i + 1)) } }, now).id]));
store.db.prepare('UPDATE schedules SET enabled=0 WHERE id=?').run(ids.legacy);
store.setSetting('dailyMetrics.config', JSON.stringify({ conversationId, chatId: '-100', timezone: 'Europe/Moscow', participants: [{ id: '1001', name: 'Анна' }, { id: '1002', name: 'Борис' }], metrics: Object.fromEntries(metrics.map(metric => [metric, ids[metric]])), legacyCalmScheduleId: ids.legacy }));
store.setSetting('telegram.bot_token', '1000:fixture-only-token');
let serial = 0;
function vote(date, metric, userId, value) {
  const pollId = `fixture-${serial++}`, options = Array.from({ length: 10 }, (_, i) => String(i + 1));
  recordPoll(store, { pollId, scheduleId: ids[metric], conversationId, chatId: '-100', messageId: serial, localDate: date, question: metric, options, createdAt: date + 'T08:00:00Z' });
  recordAnswer(store, { pollId, userId, userName: 'Fixture', optionIds: [value - 1], at: date + 'T09:00:00Z' });
}
// Explicit gaps, a historical calm zero and excluded Saturday votes.
for (const [date, calm] of [['2026-10-26', 3], ['2026-10-27', 5], ['2026-10-28', 4], ['2026-10-29', 6], ['2026-10-30', 5], ['2026-11-01', 7], ['2026-11-02', 4], ['2026-11-03', 6], ['2026-11-05', 8], ['2026-11-06', 7], ['2026-11-07', 10]]) {
  vote(date, 'calm', '1001', calm);
  vote(date, 'focus', '1001', 7); vote(date, 'energy', '1001', 6); vote(date, 'mood', '1001', 8);
  for (const metric of metrics) vote(date, metric, '1002', 9);
}
vote('2026-10-25', 'legacy', '1001', 10);
const telegram = new TelegramAdapter(null, store, messages);
const api = new HttpApi(store, messages, telegram, 'fixture-owner-token');
const address = await api.listen('127.0.0.1', 0);
process.send?.({ base: `http://127.0.0.1:${address.port}` });
process.once('SIGTERM', async () => { await api.close(); telegram.stop(); store.close(); process.exit(0); });
