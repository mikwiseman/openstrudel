#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:?Pass the built OpenStrudel.app path}"
NODE_BIN="$(command -v node)"
RUNTIME="$ROOT/.data/packaged-runtime"
if [[ ! -f "$APP/Contents/Info.plist" ]]; then echo "Built macOS app required" >&2; exit 1; fi
mkdir -p "$RUNTIME/bin" "$RUNTIME/scripts"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$RUNTIME/"
npm ci --prefix "$RUNTIME" --omit=dev --ignore-scripts
ditto "$ROOT/dist" "$RUNTIME/dist"
cp "$ROOT/scripts/install-prebuilt-mac.sh" "$RUNTIME/scripts/"
cp "$ROOT/scripts/mac-launch-agent.mjs" "$RUNTIME/scripts/"
cp "$NODE_BIN" "$RUNTIME/bin/node"
chmod 755 "$RUNTIME/bin/node" "$RUNTIME/scripts/install-prebuilt-mac.sh"
# The digest lets the app replace its launch configuration after an update.
(cd "$ROOT" && find dist scripts/install-prebuilt-mac.sh scripts/mac-launch-agent.mjs package-lock.json -type f -exec shasum -a 256 {} \; | LC_ALL=C sort | shasum -a 256 | cut -d ' ' -f 1) > "$RUNTIME/release.txt"
# Package only public runtime files. No user state, auth, configuration or exports.
ditto "$RUNTIME" "$APP/Contents/Resources/Runtime"
echo "Codex and its runtime are bundled. No Node or terminal setup is needed."
