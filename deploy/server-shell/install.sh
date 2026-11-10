#!/usr/bin/env bash
# Give the owner of the OpenStrudel Home on this server a root shell from their own chat, and `openstrudel-update`.
# Read README.md first: whatever can write into the Home's data folder becomes root on this server.
#
#   sudo bash deploy/server-shell/install.sh --telegram 123456789 [--telegram ID ...] [--container openstrudel-home-1]
#
# --telegram names the paired owners who get the shell in their private Telegram chat. Without it only the owner's
# devices in the app have it. Run again to change the list or to install a newer version.
set -euo pipefail

fail() { printf 'OpenStrudel: %s\n' "$*" >&2; exit 1; }
container=openstrudel-home-1
people=()
while (($#)); do
  case "$1" in
    --telegram) [[ "${2:-}" =~ ^[1-9][0-9]{0,19}$ ]] || fail '--telegram takes a numeric Telegram user id.'; people+=("$2"); shift 2 ;;
    --container) [[ -n "${2:-}" ]] || fail '--container takes a name.'; container=$2; shift 2 ;;
    *) fail "Unknown option $1. See the top of this file." ;;
  esac
done
[[ "$(id -u)" == 0 ]] || fail 'Run as root.'
command -v python3 >/dev/null && command -v git >/dev/null || fail 'python3 and git are needed on the server.'

volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$container") || fail "No container named $container."
data="$volume/.data"
[[ -n "$volume" && -d "$data" ]] || fail "The data folder of $container was not found."
owner=$(stat -c '%u:%g' "$data")
spool="$data/server-shell"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

install -d -m 0755 /opt/openstrudel-server-shell
install -m 0644 "$here/runner.py" "$here/update.py" /opt/openstrudel-server-shell/
printf '#!/bin/sh\nexec /usr/bin/python3 /opt/openstrudel-server-shell/update.py --container %s "$@"\n' "$container" > /usr/local/bin/openstrudel-update
chmod 0755 /usr/local/bin/openstrudel-update

install -d -m 0700 -o "${owner%:*}" -g "${owner#*:}" "$spool"
printf '[%s]\n' "$(printf '"%s",' "${people[@]}" | sed 's/,$//')" > "$spool/owners.json"
chown "$owner" "$spool/owners.json"
chmod 0600 "$spool/owners.json"

sed "s|@SPOOL@|$spool|" "$here/openstrudel-server-shell.service" > /etc/systemd/system/openstrudel-server-shell.service
systemctl daemon-reload
systemctl enable --quiet openstrudel-server-shell.service
systemctl restart openstrudel-server-shell.service
sleep 2
systemctl is-active --quiet openstrudel-server-shell.service || fail 'The runner did not start: journalctl -u openstrudel-server-shell'
printf 'The server shell is on for %s: %s.\n' "$container" "${people[*]:-the app only}"
