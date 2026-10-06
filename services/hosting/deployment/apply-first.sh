#!/usr/bin/env bash
# Run only for the reviewed FIRST install; never restores/deletes a live database.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo 'Run on the documented host as root.' >&2; exit 1; }
release=${1:?Usage: apply-first.sh RELEASE_ID [--recover-stopped-first]}
recovery=${2:-}
[[ -z "$recovery" || "$recovery" == --recover-stopped-first ]] || exit 2
[[ "$release" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] || exit 2
root=/srv/wai-vds
bundle="$root/releases/$release/deploy"
source_caddy=/srv/wai-pay/app/Caddyfile
export WAI_VDS_RELEASE="$release"
test -r "$bundle/compose.yml" && test -r "$root/runtime.env"
test "$(stat -c '%u:%a' "$root/runtime.env")" = '0:600' || { echo 'runtime.env must be root:0600.' >&2; exit 1; }
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another WAI VDS deploy is running.' >&2; exit 1; }
if [[ -e "$root/data/wai.sqlite" && "$recovery" != --recover-stopped-first ]]; then
  echo 'First-install script refuses an existing database.' >&2; exit 1
fi
if docker container inspect wai-vds >/dev/null 2>&1; then
  [[ "$recovery" == --recover-stopped-first ]] || { echo 'First-install script refuses an existing wai-vds container.' >&2; exit 1; }
  test "$(docker inspect wai-vds --format '{{.State.Status}}')" = exited
  test "$(docker inspect wai-vds --format '{{index .Config.Labels "com.docker.compose.project"}}')" = wai-vds
  test "$(docker inspect wai-vds --format '{{index .Config.Labels "com.docker.compose.service"}}')" = wai-vds
  test ! -e "$root/current-release"
  echo 'Recovering only the stopped first-install container; customer data must be absent.'
fi
if [[ -e "$root/data/wai.sqlite" ]]; then
  test "$(docker inspect wai-vds --format '{{.State.Status}}')" = exited
  test ! -e "$root/current-release"
  python3 - "$root/data/wai.sqlite" <<'PY'
import pathlib,sqlite3,sys
db=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True)
assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
assert db.execute('PRAGMA user_version').fetchone()[0]==6
assert db.execute("SELECT value FROM settings WHERE key='mode'").fetchone()[0]=='kamatera:wai_pay:live'
for table in ['users','sessions','orders','payments','payment_events','servers','operations','attempts','api_keys','wai_pay_attempts','sim_machines','sim_payments','order_aliases','audit']:
    assert db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]==0, 'Recovery refuses customer or operation data'
db.close()
PY
fi
test "$(sha256sum "$source_caddy" | cut -d ' ' -f 1)" = c3e872c7c0fb54d14e7c7cf963e8c465940271dc743d01018fb3395cce1c6387 || { echo 'Caddy changed since review; rebase the small VDS fragment first.' >&2; exit 1; }
cmp "$source_caddy" "$bundle/Caddyfile.before"
docker network inspect app_waipay >/dev/null
test "$(df -Pk "$root" | awk 'NR==2{print $4}')" -gt 2097152 || { echo 'Need 2 GiB free before image build.' >&2; exit 1; }
python3 - "$root/runtime.env" <<'PY'
import pathlib,sys
env={}
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if line and not line.lstrip().startswith('#'):
        key,value=line.split('=',1);env[key]=value
required={'WAI_HOST':'0.0.0.0','WAI_PORT':'4781','WAI_ORIGIN':'https://pay.waiwai.is/vds',
  'WAI_SECURE_COOKIE':'1','WAI_DATA':'/var/lib/wai-vds','WAI_PROVIDER':'kamatera','WAI_PAYMENTS':'wai_pay',
  'WAI_PAY_MODE':'live','WAI_PAY_BASE_URL':'https://pay.waiwai.is','WAI_ALLOW_PAID_VM':'',
  'WAI_MAX_PROVIDER_MONTHLY_USD':'0','WAI_PAY_RUB_AMOUNT':'0','WAI_PAY_TBANK_ACCOUNT_ID':'',
  'WAI_PAY_STRIPE_ACCOUNT_ID':'stripe-main','WAI_PAY_CRYPTO_ACCOUNT_ID':'cryptomus-main'}
if any(env.get(k)!=v for k,v in required.items()):
    raise SystemExit('Runtime configuration differs from reviewed first-install/no-spend settings.')
for key in ['WAI_PAY_API_KEY','WAI_PAY_WEBHOOK_SECRET','WAI_KAMATERA_CLIENT_ID','WAI_KAMATERA_SECRET']:
    if not env.get(key): raise SystemExit('Required dedicated integration credentials are missing.')
PY
compose=(docker compose -p wai-vds --project-directory "$root" --env-file /dev/null -f "$bundle/compose.yml")
"${compose[@]}" config --quiet
# Build runs all repository tests with two workers. No payment/provider writes occur in tests.
"${compose[@]}" build wai-vds
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$root/backups/$stamp"
install -d -m 700 "$backup"
cp -p "$source_caddy" "$backup/Caddyfile"
cp -p "$root/runtime.env" "$backup/runtime.env"
if [[ -e "$root/data/wai.sqlite" ]]; then
  python3 - "$root/data" "$backup" <<'PY'
import pathlib,shutil,sqlite3,sys
source,dest=map(pathlib.Path,sys.argv[1:])
db=sqlite3.connect((source/'wai.sqlite').as_uri()+'?mode=ro',uri=True)
saved=sqlite3.connect(dest/'wai.sqlite');db.backup(saved)
assert saved.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
saved.close();db.close();(dest/'wai.sqlite').chmod(0o600)
for name in ['master.key','bootstrap-signing.pem']:
    shutil.copy2(source/name,dest/name);(dest/name).chmod(0o600)
