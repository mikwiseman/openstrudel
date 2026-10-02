#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "OpenStrudel needs Node.js 22 or newer. Install it from https://nodejs.org/ and run this again." >&2
  exit 1
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "OpenStrudel needs Node.js 22 or newer; found $(node --version)." >&2
  exit 1
fi

npm ci
npm run build
mkdir -p .data
chmod 700 .data

if [[ "$(uname -s)" == "Darwin" ]]; then
  LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
  PLIST="$LAUNCH_AGENTS/is.openstrudel.home.plist"
  mkdir -p "$LAUNCH_AGENTS"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>is.openstrudel.home</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$ROOT/dist/cli.js</string><string>start</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict><key>OPENSTRUDEL_DB</key><string>$ROOT/.data/openstrudel.sqlite</string></dict>
  <key>StandardOutPath</key><string>$ROOT/.data/home.log</string>
  <key>StandardErrorPath</key><string>$ROOT/.data/home.error.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "OpenStrudel Home is running at http://127.0.0.1:7788"
  echo "Native app: open native/OpenStrudel/OpenStrudel.xcodeproj"
else
  USER_UNIT="$HOME/.config/systemd/user/openstrudel.service"
  mkdir -p "$(dirname "$USER_UNIT")"
  cat > "$USER_UNIT" <<EOF
[Unit]
Description=OpenStrudel personal AI Home
After=network-online.target

[Service]
WorkingDirectory=$ROOT
ExecStart=$NODE_BIN $ROOT/dist/cli.js start
Restart=on-failure
RestartSec=3
Environment=OPENSTRUDEL_DB=$ROOT/.data/openstrudel.sqlite

[Install]
WantedBy=default.target
EOF
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload
    systemctl --user enable --now openstrudel.service
    echo "OpenStrudel Home is running at http://127.0.0.1:7788"
  else
    echo "Build complete. Start Home with: $NODE_BIN $ROOT/dist/cli.js start"
  fi
fi

echo "Connect Telegram from the OpenStrudel app's Settings screen."
