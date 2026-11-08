import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'daily-metrics-ui.spec.mjs', fullyParallel: false, workers: 1,
  outputDir: '../.data/metrics-ui-results', reporter: 'list',
  use: { viewport: { width: 390, height: 844 }, locale: 'ru-RU', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
