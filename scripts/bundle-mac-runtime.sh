#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:?Pass the built OpenStrudel.app path}"
if [[ ! -f "$APP/Contents/Info.plist" ]]; then echo "Built macOS app required" >&2; exit 1; fi
CACHE="$HOME/Library/Caches/OpenStrudelBuilds/runtime-temp"
mkdir -p "$CACHE"
WORK="$(mktemp -d "$CACHE/packaged-runtime.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
RUNTIME="$WORK/runtime"
mkdir -p "$WORK/source" "$RUNTIME/bin" "$RUNTIME/scripts"
# Homebrew's Node can link to libraries outside the executable. Ship the same
# standalone upstream version on every release machine, with pinned checksums.
NODE_VERSION="26.7.0"
case "$(lipo -archs "$APP/Contents/MacOS/OpenStrudel")" in
  arm64) NODE_ARCH="arm64"; NODE_SHA256="7ee659a7768e641bbfd5360940660b8e8fd0052f77488f365562bac522fc15d4" ;;
  x86_64) NODE_ARCH="x64"; NODE_SHA256="f279d1ed28ce57f7788bf23435d2ad7fdd7438904ad5c4d8a1081a7cde3d4b96" ;;
  *) echo "Build one Mac architecture before bundling the runtime." >&2; exit 1 ;;
esac
NODE_PACKAGE="node-v$NODE_VERSION-darwin-$NODE_ARCH"
curl --fail --silent --show-error --location --retry 2 --connect-timeout 15 --max-time 300 \
  "https://nodejs.org/dist/v$NODE_VERSION/$NODE_PACKAGE.tar.gz" -o "$WORK/node.tar.gz"
printf '%s  %s\n' "$NODE_SHA256" "$WORK/node.tar.gz" | shasum -a 256 -c -
tar -xzf "$WORK/node.tar.gz" -C "$WORK"
cp "$WORK/$NODE_PACKAGE/bin/node" "$RUNTIME/bin/node"
cp "$WORK/$NODE_PACKAGE/LICENSE" "$RUNTIME/Node-LICENSE.txt"
otool -L "$RUNTIME/bin/node" | tail -n +2 | while read -r dependency rest; do
  case "$dependency" in
    /usr/lib/*|/System/Library/*) ;;
    *) echo "Node depends on a library outside macOS: $dependency" >&2; exit 1 ;;
  esac
done
"$RUNTIME/bin/node" --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; new DatabaseSync(':memory:').close();"
# Build only tracked sources, including reviewed working-tree edits. Local dist,
# ignored migration helpers and stale files from earlier bundles are never input.
while IFS= read -r -d '' file; do
  mkdir -p "$WORK/source/$(dirname "$file")"
  cp "$ROOT/$file" "$WORK/source/$file"
done < <(git -C "$ROOT" ls-files -z -- src public package.json package-lock.json tsconfig.json)
# The checkout's .npmrc does not reach another --prefix, so install scripts are turned off here too.
npm ci --prefix "$WORK/source" --ignore-scripts
npm run --prefix "$WORK/source" build
cp "$WORK/source/package.json" "$WORK/source/package-lock.json" "$RUNTIME/"
# Native packages for the app's architecture rather than the build machine's.
npm ci --prefix "$RUNTIME" --omit=dev --ignore-scripts --os=darwin --cpu="$NODE_ARCH"
# The Grok subscription runs xAI's pinned Grok Build. Its native binary goes to bin/grok with its Apache-2.0
# license and notices; the compressed npm copy is not shipped twice.
"$RUNTIME/bin/node" "$ROOT/scripts/extract-grok.mjs" "$RUNTIME" "darwin-$NODE_ARCH"
cp "$ROOT/licenses/Grok-LICENSE.txt" "$ROOT/licenses/Grok-THIRD_PARTY_NOTICES.md" "$RUNTIME/"
# npm links bin/grok there too; a link to nothing fails `codesign --verify --deep --strict`.
rm -rf "$RUNTIME/node_modules/@xai-official" "$RUNTIME/node_modules/.bin/grok"
mkdir -p "$WORK/grok-home"
env -i PATH=/usr/bin:/bin HOME="$WORK/grok-home" GROK_HOME="$WORK/grok-home" GROK_DISABLE_AUTOUPDATER=1 "$RUNTIME/bin/grok" --no-auto-update --version
ditto "$WORK/source/dist" "$RUNTIME/dist"
ditto "$WORK/source/public" "$RUNTIME/public"
cp "$ROOT/scripts/install-prebuilt-mac.sh" "$RUNTIME/scripts/"
cp "$ROOT/scripts/mac-launch-agent.mjs" "$RUNTIME/scripts/"
cp "$ROOT/scripts/document-signing.py" "$RUNTIME/scripts/"
chmod 755 "$RUNTIME/bin/node" "$RUNTIME/scripts/install-prebuilt-mac.sh"
# The digest lets the app replace its launch configuration after an update.
(cd "$RUNTIME" && find dist public bin/node scripts/install-prebuilt-mac.sh scripts/mac-launch-agent.mjs scripts/document-signing.py package-lock.json -type f -exec shasum -a 256 {} \; | LC_ALL=C sort | shasum -a 256 | cut -d ' ' -f 1) > "$RUNTIME/release.txt"
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
echo "Codex, Grok Build and their runtime are bundled. No Node or terminal setup is needed."
