#!/usr/bin/env bash
# Run this on root@103.45.247.25 AFTER final review/build. No payments are created.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo 'Run as root on the documented wai-pay host.' >&2; exit 1; }
bundle=$(cd "$(dirname "$0")" && pwd)
test -r /srv/wai-pay/.env
install -d -m 700 /srv/wai-vds
exec 9>/srv/wai-vds/register-app.lock
flock -n 9 || { echo 'Another App registration is running.' >&2; exit 1; }
# Backend credentials are already injected from the documented wai-pay env file.
# The Python parent captures stdout/stderr from both Docker exec calls in memory.
# Secret values never appear in shell arguments, environment overrides or logs.
python3 - "$bundle/register-app.mjs" <<'PY'
import json,os,pathlib,re,subprocess,sys
destination=pathlib.Path('/srv/wai-vds/app-credentials.env')
if destination.exists() or destination.is_symlink():
    raise SystemExit('Dedicated credential file already exists; registration aborted without rotation.')
source=pathlib.Path(sys.argv[1]).read_text()
command=['docker','exec','-i','-e','WAI_REGISTER_SECRET_PIPE=1','waipay-backend',
         'node','--input-type=module','-']
def execute(phase,script):
    try:
        result=subprocess.run(command+[phase],input=script,text=True,capture_output=True,timeout=45,check=False)
        data=json.loads(result.stdout)
        if not isinstance(data,dict): return {'ok':False,'code':'unexpected_result'}
        if result.returncode and data.get('ok') and phase!='create': return {'ok':False,'code':'unexpected_exit'}
        return data
    except Exception:
        # Never print process output: the create result can contain secrets.
        return {'ok':False,'code':'outcome_unknown'}
fd=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
created=execute('create',source)
if not created.get('ok'):
    os.close(fd)
    code=created.get('code')
    if code in ('app_exists','provider_account_not_ready','admin_auth_missing','wrapper_required'):
        destination.unlink() # Only the empty reservation created above by this call.
    safe=code if isinstance(code,str) and re.fullmatch(r'[a-z_0-9]+',code) else 'create_failed'
    raise SystemExit('App registration stopped: '+safe+'. No automatic retry or key rotation.')
if created.get('appId')!='wai-vds' or not re.fullmatch(r'wp_live_[A-Za-z0-9_-]{32}',created.get('apiKey','')) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',created.get('webhookSecret','')):
    os.close(fd)
    raise SystemExit('App creation returned an unexpected result. Outcome must be checked before retrying.')
credentials={'appId':'wai-vds','apiKey':created['apiKey'],'webhookSecret':created['webhookSecret']}
try:
    with os.fdopen(fd,'w') as stream:
        stream.write('WAI_PAY_API_KEY='+credentials['apiKey']+'\nWAI_PAY_WEBHOOK_SECRET='+credentials['webhookSecret']+'\n')
        stream.flush();os.fsync(stream.fileno())
    parent=os.open(destination.parent,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(parent)
    finally: os.close(parent)
except Exception:
    raise SystemExit('App created but credential persistence failed. Do not retry or rotate automatically.') from None
# Do not activate the app until its unique credentials are durably saved.
injected='globalThis.__WAI_OWN_APP='+json.dumps(credentials,separators=(',',':'))+';\n'+source
activated=execute('activate-own-app',injected)
if not activated.get('ok'):
    raise SystemExit('App created; own credentials saved root:0600; activation/check needs attention. No retry or rotation.')
print(json.dumps({'ok':True,'app':activated.get('app'),'credentialFile':str(destination),
  'permissions':'root:0600','authenticatedRead':activated.get('authenticatedRead'),'invoicesCreated':0},ensure_ascii=False))
PY
