import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transition, scenario, restore, canCreateNewOrder, phases } from './flow.mjs';

function apply(start, ...events) { return events.reduce((state, type) => transition(state, { type }), start); }

test('return from checkout does not mean paid and cannot prepare a server', () => {
  const state = apply(initialState(), 'CHECKOUT', 'PAYMENT_RETURN', 'CREATED', 'HEALTHY');
  assert.equal(state.phase, 'verifying'); assert.equal(state.paid, false); assert.equal(state.orderId, null);
});
test('confirmed payment, provisioning, personal consent and account readiness complete in order', () => {
  const state = apply(initialState(), 'CHECKOUT', 'PAYMENT_RETURN', 'PAYMENT_CONFIRMED', 'CREATED', 'INSTALLED', 'HEALTHY', 'OPENAI_LOGIN', 'AUTH_GRANTED');
  assert.equal(state.phase, 'ready'); assert.equal(state.accountConnected, true); assert.equal(state.orderId, 'demo-order-1');
});
test('out-of-order authorisation never signs a user in or skips their consent', () => {
  assert.equal(apply(initialState(), 'AUTH_GRANTED', 'HEALTHY').accountConnected, false);
  assert.equal(apply(scenario('openai'), 'AUTH_GRANTED').phase, 'openai');
});
test('double payment confirmations and repeated clicks keep one order', () => {
  const paid = apply(initialState(), 'CHECKOUT', 'PAYMENT_CONFIRMED');
  assert.deepEqual(apply(paid, 'PAYMENT_CONFIRMED', 'CHECKOUT', 'PAYMENT_RETURN'), paid);
});
test('unknown result and slow setup preserve the existing paid order', () => {
  for (const event of ['CREATE_UNKNOWN', 'SETUP_DELAYED']) {
    const state = apply(scenario('creating'), event, 'RETRY_STATUS', 'CHECKOUT', 'PAYMENT_CONFIRMED');
    assert.equal(state.orderId, 'demo-order-1'); assert.equal(state.paid, true); assert.equal(canCreateNewOrder(state), false);
  }
});
test('loss of connection does not require OpenAI login again when the host returns', () => {
  const state = apply(scenario('ready'), 'DISCONNECTED', 'RETRY_STATUS', 'HEALTHY');
  assert.equal(state.phase, 'ready'); assert.equal(state.accountConnected, true);
});
test('revoked OpenAI access is recovered without another payment or new machine', () => {
  const expired = apply(scenario('ready'), 'AUTH_EXPIRED');
  assert.equal(expired.phase, 'authExpired'); assert.equal(expired.accountConnected, false);
  const ready = apply(expired, 'OPENAI_LOGIN', 'AUTH_GRANTED');
  assert.equal(ready.phase, 'ready'); assert.equal(ready.orderId, expired.orderId); assert.equal(ready.paid, true);
});
test('closing authorisation preserves the paid installation', () => {
  const state = apply(scenario('openai'), 'OPENAI_LOGIN', 'AUTH_CANCELLED');
  assert.equal(state.phase, 'openai'); assert.equal(state.hostReady, true); assert.equal(state.paid, true);
});
test('declined payment allows retry, but cannot cause provisioning', () => {
  const state = apply(initialState(), 'CHECKOUT', 'PAYMENT_FAILED', 'CREATED');
  assert.equal(state.phase, 'paymentFailed'); assert.equal(canCreateNewOrder(state), true);
  assert.equal(apply(state, 'CHECKOUT').phase, 'checkout');
});
test('autorenew starts off and cancellation preserves paid service', () => {
  assert.equal(initialState().autoRenew, false);
  const renewed = transition(scenario('checkout'), { type: 'SET_AUTORENEW', enabled: true });
  assert.equal(renewed.autoRenew, true);
  const cancelled = apply({ ...scenario('ready'), autoRenew: true }, 'CANCEL_RENEWAL');
  assert.equal(cancelled.autoRenew, false); assert.equal(cancelled.hostReady, true); assert.equal(cancelled.paid, true);
});
test('every review scenario survives reopening without losing its order', () => {
  for (const phase of phases) assert.deepEqual(restore(JSON.stringify(scenario(phase))), scenario(phase), phase);
});
test('incomplete or tampered preview storage starts safely and discards secrets', () => {
  assert.deepEqual(restore('{bad'), initialState());
  assert.deepEqual(restore(JSON.stringify({ ...scenario('ready'), paid: false })), initialState());
  assert.deepEqual(restore(JSON.stringify({ ...scenario('ready'), accountConnected: false })), initialState());
  assert.equal(restore(JSON.stringify({ ...scenario('ready'), token: 'do-not-restore' })).token, undefined);
});

test('temporary OpenAI outage retains authorisation and returns to the same team', () => {
  const outage = apply(scenario('ready'), 'OPENAI_UNAVAILABLE');
  assert.equal(outage.accountConnected, true); assert.equal(outage.phase, 'openaiOutage');
  assert.equal(apply(outage, 'OPENAI_LOGIN').phase, 'openaiOutage');
  assert.equal(apply(outage, 'OPENAI_AVAILABLE').phase, 'ready');
});
test('ordinary paired clients cannot authorise OpenAI and recover when the owner reconnects', () => {
  const waiting = scenario('ownerRequired');
  assert.deepEqual(apply(waiting, 'OPENAI_LOGIN', 'AUTH_GRANTED'), waiting);
  const ready = apply(waiting, 'OWNER_RECONNECTED');
  assert.equal(ready.phase, 'ready'); assert.equal(ready.role, 'member');
  assert.deepEqual(apply(ready, 'CANCEL_RENEWAL'), ready);
  assert.equal(apply(ready, 'AUTH_EXPIRED').phase, 'ownerRequired');
  assert.deepEqual(restore(JSON.stringify(ready)), ready);
});
test('revoked pairing is different from a revoked OpenAI account and cannot create another paid order', () => {
  const revoked = apply(scenario('ready'), 'PAIRING_REVOKED');
  assert.equal(revoked.phase, 'pairingRevoked'); assert.equal(revoked.accountConnected, true);
  assert.equal(canCreateNewOrder(revoked), false); assert.equal(apply(revoked, 'OPENAI_LOGIN').phase, 'pairingRevoked');
});
test('an expired device code is retried without losing installation or payment', () => {
  const expired = apply(scenario('authorizing'), 'AUTH_TIMED_OUT');
  assert.equal(expired.phase, 'codeExpired'); assert.equal(expired.paid, true);
  const retry = apply(expired, 'OPENAI_LOGIN');
  assert.equal(retry.phase, 'authorizing'); assert.equal(retry.orderId, expired.orderId);
});
