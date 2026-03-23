#!/bin/bash
# cc-remote watchdog — 简化版，不用关联数组
# 每 30 秒检查 tmux session + ttyd + api + caddy

DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${CC_REMOTE_CWD:-/Users/rayman.chen/mycc}"

echo "[watchdog] 启动监控（每 30 秒检查）"

while true; do
  # 1. 确保 tmux session 存在
  for cli in claude codex gemini; do
    if command -v "$cli" &>/dev/null && ! tmux has-session -t "cc-$cli" 2>/dev/null; then
      echo "[watchdog] $(date '+%H:%M:%S') tmux cc-$cli 丢失，重建..."
      tmux new-session -d -s "cc-$cli" -c "$PROJECT_DIR" "$cli"
    fi
  done

  # 2. 确保 ttyd 在线（检测端口 + tmux 连接是否有效）
  for pair in "19001:claude" "19002:codex" "19003:gemini"; do
    port="${pair%%:*}"
    cli="${pair##*:}"
    session="cc-$cli"
    base="/$cli"

    if ! lsof -i :"$port" -t &>/dev/null; then
      echo "[watchdog] $(date '+%H:%M:%S') ttyd-$cli 端口 $port 不在线，重启..."
      "$DIR/ttyd-wrapper.sh" "$port" "$base" "$session" &
      sleep 2
    fi
  done

  # 3. 确保 API 在线
  if ! lsof -i :19100 -t &>/dev/null; then
    echo "[watchdog] $(date '+%H:%M:%S') API 端口 19100 不在线，重启..."
    python3 "$DIR/api.py" &
    sleep 2
  fi

  # 4. 确保 Caddy 在线
  if ! lsof -i :19443 -t &>/dev/null; then
    echo "[watchdog] $(date '+%H:%M:%S') Caddy 端口 19443 不在线，重启..."
    caddy run --config /tmp/cc-remote-v4-Caddyfile --adapter caddyfile &
    sleep 2
  fi

  # 5. 日志轮转
  bash "$DIR/logrotate.sh" 2>/dev/null

  sleep 30
done
