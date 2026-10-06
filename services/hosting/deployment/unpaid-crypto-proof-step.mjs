// Read-only Cryptomus proof. POST /payment/info is the documented information API.
// Never call invoice create, refresh, refund, recurrence cancel, mark-paid or test-webhook.
import { createHash } from 'node:crypto';

export async function unpaidCryptoStep(phase, input, { prisma, fetcher = fetch, env = process.env, now = Date.now }) {
  const fail = code => { const e = new Error('Unpaid crypto proof stopped'); e.safeCode = code; throw e; };
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const decimalZero = value => typeof value === 'string' && /^0+(?:\.0+)?$/.test(value);
  const decimalTwelve = value => typeof value === 'string' && /^12(?:\.0+)?$/.test(value);
  const uninitialized = value => ['network', 'address', 'txid', 'from'].every(k => value[k] === null || value[k] === undefined);
  const canceledWithNullAmount = value => value.status === 'cancel' && value.is_final === true &&
    value.payment_amount === null && uninitialized(value);
  if (phase !== 'inspect' || !uuid.test(input?.orderId || '') || !uuid.test(input?.userId || '') ||
      input.externalId !== 'wai-vds-' + input.orderId + '-g0' ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(input.paymentId || '')) fail('exact_own_proof_identifiers_required');
  const payment = await prisma.payment.findUnique({ where: { id: input.paymentId } });
  if (!payment || payment.appId !== 'wai-vds' || payment.providerAccountId !== 'cryptomus-main' || payment.provider !== 'CRYPTOMUS' ||
      payment.mode !== 'LIVE' || payment.apiVersion !== 2 || payment.externalOrderId !== input.externalId ||
      payment.requestedAmount !== 1200 || payment.currency !== 'USDT' || payment.paidAmount !== 0 ||
      payment.refundedAmount !== 0 || payment.paidAt ||
      payment.metadata?.wai_order_id !== input.orderId || payment.metadata?.wai_user_id !== input.userId ||
      !uuid.test(payment.providerPaymentId || '')) fail('payment_binding_or_unpaid_guard');
  const account = await prisma.providerAccount.findUnique({ where: { id: 'cryptomus-main' } });
  if (!account?.isActive || account.mode !== 'LIVE' || account.provider !== 'CRYPTOMUS' || account.envPrefix !== 'CRYPTOMUS_MAIN') fail('reviewed_crypto_account_required');
  const merchant = env.CRYPTOMUS_MAIN_MERCHANT_ID, key = env.CRYPTOMUS_MAIN_API_KEY;
  if (!uuid.test(merchant || '') || typeof key !== 'string' || key.length < 16) fail('live_crypto_credentials_required');
  const body = JSON.stringify({ uuid: payment.providerPaymentId });
  const sign = createHash('md5').update(Buffer.from(body).toString('base64') + key).digest('hex');
  let response, parsed;
  try {
    response = await fetcher('https://api.cryptomus.com/v1/payment/info', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', merchant, sign }, body
    });
  } catch { fail('provider_info_unavailable_no_retry'); }
  if (!response.ok) fail('provider_info_http_' + response.status);
  try { parsed = await response.json(); } catch { fail('provider_info_invalid_json'); }
  const invoice = parsed?.result;
  if (parsed?.state !== 0 || !invoice || invoice.uuid !== payment.providerPaymentId || invoice.order_id !== payment.id ||
      !decimalTwelve(invoice.amount) || invoice.currency !== 'USDT') fail('crypto_invoice_binding_or_amount_guard');
  const terminal = ['cancel', 'expired'].includes(invoice.status);
  if (!['new', 'process', 'check', 'cancel', 'expired'].includes(invoice.status) ||
      typeof invoice.is_final !== 'boolean' || invoice.is_final !== terminal ||
      (invoice.payment_status !== undefined && invoice.payment_status !== null && invoice.payment_status !== invoice.status)) fail('crypto_invoice_unpaid_status_guard');
  // Official schema permits payment_amount:string|null. This live, never-opened
  // invoice finalized as cancel with null and no network/address/transaction.
  // This is cancellation evidence, not an explicit zero amount. The DB binding
  // above separately requires paidAmount=0, refundedAmount=0 and no paidAt.
  const zeroAmountVerified = decimalZero(invoice.payment_amount);
  const receivedAmountNull = invoice.payment_amount === null;
  const uninitializedInvoice = uninitialized(invoice);
  const cancellationUnpaidVerified = invoice.status === 'cancel' && invoice.is_final === true &&
    (zeroAmountVerified || canceledWithNullAmount(invoice));
  if ((receivedAmountNull && !canceledWithNullAmount(invoice)) ||
      (!zeroAmountVerified && invoice.payment_amount !== undefined && !receivedAmountNull) ||
      (terminal && !zeroAmountVerified && !cancellationUnpaidVerified)) fail('crypto_received_amount_guard');
  const expires = invoice.expired_at;
  const created = typeof invoice.created_at === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(invoice.created_at) ? Date.parse(invoice.created_at) : NaN;
  const savedExpiry = payment.expiresAt instanceof Date ? payment.expiresAt.getTime() : Date.parse(payment.expiresAt || '');
  const lifetime = expires - created / 1000;
  if (!Number.isSafeInteger(expires) || !Number.isFinite(created) || !Number.isFinite(savedExpiry) ||
      savedExpiry !== expires * 1000 || lifetime < 898 || lifetime > 902) fail('crypto_900_second_expiry_binding_guard');
  const expectedEvent = invoice.status === 'cancel' ? 'payment.canceled' : invoice.status === 'expired' ? 'payment.expired' : null;
  const logs = await prisma.webhookLog.findMany({ where: { paymentId: payment.id, providerAccountId: 'cryptomus-main',
    provider: 'CRYPTOMUS', verified: true, processed: true }, select: { id: true, createdAt: true, rawPayload: true }, take: 20, orderBy: { createdAt: 'desc' } });
  const verifiedTerminal = logs.filter(x => {
    const p = x.rawPayload;
    return terminal && p?.uuid === payment.providerPaymentId && p.order_id === payment.id && p.status === invoice.status &&
      p.is_final === true && (decimalZero(p.payment_amount) || canceledWithNullAmount(p)) && decimalTwelve(p.amount) && p.currency === 'USDT';
  }).map(x => ({ logId: x.id, status: x.rawPayload.status, createdAt: x.createdAt,
    receivedAmountNull: x.rawPayload.payment_amount === null,
    uninitializedInvoice: uninitialized(x.rawPayload), receivedZeroVerified: decimalZero(x.rawPayload.payment_amount) }));
  const events = await prisma.clientEvent.findMany({ where: { appId: 'wai-vds', paymentId: payment.id,
    type: { in: ['payment.canceled', 'payment.expired'] } },
    select: { id: true, type: true, paymentVersion: true, deliveries: { select: { status: true, statusCode: true, deliveredAt: true, callbackUrl: true } } } });
  return { ok: true, phase, paymentId: payment.id, orderId: input.orderId,
    cryptomus: { status: invoice.status, final: invoice.is_final, amountMinor: 1200, currency: 'USDT',
      receivedZeroVerified: zeroAmountVerified, receivedAmountNull, uninitializedInvoice, cancellationUnpaidVerified,
      expiresAt: new Date(expires * 1000).toISOString(),
      lifetimeSeconds: lifetime, naturalExpiryReached: now() >= expires * 1000, expectedEvent },
    waiPay: { status: payment.status, paidAmountMinor: payment.paidAmount, refundedAmountMinor: payment.refundedAmount },
    verifiedCryptomusTerminalEvents: verifiedTerminal,
    clientEvents: events.map(e => ({ id: e.id, type: e.type, paymentVersion: e.paymentVersion,
      deliveredToOwnApp: e.deliveries.some(d => d.status === 'delivered' && d.statusCode === 200 &&
        d.callbackUrl === 'https://pay.waiwai.is/vds/api/v1/webhooks/wai-pay'),
      deliveryStatuses: e.deliveries.map(d => ({ status: d.status, statusCode: d.statusCode, deliveredAt: d.deliveredAt })) })),
    sources: { nullableAmountSchema: 'https://doc.cryptomus.com/merchant-api/payments/creating-invoice',
      cancellationStatus: 'https://doc.cryptomus.com/merchant-api/payments/payment-statuses',
      signedWebhook: 'https://doc.cryptomus.com/merchant-api/payments/webhook' },
    providerMutationRequests: 0, chargesPerformed: 0, fakePaymentCallbacksSent: 0 };
}

if (process.argv[1] === '-') {
  let prisma;
  try {
    if (process.env.WAI_UNPAID_PRIVATE_PIPE !== '1' || process.stdout.isTTY) throw new Error('private_wrapper_required');
    const { PrismaClient } = await import('@prisma/client'); prisma = new PrismaClient();
    process.stdout.write(JSON.stringify(await unpaidCryptoStep(process.argv[2], globalThis.__WAI_UNPAID_INPUT, { prisma })));
  } catch (e) { process.stdout.write(JSON.stringify({ ok: false, code: e.safeCode || 'proof_failed' })); process.exitCode = 1; }
  finally { await prisma?.$disconnect(); }
}
