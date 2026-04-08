#!/bin/bash
# run_vision.sh — 启动 vision daemon（直接运行或 PM2）
#
# 用法:
#   bash tools/vision/run_vision.sh          # 前台运行
#   bash tools/vision/run_vision.sh --pm2    # PM2 托管

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRAIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv-vision"
VPYTHON="$VENV_DIR/bin/python3"
DAEMON="$SCRIPT_DIR/vision_daemon.py"

if [ ! -f "$VPYTHON" ]; then
  echo "ERROR: venv 不存在。请先运行 setup_studio.sh"
  exit 1
fi

if [ "$1" = "--pm2" ]; then
  echo "以 PM2 启动 vision daemon..."
  pm2 start "$VPYTHON" \
    --name "vision-daemon" \
    --cwd "$BRAIN_ROOT" \
    -- "$DAEMON" \
    --data-dir "$BRAIN_ROOT/data/activity" \
    --debug
  pm2 save
  echo "PM2 启动完成。查看日志: pm2 logs vision-daemon"
else
  echo "前台启动 vision daemon..."
  exec "$VPYTHON" "$DAEMON" \
    --data-dir "$BRAIN_ROOT/data/activity" \
    --debug \
    "$@"
fi
