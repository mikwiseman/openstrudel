#!/usr/bin/env bash
set -euo pipefail
umask 077
release=${1:?Usage: pack.sh RELEASE_ID}
[[ "$release" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] || exit 2
bundle=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$bundle/.." && pwd)
mkdir -p "$repo/work/deploy-archives"
archive="$repo/work/deploy-archives/wai-vds-$release.tgz"
test ! -e "$archive" || { echo 'Release archive already exists; use a new ID.' >&2; exit 1; }
stage=$(mktemp -d "$repo/work/deploy-archives/stage.XXXXXX")
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/app" "$stage/deploy"
cp "$repo/package.json" "$stage/app/"
for directory in src public scripts tests; do cp -R "$repo/$directory" "$stage/app/$directory"; done
cp "$bundle/Dockerfile" "$stage/app/"
for file in compose.yml runtime.env.example Caddyfile.before Caddyfile.after Caddyfile.fragment Caddyfile.server domain-upgrade.py domain-callback.mjs home-upgrade.py magic-upgrade.py apply-first.sh upgrade.sh ui-upgrade.sh production-upgrade.sh promote.sh stripe-vds-setup.py stripe-vds-step.mjs register-app.mjs register-app.sh RUNBOOK.md; do
  cp "$bundle/$file" "$stage/deploy/$file"
done
for file in "$bundle"/operations-*; do cp "$file" "$stage/deploy/"; done
printf '%s\n' "$release" > "$stage/RELEASE"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$stage" -czf "$archive" .
python3 -c 'import hashlib,pathlib,sys;p=pathlib.Path(sys.argv[1]);print(hashlib.sha256(p.read_bytes()).hexdigest()+"  "+p.name)' "$archive" > "$archive.sha256"
cat "$archive.sha256"
