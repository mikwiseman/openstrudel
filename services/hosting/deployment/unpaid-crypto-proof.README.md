# Unpaid Cryptomus checkout proof — verified in production

Executed 5 October 2026: natural cancel, actual verified provider webhook, callback HTTP 200, matching VDS receipt and released capacity; no transfer or new VM. Evidence: `outputs/production-crypto-proof.json`. The invoice returned a documented nullable received amount, explicitly distinguished from numerical zero. Upstream cancellation arrived 115 seconds after the invoice deadline; the provider publishes no delay SLA.

For a future separately reviewed proof, install the two `unpaid-crypto-proof` files beside the reviewed
`unpaid-stripe-proof.py` on the documented host. The latter supplies generic
private-file, HTTP and read-only SQLite utilities only; no Stripe call is reused.

1. After reviewing routing and enabling the VDS checkout gate, run
   `python3 unpaid-crypto-proof.py create` once as root on `103.45.247.25`.
   It creates one normal VDS **site** order and one **12 USDT** invoice through
   the normal VDS API. It does not pay, open the checkout page or publish its URL.
2. Keep `/srv/wai-vds/unpaid-crypto-proof/state.json` (root0600). It contains the
   stable idempotency intent and private checkout URL. Re-running `create` reads
   the same saved payment. A lost response is reconciled through the exact
   external ID before considering the same normal VDS checkout operation.
3. Do other work until the returned `verifyAfter` timestamp. Nothing sleeps or
   polls inside the script. It does not reset invoice lifetime.
4. Run `python3 unpaid-crypto-proof.py verify`. If actual callback delivery is
   pending, retry this read-only phase later. It remains usable with the public
   checkout gate closed. Evidence is root0600 `evidence.json`; stdout is sanitized.

`passed:true` requires native explicit zero received amount, or the narrow verified
case `cancel` + `is_final:true` + `payment_amount:null` with no network, address,
transaction ID or sender in both native information and its signed webhook.
The nullable case is reported separately with `receivedAmountNull:true`,
`uninitializedInvoice:true`, `receivedZeroVerified:false` and
`cancellationUnpaidVerified:true`; it is never represented as explicit zero.
Null amounts with a noncancel status or any transaction/address evidence fail.
Both cases also require natural terminal expiry, the matching WAI Pay terminal state, a verified/processed provider webhook,
the real v2 event delivered to our exact callback with HTTP200, a matching VDS
receipt, no paid timestamp or VM, and released capacity. Customer wallet address,
active payment URL, credentials and email never appear in stdout/evidence.

The normal native outcome for a never-paid invoice is `cancel`, mapped by WAI Pay
to `CANCELLED` / `payment.canceled`. `expired` is also recognized by the existing
driver. The script checks the actual result instead of forcing either state.

Official contract:

- [Creating an invoice](https://doc.cryptomus.com/merchant-api/payments/creating-invoice): lifetime300–43200 seconds; deployed WAI Pay v2 uses900.
- [Payment information](https://doc.cryptomus.com/merchant-api/payments/payment-information): the only native request in this proof is read-only POST `/v1/payment/info` with the exact bound UUID.
- [Payment statuses](https://doc.cryptomus.com/merchant-api/payments/payment-statuses): `cancel` means the customer did not pay.
- [Webhook](https://doc.cryptomus.com/merchant-api/payments/webhook): real signed provider callback evidence.
- [Cancel recurrence](https://doc.cryptomus.com/merchant-api/recurring/cancel) cancels a recurring payment, not this invoice. No documented early cancellation for a single invoice was found in the payments API, so no guessed endpoint is attempted.

No native create, refresh, refund, recurrence cancel, mark-paid, test-webhook,
manual sync, fake callback, charge or payout API is called by the helper. The
normal VDS checkout is the sole invoice creation path; all history is retained.
