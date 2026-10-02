#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="${1:?Specify the private server address}"
HOST_KEY="${2:?Specify its previously verified host key file}"
KEY="$HOME/.ssh/id_ed25519_openstrudel_relay"
[[ -f "$KEY" && -f "$HOST_KEY" ]] || { echo "Verified connection credentials are missing" >&2; exit 1; }
mkdir -p "$HOME/.ssh" "$HOME/Library/LaunchAgents" "$ROOT/.data"
chmod 700 "$HOME/.ssh" "$ROOT/.data"
export STRUDEL_RELAY_ROOT="$ROOT" STRUDEL_RELAY_SERVER="$SERVER" STRUDEL_RELAY_HOST_KEY="$HOST_KEY"
/usr/bin/python3 - <<'PY'
import os,pathlib,plistlib
home=pathlib.Path.home()
root=os.environ['STRUDEL_RELAY_ROOT']
server=os.environ['STRUDEL_RELAY_SERVER']
fields=pathlib.Path(os.environ['STRUDEL_RELAY_HOST_KEY']).read_text().split()
key=fields[:2] if fields[0].startswith('ssh-') else fields[1:3]
if len(key)!=2 or not key[0].startswith('ssh-'): raise SystemExit('Invalid verified host key')
known=home/'.ssh/openstrudel_relay_known_hosts'
known.write_text(server+' '+' '.join(key)+'\n')
known.chmod(0o600)
args=['/usr/bin/ssh','-N','-i',str(home/'.ssh/id_ed25519_openstrudel_relay'),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(home/'.ssh/openstrudel_relay_known_hosts'),'-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3','-R','0.0.0.0:17789:127.0.0.1:7789','strudel-relay@'+os.environ['STRUDEL_RELAY_SERVER']]
target=home/'Library/LaunchAgents/is.openstrudel.relay.plist'
target.write_bytes(plistlib.dumps(dict(Label='is.openstrudel.relay',ProgramArguments=args,RunAtLoad=True,KeepAlive=True,ThrottleInterval=10,StandardOutPath=root+'/.data/relay.log',StandardErrorPath=root+'/.data/relay.error.log')))
target.chmod(0o600)
PY
PLIST="$HOME/Library/LaunchAgents/is.openstrudel.relay.plist"
launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "OpenStrudel reconnects to the private server automatically."
