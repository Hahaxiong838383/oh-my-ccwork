#!/usr/bin/env bash
set -euo pipefail

deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$deploy_dir"

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

public_domain="${PUBLIC_DOMAIN:-erp.hahaxiong.cc}"
runtime_dir="$deploy_dir/runtime"
pid_file="$runtime_dir/public-tunnel-supervisor.pid"

if [[ ! -s "$pid_file" ]]; then
  echo "公网隧道 supervisor PID 不存在。" >&2
  exit 1
fi

supervisor_pid="$(cat "$pid_file")"
supervisor_command="$(ps -p "$supervisor_pid" -o command= 2>/dev/null || true)"
if [[ "$supervisor_command" != *"public-tunnel-supervisor.sh"* ]]; then
  echo "公网隧道 supervisor PID 不匹配。" >&2
  exit 1
fi

ping_response="$(curl -fsS --max-time 15 "https://${public_domain}/api/method/ping")"
if [[ "$ping_response" != *'"message":"pong"'* ]]; then
  echo "公网 ERP ping 返回异常。" >&2
  exit 1
fi

login_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
  "https://${public_domain}/login")"
if [[ "$login_status" != "200" ]]; then
  echo "公网 ERP 登录页状态异常: $login_status" >&2
  exit 1
fi

printf '{"status":"ok","domain":"%s","supervisor_pid":%s,"login_status":%s}\n' \
  "$public_domain" "$supervisor_pid" "$login_status"
