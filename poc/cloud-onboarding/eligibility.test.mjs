import test from 'node:test';
import assert from 'node:assert/strict';
import { assessVdsCatalog } from './eligibility.mjs';

const smallCatalog = { plan: { id: 'start', amount: 1200, currency: 'usd', period_days: 30, ram_mb: 2048, disk_gb: 20, ipv4: 1 }, mode: { provider: 'emulator', payments: 'emulator' } };

test('the VDS service general-purpose 2 GB / 20 GB plan is not accepted as the OpenStrudel profile', () => {
  const result = assessVdsCatalog(smallCatalog);
  assert.equal(result.matchingResourceProfile, false);
  assert.ok(result.blockers.includes('insufficient_memory'));
  assert.ok(result.blockers.includes('insufficient_disk'));
  assert.ok(result.blockers.includes('live_provider_not_verified'));
  assert.equal(result.readyForPublicSales, false);
});
test('qualifying resources do not certify bootstrap, human OAuth, payment, or reboot', () => {
  const result = assessVdsCatalog({ ...smallCatalog, plan: { ...smallCatalog.plan, ram_mb: 4096, disk_gb: 40 }, mode: { provider: 'kamatera', payments: 'stripe' } });
  assert.equal(result.matchingResourceProfile, true);
  assert.equal(result.homeBootstrapVerified, false);
  assert.equal(result.humanOpenAIAuthorizationVerified, false);
  assert.equal(result.rebootRecoveryVerified, false);
  assert.equal(result.readyForPublicSales, false);
});
test('missing catalog, IPv6-only offers and unquoted prices fail preflight', () => {
  assert.ok(assessVdsCatalog(null).blockers.includes('plan_missing'));
  const result = assessVdsCatalog({ ...smallCatalog, plan: { ...smallCatalog.plan, ipv4: 0, amount: Infinity, period_days: 0 } });
  assert.ok(result.blockers.includes('public_ipv4_required'));
  assert.ok(result.blockers.includes('quote_invalid'));
  assert.ok(result.blockers.includes('billing_period_missing'));
});
test('a live catalog with closed checkout stays visibly blocked', () => {
  const result = assessVdsCatalog({ ...smallCatalog, plan: { ...smallCatalog.plan, checkout_enabled: false }, mode: { provider: 'kamatera', payments: 'wai_pay' } });
  assert.ok(result.blockers.includes('checkout_disabled'));
  assert.equal(result.readyForPublicSales, false);
});
