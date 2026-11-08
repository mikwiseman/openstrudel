// Dependency-free regressions against the shipped browser code and server helper (Node 24).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isMetricsDay, previousMetricsDate, calmStreakThrough } from '../src/daily-metrics-calendar.ts';

const row = (date, calm = 4) => ({ date, values: { person: { calm } } });
function frontend(today, days) {
  const text = readFileSync(new URL('../public/check-in/app.js', import.meta.url), 'utf8');
  const prefix = text.slice(0, text.indexOf('$("check-in-form").addEventListener'));
  const context = vm.createContext({ window: {}, document: {}, Intl, Date });
  vm.runInContext(prefix + '\nglobalThis.api = { state, calendarStreak, weekDates, weekStart, metricSummary, firstVisibleWeek };', context);
  context.api.state.data = { today, days };
  context.api.state.person = 'person';
  context.api.state.week = context.api.weekStart(today);
  return context.api;
}
test('Saturday is skipped across month boundaries', () => {
  assert.equal(isMetricsDay('2026-10-31'), false);
  assert.equal(previousMetricsDate('2026-11-01'), '2026-10-30');
  assert.equal(previousMetricsDate('2026-11-07'), '2026-11-06');
});
test('Sunday before an answer continues Friday; zero calm counts on client and server', () => {
  const days = [{ date: '2026-11-03', values: {} }, row('2026-11-04'), row('2026-11-05'), row('2026-11-06', 0), row('2026-11-07', 10)];
  assert.equal(frontend('2026-11-08', days).calendarStreak().count, 3);
  assert.equal(calmStreakThrough(days, 'person', previousMetricsDate('2026-11-08')), 3);
  assert.equal(frontend('2026-11-07', days).calendarStreak().count, 3);
});
test('an ordinary missed day breaks calm streak despite other metric answers', () => {
  const days = [row('2026-11-06'), { date: '2026-11-08', values: { person: { focus: 7, energy: 5, mood: 4 } } }];
  assert.equal(frontend('2026-11-09', days).calendarStreak().count, 0);
  assert.equal(calmStreakThrough(days, 'person', '2026-11-08'), 0);
  days.push(row('2026-11-09'));
  assert.equal(frontend('2026-11-09', days).calendarStreak().count, 1);
});
test('Sunday bridges Saturday; bounded streaks report a lower bound', () => {
  const days = [row('2026-10-30'), row('2026-11-01')];
  const result = frontend('2026-11-01', days).calendarStreak();
  assert.equal(result.count, 2);
  assert.equal(result.truncated, true);
  assert.equal(calmStreakThrough(days, 'person', '2026-11-01'), 2);
});
test('weeks align to Monday across years and contain exactly six eligible dates', () => {
  const api = frontend('2027-01-03', []);
  assert.equal(api.weekStart('2027-01-03'), '2026-12-28');
  assert.deepEqual(Array.from(api.weekDates('2026-12-28')), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-03']);
});
test('weekly means count zero, omit Saturdays and gaps, and keep metrics separate', () => {
  const api = frontend('2026-11-08', [row('2026-11-02', 0), row('2026-11-03', 6), row('2026-11-07', 10), { date: '2026-11-08', values: { person: { focus: 9 } } }]);
  assert.equal(api.metricSummary('calm').n, 2);
  assert.equal(api.metricSummary('calm').mean, 3);
  assert.equal(api.metricSummary('focus').mean, 9);
  assert.equal(api.metricSummary('energy').mean, null);
  assert.equal(api.metricSummary('mood', '2026-10-26').n, 0);
});
test('the earliest navigable week has a full preceding baseline', () => {
  assert.equal(frontend('2026-11-08', [row('2026-09-28')]).firstVisibleWeek(), '2026-10-05');
  assert.equal(frontend('2026-11-08', [row('2026-09-30')]).firstVisibleWeek(), '2026-10-12');
});
