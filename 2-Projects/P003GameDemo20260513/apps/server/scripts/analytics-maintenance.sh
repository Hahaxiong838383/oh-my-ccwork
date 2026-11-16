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
if [[ "$analytics_mode" == backup ]]; then
  # Backup API has its own lock; a long backup must not stall five-minute rollup.
  exec 9>./data/analytics-backup.lock
  if ! /usr/bin/flock -w 20 9; then
    echo '{"ok":false,"mode":"backup","skipped":true,"reason":"maintenance_lock_timeout"}'
    exit 1
  fi
else
  exec 9>./data/analytics-maintenance.lock
  if ! /usr/bin/flock -n 9; then
  echo '{"ok":true,"mode":"rollup","skipped":true,"reason":"maintenance_lock_busy"}'
  exit 0
  fi
fi
# Read only the runtime path; never source a protected env file as shell code.
analytics_node="${ANALYTICS_NODE_PATH:-}"
if [[ -z "$analytics_node" ]]; then
  analytics_node=$(/usr/bin/python3 - "$analytics_env_file" <<'PY_RUNTIME'
import json, sys
from pathlib import Path
runtime = '/opt/p003/server/.runtime/node-v24.19.0-linux-x64/bin/node'
for line in Path(sys.argv[1]).read_text().splitlines():
    key, separator, value = line.partition('=')
    if separator and key.strip() == 'ANALYTICS_NODE_PATH':
        runtime = json.loads(value.strip())
if not isinstance(runtime, str) or not runtime.startswith('/'):
    raise SystemExit('INVALID_ANALYTICS_NODE_PATH')
print(runtime)
PY_RUNTIME
)
fi
[[ "$analytics_node" == /* && -x "$analytics_node" ]] || { echo '{"ok":false,"reason":"analytics_runtime_unavailable"}'; exit 1; }
exec "$analytics_node" --max-old-space-size=256 --env-file="$analytics_env_file" ./scripts/analytics-maintenance.mjs "$analytics_mode"
