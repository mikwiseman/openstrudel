#!/bin/sh
set -eu
if ! docker network inspect wolf-packages >/dev/null 2>&1; then
  docker network create --driver bridge --opt com.docker.network.bridge.name=br-wolfpkg --opt com.docker.network.bridge.enable_icc=false wolf-packages >/dev/null
fi
test "$(docker network inspect --format '{{index .Options "com.docker.network.bridge.name"}}' wolf-packages)" = br-wolfpkg
{
  if nft list table inet wolf_packages >/dev/null 2>&1; then echo 'delete table inet wolf_packages'; fi
  cat <<'RULES'
table inet wolf_packages {
  chain input {
    type filter hook input priority -10; policy accept;
    iifname "br-wolfpkg" drop
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname "br-wolfpkg" meta nfproto ipv6 drop
    iifname "br-wolfpkg" ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4 } drop
    iifname "br-wolfpkg" tcp dport { 53, 80, 443 } accept
    iifname "br-wolfpkg" udp dport 53 accept
    iifname "br-wolfpkg" drop
  }
}
RULES
} | nft -f -
