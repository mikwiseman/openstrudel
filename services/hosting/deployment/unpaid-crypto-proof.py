#!/usr/bin/env python3
"""Prepared only. create: one normal VDS site/crypto order, no payment.
verify: read native info and actual webhook/callback receipts after 900s expiry.
Requires the reviewed unpaid-stripe-proof.py beside this file for shared
HTTP/private-file/read-only SQLite utilities. No Stripe provider call is reused.
No automatic wait, polling, refresh, cancel, refund, mark-paid or test-webhook.
"""
import datetime
import fcntl
import importlib.util
import json
import os
import pathlib
import re
import secrets
import stat
import subprocess
import sys
import uuid

_spec = importlib.util.spec_from_file_location('unpaid_proof_utilities', pathlib.Path(__file__).with_name('unpaid-stripe-proof.py'))
_shared = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_shared)
Stop, write_private, private_bytes, request, local_evidence = (_shared.Stop, _shared.write_private, _shared.private_bytes, _shared.request, _shared.local_evidence)
BASE = pathlib.Path('/srv/wai-vds/unpaid-crypto-proof')
STATE, EVIDENCE = BASE / 'state.json', BASE / 'evidence.json'
HELPER = pathlib.Path(__file__).with_name('unpaid-crypto-proof-step.mjs')
STRIPE_STATE = pathlib.Path('/srv/wai-vds/unpaid-stripe-proof/state.json')
ORIGIN = 'https://pay.waiwai.is'
VDS = ORIGIN + '/vds'

def backend(state):
    payload = {k: state[k] for k in ('orderId', 'userId', 'externalId', 'paymentId')}
    source = 'globalThis.__WAI_UNPAID_INPUT=' + json.dumps(payload) + ';\n' + HELPER.read_text()
    try:
        result = subprocess.run(['docker', 'exec', '-i', '-e', 'WAI_UNPAID_PRIVATE_PIPE=1', 'waipay-backend',
            'node', '--input-type=module', '-', 'inspect'], input=source, text=True, capture_output=True, timeout=60)
        data = json.loads(result.stdout)
    except Exception: raise Stop('backend_readonly_proof_unavailable') from None
    if result.returncode or not data.get('ok'):
        code = data.get('code', '')
        raise Stop(code if re.fullmatch(r'[a-z0-9_]+', str(code)) else 'backend_readonly_proof_failed')
    return data

def verify(state):
    upstream = backend(state)
    events, native = upstream['clientEvents'], upstream['cryptomus']
    local = local_evidence(state, [e['id'] for e in events])
    expected_event = native['expectedEvent']
    delivered_ids = {e['id'] for e in events if e['deliveredToOwnApp'] and e['type'] == expected_event}
    receipt_ids = {e['id'].removeprefix('wai:') for e in local['receipts'] if e['type'] == expected_event}
    null_cancellation = native.get('cancellationUnpaidVerified') is True and native['status'] == 'cancel' and native['final'] is True and native.get('receivedAmountNull') is True and native.get('uninitializedInvoice') is True
    unpaid = (native['receivedZeroVerified'] or null_cancellation) and upstream['waiPay']['paidAmountMinor'] == 0 and local['paidAmountMinor'] == 0 and not local['paidAtPresent'] and not local['serverIdPresent'] and local['serverCount'] == 0
    terminal_mapping = {'cancel': ('CANCELLED', 'canceled'), 'expired': ('EXPIRED', 'expired')}
    matching_terminal = terminal_mapping.get(native['status']) == (upstream['waiPay']['status'], local['attemptState'])
    passed = bool(unpaid and native['final'] and native['naturalExpiryReached'] and matching_terminal and upstream['verifiedCryptomusTerminalEvents'] and delivered_ids & receipt_ids and local['capacityState'] == 'released')
    result = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'passed': passed,
        'pendingNaturalExpiry': not native['naturalExpiryReached'],
        'pendingRealDelivery': native['naturalExpiryReached'] and unpaid and not passed,
        'verifyAfter': native['expiresAt'], 'upstream': upstream, 'vds': local,
        'chargesPerformed': 0, 'fakePaymentCallbacksSent': 0, 'providerCancelOrRefundRequests': 0,
        'retainedDiagnosticHistory': True}
    write_private(EVIDENCE, result)
    return result

def bind_payment(state, data):
    payment = data.get('payment', {})
    if payment.get('externalPaymentId') != state['externalId'] or payment.get('providerAccountId') != 'cryptomus-main' or payment.get('provider') != 'cryptomus' or payment.get('mode') != 'live' or payment.get('requestedAmountMinor') != 1200 or payment.get('currency') != 'USDT' or payment.get('paidAmountMinor') != 0 or payment.get('refundedAmountMinor') != 0 or payment.get('metadata', {}).get('wai_order_id') != state['orderId'] or payment.get('metadata', {}).get('wai_user_id') != state['userId']:
        raise Stop('wai_pay_crypto_binding_failed')
    if state.get('paymentId') and state['paymentId'] != payment.get('id'): raise Stop('persisted_payment_changed')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', str(payment.get('id', ''))): raise Stop('payment_id_invalid')
    state['paymentId'] = payment['id']
    write_private(STATE, state)

