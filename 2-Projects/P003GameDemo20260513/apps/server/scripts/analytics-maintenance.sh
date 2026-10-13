#!/bin/bash
set -euo pipefail
analytics_server_root="${ANALYTICS_SERVER_ROOT:-/opt/p003/server}"
analytics_env_file="${ANALYTICS_ENV_FILE:-.env.analytics}"
analytics_mode="${1:-rollup}"
case "$analytics_mode" in
  rollup|backup) ;;
  *) echo '{"ok":false,"reason":"invalid_maintenance_mode"}'; exit 1 ;;
esac
cd "$analytics_server_root"
exec 9>./data/analytics-maintenance.lock
if [[ "$analytics_mode" == backup ]]; then
  # The service allows 120 seconds: wait at most 20, then Python backup at most 90.
  if ! /usr/bin/flock -w 20 9; then
    echo '{"ok":false,"mode":"backup","skipped":true,"reason":"maintenance_lock_timeout"}'
    exit 1
  fi
elif ! /usr/bin/flock -n 9; then
  echo '{"ok":true,"mode":"rollup","skipped":true,"reason":"maintenance_lock_busy"}'
  exit 0
fi
exec /usr/bin/node --max-old-space-size=256 --env-file="$analytics_env_file" ./scripts/analytics-maintenance.mjs "$analytics_mode"
