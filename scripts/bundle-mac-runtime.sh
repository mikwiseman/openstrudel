#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:?Pass the built OpenStrudel.app path}"
NODE_BIN="$(command -v node)"
if [[ ! -f "$APP/Contents/Info.plist" ]]; then echo "Built macOS app required" >&2; exit 1; fi
mkdir -p "$ROOT/.data"
WORK="$(mktemp -d "$ROOT/.data/packaged-runtime.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
RUNTIME="$WORK/runtime"
mkdir -p "$WORK/source" "$RUNTIME/bin" "$RUNTIME/scripts"
# Build only tracked sources, including reviewed working-tree edits. Local dist,
# ignored migration helpers and stale files from earlier bundles are never input.
while IFS= read -r -d '' file; do
  mkdir -p "$WORK/source/$(dirname "$file")"
  cp "$ROOT/$file" "$WORK/source/$file"
done < <(git -C "$ROOT" ls-files -z -- src public package.json package-lock.json tsconfig.json)
npm ci --prefix "$WORK/source" --ignore-scripts
npm run --prefix "$WORK/source" build
cp "$WORK/source/package.json" "$WORK/source/package-lock.json" "$RUNTIME/"
npm ci --prefix "$RUNTIME" --omit=dev --ignore-scripts
ditto "$WORK/source/dist" "$RUNTIME/dist"
ditto "$WORK/source/public" "$RUNTIME/public"
cp "$ROOT/scripts/install-prebuilt-mac.sh" "$RUNTIME/scripts/"
cp "$ROOT/scripts/mac-launch-agent.mjs" "$RUNTIME/scripts/"
cp "$NODE_BIN" "$RUNTIME/bin/node"
chmod 755 "$RUNTIME/bin/node" "$RUNTIME/scripts/install-prebuilt-mac.sh"
# The digest lets the app replace its launch configuration after an update.
(cd "$RUNTIME" && find dist public scripts/install-prebuilt-mac.sh scripts/mac-launch-agent.mjs package-lock.json -type f -exec shasum -a 256 {} \; | LC_ALL=C sort | shasum -a 256 | cut -d ' ' -f 1) > "$RUNTIME/release.txt"
# Package only public runtime files. No user state, auth, configuration or exports.
mkdir -p "$APP/Contents/Resources"
if [[ -e "$APP/Contents/Resources/Runtime" ]]; then
  mv "$APP/Contents/Resources/Runtime" "$WORK/previous-runtime"
fi
if ! ditto "$RUNTIME" "$APP/Contents/Resources/Runtime"; then
  rm -rf "$APP/Contents/Resources/Runtime"
  if [[ -e "$WORK/previous-runtime" ]]; then mv "$WORK/previous-runtime" "$APP/Contents/Resources/Runtime"; fi
  exit 1
fi
echo "Codex and its runtime are bundled. No Node or terminal setup is needed."
