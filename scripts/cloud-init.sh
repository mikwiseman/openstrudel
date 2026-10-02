#!/usr/bin/env bash
# Runs only on a new, customer-owned Ubuntu VM. Credentials arrive in a root-only
# file, never as command arguments, environment variables, or log messages.
set -euo pipefail
umask 077
STATE_DIR=/var/lib/openstrudel-cloud
INSTALL_ROOT=/opt/openstrudel-home
STAGING_DIR=

fail() { printf 'OpenStrudel: %s\n' "$*" >&2; exit 1; }
progress() { printf 'OpenStrudel: %s\n' "$1"; }

installer_unit() {
  cat <<'UNIT'
[Unit]
Description=Finish the OpenStrudel cloud installation
Wants=network-online.target
After=network-online.target cloud-final.service
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart=/bin/bash /var/lib/openstrudel-cloud/install.sh --attempt
Restart=on-failure
RestartSec=60
RestartPreventExitStatus=78
TimeoutStartSec=2h
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
}

install_service() {
  check_host
  installer_unit > "$STATE_DIR/install.service"
  install -m 0644 "$STATE_DIR/install.service" /etc/systemd/system/openstrudel-install.service
  systemctl daemon-reload
  # Do not wait for a unit ordered after cloud-final from inside cloud-final.
  systemctl enable --now --no-block openstrudel-install.service
}

run_attempt() {
  # Persist the limit before starting any work. Unlike systemd's restart counter,
  # this survives reboot, a killed installer, and another "start" request.
  exec 8>"$STATE_DIR/attempt.lock"
  flock -w 30 8 || exit 78
  if [[ -f "$STATE_DIR/complete" ]]; then
    progress 'Installation already completed.'
    return
  fi
  local attempt=0
  if [[ -f "$STATE_DIR/attempts" ]]; then
    read -r attempt < "$STATE_DIR/attempts" || exit 78
  fi
  if [[ ! "$attempt" =~ ^[0-5]$ || "$attempt" == 5 ]]; then
    progress 'Installation attempts exhausted. Check this server in DigitalOcean; billing continues until it is deleted.'
    exit 78
  fi
  attempt=$((attempt + 1))
  printf '%s\n' "$attempt" > "$STATE_DIR/attempts.new"
  mv "$STATE_DIR/attempts.new" "$STATE_DIR/attempts"
  progress "Installation attempt $attempt of 5."
  # A separate shell preserves errexit inside main, even in this conditional.
  if /bin/bash "$STATE_DIR/install.sh" --run-once; then
    printf 'complete\n' > "$STATE_DIR/complete.new"
    mv "$STATE_DIR/complete.new" "$STATE_DIR/complete"
  elif [[ "$attempt" == 5 ]]; then
    progress 'Installation attempts exhausted. Existing data is preserved; check this server in DigitalOcean.'
    exit 78
  else
    progress 'Installation interrupted. The same installation will resume after one minute.'
    exit 1
  fi
}

