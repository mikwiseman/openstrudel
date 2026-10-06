#!/usr/bin/env python3
"""Prepared installer; run only on root@103.45.247.25 after review.

Commands: prepare -> stage -> apply. No command runs implicitly.
prepare creates only a dedicated Stripe webhook and saves its new secret.
stage prints the exact nonsecret env diff. apply recreates only backend.
rollback preserves endpoint, credentials, DB records and webhook history.
"""
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

BASE = pathlib.Path('/srv/wai-vds/stripe-vds-setup')
ENV_PATH = pathlib.Path('/srv/wai-pay/.env')
APP = pathlib.Path('/srv/wai-pay/app')
COMPOSE = APP / 'docker-compose.yml'
HELPER = pathlib.Path(__file__).with_name('stripe-vds-step.mjs')
STATE = BASE / 'state.json'
CREDS = BASE / 'credentials.json'
CANDIDATE = BASE / 'wai-pay.env.candidate'
NEW_KEYS = ('STRIPE_WAI_VDS_SECRET_KEY', 'STRIPE_WAI_VDS_WEBHOOK_SECRET')

class Stop(Exception):
    pass

def digest(data):
    return hashlib.sha256(data).hexdigest()

def private_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise Stop('private_file_permissions_or_type')
    return path.read_bytes()

def atomic(path, data):
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def save(path, obj):
    atomic(path, (json.dumps(obj, indent=2) + '\n').encode())

def load(path):
    return json.loads(private_file(path))

def run(command, code, **kwargs):
    try:
        result = subprocess.run(command, capture_output=True, timeout=90, **kwargs)
    except Exception:
        raise Stop(code + '_outcome_unknown') from None
    if result.returncode:
        raise Stop(code)
    return result

def step(phase, state, credentials=None):
    payload = {'intent': state.get('intent')}
    if credentials:
        payload['credentials'] = credentials
    source = 'globalThis.__WAI_SETUP_INPUT=' + json.dumps(payload) + ';\n' + HELPER.read_text()
    # The secret-bearing request and response remain stdin/stdout pipes in host memory.
    try:
        result = subprocess.run(['docker', 'exec', '-i', '-e', 'WAI_STRIPE_VDS_PRIVATE_PIPE=1',
            'waipay-backend', 'node', '--input-type=module', '-', phase],
            input=source, text=True, capture_output=True, timeout=90)
        obj = json.loads(result.stdout)
    except Exception:
        raise Stop('step_' + phase + '_outcome_unknown') from None
    # A valid successful prepare response must be persisted even if process teardown failed.
    if not isinstance(obj, dict) or not obj.get('ok') or (result.returncode and phase != 'prepare'):
        code = obj.get('code') if isinstance(obj, dict) else None
        if not isinstance(code, str) or not re.fullmatch(r'[a-z0-9_]+', code):
            code = 'step_' + phase + '_failed'
        raise Stop(code)
    return obj

def compose(*args, candidate=None):
    command = ['docker', 'compose', '--project-directory', str(APP)]
    if candidate:
        command += ['--env-file', str(candidate)]
    command += ['-f', str(COMPOSE), *args]
    return run(command, 'compose_' + args[0] + '_failed')

def health():
    for attempt in range(12):
        try:
            with urllib.request.urlopen('https://pay.waiwai.is/api/v1/healthz', timeout=5) as r:
                data = json.load(r)
                if r.status == 200 and data.get('ok') is True and data.get('service') == 'wai-pay':
                    return
        except Exception:
            pass
        if attempt < 11:
            time.sleep(2)
    raise Stop('backend_health_failed')

