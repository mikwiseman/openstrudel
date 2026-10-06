#!/usr/bin/env bash
# Runs on the approved Mac. The age identity never leaves this machine.
set -euo pipefail
umask 077
root="$HOME/Library/Application Support/WAI VDS"
identity="$root/backup-keys/production.agekey"
dest="$root/backups/production-encrypted"
script_dir=$(cd "$(dirname "$0")" && pwd)
script=${WAI_BACKUP_SCRIPT:-"$script_dir/production-backup.mjs"}
[[ -f "$script" ]] || script="$script_dir/../scripts/production-backup.mjs"
node=${WAI_BACKUP_NODE:-"$HOME/.local/bin/node"}
host=root@103.45.247.25
remote=/srv/wai-vds/operations/backups
command -v age >/dev/null
[[ $(stat -f '%Lp' "$identity") == 600 ]]
mkdir -p "$dest"
chmod 700 "$dest"
lock="$dest/.pull.lock"
mkdir "$lock" 2>/dev/null || { echo '{"ok":false,"reason":"pull_already_running_or_stale_lock"}'; exit 1; }
stage=''
trap '[[ -z "$stage" ]] || rm -rf -- "$stage"; rmdir "$lock"' EXIT
stage=$(mktemp -d "$dest/.restore.XXXXXXXX")
name=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" 'python3 -c '\''import pathlib,re; p=pathlib.Path("/srv/wai-vds/operations/backups"); a=sorted(x.name for x in p.iterdir() if re.fullmatch(r"wai-vds-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.age",x.name) and x.is_file() and not x.is_symlink() and x.with_name(x.name+".json").is_file()); print(a[-1] if a else "")'\''')
[[ "$name" =~ ^wai-vds-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}\.tar\.age$ ]]
scp -q -o BatchMode=yes "$host:$remote/$name" "$host:$remote/$name.json" "$stage/"
expected=$(python3 - "$stage/$name.json" "$stage/$name" <<'PY'
import sys,json,hashlib,pathlib
m=json.loads(pathlib.Path(sys.argv[1]).read_text());p=pathlib.Path(sys.argv[2]);assert p.stat().st_size<=64*1024*1024; h=hashlib.sha256(p.read_bytes()).hexdigest();assert m['file']==p.name and m['sha256']==h and m['bytes']==p.stat().st_size;print(h)
PY
)
age --decrypt -i "$identity" -o "$stage/payload.tar" "$stage/$name"
"$node" "$script" restore-tar "$stage/payload.tar" "$stage/restored"
mv -n "$stage/$name" "$dest/$name"
mv -n "$stage/$name.json" "$dest/$name.json"
"$node" "$script" acknowledge "$dest" "$name" "$expected"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "/srv/wai-vds/operations/operations-backup.sh acknowledge $name $expected"
"$node" "$script" prune "$dest" 30 1073741824
printf '{"ok":true,"independent_copy":"approved_mac","restore_verified":true}\n'