def initial_state():
    identifier = str(uuid.uuid4())
    state = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'proofId': identifier,
        'orderKey': 'crypto-unpaid-proof-' + identifier, 'purpose': 'site', 'paymentMethod': 'crypto'}
    if STRIPE_STATE.exists():
        old = json.loads(private_bytes(STRIPE_STATE))
        if not re.fullmatch(r'wai-vds-unpaid-[a-f0-9-]{36}@example\.invalid', str(old.get('email', ''))) or not isinstance(old.get('password'), str) or len(old['password']) < 32:
            raise Stop('saved_qa_identity_guard')
        if not old.get('paymentId'): raise Stop('complete_stripe_proof_first')
        previous = local_evidence(old, [])
        if previous['paidAmountMinor'] != 0 or previous['paidAtPresent'] or previous['serverIdPresent'] or previous['serverCount'] != 0 or previous['capacityState'] != 'released':
            raise Stop('previous_qa_capacity_not_released')
        state.update(email=old['email'], password=old['password'], expectedUserId=old['userId'], reusedStripeQaAccount=True)
    else:
        state.update(email='wai-vds-crypto-unpaid-' + identifier + '@example.invalid', password=secrets.token_urlsafe(36), reusedStripeQaAccount=False)
    return state

def main(command):
    if command not in ('create', 'verify'): raise Stop('use_create_or_verify')
    if os.geteuid() != 0 or not pathlib.Path('/srv/wai-pay/app/docker-compose.yml').is_file(): raise Stop('documented_host_root_required')
    env = {}
    for line in private_bytes(pathlib.Path('/srv/wai-vds/runtime.env')).decode().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k, v = line.split('=', 1); env[k.strip()] = v.strip().strip('"').strip("'")
    if env.get('WAI_ORIGIN') != VDS or env.get('WAI_PAY_MODE') != 'live' or env.get('WAI_PAY_CRYPTO_ACCOUNT_ID') != 'cryptomus-main': raise Stop('reviewed_vds_crypto_routing_required')
    BASE.mkdir(mode=0o700, exist_ok=True)
    info = BASE.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077: raise Stop('private_directory_permissions')
    lock = os.open(BASE/'proof.lock', os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
        state = json.loads(private_bytes(STATE)) if STATE.exists() else None
        if command == 'verify' or state and state.get('paymentId'):
            if not state or not state.get('paymentId'): raise Stop('existing_crypto_proof_required')
            return verify(state)
        pay_headers = {'Authorization': 'Bearer ' + env['WAI_PAY_API_KEY']}
        if state and state.get('externalId'):
            # Recover a lost checkout response even after the public gate is closed.
            code, data, _ = request(ORIGIN+'/api/v2/payments/by-external/'+state['externalId'], headers=pay_headers)
            if code == 200: bind_payment(state, data); return verify(state)
            if code != 404 or data.get('error', {}).get('code') != 'NOT_FOUND': raise Stop('existing_intent_read_failed')
        code, catalog, _ = request(VDS+'/api/v1/catalog')
        crypto = next((m for m in catalog.get('payment_methods', []) if m.get('id') == 'crypto'), {})
        if code != 200 or not catalog.get('plan', {}).get('checkout_enabled') or crypto.get('amount') != 1200 or crypto.get('currency') != 'usdt' or crypto.get('test') is not False or crypto.get('available') is not True:
            raise Stop('temporarily_enabled_reviewed_crypto_checkout_required')
        if state is None:
            state = initial_state(); write_private(STATE, state)
        code, auth, cookie = request(VDS+'/api/v1/auth/login', {'email': state['email'], 'password': state['password']})
        if code == 401 and not state.get('reusedStripeQaAccount'):
            code, auth, cookie = request(VDS+'/api/v1/auth/register', {'email': state['email'], 'password': state['password']})
        if code != 200 or not cookie or not auth.get('csrf') or not auth.get('user', {}).get('id'): raise Stop('qa_auth_failed')
        if state.get('expectedUserId') and state['expectedUserId'] != auth['user']['id']: raise Stop('saved_qa_user_changed')
        state.update(userId=auth['user']['id'], cookie=cookie.split(';', 1)[0], csrf=auth['csrf'])
        if auth.get('recovery_code'): state['recoveryCode'] = auth['recovery_code']
        write_private(STATE, state)
        headers = {'Cookie': state['cookie'], 'X-CSRF-Token': state['csrf']}
        if not state.get('orderId'):
            code, order, _ = request(VDS+'/api/v1/orders', {'purpose': 'site', 'idempotency_key': state['orderKey'], 'consent': True, 'payment_method': 'crypto'}, headers)
            if code != 201 or order.get('user_id') != state['userId'] or order.get('purpose') != 'site' or order.get('amount') != 1200 or order.get('currency') != 'usdt' or order.get('payment_method') != 'crypto': raise Stop('own_crypto_site_order_failed')
            state.update(orderId=order['id'], externalId='wai-vds-' + order['id'] + '-g0')
            write_private(STATE, state)
        url = ORIGIN+'/api/v2/payments/by-external/'+state['externalId']
        code, data, _ = request(url, headers=pay_headers)
        if code == 404 and data.get('error', {}).get('code') == 'NOT_FOUND':
            code, checkout, _ = request(VDS+'/api/v1/orders/'+state['orderId']+'/checkout', {}, headers)
            if code != 200: raise Stop('checkout_result_needs_same_order_reconciliation')
            state['checkoutUrl'] = checkout.get('url'); write_private(STATE, state)
            code, data, _ = request(url, headers=pay_headers)
        if code != 200: raise Stop('wai_pay_crypto_read_failed')
        bind_payment(state, data)
        return verify(state)
    finally: os.close(lock)

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2: raise Stop('one_phase_argument_required')
        print(json.dumps(main(sys.argv[1]), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'code': str(error) if isinstance(error, Stop) else 'crypto_proof_failed', 'credentialsAndIntentPreserved': True}))
        sys.exit(1)
