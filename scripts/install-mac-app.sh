#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE="$ROOT/native/OpenStrudel"
DEST="$HOME/Applications/OpenStrudel.app"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS." >&2
  exit 1
fi
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "OpenStrudel needs xcodegen. Install it with: brew install xcodegen" >&2
  exit 1
fi
if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "OpenStrudel needs Xcode with xcodebuild available." >&2
  exit 1
fi

cd "$NATIVE"
xcodegen generate
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/openstrudel-install.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
python3 "$ROOT/scripts/native-build.py" \
  --copy-product Build/Products/Release/OpenStrudel.app "$STAGING/OpenStrudel.app" -- \
  -scheme 'OpenStrudel macOS' \
  -configuration Release \
  -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO \
  build

mkdir -p "$HOME/Applications"
rm -rf "$DEST"
ditto "$STAGING/OpenStrudel.app" "$DEST"
open "$DEST"
echo "Installed $DEST"
