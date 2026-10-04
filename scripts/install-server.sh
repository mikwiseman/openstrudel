#!/usr/bin/env bash
# Personal Ubuntu server installation. No hosting account is created by this script.
set -euo pipefail

fail() { printf 'OpenStrudel: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
as_root() { if [[ "$(id -u)" == 0 ]]; then "$@"; else sudo -- "$@"; fi; }

usage() {
  cat <<'HELP'
OpenStrudel — установка на собственный Ubuntu VDS

bash install-server.sh [--host example.com] [--port 7789] [--dir PATH] [--project NAME]

Нужны Ubuntu 22.04/24.04/26.04, Docker Engine 29+, Compose и AppArmor.
Адрес берётся из публичного IPv4 сетевого интерфейса; за NAT укажите --host.
Папка по умолчанию: ~/OpenStrudel-Home (или текущий распакованный комплект).
Повторный запуск сохраняет настройки и данные, выдаёт новое приглашение.
HELP
}

check_platform() {
  [[ "$(uname -s)" == Linux ]] || fail 'Этот установщик предназначен для Ubuntu VDS. На Mac используйте приложение.'
  [[ -r /etc/os-release ]] || fail 'Не удалось определить версию Ubuntu.'
  local ID VERSION_ID
  . /etc/os-release
  [[ "$ID" == ubuntu && "$VERSION_ID" =~ ^(22\.04|24\.04|26\.04)$ ]] || fail 'Поддерживаются Ubuntu 22.04, 24.04 и 26.04.'
  case "$(uname -m)" in x86_64|aarch64) ;; *) fail 'Нужен 64-битный сервер x86_64 или ARM64.' ;; esac
}

check_dependencies() {
  local executable
  for executable in python3 curl flock apparmor_parser; do
    command -v "$executable" >/dev/null 2>&1 || fail "Не найден $executable. Установите зависимости: sudo apt-get install curl python3 util-linux apparmor"
  done
  [[ "$(id -u)" == 0 ]] || command -v sudo >/dev/null 2>&1 || fail 'Нужен sudo для загрузки профиля AppArmor.'
  [[ -r /sys/module/apparmor/parameters/enabled && "$(cat /sys/module/apparmor/parameters/enabled)" == Y ]] || fail 'AppArmor не активен. Нужен Ubuntu VDS с работающим AppArmor; отключать sandbox нельзя.'
}

