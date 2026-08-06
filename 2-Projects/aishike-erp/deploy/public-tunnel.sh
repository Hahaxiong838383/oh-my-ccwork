#!/usr/bin/env bash
set -euo pipefail

deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$deploy_dir"

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

key_file="${PUBLIC_TUNNEL_KEY_FILE:-$deploy_dir/secrets/public_tunnel_ed25519}"
known_hosts_file="${PUBLIC_TUNNEL_KNOWN_HOSTS_FILE:-$deploy_dir/secrets/public_tunnel_known_hosts}"
remote_host="${PUBLIC_TUNNEL_HOST:-cli4.hahaxiong.cc}"
remote_user="${PUBLIC_TUNNEL_USER:-aishike-tunnel}"
remote_ssh_port="${PUBLIC_TUNNEL_SSH_PORT:-22}"
remote_port="${PUBLIC_TUNNEL_REMOTE_PORT:-13281}"
local_port="${HTTP_PUBLISH_PORT:-18080}"

if [[ ! -s "$key_file" ]]; then
  echo "公网隧道私钥不存在: $key_file" >&2
  exit 1
fi
if [[ ! -s "$known_hosts_file" ]]; then
  echo "公网隧道 known_hosts 不存在: $known_hosts_file" >&2
  exit 1
fi
if ! curl -fsS --max-time 5 "http://127.0.0.1:${local_port}/api/method/ping" >/dev/null; then
  echo "ERP 本地入口不可用: 127.0.0.1:${local_port}" >&2
  exit 1
fi

exec ssh \
  -N \
  -T \
  -p "$remote_ssh_port" \
  -i "$key_file" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$known_hosts_file" \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o TCPKeepAlive=yes \
  -R "127.0.0.1:${remote_port}:127.0.0.1:${local_port}" \
  "${remote_user}@${remote_host}"
