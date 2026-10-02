#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_ROOT="${1:-$ROOT}"
NODE_BIN="$ROOT/bin/node"
if [[ ! -x "$NODE_BIN" ]]; then NODE_BIN="$(command -v node || true)"; fi
if [[ -z "$NODE_BIN" && -x "$HOME/.local/bin/node" ]]; then NODE_BIN="$HOME/.local/bin/node"; fi
if [[ -z "$NODE_BIN" || ! -f "$ROOT/dist/cli.js" ]]; then echo "Prepared runtime or Node.js is missing" >&2; exit 1; fi
mkdir -p "$DATA_ROOT/.data" "$HOME/Library/LaunchAgents"
chmod 700 "$DATA_ROOT/.data"
PLIST="$HOME/Library/LaunchAgents/is.openstrudel.home.plist"
PREVIOUS=""
if [[ -f "$PLIST" ]]; then PREVIOUS="$(/usr/bin/shasum -a 256 "$PLIST")"; fi
"$NODE_BIN" "$ROOT/scripts/mac-launch-agent.mjs" "$ROOT" "$DATA_ROOT"
CURRENT="$(/usr/bin/shasum -a 256 "$PLIST")"
if [[ "$PREVIOUS" != "$CURRENT" ]]; then
  launchctl bootout "gui/$(id -u)/is.openstrudel.home" >/dev/null 2>&1 || true
fi
if ! launchctl print "gui/$(id -u)/is.openstrudel.home" >/dev/null 2>&1; then
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
fi
echo "OpenStrudel starts automatically on this Mac."
