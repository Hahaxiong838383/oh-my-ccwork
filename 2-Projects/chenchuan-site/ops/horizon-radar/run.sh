#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${HORIZON_APP_DIR:-/opt/horizon-radar}"
HORIZON_PATH="${HORIZON_PATH:-$APP_DIR/vendor/Horizon}"
LOCK_FILE="${HORIZON_LOCK_FILE:-/run/lock/horizon-radar.lock}"
PYTHON_BIN="${HORIZON_PYTHON_BIN:-$HORIZON_PATH/.venv/bin/python}"

exec 9>"$LOCK_FILE"
flock -n 9 || { echo 'horizon-radar already running' >&2; exit 75; }

cd "$HORIZON_PATH"
[[ -x "$PYTHON_BIN" ]] || { echo "horizon python is not executable: $PYTHON_BIN" >&2; exit 70; }
exec "$PYTHON_BIN" "$APP_DIR/runner.py"
