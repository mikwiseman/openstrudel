#!/usr/bin/env bash
# Host entry point. Only this service's private operation directories are writable.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || exit 1
root=/srv/wai-vds
ops=$root/operations
archives=$ops/backups
action=${1:-backup}
exec 9>"$root/deploy.lock"
flock -n 9 || { echo '{"ok":false,"reason":"deployment_in_progress"}'; exit 1; }
exec 8>"$ops/backup.lock"
flock -n 8 || exit 1
release=$(cat "$root/current-release")
[[ "$release" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] || exit 1
image=$(docker image inspect "wai-vds:$release" --format '{{.Id}}')
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
install -d -m 700 "$archives" "$ops/tmp"
helper=(docker run --rm --pull never --network none --read-only --user 0:0 --cap-drop ALL --security-opt no-new-privileges --memory 256m --pids-limit 32 --tmpfs /tmp:rw,noexec,nosuid,size=16m --entrypoint node)
script=(--mount "type=bind,source=$ops/production-backup.mjs,target=/operation.mjs,readonly")
run_archive() { "${helper[@]}" "${script[@]}" --mount "type=bind,source=$archives,target=/archives" "$image" /operation.mjs "$@"; }
if [[ "$action" == acknowledge ]]; then
  [[ ${2:-} =~ ^wai-vds-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}\.tar\.age$ && ${3:-} =~ ^[a-f0-9]{64}$ ]] || exit 1
  run_archive acknowledge /archives "$2" "$3"
  exit 0
fi
[[ "$action" == backup ]] || exit 1
command -v age >/dev/null
[[ $(stat -c '%u:%a' "$root/runtime.env") == 0:600 ]]
[[ $(stat -c '%u:%a' "$ops/recipient.txt") == 0:600 ]]
grep -Eq '^age1[0-9a-z]+$' "$ops/recipient.txt"
test "$(docker inspect wai-vds --format '{{.Config.Image}} {{.Image}} {{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}}')" = "wai-vds:$release $image wai-vds wai-vds"
run_archive prune /archives 14 536870912
stage=$(mktemp -d "$ops/tmp/snapshot.XXXXXXXX")
name="wai-vds-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4).tar.age"
partial="$archives/.$name.partial"
committed=0
trap 'rm -rf -- "$stage"; rm -f -- "$partial"; [[ "$committed" == 1 ]] || rm -f -- "$archives/$name" "$archives/$name.json"' EXIT
# UID 0 needs read/search permission through the app-owned 0700 data directory.
# This capability is limited to snapshot; all source mounts remain read-only.
"${helper[@]}" --cap-add DAC_READ_SEARCH "${script[@]}" --mount "type=bind,source=$root/data,target=/source,readonly" --mount "type=bind,source=$root/runtime.env,target=/runtime.env,readonly" --mount "type=bind,source=$root/current-release,target=/current-release,readonly" --mount "type=bind,source=$stage,target=/snapshot" "$image" /operation.mjs snapshot /source /runtime.env /current-release /snapshot
tar --format=ustar -C "$stage" -cf - wai.sqlite master.key bootstrap-signing.pem runtime.env current-release manifest.json | age --encrypt -R "$ops/recipient.txt" > "$partial"
test -s "$partial"
[[ $(stat -c '%s' "$partial") -le 67108864 ]]
mv -- "$partial" "$archives/$name"
run_archive record /archives "$name"
committed=1
run_archive prune /archives 14 536870912
