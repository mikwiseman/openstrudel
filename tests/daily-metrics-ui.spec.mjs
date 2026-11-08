import { test as base, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';

const today = '2026-11-08T10:00:00Z';
function signed(user = 1001, at = today) {
  const data = new URLSearchParams({ auth_date: String(Date.parse(at) / 1000), user: JSON.stringify({ id: user, first_name: 'Untrusted name' }) });
  const check = [...data].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update('1000:fixture-only-token').digest();
  data.set('hash', createHmac('sha256', secret).update(check).digest('hex')); return data.toString();
}
const test = base.extend({
  serverDate: [today, { option: true }],
  server: async ({ serverDate }, use) => {
    const child = fork(new URL('./daily-metrics-ui-server.mjs', import.meta.url), { env: { ...process.env, METRICS_TEST_DATE: serverDate }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const [{ base }] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(stderr || 'Fixture server exited'); })]);
    try { await use(base); } finally { child.kill('SIGTERM'); await once(child, 'exit'); }
  },
  boot: async ({ page, server, serverDate }, use) => {
    await page.route('https://telegram.org/js/telegram-web-app.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
    await use(async ({ user = 1001, theme = 'light', initData = signed(user, serverDate) } = {}) => {
      await page.addInitScript(({ initData, theme }) => {
        const events = {};
        window.Telegram = { WebApp: { initData, colorScheme: theme, safeAreaInset: { top: 0, bottom: 16 }, contentSafeAreaInset: { top: 0 }, isVersionAtLeast: () => true, ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {}, setBottomBarColor() {}, onEvent: (name, handler) => { events[name] = handler; }, events } };
      }, { initData, theme });
      await page.goto(server + '/check-in/');
    });
  },
});
const card = (page, metric) => page.locator(`[data-metric="${metric}"]`);
async function fillScores(page, scores = [8, 7, 9, 6]) {
  if (!await page.locator('#entry').getAttribute('open').then(value => value !== null)) await page.locator('#entry > summary').click();
  for (const [i, metric] of ['calm', 'focus', 'energy', 'mood'].entries()) await page.locator(`#range-${metric}`).fill(String(scores[i]));
}

test('real signed API renders separate weekly averages, counts, gaps and dated chart', async ({ page, boot }) => {
  await boot();
  await expect(card(page, 'calm').locator('.card-value')).toHaveText('6,3');
  await expect(card(page, 'calm').locator('.card-count')).toHaveText('4 ответа');
  await expect(card(page, 'calm').locator('.card-delta')).toHaveText('+1,3 к прошлой · 6 ответов');
  await expect(card(page, 'focus').locator('.card-value')).toHaveText('7');
  await expect(page.locator('#week-state')).toHaveText('Текущая · ещё идёт');
  await expect(page.locator('#chart-description')).toContainText('4 нояб.: нет оценки');
  await expect(page.locator('#chart-description')).not.toContainText('7 нояб.');
  await expect(page.locator('#chart .chart-dot')).toHaveCount(4);
  await expect(page.locator('#chart .chart-line')).toHaveCount(2);
  await expect(page.locator('#streak')).toHaveText('2 дня с оценкой спокойствия подряд');
  await card(page, 'energy').click(); await expect(page.locator('#trend-title')).toHaveText('Энергия');
  await page.locator('.history-details summary').click(); await expect(page.locator('#history-rows tr')).toHaveCount(6);
  await expect(page.locator('.method')).not.toHaveAttribute('open');
});

test('week navigation includes historical zero and never compares an incomplete baseline', async ({ page, boot }) => {
  await boot(); await expect(page.locator('#next-week')).toBeDisabled();
  await page.locator('#previous-week').click(); await expect(page.locator('#week-state')).toContainText('завершена');
  await page.locator('#previous-week').click();
  await expect(card(page, 'calm').locator('.card-value')).toHaveText('0');
  await expect(card(page, 'calm').locator('.card-count')).toHaveText('1 ответ');
  await expect(card(page, 'calm').locator('.card-delta')).toHaveText('Нет сравнения');
  await expect(page.locator('#chart .chart-dot')).toHaveCount(1);
  await page.locator('#previous-week').click(); await page.locator('#previous-week').click();
  await expect(page.locator('#previous-week')).toBeDisabled();
  await page.locator('#current-week').click(); await expect(page.locator('#next-week')).toBeDisabled();
});

test('participant selection never changes the author of My day; POST survives reload', async ({ page, boot }) => {
  await boot(); await page.getByRole('button', { name: 'Борис', exact: true }).click();
  await expect(card(page, 'calm').locator('.card-value')).toHaveText('9');
  await expect(page.locator('#entry-label')).toHaveText('Мой день · отметить');
  await fillScores(page);
  await expect(page.locator('#today-date')).toContainText('Анна');
  const request = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/check-in/api'));
  await page.locator('#save').click();
  expect((await request).postDataJSON()).toEqual({ date: '2026-11-08', scores: { calm: 8, focus: 7, energy: 9, mood: 6 } });
  await expect(page.locator('#save-status')).toHaveText('Сохранено');
  await expect(card(page, 'calm').locator('.card-value')).toHaveText('9');
  await page.reload(); await expect(page.locator('#entry-label')).toHaveText('Мой день · изменить');
  await page.locator('#entry > summary').click(); await expect(page.locator('#output-calm')).toHaveText('8/10');
  await expect(page.locator('#save')).toBeDisabled();
});

