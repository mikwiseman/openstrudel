#!/usr/bin/env bash
# Bounded production launch or checkout closure. Does not make provider purchases.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || exit 1
action=${1:?Usage: promote.sh open|close}
[[ "$action" == open || "$action" == close ]] || exit 2
root=/srv/wai-vds
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another WAI VDS operation is running.' >&2; exit 1; }
release=$(cat "$root/current-release")
[[ "$release" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] || exit 2
bundle="$root/releases/$release/deploy"
image=$(docker image inspect "wai-vds:$release" --format '{{.Id}}')
test "$(docker inspect wai-vds --format '{{.State.Health.Status}} {{.Config.Image}} {{.Image}} {{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}}')" = "healthy wai-vds:$release $image wai-vds wai-vds"
test "$(stat -c '%u:%a' "$root/runtime.env")" = 0:600
export WAI_VDS_RELEASE="$release"
compose=(docker compose -p wai-vds --project-directory "$root" --env-file /dev/null -f "$bundle/compose.yml")
"${compose[@]}" config --quiet
if [[ "$action" == open ]]; then
  python3 "$bundle/stripe-vds-setup.py" verify
  python3 - "$root" <<'PY'
import json,pathlib,sqlite3,sys,time
p=pathlib.Path(sys.argv[1]); db=sqlite3.connect((p/'data/wai.sqlite').as_uri()+'?mode=ro',uri=True)
assert db.execute('PRAGMA user_version').fetchone()[0]==7
assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
assert db.execute("SELECT count(*) FROM orders WHERE status IN('paid','fulfilling','needs_refund')").fetchone()[0]==0
assert db.execute("SELECT count(*) FROM servers WHERE state!='deleted'").fetchone()[0]==0
assert db.execute("SELECT count(*) FROM capacity_reservations WHERE state!='released'").fetchone()[0]==0
import datetime
metadata=[json.loads(f.read_text()) for f in (p/'operations/backups').glob('wai-vds-*.tar.age.json')]
def fresh(k,h):
 return any(k in m and 0<=time.time()-datetime.datetime.fromisoformat(m[k].replace('Z','+00:00')).timestamp()<h*3600 for m in metadata)
assert fresh('created',36) and fresh('restore_verified_at',48), 'Fresh independently verified backup required'
PY
fi
candidate=$(mktemp "$root/.runtime-promotion.XXXXXX")
trap 'rm -f -- "$candidate"' EXIT
python3 - "$root/runtime.env" "$candidate" "$action" <<'PY'
import pathlib,sys
lines=pathlib.Path(sys.argv[1]).read_text().splitlines();env=dict(x.split('=',1) for x in lines if x and not x.startswith('#'))
assert env['WAI_PROVIDER']=='kamatera' and env['WAI_PAYMENTS']=='wai_pay' and env['WAI_PAY_MODE']=='live'
assert env['WAI_PAY_STRIPE_ACCOUNT_ID']=='stripe-vds' and env['WAI_PAY_CRYPTO_ACCOUNT_ID']=='cryptomus-main'
updates={'WAI_ALLOW_PAID_VM':'I_APPROVE_KAMATERA_SPEND' if sys.argv[3]=='open' else '', 'WAI_MAX_PROVIDER_MONTHLY_USD':'10' if sys.argv[3]=='open' else '0', 'WAI_MAX_LIVE_SERVERS':'1'}
assert all(sum(x.startswith(k+'=') for x in lines)==1 for k in updates)
result=[x.split('=',1)[0]+'='+updates[x.split('=',1)[0]] if x.split('=',1)[0] in updates else x for x in lines]
pathlib.Path(sys.argv[2]).write_text('\n'.join(result)+'\n')
print('Checkout '+sys.argv[3]+'; maximum active/reserved VM: 1; public monthly estimate ceiling including known administration fee, excluding unverified tax: '+updates['WAI_MAX_PROVIDER_MONTHLY_USD']+' USD.')
PY
if cmp -s "$candidate" "$root/runtime.env"; then echo 'Settings already applied; no restart.'; exit 0; fi
backup="$root/backups/promotion-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$backup"
cp -p "$root/runtime.env" "$backup/runtime.env"
health() {
  local expected=$1
  for attempt in $(seq 1 40); do
    if [[ $(docker inspect wai-vds --format '{{.State.Health.Status}} {{.Image}}') == "healthy $image" ]]; then break; fi
    sleep 2
  done
  test "$(docker inspect wai-vds --format '{{.State.Health.Status}} {{.Image}}')" = "healthy $image" || return 1
  curl -fsS --max-time 10 https://server.waiwai.is/api/v1/catalog > "$backup/catalog-$expected.json" || return 1
  curl -fsS --max-time 10 https://pay.waiwai.is/api/v1/healthz > "$backup/pay-health.json" || return 1
  python3 - "$backup" "$expected" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]);c=json.loads((p/('catalog-'+sys.argv[2]+'.json')).read_text());pay=json.loads((p/'pay-health.json').read_text())
assert c['plan']['checkout_enabled']==(sys.argv[2]=='open')
assert c['mode']=={'provider':'kamatera','payments':'wai_pay','payment_live':True}
assert pay['ok'] is True and pay['service']=='wai-pay'
PY
}
previous_action=$(python3 -c 'import sys;print("open" if "WAI_ALLOW_PAID_VM=I_APPROVE_KAMATERA_SPEND" in open(sys.argv[1]).read().splitlines() else "close")' "$backup/runtime.env")
rollback() {
  code=$?;trap - ERR INT TERM;set +e
  restored=0
  install -m 600 "$backup/runtime.env" "$root/runtime.rollback.env" && mv -f "$root/runtime.rollback.env" "$root/runtime.env" || restored=1
  "${compose[@]}" up -d --no-deps --no-build --pull never wai-vds || restored=1
  health "$previous_action" || restored=1
  echo "Promotion failed; rollback health exit: $restored; backup: $backup" >&2
  [[ "$code" != 0 ]] || code=1
  exit "$code"
}
trap rollback ERR INT TERM
install -m 600 "$candidate" "$root/runtime.next.env"
mv -f "$root/runtime.next.env" "$root/runtime.env"
"${compose[@]}" up -d --no-deps --no-build --pull never wai-vds
health "$action"
trap - ERR INT TERM
echo "WAI VDS checkout: $action; exact service healthy; backup: $backup"
