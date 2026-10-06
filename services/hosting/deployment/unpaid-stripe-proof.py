#!/usr/bin/env python3
"""Prepared, not automatically executed. Documented host root only.
start: normal VDS account/order/checkout, then expire that exact unpaid session.
verify: only read real Stripe/WAI Pay/VDS evidence; no sync or fake callbacks.
The reserved-domain QA account and its audit history remain for traceability.
"""
import datetime
import fcntl
import json
import os
import pathlib
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid

BASE = pathlib.Path('/srv/wai-vds/unpaid-stripe-proof')
STATE = BASE / 'state.json'
EVIDENCE = BASE / 'evidence.json'
HELPER = pathlib.Path(__file__).with_name('unpaid-stripe-proof-step.mjs')
ORIGIN = 'https://pay.waiwai.is'
VDS = ORIGIN + '/vds'

class Stop(Exception): pass
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl): return None

def write_private(path, obj):
    fd, temp = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(obj, stream, indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(temp, path)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(parent)
        finally: os.close(parent)
    finally:
        if os.path.exists(temp): os.unlink(temp)

def private_bytes(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise Stop('private_file_permissions')
    return path.read_bytes()

def request(url, body=None, headers=None):
    h = dict(headers or {})
    if body is not None: h.update({'Content-Type': 'application/json', 'Origin': ORIGIN})
    r = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=h)
    try:
        with urllib.request.build_opener(NoRedirect()).open(r, timeout=25) as response:
            return response.status, json.load(response), response.headers.get('Set-Cookie')
    except urllib.error.HTTPError as error:
        try: data = json.loads(error.read())
        except Exception: data = {}
        return error.code, data, None
    except Exception: raise Stop('http_result_unknown_preserve_same_intent') from None

def backend(phase, state):
    payload = {k: state[k] for k in ('orderId', 'userId', 'externalId', 'paymentId')}
    source = 'globalThis.__WAI_UNPAID_INPUT=' + json.dumps(payload) + ';\n' + HELPER.read_text()
    try:
        result = subprocess.run(['docker', 'exec', '-i', '-e', 'WAI_UNPAID_PRIVATE_PIPE=1', 'waipay-backend',
            'node', '--input-type=module', '-', phase], input=source, text=True, capture_output=True, timeout=90)
        data = json.loads(result.stdout)
    except Exception: raise Stop('backend_proof_result_unknown') from None
    if result.returncode or not data.get('ok'):
        code = data.get('code', '')
        raise Stop(code if re.fullmatch(r'[a-z0-9_]+', str(code)) else 'backend_proof_failed')
    return data

def local_evidence(state, event_ids):
    identifiers = {k: state[k] for k in ('orderId', 'userId', 'externalId', 'paymentId')}
    identifiers['eventIds'] = event_ids
    # Read-only SQLite: no Service instantiation, migrations, credential reads or worker calls.
    source = 'const input=' + json.dumps(identifiers) + ';\n' + r'''
import {DatabaseSync} from 'node:sqlite'; import {join} from 'node:path';
const db=new DatabaseSync(join(process.env.WAI_DATA,'wai.sqlite'),{readOnly:true});
try {
 const o=db.prepare('SELECT id,user_id,status,paid_at,server_id FROM orders WHERE id=? AND user_id=?').get(input.orderId,input.userId);
 const a=db.prepare('SELECT state,paid_amount,payment_id FROM wai_pay_attempts WHERE external_id=? AND order_id=?').get(input.externalId,input.orderId);
 if(!o||!a||a.payment_id!==input.paymentId)throw Error('binding');
 const receipts=input.eventIds.map(id=>db.prepare('SELECT id,type,created FROM payment_events WHERE id=? AND order_id=?').get('wai:'+id,input.orderId)).filter(Boolean);
 const count=db.prepare('SELECT count(*) AS n FROM servers WHERE order_id=?').get(input.orderId).n;
 const capacity=db.prepare('SELECT state FROM capacity_reservations WHERE order_id=?').get(input.orderId);
 console.log(JSON.stringify({ok:true,orderStatus:o.status,paidAtPresent:!!o.paid_at,serverIdPresent:!!o.server_id,serverCount:count,attemptState:a.state,paidAmountMinor:a.paid_amount,capacityState:capacity?.state||null,receipts}));
} finally {db.close();}
'''
    try:
        r = subprocess.run(['docker','exec','-i','wai-vds','node','--input-type=module','-'], input=source, text=True, capture_output=True, timeout=20)
        data = json.loads(r.stdout)
    except Exception: raise Stop('vds_readonly_evidence_failed') from None
    if r.returncode or not data.get('ok'): raise Stop('vds_readonly_evidence_failed')
    return data

def verify(state):
    upstream = backend('inspect', state)
    events = upstream['clientEvents']
    local = local_evidence(state, [e['id'] for e in events])
    delivered_ids = {e['id'] for e in events if e['deliveredToOwnApp']}
    receipt_ids = {e['id'].removeprefix('wai:') for e in local['receipts'] if e['type'] == 'payment.expired'}
    unpaid = upstream['stripe']['paymentStatus'] == 'unpaid' and upstream['waiPay']['paidAmountMinor'] == 0 and local['paidAmountMinor'] == 0 and not local['paidAtPresent'] and not local['serverIdPresent'] and local['serverCount'] == 0
    passed = unpaid and upstream['stripe']['sessionStatus'] == 'expired' and upstream['waiPay']['status'] == 'EXPIRED' and bool(upstream['verifiedStripeExpiryEvents']) and bool(delivered_ids & receipt_ids) and local['capacityState'] == 'released'
    result = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'passed': passed,
        'pendingRealDelivery': not passed and unpaid, 'upstream': upstream, 'vds': local,
        'chargesPerformed': 0, 'fakePaymentCallbacksSent': 0, 'cryptoInvoicesCreated': 0,
        'retainedDiagnosticHistory': True}
    write_private(EVIDENCE, result)
    return result