test('second configured identity can save only its own data', async ({ page, boot, server, request }) => {
  await boot({ user: 1002 }); await fillScores(page, [2, 3, 4, 5]);
  await expect(page.locator('#today-date')).toContainText('Борис');
  await page.locator('#save').click(); await expect(page.locator('#save-status')).toHaveText('Сохранено');
  const response = await request.get(server + '/check-in/api', { headers: { authorization: `tma ${signed()}` } });
  const data = await response.json(); expect(data.days.at(-1).values).toEqual({ '1002': { calm: 2, focus: 3, energy: 4, mood: 5 } });
});

test('a failed save preserves all values and can be retried', async ({ page, boot }) => {
  await boot(); await fillScores(page);
  let fail = true;
  await page.route('**/check-in/api', route => { if (route.request().method() === 'POST' && fail) { fail = false; return route.fulfill({ status: 503, body: '{}' }); } return route.continue(); });
  await page.locator('#save').click(); await expect(page.locator('#save-status')).toContainText('Не удалось подтвердить');
  await expect(page.locator('#range-calm')).toHaveValue('8'); await expect(page.locator('#save')).toBeEnabled();
  await page.locator('#save').click(); await expect(page.locator('#save-status')).toHaveText('Сохранено');
});

test('loading, retry and refresh use the API and retain an unsaved draft', async ({ page, boot, server, request }) => {
  let fail = true;
  await page.route('**/check-in/api', route => fail ? route.fulfill({ status: 503, body: '{}' }) : route.continue());
  await boot(); await expect(page.locator('#retry')).toBeVisible();
  fail = false; await page.locator('#retry').click(); await expect(page.locator('#dashboard')).toBeVisible();
  await fillScores(page, [2, 3, 4, 5]);
  const response = await request.post(server + '/check-in/api', { headers: { authorization: `tma ${signed()}` }, data: { date: '2026-11-08', scores: { calm: 10, focus: 10, energy: 10, mood: 10 } } });
  expect(response.status()).toBe(200);
  await page.locator('#refresh').click(); await expect(card(page, 'calm').locator('.card-count')).toHaveText('5 ответов');
  await expect(page.locator('#range-calm')).toHaveValue('2');
  fail = true; await page.locator('#refresh').click(); await expect(page.locator('#refresh-status')).toContainText('ранее загруженные');
  await expect(card(page, 'calm').locator('.card-count')).toHaveText('5 ответов');
});

for (const [name, options, title] of [
  ['outside Telegram', { initData: '' }, 'Открой Выдох в Telegram'],
  ['unconfigured identity', { user: 9999 }, 'Доступ не настроен'],
  ['expired identity', { initData: signed(1001, '2026-11-06T09:00:00Z') }, 'Войди заново'],
  ['forged identity', { initData: signed().replace('Untrusted', 'Forged') }, 'Войди заново'],
]) test(name + ' shows no scores', async ({ page, boot }) => {
  await boot(options); await expect(page.locator('#gate-title')).toHaveText(title); await expect(page.locator('#dashboard')).toBeHidden();
});

test.describe('Saturday', () => {
  test.use({ serverDate: '2026-11-07T10:00:00Z' });
  test('disables scoring, omits Saturday votes, and preserves Friday streak', async ({ page, boot }) => {
    await boot(); await expect(page.locator('#entry-label')).toContainText('без оценок');
    await page.locator('#entry > summary').click(); await expect(page.locator('#check-in-form')).toBeHidden();
    await expect(card(page, 'calm').locator('.card-count')).toHaveText('4 ответа');
    await expect(page.locator('#streak')).toHaveText('2 дня с оценкой спокойствия подряд');
  });
});

test('phone light/dark and desktop fit, honor Telegram events, and produce fixture screenshots', async ({ page, boot }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await boot(); await expect(card(page, 'calm')).toBeVisible();
  for (const width of [320, 390, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width !== 320) await page.screenshot({ path: info.outputPath(width === 390 ? 'phone-light.png' : 'desktop.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { const app = window.Telegram.WebApp; app.colorScheme = 'dark'; app.events.themeChanged(); app.contentSafeAreaInset.top = 24; app.events.contentSafeAreaChanged(); });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.locator('html').evaluate(element => element.style.getPropertyValue('--safe-top'))).toContain('24px');
  await page.screenshot({ path: info.outputPath('phone-dark.png'), fullPage: true });
  await page.locator('#previous-week').focus(); await page.keyboard.press('Enter'); await expect(page.locator('#week-state')).toContainText('завершена');
  expect(errors).toEqual([]);
});
