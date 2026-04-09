#!/bin/bash
# run_semantic_vision.sh — 启动语义视觉 daemon（Qwen2-VL 2B / MLX）

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRAIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MONO_ROOT="$(cd "$BRAIN_ROOT/../../.." && pwd)"
DAEMON="$SCRIPT_DIR/semantic_vision_daemon.py"

find_semantic_python() {
  local candidates=()

  if [ -n "${VISION_SEMANTIC_PYTHON:-}" ]; then
    candidates+=("$VISION_SEMANTIC_PYTHON")
  fi

  candidates+=(
    "$SCRIPT_DIR/.venv-vision/bin/python3"
    "$MONO_ROOT/2-Projects/cc-eye/.venv/bin/python"
    "$HOME/mlx-server-env/bin/python3"
    "$(command -v python3 2>/dev/null || true)"
  )

  local py
  for py in "${candidates[@]}"; do
    [ -n "$py" ] || continue
    [ -x "$py" ] || continue
    if "$py" - <<'PY' >/dev/null 2>&1
try:
    import mlx_vlm  # noqa: F401
except Exception:
    raise SystemExit(1)
raise SystemExit(0)
PY
    then
      echo "$py"
      return 0
    fi
  done

  return 1
}

SEMANTIC_PYTHON="$(find_semantic_python || true)"

if [ ! -x "$SEMANTIC_PYTHON" ]; then
  echo "ERROR: 找不到可用的 semantic vision Python: $SEMANTIC_PYTHON"
  echo "可通过 VISION_SEMANTIC_PYTHON 指向带 mlx_vlm 的解释器。"
  exit 1
fi

if [ "${1:-}" = "--pm2" ]; then
  shift
  echo "以 PM2 启动 semantic vision daemon..."
  pm2 start "$DAEMON" \
    --interpreter "$SEMANTIC_PYTHON" \
    --name "semantic-vision-daemon" \
    --cwd "$BRAIN_ROOT" \
    -- \
    --data-dir "$BRAIN_ROOT/data/activity" \
    "$@"
  pm2 save
  echo "PM2 启动完成。查看日志: pm2 logs semantic-vision-daemon"
else
  echo "前台启动 semantic vision daemon..."
  exec "$SEMANTIC_PYTHON" "$DAEMON" \
    --data-dir "$BRAIN_ROOT/data/activity" \
    "$@"
fi