PY
fi
docker exec waipay-caddy wget -qO- http://127.0.0.1:2019/config/ > "$backup/Caddy.active.json"
docker exec -i waipay-caddy caddy adapt --config - --adapter caddyfile < "$source_caddy" > "$backup/Caddy.source.json"
python3 - "$backup/Caddy.active.json" "$backup/Caddy.source.json" <<'PY'
import json,sys
with open(sys.argv[1]) as f: active=json.load(f)
with open(sys.argv[2]) as f: source=json.load(f)
if active!=source: raise SystemExit('Caddy runtime differs from reviewed source; inspect drift before deployment.')
PY
docker exec -i waipay-caddy caddy validate --config - --adapter caddyfile < "$bundle/Caddyfile.after"
curl --fail --silent --show-error --max-time 10 https://pay.waiwai.is/api/v1/healthz > "$backup/wai-pay-health.before.json"
python3 - "$backup/wai-pay-health.before.json" <<'PY'
import json,sys
with open(sys.argv[1]) as f: result=json.load(f)
assert result.get('ok') is True and result.get('service')=='wai-pay'
PY
started=0
caddy_changed=0
rollback() {
  status=$?
  [[ "$status" != 0 ]] || status=1
  trap - ERR INT TERM
  set +e
  rollback_failed=0
  if [[ "$caddy_changed" == 1 ]]; then
    cp -p "$backup/Caddyfile" "/srv/wai-pay/app/.Caddyfile.rollback.$stamp" || rollback_failed=1
    mv -f "/srv/wai-pay/app/.Caddyfile.rollback.$stamp" "$source_caddy" || rollback_failed=1
    # The single-file bind mount retains its old inode. Load exact backed-up runtime via stdin.
    docker exec -i waipay-caddy caddy reload --config - < "$backup/Caddy.active.json" || rollback_failed=1
  fi
  if [[ "$started" == 1 ]]; then "${compose[@]}" stop --timeout 20 wai-vds || rollback_failed=1; fi
  curl --fail --silent --show-error --max-time 10 https://pay.waiwai.is/api/v1/healthz > "$backup/wai-pay-health.rollback.json" || rollback_failed=1
  python3 -c 'import json,sys;x=json.load(open(sys.argv[1]));assert x.get("ok") is True and x.get("service")=="wai-pay"' "$backup/wai-pay-health.rollback.json" || rollback_failed=1
  if [[ "$rollback_failed" == 0 ]]; then
    echo "Deployment failed; Caddy restored, wai-pay healthy, new service stopped, data preserved. Backup: $backup" >&2
  else
    echo "Deployment failed and automatic rollback needs attention. Data preserved. Inspect backup: $backup" >&2
  fi
  exit "$status"
}
trap rollback ERR INT TERM
install -d -m 700 -o 1000 -g 1000 "$root/data"
started=1
"${compose[@]}" up -d --no-deps --no-build wai-vds
healthy=0
for attempt in $(seq 1 40); do
  if [[ $(docker inspect wai-vds --format '{{.State.Health.Status}}') == healthy ]]; then healthy=1; break; fi
  sleep 2
done
test "$healthy" == 1
cp "$bundle/Caddyfile.after" "/srv/wai-pay/app/.Caddyfile.wai-vds.$stamp"
chmod 644 "/srv/wai-pay/app/.Caddyfile.wai-vds.$stamp"
caddy_changed=1
mv -f "/srv/wai-pay/app/.Caddyfile.wai-vds.$stamp" "$source_caddy"
# Read host file into stdin: do not reload from the stale single-file bind mount.
docker exec -i waipay-caddy caddy reload --config - --adapter caddyfile < "$source_caddy"
curl --fail --silent --show-error --max-time 10 https://pay.waiwai.is/vds/healthz > "$backup/wai-vds-health.after.json"
curl --fail --silent --show-error --max-time 10 https://pay.waiwai.is/vds/api/v1/catalog > "$backup/wai-vds-catalog.after.json"
curl --fail --silent --show-error --max-time 10 https://pay.waiwai.is/api/v1/healthz > "$backup/wai-pay-health.after.json"
python3 - "$backup" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1])
vds=json.loads((p/'wai-vds-health.after.json').read_text())
assert vds.get('ok') is True and vds.get('service')=='wai-vds'
assert vds.get('provider')=='kamatera' and vds.get('payments')=='wai_pay'
catalog=json.loads((p/'wai-vds-catalog.after.json').read_text())
assert catalog['plan']['checkout_enabled'] is False, 'Payments must stay locked until Kamatera spending is approved'
pay=json.loads((p/'wai-pay-health.after.json').read_text())
assert pay.get('ok') is True and pay.get('service')=='wai-pay'
PY
curl --fail --silent --show-error --max-time 10 https://pay.waiwai.is/vds/ > "$backup/wai-vds-page.after.html"
curl --fail --silent --show-error --max-time 10 https://pay.waiwai.is/vds/openapi.json > "$backup/wai-vds-openapi.after.json"
test -s "$backup/wai-vds-page.after.html"
python3 - "$backup/wai-vds-openapi.after.json" <<'PY'
import json,sys
with open(sys.argv[1]) as f: schema=json.load(f)
assert schema.get('openapi','').startswith('3.')
assert schema.get('servers',[{}])[0].get('url')=='https://pay.waiwai.is/vds/api/v1'
PY
printf '%s\n' "$release" > "$root/current-release.tmp"
mv -f "$root/current-release.tmp" "$root/current-release"
trap - ERR INT TERM
echo "WAI VDS deployed with checkout locked. Release: $release; backup: $backup"
