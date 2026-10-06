#!/usr/bin/env bash
# Review and invoke explicitly on the documented host. Does not install packages.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || exit 1
bundle=$(cd "$(dirname "$0")" && pwd)
scripts="$bundle/../app/scripts"
[[ -d "$scripts" ]] || scripts="$bundle/../scripts"
recipient=${1:?Usage: operations-install.sh ROOT_ONLY_PUBLIC_RECIPIENT_FILE}
root=/srv/wai-vds
ops=$root/operations
command -v age >/dev/null
[[ $(stat -c '%u:%a' "$recipient") == 0:600 ]]
python3 - "$recipient" <<'PY'
import pathlib,re,sys
s=pathlib.Path(sys.argv[1]).read_text().strip();assert re.fullmatch(r'age1[0-9a-z]+',s)
PY
install -d -m 700 "$ops" "$ops/backups" "$ops/tmp"
if [[ -e "$ops/recipient.txt" ]]; then cmp "$recipient" "$ops/recipient.txt"; else install -m 600 "$recipient" "$ops/recipient.txt"; fi
for f in production-backup.mjs production-monitor.mjs; do install -m 500 "$scripts/$f" "$ops/$f"; done
for f in operations-backup.sh operations-monitor.sh; do install -m 500 "$bundle/$f" "$ops/$f"; done
for task in backup monitor; do
  for kind in service timer; do
    target="/etc/systemd/system/wai-vds-operations-$task.$kind"
    if [[ -e "$target" ]]; then grep -qx '# Managed exclusively by WAI VDS operations.' "$target"; fi
    install -m 644 "$bundle/operations-$task.$kind" "$target"
  done
done
systemd-analyze verify /etc/systemd/system/wai-vds-operations-{backup,monitor}.{service,timer}
systemctl daemon-reload
systemctl enable --now wai-vds-operations-backup.timer wai-vds-operations-monitor.timer
printf '{"installed":true,"application_restarted":false,"recipient_rotated":false}\n'
