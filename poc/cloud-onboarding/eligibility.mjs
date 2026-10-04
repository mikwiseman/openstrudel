// Provider-independent preflight for the separate VDS service's public catalog.
// A matching plan is necessary, but never sufficient, to publish paid cloud setup.
export const homeRequirements = Object.freeze({ memoryMiB: 4096, diskGB: 30, publicIPv4: 1 });

export function assessVdsCatalog(catalog) {
  const plan = catalog?.plan;
  const blockers = [];
  if (!plan || typeof plan.id !== 'string' || !plan.id.trim()) blockers.push('plan_missing');
  if (!Number.isFinite(plan?.ram_mb) || plan.ram_mb < homeRequirements.memoryMiB) blockers.push('insufficient_memory');
  if (!Number.isFinite(plan?.disk_gb) || plan.disk_gb < homeRequirements.diskGB) blockers.push('insufficient_disk');
  if (!Number.isInteger(plan?.ipv4) || plan.ipv4 < homeRequirements.publicIPv4) blockers.push('public_ipv4_required');
  if (!Number.isSafeInteger(plan?.amount) || plan.amount <= 0 || typeof plan?.currency !== 'string'
    || !/^[a-zA-Z]{3}$/.test(plan.currency)) blockers.push('quote_invalid');
  if (!Number.isInteger(plan?.period_days) || plan.period_days <= 0) blockers.push('billing_period_missing');
  if (plan?.checkout_enabled === false) blockers.push('checkout_disabled');
  const infrastructureMode = catalog?.mode?.provider;
  const paymentMode = catalog?.mode?.payments;
  if (!infrastructureMode || infrastructureMode === 'emulator') blockers.push('live_provider_not_verified');
  if (!paymentMode || paymentMode === 'emulator') blockers.push('live_payments_not_verified');
  return {
    requirements: homeRequirements,
    matchingResourceProfile: !blockers.some(code => ['plan_missing', 'insufficient_memory', 'insufficient_disk', 'public_ipv4_required'].includes(code)),
    blockers,
    // Do not trust marketing, a health endpoint, a paid flag, or a running VM as Home acceptance.
    homeBootstrapVerified: false,
    humanOpenAIAuthorizationVerified: false,
    rebootRecoveryVerified: false,
    readyForPublicSales: false,
  };
}
