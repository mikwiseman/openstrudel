#!/usr/bin/env bash
# Frontend-only upgrade with unchanged backend, runtime configuration and current data.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || exit 1
release=${1:?Usage: ui-upgrade.sh NEW_RELEASE_ID}
[[ "$release" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] || exit 2
root=/srv/wai-vds
previous=$(cat "$root/current-release")
[[ "$previous" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] || exit 2
if [[ "$release" == "$previous" ]]; then echo 'Release already installed; no restart.'; exit 0; fi
bundle="$root/releases/$release/deploy"
old_bundle="$root/releases/$previous/deploy"
test -r "$bundle/compose.yml" && test -r "$old_bundle/compose.yml"
test "$(stat -c '%u:%a' "$root/runtime.env")" = 0:600
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another WAI VDS deploy is running.' >&2; exit 1; }
test "$(cat "$root/current-release")" = "$previous"
test "$(docker inspect wai-vds --format '{{.State.Health.Status}}')" = healthy
test "$(docker inspect wai-vds --format '{{.Config.Image}}')" = "wai-vds:$previous"
test "$(docker inspect wai-vds --format '{{index .Config.Labels "com.docker.compose.project"}}')" = wai-vds
test "$(docker inspect wai-vds --format '{{index .Config.Labels "com.docker.compose.service"}}')" = wai-vds
previous_image=$(docker inspect wai-vds --format '{{.Image}}')
test "$(docker image inspect "wai-vds:$previous" --format '{{.Id}}')" = "$previous_image"
container_matches() {
  local expected_release=$1 expected_image=$2
  test "$(docker inspect wai-vds --format '{{.State.Health.Status}} {{.Config.Image}} {{.Image}} {{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}}')" = "healthy wai-vds:$expected_release $expected_image wai-vds wai-vds"
}
# Refuse any backend/configuration change through this narrow deployment path.
python3 - "$root/releases/$previous" "$root/releases/$release" <<'PYCOMPARE'
import pathlib,sys,hashlib
old,new=map(pathlib.Path,sys.argv[1:])
def contents(p):
 assert p.is_dir() and not p.is_symlink()
 return {str(x.relative_to(p)):hashlib.sha256(x.read_bytes()).hexdigest() for x in p.rglob('*') if x.is_file() and not x.is_symlink()}
for name in ('src','scripts','tests'):
 assert contents(old/'app'/name)==contents(new/'app'/name), 'backend_or_tests_changed'
for name in ('package.json','Dockerfile'):
 assert (old/'app'/name).read_bytes()==(new/'app'/name).read_bytes(), 'build_contract_changed'
assert (old/'deploy/compose.yml').read_bytes()==(new/'deploy/compose.yml').read_bytes(), 'compose_changed'
assert contents(old/'app/public')!=contents(new/'app/public'), 'no_ui_change'
print('Only public interface files differ; backend and Compose match.')
PYCOMPARE
before_env=$(sha256sum "$root/runtime.env" | cut -d ' ' -f 1)
export WAI_VDS_RELEASE="$release"
compose=(docker compose -p wai-vds --project-directory "$root" --env-file /dev/null -f "$bundle/compose.yml")
"${compose[@]}" config --quiet
"${compose[@]}" build wai-vds
next_image=$(docker image inspect "wai-vds:$release" --format '{{.Id}}')
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$root/backups/$stamp"
install -d -m 700 "$backup"
cp -p "$root/runtime.env" "$backup/runtime.env"
cp -p "$old_bundle/compose.yml" "$backup/compose.previous.yml"
printf '%s\n' "$previous" > "$backup/previous-release"
python3 - "$root/data" "$backup" <<'PY'
import pathlib,shutil,sqlite3,sys
source,dest=map(pathlib.Path,sys.argv[1:])
db=sqlite3.connect((source/'wai.sqlite').as_uri()+'?mode=ro',uri=True)
assert db.execute('PRAGMA user_version').fetchone()[0]==7
saved=sqlite3.connect(dest/'wai.sqlite');db.backup(saved)
assert saved.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
saved.close();db.close();(dest/'wai.sqlite').chmod(0o600)
for name in ['master.key','bootstrap-signing.pem']:
    shutil.copy2(source/name,dest/name);(dest/name).chmod(0o600)
PY
curl -fsS --max-time 10 https://pay.waiwai.is/api/v1/healthz > "$backup/wai-pay.before.json"
curl -fsS --max-time 10 https://server.waiwai.is/api/v1/catalog > "$backup/catalog.before.json"
test "$(sha256sum "$root/runtime.env" | cut -d ' ' -f 1)" = "$before_env"
rollback() {
  result=$?
  trap - ERR INT TERM
  set +e
  rollback_failed=0
  export WAI_VDS_RELEASE="$previous"
  docker compose -p wai-vds --project-directory "$root" --env-file /dev/null -f "$old_bundle/compose.yml" up -d --no-deps --no-build wai-vds || rollback_failed=1
  healthy=0
  for attempt in $(seq 1 40); do
    if container_matches "$previous" "$previous_image"; then healthy=1; break; fi
    sleep 2
  done
  [[ "$healthy" == 1 ]] || rollback_failed=1
  curl -fsS --max-time 10 https://server.waiwai.is/healthz > "$backup/rollback-health.json" || rollback_failed=1
  curl -fsS --max-time 10 https://server.waiwai.is/api/v1/catalog > "$backup/catalog.rollback.json" || rollback_failed=1
  curl -fsS --max-time 10 https://pay.waiwai.is/api/v1/healthz > "$backup/wai-pay.rollback.json" || rollback_failed=1
  python3 - "$backup" <<'PY' || rollback_failed=1
import json,pathlib,sys
p=pathlib.Path(sys.argv[1])
vds=json.loads((p/'rollback-health.json').read_text());pay=json.loads((p/'wai-pay.rollback.json').read_text());catalog=json.loads((p/'catalog.rollback.json').read_text())
assert vds.get('ok') is True and vds.get('service')=='wai-vds'
assert vds.get('provider')=='kamatera' and vds.get('payments')=='wai_pay'
assert pay.get('ok') is True and pay.get('service')=='wai-pay'
assert catalog==json.loads((p/'catalog.before.json').read_text())
PY
  if [[ "$rollback_failed" == 0 ]]; then
    # Also repair the marker if a signal arrived after its final atomic rename.
    printf '%s\n' "$previous" > "$root/current-release.tmp" && mv -f "$root/current-release.tmp" "$root/current-release" || rollback_failed=1
  fi
  if [[ "$rollback_failed" == 0 ]]; then
    echo "Upgrade failed; previous release restored, current data retained. Backup: $backup" >&2
  else
    echo "Upgrade failed; rollback needs attention. Data retained. Backup: $backup" >&2
  fi
  [[ "$result" != 0 ]] || result=1
  exit "$result"
}
trap rollback ERR INT TERM
"${compose[@]}" up -d --no-deps --no-build --pull never wai-vds
healthy=0
for attempt in $(seq 1 40); do
  if container_matches "$release" "$next_image"; then healthy=1; break; fi
  sleep 2
done
test "$healthy" == 1
curl -fsS --max-time 10 https://server.waiwai.is/healthz > "$backup/wai-vds.after.json"
curl -fsS --max-time 10 https://server.waiwai.is/api/v1/catalog > "$backup/catalog.after.json"
curl -fsS --max-time 10 https://pay.waiwai.is/api/v1/healthz > "$backup/wai-pay.after.json"
python3 - "$backup" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1])
vds=json.loads((p/'wai-vds.after.json').read_text());pay=json.loads((p/'wai-pay.after.json').read_text());catalog=json.loads((p/'catalog.after.json').read_text())
assert vds.get('ok') is True and vds.get('service')=='wai-vds' and vds.get('provider')=='kamatera' and vds.get('payments')=='wai_pay'
assert pay.get('ok') is True and pay.get('service')=='wai-pay'
assert catalog==json.loads((p/'catalog.before.json').read_text())
PY
test "$(sha256sum "$root/runtime.env" | cut -d ' ' -f 1)" = "$before_env"
python3 - "$root/data/wai.sqlite" <<'PYVERIFY'
import sqlite3,sys
s=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
assert s.execute('PRAGMA user_version').fetchone()[0]==7
assert s.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
assert s.execute('PRAGMA foreign_key_check').fetchall()==[]
PYVERIFY
printf '%s\n' "$release" > "$root/current-release.tmp"
mv -f "$root/current-release.tmp" "$root/current-release"
trap - ERR INT TERM
echo "WAI VDS interface updated; runtime settings and current data preserved. Release: $release; backup: $backup"
