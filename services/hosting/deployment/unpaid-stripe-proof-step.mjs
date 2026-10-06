// Private host pipe only. The only provider mutation is expiring this exact
// diagnostic unpaid checkout. No charge, confirmation, refund or payout API.
export async function unpaidStripeStep(phase, input, { prisma, fetcher = fetch, env = process.env }) {
  const fail = code => { const e = new Error('Unpaid checkout proof stopped'); e.safeCode = code; throw e; };
  if (!['expire', 'inspect'].includes(phase) || !/^[a-f0-9-]{36}$/.test(input?.orderId || '') ||
      !/^[a-f0-9-]{36}$/.test(input?.userId || '') ||
      input.externalId !== 'wai-vds-' + input.orderId + '-g0' ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(input.paymentId || '')) fail('exact_own_proof_identifiers_required');
  const payment = await prisma.payment.findUnique({ where: { id: input.paymentId } });
  if (!payment || payment.appId !== 'wai-vds' || payment.providerAccountId !== 'stripe-vds' || payment.provider !== 'STRIPE' ||
      payment.mode !== 'LIVE' || payment.apiVersion !== 2 || payment.externalOrderId !== input.externalId ||
      payment.requestedAmount !== 1200 || payment.currency !== 'USD' || payment.paidAmount !== 0 ||
      payment.refundedAmount !== 0 || payment.paidAt ||
      payment.metadata?.wai_order_id !== input.orderId || payment.metadata?.wai_user_id !== input.userId ||
      !/^cs_live_[A-Za-z0-9_]+$/.test(payment.providerPaymentId || '')) fail('payment_binding_or_unpaid_guard');
  const account = await prisma.providerAccount.findUnique({ where: { id: 'stripe-vds' } });
  if (!account?.isActive || account.mode !== 'LIVE' || account.provider !== 'STRIPE' || account.envPrefix !== 'STRIPE_WAI_VDS') fail('dedicated_provider_not_ready');
  const key = env.STRIPE_WAI_VDS_SECRET_KEY;
  if (!/^sk_live_[A-Za-z0-9_-]+$/.test(key || '')) fail('dedicated_live_key_required');
  const base = 'https://api.stripe.com/v1/checkout/sessions/' + payment.providerPaymentId;
  const request = async (url, options = {}) => {
    let response;
    try { response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + key, 'Stripe-Version': '2025-02-24.acacia', ...options.headers } }); }
    catch { fail('provider_result_unknown_reconcile_same_session'); }
    if (!response.ok) fail('provider_http_' + response.status);
    try { return await response.json(); } catch { fail('provider_result_unknown_reconcile_same_session'); }
  };
  const assertSession = s => {
    if (s.id !== payment.providerPaymentId || s.livemode !== true || s.mode !== 'payment' ||
        s.client_reference_id !== payment.id || s.metadata?.waiPayPaymentId !== payment.id ||
        s.amount_total !== 1200 || s.currency !== 'usd' || s.payment_status !== 'unpaid' ||
        !['open', 'expired'].includes(s.status)) fail('stripe_session_binding_or_unpaid_guard');
  };
  let session = await request(base); assertSession(session);
  let expireRequestSent = false;
  if (phase === 'expire' && session.status === 'open') {
    expireRequestSent = true;
    session = await request(base + '/expire', { method: 'POST', body: '', headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': 'wai-vds-unpaid-expire-' + input.orderId } });
    assertSession(session);
    if (session.status !== 'expired') fail('session_not_expired');
  }
  const logs = await prisma.webhookLog.findMany({ where: { paymentId: payment.id, providerAccountId: 'stripe-vds',
    provider: 'STRIPE', verified: true, processed: true }, select: { id: true, createdAt: true, rawPayload: true }, take: 20, orderBy: { createdAt: 'desc' } });
  const verifiedExpiry = logs.filter(x => x.rawPayload?.type === 'checkout.session.expired' &&
    x.rawPayload?.data?.object?.id === payment.providerPaymentId).map(x => ({ logId: x.id, eventId: x.rawPayload.id, createdAt: x.createdAt }));
  const events = await prisma.clientEvent.findMany({ where: { appId: 'wai-vds', paymentId: payment.id, type: 'payment.expired' },
    select: { id: true, type: true, paymentVersion: true, deliveries: { select: { status: true, statusCode: true, deliveredAt: true, callbackUrl: true } } } });
  return { ok: true, phase, paymentId: payment.id, orderId: input.orderId,
    stripe: { sessionStatus: session.status, paymentStatus: session.payment_status, amountMinor: session.amount_total, currency: session.currency, expireRequestSent },
    waiPay: { status: payment.status, paidAmountMinor: payment.paidAmount, refundedAmountMinor: payment.refundedAmount },
    verifiedStripeExpiryEvents: verifiedExpiry,
    clientEvents: events.map(e => ({ id: e.id, type: e.type, paymentVersion: e.paymentVersion,
      deliveredToOwnApp: e.deliveries.some(d => d.status === 'delivered' && d.statusCode === 200 &&
        d.callbackUrl === 'https://pay.waiwai.is/vds/api/v1/webhooks/wai-pay'),
      deliveryStatuses: e.deliveries.map(d => ({ status: d.status, statusCode: d.statusCode, deliveredAt: d.deliveredAt })) })),
    chargesPerformed: 0, fakePaymentCallbacksSent: 0 };
}
if (process.argv[1] === '-') {
  let prisma;
  try {
    if (process.env.WAI_UNPAID_PRIVATE_PIPE !== '1' || process.stdout.isTTY) throw new Error('private_wrapper_required');
    const { PrismaClient } = await import('@prisma/client'); prisma = new PrismaClient();
    process.stdout.write(JSON.stringify(await unpaidStripeStep(process.argv[2], globalThis.__WAI_UNPAID_INPUT, { prisma })));
  } catch (e) { process.stdout.write(JSON.stringify({ ok: false, code: e.safeCode || 'proof_failed' })); process.exitCode = 1; }
  finally { await prisma?.$disconnect(); }
}