def recreate():
    compose('config', '--quiet')
    # No build/pull, no dependencies, no other service restart.
    compose('up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'backend')
    health()

def backend_has_new_keys():
    result = run(['docker', 'exec', 'waipay-backend', 'node', '-e',
        'process.stdout.write(String(Boolean(process.env.STRIPE_WAI_VDS_SECRET_KEY||process.env.STRIPE_WAI_VDS_WEBHOOK_SECRET)))'],
        'backend_env_presence_failed', text=True)
    value = result.stdout.strip()
    if value not in ('true', 'false'):
        raise Stop('backend_env_presence_unknown')
    return value == 'true'

def rollback(state):
    # Do not strip credentials needed by a payment created after activation.
    # No automatic rollback is possible after the first stripe-vds payment.
    if state.get('activationStarted'):
        step('rollback', state)
    current = private_file(ENV_PATH)
    if digest(current) == state.get('candidateSha256'):
        original = private_file(pathlib.Path(state['backup']))
        if digest(original) != state['originalSha256']:
            raise Stop('backup_hash_mismatch')
        atomic(ENV_PATH, original)
        recreate()
    elif digest(current) != state.get('originalSha256'):
        raise Stop('concurrent_env_change_preserved')
    elif backend_has_new_keys():
        # Recovery after a crash between restoring the env file and recreating backend.
        recreate()
    health()
    state['phase'] = 'rolled_back'
    save(STATE, state)
    return {'ok': True, 'rolledBack': True, 'endpointAndCredentialsRetained': True, 'historyRetained': True}

def main(command):
    if command not in ('prepare', 'stage', 'apply', 'verify', 'rollback'):
        raise Stop('expected_prepare_stage_apply_verify_or_rollback')
    if os.geteuid() != 0:
        raise Stop('documented_host_root_required')
    if not ENV_PATH.exists() or not COMPOSE.exists() or not HELPER.is_file():
        raise Stop('documented_host_files_missing')
    label = run(['docker', 'inspect', 'waipay-backend', '--format',
        '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'], 'backend_inspect_failed', text=True).stdout.strip()
    if label != str(APP):
        raise Stop('documented_compose_target_mismatch')
    BASE.mkdir(mode=0o700, exist_ok=True)
    info = BASE.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise Stop('setup_directory_permissions')
    lockfd = os.open(BASE / 'setup.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = load(STATE) if STATE.exists() else None
        if command == 'prepare':
            if state is None:
                preflight = step('preflight', {})
                identifier = str(uuid.uuid4())
                state = {'phase': 'intent', 'preflight': preflight, 'intent': {
                    'providerAccountId': 'stripe-vds', 'setupId': identifier,
                    'idempotencyKey': 'wai-vds-webhook-' + identifier,
                    'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}}
                save(STATE, state)  # Must precede the first provider POST.
            credentials = load(CREDS) if CREDS.exists() else None
            prepared = step('prepare', state, credentials)
            if credentials is None:
                save(CREDS, prepared['credentials'])  # fsync before any DB/routing activation.
            state['phase'] = 'prepared' if state['phase'] == 'intent' else state['phase']
            save(STATE, state)
            return {'ok': True, 'phase': state['phase'], 'providerAccountId': 'stripe-vds',
                'endpointId': prepared['credentials']['endpointId'], 'credentialsSavedRoot0600': True,
                'invoicesCreated': 0, 'backendRestarted': False}
        if not state or not CREDS.exists():
            raise Stop('prepare_required')
        credentials = load(CREDS)
        if command == 'stage':
            if state['phase'] in ('staged', 'applied'):
                if digest(private_file(CANDIDATE)) != state['candidateSha256']:
                    raise Stop('candidate_hash_mismatch')
                return {'ok': True, 'phase': state['phase'], 'addedKeys': list(NEW_KEYS), 'oldKeysChanged': 0}
            if state['phase'] != 'prepared':
                raise Stop('review_recovery_state_before_restage')
            original = private_file(ENV_PATH)
            text = original.decode('utf-8')
            if any(re.search(r'^\s*(?:export\s+)?' + key + r'\s*=', text, re.M) for key in NEW_KEYS):
                raise Stop('dedicated_env_keys_already_exist')
            if not re.fullmatch(r'sk_live_[A-Za-z0-9_-]+', credentials.get('apiKey', '')) or not re.fullmatch(r'whsec_[A-Za-z0-9_-]+', credentials.get('webhookSecret', '')):
                raise Stop('credential_shape_invalid')
            addition = ('' if not text or text.endswith('\n') else '\n') + '\n'.join([
                NEW_KEYS[0] + '=' + credentials['apiKey'], NEW_KEYS[1] + '=' + credentials['webhookSecret']]) + '\n'
            candidate = original + addition.encode()
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            backup = BASE / ('wai-pay.env.backup-' + stamp)
            if backup.exists():
                raise Stop('backup_destination_exists')
            atomic(backup, original)
            atomic(CANDIDATE, candidate)
            # Existing lines stay byte-for-byte identical; new values are strict safe env tokens.
            compose('config', '--quiet', candidate=CANDIDATE)
            state.update(phase='staged', backup=str(backup), originalSha256=digest(original), candidateSha256=digest(candidate))
            save(STATE, state)
            return {'ok': True, 'phase': 'staged', 'addedKeys': list(NEW_KEYS), 'oldKeysChanged': 0,
                'originalBytesUnchanged': candidate.startswith(original), 'backup': str(backup),
                'composeValidated': True, 'backendRestarted': False, 'next': 'Review this diff, then run apply.'}
        if command == 'verify':
            health()
            return step('verify', state, credentials)
        if command == 'rollback':
            return rollback(state)
        if state['phase'] == 'applied':
            return step('verify', state, credentials)  # Never perform a no-op restart.
        if state['phase'] != 'staged':
            raise Stop('reviewed_stage_required')
        candidate = private_file(CANDIDATE)
        if digest(candidate) != state['candidateSha256'] or digest(private_file(ENV_PATH)) not in (state['originalSha256'], state['candidateSha256']):
            raise Stop('env_changed_after_review')
        try:
            if digest(private_file(ENV_PATH)) == state['originalSha256']:
                atomic(ENV_PATH, candidate)
            recreate()
            state['activationStarted'] = True
            save(STATE, state)
            step('activate', state, credentials)
            verified = step('verify', state, credentials)
            state['phase'] = 'applied'
            save(STATE, state)
            return {**verified, 'backendHealthy': True, 'existingCredentialsChanged': 0,
                'rootRuntimeUpdateRequired': {'WAI_PAY_STRIPE_ACCOUNT_ID': 'stripe-vds'}}
        except Stop as error:
            try:
                rollback(state)
            except Stop as recovery:
                raise Stop('apply_' + str(error) + '__rollback_needs_attention_' + str(recovery)) from None
            raise Stop('apply_' + str(error) + '__automatically_rolled_back') from None
    finally:
        os.close(lockfd)

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise Stop('one_phase_argument_required')
        print(json.dumps(main(sys.argv[1]), ensure_ascii=False))
    except Exception as error:
        # Never print captured subprocess output, credentials, request headers or tracebacks.
        print(json.dumps({'ok': False, 'code': str(error) if isinstance(error, Stop) else 'setup_failed'}))
        sys.exit(1)