check_input() {
  INSTALLATION_ID=$(python3 - "$STATE_DIR" <<'PY'
import json, pathlib, re, sys, uuid
root = pathlib.Path(sys.argv[1])
try:
    file = root / 'bootstrap.json'
    if file.is_symlink() or file.stat().st_size > 16384: raise ValueError()
    value = json.loads(file.read_text())
    if set(value) != {'installationId', 'privateKeyPEM', 'ownerTokenHash'}: raise ValueError()
    identity = str(uuid.UUID(value['installationId']))
    if not re.fullmatch(r'[a-f0-9]{64}', value['ownerTokenHash']): raise ValueError()
    if not isinstance(value['privateKeyPEM'], str) or not 100 < len(value['privateKeyPEM']) <= 4096: raise ValueError()
except Exception:
    sys.exit('Invalid cloud bootstrap input; no credentials were printed.')
try:
    checksum = (root / 'release.sha256').read_text().strip()
    if not re.fullmatch(r'[a-f0-9]{64}', checksum): raise ValueError()
except Exception:
    sys.exit('Invalid trusted release checksum.')
print(identity)
PY
  ) || fail 'Invalid bootstrap input or release checksum.'
  RELEASE_SHA256=$(cat "$STATE_DIR/release.sha256")
  RELEASE_SHA256=${RELEASE_SHA256//$'\n'/}
}

check_host() {
  [[ "$(id -u)" == 0 ]] || fail 'Cloud initialization must run as root.'
  local ID VERSION_ID
  . /etc/os-release
  [[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || fail 'This cloud image requires Ubuntu 24.04.'
  case "$(uname -m)" in x86_64|aarch64) ;; *) fail 'A 64-bit x86 or ARM VM is required.' ;; esac
}

write_docker_source() {
  local target=$1 architecture=$2 source
  source=$(cat <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $architecture
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  )
  if [[ -e "$target" ]]; then
    [[ ! -L "$target" ]] && cmp -s "$target" <(printf '%s\n' "$source") || fail 'Existing Docker repository configuration requires attention.'
  else
    (set -C; printf '%s\n' "$source" > "$target")
    chmod 0644 "$target"
  fi
}

metadata_guard_script() {
  cat <<'GUARD'
#!/bin/sh
set -eu
# DO publishes user-data (including bootstrap identity) at this IPv4 endpoint.
# The FORWARD chain covers bridged containers, not the host's own metadata use.
# Create the guard before Docker starts or restores any containers on reboot.
iptables -w 10 -N DOCKER-USER 2>/dev/null || iptables -w 10 -S DOCKER-USER >/dev/null
iptables -w 10 -C DOCKER-USER -d 169.254.169.254/32 -j REJECT 2>/dev/null || \
  iptables -w 10 -I DOCKER-USER 1 -d 169.254.169.254/32 -j REJECT
iptables -w 10 -C FORWARD -j DOCKER-USER 2>/dev/null || \
  iptables -w 10 -I FORWARD 1 -j DOCKER-USER
iptables -w 10 -C DOCKER-USER -d 169.254.169.254/32 -j REJECT
iptables -w 10 -C FORWARD -j DOCKER-USER
GUARD
}

metadata_guard_unit() {
  cat <<'UNIT'
[Unit]
Description=Block cloud metadata access from OpenStrudel containers
Before=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/openstrudel-metadata-guard

[Install]
RequiredBy=docker.service
UNIT
}

install_metadata_guard() {
  metadata_guard_script > "$STATE_DIR/metadata-guard"
  metadata_guard_unit > "$STATE_DIR/metadata-guard.service"
  install -m 0700 "$STATE_DIR/metadata-guard" /usr/local/sbin/openstrudel-metadata-guard
  install -m 0644 "$STATE_DIR/metadata-guard.service" /etc/systemd/system/openstrudel-metadata-guard.service
  systemctl daemon-reload
  systemctl enable --now openstrudel-metadata-guard.service
  # Also assert the live rules when rerunning an already-active oneshot.
  /usr/local/sbin/openstrudel-metadata-guard
}

install_dependencies() {
  progress 'Preparing the server.'
  export DEBIAN_FRONTEND=noninteractive
  # A power loss can leave dpkg mid-configuration. Merely retrying apt then
  # fails forever; finish the previous transaction before starting a new one.
  timeout 900 dpkg --configure -a || {
    timeout 900 apt-get -f install -y --no-install-recommends
    timeout 900 dpkg --configure -a
  }
  timeout 600 apt-get update -qq
  timeout 900 apt-get install -y --no-install-recommends ca-certificates curl python3 util-linux apparmor iptables
  install_metadata_guard
  # Reconcile every package even when a previous attempt installed the CLI but
  # was interrupted before the Engine or Compose was configured.
  # https://docs.docker.com/engine/install/ubuntu/#install-using-the-apt-repository
  [[ ! -e /etc/apt/sources.list.d/docker.list ]] || fail 'Existing Docker repository configuration requires attention.'
  if [[ -e /etc/apt/sources.list.d/docker.sources ]]; then
    write_docker_source /etc/apt/sources.list.d/docker.sources "$(dpkg --print-architecture)"
  fi
  install -m 0755 -d /etc/apt/keyrings
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --connect-timeout 15 --max-time 90 \
    https://download.docker.com/linux/ubuntu/gpg -o "$STATE_DIR/docker.asc"
  install -m 0644 "$STATE_DIR/docker.asc" /etc/apt/keyrings/docker.asc
  rm "$STATE_DIR/docker.asc"
  chmod 0644 /etc/apt/keyrings/docker.asc
  write_docker_source /etc/apt/sources.list.d/docker.sources "$(dpkg --print-architecture)"
  timeout 600 apt-get update -qq
  timeout 1200 apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  [[ -r /sys/module/apparmor/parameters/enabled && "$(cat /sys/module/apparmor/parameters/enabled)" == Y ]] || fail 'AppArmor must be enabled; the Codex sandbox will not be disabled.'
  systemctl enable --now docker
  local version
  version=$(docker version --format '{{.Server.Version}}')
  [[ "$version" =~ ^([0-9]+)\. && "${BASH_REMATCH[1]}" -ge 29 ]] || fail 'Docker Engine 29 or newer is required.'
  docker compose version >/dev/null
}

verify_archive() {
  python3 - "$1" "$RELEASE_SHA256" <<'PY' || fail 'Release checksum mismatch; installation was not replaced.'
import hashlib, pathlib, sys
if hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest() != sys.argv[2]: sys.exit(1)
PY
}

extract_archive() {
  python3 - "$1" "$2" <<'PY' || fail 'Unsafe or incomplete release archive.'
import pathlib, sys, tarfile
destination = pathlib.Path(sys.argv[2])
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    members = archive.getmembers()
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'OpenStrudel-Home' or not (member.isfile() or member.isdir()):
            sys.exit('Unsafe release archive entry.')
    destination.mkdir(parents=True, exist_ok=True)
    archive.extractall(destination, members=members, filter='data')
PY
}

prepare_release() {
  if [[ -e "$INSTALL_ROOT" ]]; then
    [[ ! -L "$INSTALL_ROOT" && -f "$INSTALL_ROOT/.cloud-installation-id" && -f "$INSTALL_ROOT/.cloud-release.sha256" \
      && "$(cat "$INSTALL_ROOT/.cloud-installation-id")" == "$INSTALLATION_ID" \
      && "$(cat "$INSTALL_ROOT/.cloud-release.sha256")" == "$RELEASE_SHA256" ]] || fail 'Refusing to replace an existing installation.'
    return
  fi
  progress 'Downloading the verified release.'
  STAGING_DIR=$(mktemp -d "${INSTALL_ROOT}.download.XXXXXX")
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --connect-timeout 15 --max-time 180 \
    https://waiwai.is/openstrudel/downloads/OpenStrudel-Home-1.0.tar.gz -o "$STAGING_DIR/release.tar.gz"
  verify_archive "$STAGING_DIR/release.tar.gz"
  extract_archive "$STAGING_DIR/release.tar.gz" "$STAGING_DIR/extracted"
  local release="$STAGING_DIR/extracted/OpenStrudel-Home" required
  for required in Dockerfile package-lock.json src/cloud-bootstrap.ts deploy/compose.yaml deploy/docker/openstrudel.apparmor deploy/docker/seccomp.json scripts/check-sandbox.mjs; do
    [[ -f "$release/$required" ]] || fail 'The release does not include cloud installation support.'
  done
  printf '%s\n' "$INSTALLATION_ID" > "$release/.cloud-installation-id"
  printf '%s\n' "$RELEASE_SHA256" > "$release/.cloud-release.sha256"
  mv "$release" "$INSTALL_ROOT"
  rm -rf "$STAGING_DIR"; STAGING_DIR=
}

configure() {
  PUBLIC_HOST=$(ip -j -4 address show scope global | python3 -c 'import ipaddress,json,sys; addresses=[a["local"] for i in json.load(sys.stdin) for a in i.get("addr_info",[]) if ipaddress.ip_address(a["local"]).is_global]; print(addresses[0] if addresses else "")')
  if [[ -z "$PUBLIC_HOST" ]]; then
    PUBLIC_HOST=$(curl --noproxy '*' -fsS --connect-timeout 2 --max-time 5 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address)
  fi
  python3 - "$PUBLIC_HOST" <<'PY' || fail 'Could not determine the public IPv4 address.'
import ipaddress, sys
value = ipaddress.ip_address(sys.argv[1])
if value.version != 4 or not value.is_global: sys.exit(1)
PY
  local env_file="$INSTALL_ROOT/deploy/.env"
  if [[ -e "$env_file" ]]; then
    [[ ! -L "$env_file" ]] || fail 'Refusing a symlinked server configuration.'
    python3 - "$env_file" "$PUBLIC_HOST" <<'PY' || fail 'Existing server configuration does not match this installation.'
import pathlib, sys
values = {}
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if not line.strip() or line.lstrip().startswith('#'): continue
    key, sep, value = line.partition('=')
    if not sep or key in values: sys.exit(1)
    values[key] = value
if values.get('OPENSTRUDEL_PUBLIC_HOST') != sys.argv[2] or values.get('OPENSTRUDEL_PUBLIC_PORT') != '7789' or values.get('COMPOSE_PROJECT_NAME') != 'openstrudel': sys.exit(1)
PY
  else
    printf 'OPENSTRUDEL_PUBLIC_HOST=%s\nOPENSTRUDEL_PUBLIC_PORT=7789\nCOMPOSE_PROJECT_NAME=openstrudel\nTZ=UTC\n' "$PUBLIC_HOST" > "$env_file"
    chmod 0600 "$env_file"
  fi
  local working_dir
  while IFS= read -r working_dir; do
    [[ -z "$working_dir" || "$working_dir" == "$INSTALL_ROOT/deploy" ]] || fail 'Another installation owns the Compose project.'
  done < <(docker ps -a --filter label=com.docker.compose.project=openstrudel --format '{{.Label "com.docker.compose.project.working_dir"}}')
  if docker volume inspect openstrudel_data >/dev/null 2>&1; then
    [[ "$(docker volume inspect openstrudel_data --format '{{ index .Labels "is.openstrudel.installation" }}')" == "$INSTALLATION_ID" ]] || fail 'An existing data volume belongs to another installation.'
  else
    docker volume create --label "is.openstrudel.installation=$INSTALLATION_ID" \
      --label com.docker.compose.project=openstrudel --label com.docker.compose.volume=data openstrudel_data >/dev/null
  fi
}

compose() (
  unset OPENSTRUDEL_PUBLIC_HOST OPENSTRUDEL_PUBLIC_PORT COMPOSE_PROJECT_NAME TZ
  timeout "${COMPOSE_TIMEOUT:-120}" docker compose --project-name openstrudel --project-directory "$INSTALL_ROOT/deploy" \
    --env-file "$INSTALL_ROOT/deploy/.env" -f "$INSTALL_ROOT/deploy/compose.yaml" "$@"
)

bootstrap_home() {
  # Compose run does not publish service ports. Keep its configured UID, dropped
  # capabilities and security profiles; bypass only the normal start entrypoint.
  compose run --rm -T --no-deps --entrypoint node home /opt/openstrudel/dist/cli.js cloud-bootstrap < "$STATE_DIR/bootstrap.json"
}

wait_ready() {
  local attempt
  for attempt in {1..40}; do
    if COMPOSE_TIMEOUT=10 compose exec -T home node --input-type=module -e '
      import {readFile} from "node:fs/promises";
      const c=JSON.parse(await readFile("/data/.data/LocalConnection.json","utf8"));
      const r=await fetch(new URL("/health",c.url),{headers:{authorization:`Bearer ${c.token}`},signal:AbortSignal.timeout(1500)});
      process.exit(r.ok?0:1);' >/dev/null 2>&1; then return; fi
    sleep 3
  done
  fail 'The server did not become ready. Data is preserved; the sandbox has not been disabled.'
}

main() {
  check_host
  check_input
  exec 9>/run/lock/openstrudel-cloud.lock
  flock -w 30 9 || fail 'Another installation is already in progress.'
  trap 'status=$?; [[ -z "$STAGING_DIR" ]] || rm -rf "$STAGING_DIR"; if [[ $status -ne 0 ]]; then printf "OpenStrudel: Installation stopped; existing data is preserved.\n" >&2; fi' EXIT
  install_dependencies
  prepare_release
  configure
  apparmor_parser -r "$INSTALL_ROOT/deploy/docker/openstrudel.apparmor"
  progress 'Preparing OpenStrudel.'
  COMPOSE_TIMEOUT=2400 compose build home
  bootstrap_home
  compose up -d --no-build home
  wait_ready
  progress 'Ready. Return to OpenStrudel to connect.'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:---attempt}" in
    --install-service) install_service ;;
    --attempt) run_attempt ;;
    --run-once) main ;;
    *) fail 'Unknown installer operation.' ;;
  esac
fi
