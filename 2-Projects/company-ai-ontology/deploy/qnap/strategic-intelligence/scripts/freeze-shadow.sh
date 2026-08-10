#!/bin/sh
set -eu
exec </dev/null

reason=${1:-manual freeze}
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_root=$(CDPATH= cd -- "$script_root/.." && pwd)
. "$script_root/preflight-company-qnap.sh"
env_file=${SI_ENV_FILE:-$shadow_root/.env.shadow}
mkdir -p "$shadow_root"
umask 077
printf 'frozen_at=%s\nreason=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$reason" > "$shadow_root/FROZEN"
if [ -f "$env_file" ]; then
  "$docker_path" compose --env-file "$env_file" -f "$package_root/docker-compose.shadow.yml" stop intelligence-orchestrator >/dev/null 2>&1 || true
fi
printf 'strategic_intelligence_shadow=frozen\n'