ensure_docker() {
  command -v docker >/dev/null 2>&1 || fail 'Сначала установите Docker Engine с Compose по официальной инструкции: https://docs.docker.com/engine/install/ubuntu/ . Затем повторите эту команду.'
  local endpoint
  endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
  [[ "$endpoint" == unix://* ]] || fail 'Docker подключён к другой машине. Запускайте установщик на самом VDS с локальным Docker.'
  DOCKER=(docker)
  if ! docker info >/dev/null 2>&1; then
    [[ "$(id -u)" != 0 ]] || fail 'Docker не запущен. Проверьте sudo systemctl status docker.'
    DOCKER=(sudo -- docker)
    "${DOCKER[@]}" info >/dev/null 2>&1 || fail 'Нет доступа к работающему Docker. Проверьте sudo docker info.'
  fi
  local version
  version=$("${DOCKER[@]}" version --format '{{.Server.Version}}')
  [[ "$version" =~ ^([0-9]+)\. && "${BASH_REMATCH[1]}" -ge 29 ]] || fail 'Нужен Docker Engine 29 или новее. Существующий Docker автоматически не обновляется.'
  "${DOCKER[@]}" compose version >/dev/null 2>&1 || fail 'Установите официальный docker-compose-plugin: https://docs.docker.com/compose/install/linux/'
}

validate_host() {
  python3 - "$1" <<'PY' || fail 'Укажите публичный IPv4 или домен без https://, пути и порта.'
import ipaddress, re, sys
host = sys.argv[1]
try:
    address = ipaddress.ip_address(host)
    valid = address.version == 4 and address.is_global and not address.is_multicast and not address.is_reserved
except ValueError:
    valid = (len(host) <= 253 and "." in host and not host.endswith((".local", ".localhost"))
             and not re.fullmatch(r"[0-9.]+", host)
             and all(re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?", part) for part in host.split(".")))
sys.exit(0 if valid else 1)
PY
}

validate_port() { [[ "$1" =~ ^[1-9][0-9]{0,4}$ && "$1" -ge 1024 && "$1" -le 65535 ]] || fail 'Допустимый TCP-порт: от 1024 до 65535.'; }
validate_project() { [[ "$1" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || fail 'Имя проекта: строчные латинские буквы, цифры, дефис или подчёркивание.'; }

detect_host() {
  local candidate
  candidate=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')
  if [[ -n "$candidate" ]] && (validate_host "$candidate") 2>/dev/null; then printf '%s' "$candidate";
  else fail 'Публичный IPv4 не найден. Повторите с --host публичный-домен-или-IPv4. Порт должен вести на этот сервер.'; fi
}

extract_release() {
  python3 - "$1" "$2" <<'PY' || fail 'Небезопасный или повреждённый архив; установка остановлена.'
import os, pathlib, sys, tarfile
with tarfile.open(sys.argv[1], "r:gz") as archive:
    members = archive.getmembers()
    if len(members) > 10000 or sum(m.size for m in members) > 100_000_000:
        raise ValueError("Archive too large")
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if (path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != "OpenStrudel-Home"
            or any(p in (".data", ".env", "auth.json") for p in path.parts)
            or not (member.isfile() or member.isdir())):
            raise ValueError("Unsafe archive member")
        member.uid, member.gid = os.getuid(), os.getgid()
        member.uname = member.gname = ""
        member.mode &= 0o777
    archive.extractall(sys.argv[2], members=members)
PY
}

prepare_release() {
  if [[ -f "$INSTALL_ROOT/deploy/compose.yaml" && -f "$INSTALL_ROOT/Dockerfile" && -f "$INSTALL_ROOT/package.json" ]]; then return; fi
  [[ ! -e "$INSTALL_ROOT" ]] || fail 'Папка уже существует и не похожа на комплект OpenStrudel. Выберите пустой путь через --dir.'
  local parent stage archive checksum
  parent=$(dirname "$INSTALL_ROOT")
  mkdir -p "$parent"
  stage=$(mktemp -d "$parent/.openstrudel-download.XXXXXX")
  STAGING_DIR=$stage
  archive=OpenStrudel-Home-1.0.tar.gz
  say 'Скачиваем официальный комплект OpenStrudel…'
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --max-time 120 "https://waiwai.is/openstrudel/downloads/$archive" -o "$stage/$archive"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --max-time 30 'https://waiwai.is/openstrudel/downloads/SHA256SUMS' -o "$stage/SHA256SUMS"
  checksum=$(awk -v name="$archive" '$2==name {print $1}' "$stage/SHA256SUMS")
  python3 - "$stage/$archive" "$checksum" <<'PY' || fail 'Контрольная сумма не совпала. Файлы установки не изменены; повторите позже.'
import hashlib, pathlib, re, sys
expected = sys.argv[2]
if not re.fullmatch(r"[a-f0-9]{64}", expected) or hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest() != expected:
    sys.exit(1)
PY
  extract_release "$stage/$archive" "$stage/extracted"
  [[ -f "$stage/extracted/OpenStrudel-Home/deploy/compose.yaml" && -f "$stage/extracted/OpenStrudel-Home/Dockerfile" ]] || fail 'В архиве нет комплекта сервера.'
  mv "$stage/extracted/OpenStrudel-Home" "$INSTALL_ROOT"
  rm -rf "$stage"
  STAGING_DIR=
}

take_lock() {
  mkdir -p "$(dirname "$INSTALL_ROOT")"
  [[ ! -L "$INSTALL_ROOT.install.lock" ]] || fail 'Файл блокировки не должен быть символической ссылкой.'
  exec 9>>"$INSTALL_ROOT.install.lock"
  flock -n 9 || fail 'Установка уже запущена. Дождитесь её завершения.'
}

env_value() {
  python3 - "$ENV_FILE" "$1" <<'PY'
import pathlib, sys
values = []
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    key, separator, value = line.partition("=")
    if separator and key.strip() == sys.argv[2]:
        value = value.strip()
        if len(value) > 1 and value[0] == value[-1] and value[0] in "\"'": value = value[1:-1]
        values.append(value)
if len(values) > 1: sys.exit("Повторяющийся ключ в существующем deploy/.env")
print(values[0] if values else "")
PY
}

configure() {
  ENV_FILE="$INSTALL_ROOT/deploy/.env"
  HAD_ENV=false
  [[ ! -L "$ENV_FILE" ]] || fail 'deploy/.env не должен быть символической ссылкой.'
  if [[ -e "$ENV_FILE" ]]; then
    HAD_ENV=true
    local saved_host saved_port saved_project
    saved_host=$(env_value OPENSTRUDEL_PUBLIC_HOST)
    saved_port=$(env_value OPENSTRUDEL_PUBLIC_PORT); saved_port=${saved_port:-7789}
    saved_project=$(env_value COMPOSE_PROJECT_NAME); saved_project=${saved_project:-openstrudel}
    [[ -z "$PUBLIC_HOST" || "$PUBLIC_HOST" == "$saved_host" ]] || fail 'Адрес отличается от существующей установки. deploy/.env сохранён; не меняйте адрес уже подключённых устройств случайно.'
    [[ -z "$PUBLIC_PORT" || "$PUBLIC_PORT" == "$saved_port" ]] || fail 'Порт отличается от существующей установки. deploy/.env сохранён.'
    [[ -z "$PROJECT_NAME" || "$PROJECT_NAME" == "$saved_project" ]] || fail 'Имя проекта отличается от существующей установки. deploy/.env сохранён.'
    PUBLIC_HOST=$saved_host; PUBLIC_PORT=$saved_port; PROJECT_NAME=$saved_project
  else
    PUBLIC_HOST=${PUBLIC_HOST:-$(detect_host)}
    PUBLIC_PORT=${PUBLIC_PORT:-7789}
    PROJECT_NAME=${PROJECT_NAME:-openstrudel}
  fi
  validate_host "$PUBLIC_HOST"; validate_port "$PUBLIC_PORT"; validate_project "$PROJECT_NAME"
}

assert_project_available() {
  local directory directories
  directories=$("${DOCKER[@]}" ps -a --filter "label=com.docker.compose.project=$PROJECT_NAME" --format '{{.Label "com.docker.compose.project.working_dir"}}')
  while IFS= read -r directory; do
    [[ -z "$directory" || "$directory" == "$INSTALL_ROOT/deploy" ]] || fail 'Это имя Compose занято другой установкой. Выберите другое --project.'
  done <<< "$directories"
  if [[ "$HAD_ENV" == false ]] && "${DOCKER[@]}" volume inspect "${PROJECT_NAME}_data" >/dev/null 2>&1; then
    fail 'Уже существует том данных этого проекта. Используйте папку прежней установки или другое --project; данные не изменены.'
  fi
}

compose() (
  unset OPENSTRUDEL_PUBLIC_HOST OPENSTRUDEL_PUBLIC_PORT COMPOSE_PROJECT_NAME TZ
  "${DOCKER[@]}" compose --project-name "$PROJECT_NAME" --project-directory "$INSTALL_ROOT/deploy" --env-file "$ENV_FILE" -f "$INSTALL_ROOT/deploy/compose.yaml" "$@"
)
load_apparmor() {
  as_root install -m 0644 "$INSTALL_ROOT/deploy/docker/openstrudel.apparmor" /etc/apparmor.d/openstrudel-container
  as_root install -m 0644 "$INSTALL_ROOT/deploy/docker/openstrudel-apparmor.service" /etc/systemd/system/openstrudel-apparmor.service
  as_root systemctl daemon-reload
  as_root systemctl enable --now openstrudel-apparmor.service
  as_root apparmor_parser -r /etc/apparmor.d/openstrudel-container
}

wait_ready() {
  local attempt
  for attempt in {1..60}; do
    if compose exec -T home node --input-type=module -e '
      import {readFile} from "node:fs/promises";
      const c=JSON.parse(await readFile("/data/.data/LocalConnection.json","utf8"));
      const r=await fetch(new URL("/health",c.url),{headers:{authorization:`Bearer ${c.token}`},signal:AbortSignal.timeout(1500)});
      process.exit(r.ok?0:1);' >/dev/null 2>&1; then return; fi
    sleep 2
  done
  return 1
}

main() {
  local script_root= option
  PUBLIC_HOST= PUBLIC_PORT= PROJECT_NAME= INSTALL_ROOT= STAGING_DIR=
  if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd); fi
  while [[ $# -gt 0 ]]; do
    option=$1; shift
    case "$option" in
      --help|-h) usage; return ;;
      --host|--port|--dir|--project)
        [[ $# -gt 0 && -n "$1" ]] || fail "У $option нет значения."
        case "$option" in --host) PUBLIC_HOST=$1 ;; --port) PUBLIC_PORT=$1 ;; --dir) INSTALL_ROOT=$1 ;; --project) PROJECT_NAME=$1 ;; esac
        shift ;;
      *) fail "Неизвестный параметр $option. Используйте --help." ;;
    esac
  done
  check_platform
  check_dependencies
  [[ -z "$PUBLIC_HOST" ]] || validate_host "$PUBLIC_HOST"
  [[ -z "$PUBLIC_PORT" ]] || validate_port "$PUBLIC_PORT"
  [[ -z "$PROJECT_NAME" ]] || validate_project "$PROJECT_NAME"
  if [[ -z "$INSTALL_ROOT" ]]; then
    if [[ -n "$script_root" && -f "$script_root/deploy/compose.yaml" ]]; then INSTALL_ROOT=$script_root; else INSTALL_ROOT="$HOME/OpenStrudel-Home"; fi
  fi
  INSTALL_ROOT=$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).expanduser().resolve())' "$INSTALL_ROOT")
  ensure_docker
  trap '[[ -z "${STAGING_DIR:-}" ]] || rm -rf "$STAGING_DIR"' EXIT
  take_lock
  prepare_release
  configure
  assert_project_available
  if [[ "$HAD_ENV" == false ]]; then
    (umask 077; set -o noclobber; printf 'OPENSTRUDEL_PUBLIC_HOST=%s\nOPENSTRUDEL_PUBLIC_PORT=%s\nCOMPOSE_PROJECT_NAME=%s\nTZ=UTC\n' "$PUBLIC_HOST" "$PUBLIC_PORT" "$PROJECT_NAME" > "$ENV_FILE")
  fi
  load_apparmor
  say "Запускаем OpenStrudel: $PUBLIC_HOST:$PUBLIC_PORT. Первая сборка займёт несколько минут…"
  if ! compose up -d --build || ! wait_ready; then
    fail "Не удалось запустить защищённый сервер. Данные сохранены. Диагностика: cd '$INSTALL_ROOT' && docker compose --project-directory deploy -f deploy/compose.yaml logs --tail 30. Не отключайте sandbox."
  fi
  say 'Сервер готов. Откройте приглашение в OpenStrudel, затем войдите в OpenAI. API-ключ не нужен.'
  compose exec -T home node /opt/openstrudel/dist/cli.js pair
  say "Доступ из интернета требует открытого TCP-порта $PUBLIC_PORT. Установщик не меняет firewall. Для нового приглашения повторите эту команду."
}

if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
