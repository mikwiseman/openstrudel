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
PREPARED="$(mktemp "$PLIST.XXXXXX")"
trap 'rm -f "$PREPARED" "$PREPARED.new"' EXIT
"$NODE_BIN" "$ROOT/scripts/mac-launch-agent.mjs" "$ROOT" "$DATA_ROOT" "$PREPARED"
SERVICE="gui/$(id -u)/is.openstrudel.home"
if ! cmp -s "$PLIST" "$PREPARED"; then
  launchctl bootout "$SERVICE" >/dev/null 2>&1 || true
  # bootout returns before launchd has finished removing the old process.
  for attempt in {1..100}; do
    if ! launchctl print "$SERVICE" >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
  if launchctl print "$SERVICE" >/dev/null 2>&1; then
    echo "The previous Home is still stopping. Try again shortly." >&2
    exit 1
  fi
  # Commit the version only after the old service has stopped. A failed stop
  # must remain retryable and must not look like an already installed update.
  mv -f "$PREPARED" "$PLIST"
fi
if ! launchctl print "$SERVICE" >/dev/null 2>&1; then
  # launchd may briefly reject a bootstrap immediately after removal.
  for attempt in {1..20}; do
    if launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
  launchctl print "$SERVICE" >/dev/null
fi
echo "OpenStrudel starts automatically on this Mac."