def bind_payment(state, data):
    payment=data.get('payment',{})
    if payment.get('externalPaymentId')!=state['externalId'] or payment.get('providerAccountId')!='stripe-vds' or payment.get('mode')!='live' or payment.get('requestedAmountMinor')!=1200 or payment.get('currency')!='USD' or payment.get('paidAmountMinor')!=0 or payment.get('metadata',{}).get('wai_order_id')!=state['orderId'] or payment.get('metadata',{}).get('wai_user_id')!=state['userId']:
        raise Stop('wai_pay_binding_failed')
    state['paymentId']=payment['id'];write_private(STATE,state)

def main(command):
    if command not in ('start','verify'): raise Stop('use_start_or_verify')
    if os.geteuid() != 0 or not pathlib.Path('/srv/wai-pay/app/docker-compose.yml').is_file(): raise Stop('documented_host_root_required')
    env = {}
    for line in private_bytes(pathlib.Path('/srv/wai-vds/runtime.env')).decode().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k,v=line.split('=',1); env[k.strip()] = v.strip().strip('"').strip("'")
    if env.get('WAI_ORIGIN') != VDS or env.get('WAI_PAY_MODE') != 'live' or env.get('WAI_PAY_STRIPE_ACCOUNT_ID') != 'stripe-vds': raise Stop('reviewed_vds_stripe_routing_required')
    BASE.mkdir(mode=0o700, exist_ok=True)
    info=BASE.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077: raise Stop('private_directory_permissions')
    lock=os.open(BASE/'proof.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        state=json.loads(private_bytes(STATE)) if STATE.exists() else None
        if command=='verify':
            if not state or not state.get('paymentId'): raise Stop('existing_proof_payment_required')
            return verify(state)
        if state and state.get('paymentId'):
            backend('expire',state)  # Reconcile exactly the saved session; never create another.
            return verify(state)
        if state and state.get('externalId'):
            # Recover a lost checkout response even after the public gate was closed.
            code,data,_=request(ORIGIN+'/api/v2/payments/by-external/'+state['externalId'],headers={'Authorization':'Bearer '+env['WAI_PAY_API_KEY']})
            if code==200:
                bind_payment(state,data);backend('expire',state);return verify(state)
            if code!=404 or data.get('error',{}).get('code')!='NOT_FOUND':raise Stop('existing_intent_read_failed')
        code,catalog,_=request(VDS+'/api/v1/catalog')
        card=next((m for m in catalog.get('payment_methods',[]) if m.get('id')=='card'),{})
        if code!=200 or not catalog.get('plan',{}).get('checkout_enabled') or card.get('amount')!=1200 or card.get('currency')!='usd' or card.get('test') is not False: raise Stop('temporarily_enabled_reviewed_card_checkout_required')
        if state is None:
            identifier=str(uuid.uuid4())
            state={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'proofId':identifier,
                'email':'wai-vds-unpaid-'+identifier+'@example.invalid','password':secrets.token_urlsafe(36),
                'orderKey':'stripe-unpaid-proof-'+identifier}
            write_private(STATE,state)
        # Same persisted QA credentials make a lost registration response recoverable.
        code,auth,cookie=request(VDS+'/api/v1/auth/login',{'email':state['email'],'password':state['password']})
        if code==401:
            code,auth,cookie=request(VDS+'/api/v1/auth/register',{'email':state['email'],'password':state['password']})
        if code!=200 or not cookie or not auth.get('csrf') or not auth.get('user',{}).get('id'): raise Stop('qa_auth_failed')
        state.update(userId=auth['user']['id'],cookie=cookie.split(';',1)[0],csrf=auth['csrf'])
        if auth.get('recovery_code'): state['recoveryCode']=auth['recovery_code']
        write_private(STATE,state)
        headers={'Cookie':state['cookie'],'X-CSRF-Token':state['csrf']}
        if not state.get('orderId'):
            code,order,_=request(VDS+'/api/v1/orders',{'purpose':'clean','idempotency_key':state['orderKey'],'consent':True,'payment_method':'card'},headers)
            if code!=201 or order.get('user_id')!=state['userId'] or order.get('amount')!=1200 or order.get('currency')!='usd' or order.get('payment_method')!='card': raise Stop('own_order_failed')
            state.update(orderId=order['id'],externalId='wai-vds-'+order['id']+'-g0')
            write_private(STATE,state)
        pay_headers={'Authorization':'Bearer '+env['WAI_PAY_API_KEY']}
        url=ORIGIN+'/api/v2/payments/by-external/'+state['externalId']
        code,data,_=request(url,headers=pay_headers)
        if code==404 and data.get('error',{}).get('code')=='NOT_FOUND':
            code,checkout,_=request(VDS+'/api/v1/orders/'+state['orderId']+'/checkout',{},headers)
            if code!=200: raise Stop('checkout_result_needs_same_order_reconciliation')
            # Persist the payable URL privately and never print it.
            state['checkoutUrl']=checkout.get('url'); write_private(STATE,state)
            code,data,_=request(url,headers=pay_headers)
        if code!=200:raise Stop('wai_pay_read_failed')
        bind_payment(state,data)
        backend('expire',state)
        return verify(state)
    finally:os.close(lock)

if __name__=='__main__':
    try:
        if len(sys.argv)!=2:raise Stop('one_phase_argument_required')
        print(json.dumps(main(sys.argv[1]),ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok':False,'code':str(error) if isinstance(error,Stop) else 'proof_failed','credentialsAndIntentPreserved':True}))
        sys.exit(1)
