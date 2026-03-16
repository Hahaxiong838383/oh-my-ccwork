#!/bin/bash
# cc-remote watchdog — 监控 tmux session + ttyd/caddy/api 进程
# 每 30 秒检查一次，崩溃自动重启

DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${CC_REMOTE_CWD:-/Users/rayman.chen/mycc}"

# 确保 tmux session 存在，不存在则重建
ensure_tmux() {
  local name=$1 cmd=$2
  if ! tmux has-session -t "$name" 2>/dev/null; then
    echo "[watchdog] $(date '+%H:%M:%S') tmux $name 丢失，重建..."
    tmux new-session -d -s "$name" -c "$PROJECT_DIR" "$cmd"
    echo "[watchdog] $(date '+%H:%M:%S') tmux $name 已重建"
  fi
}

# 确保端口在线，不在线则重启
ensure_port() {
  local name=$1 port=$2 restart_cmd=$3
  if ! lsof -i :"$port" -t &>/dev/null; then
    echo "[watchdog] $(date '+%H:%M:%S') $name 端口 $port 不在线，重启..."
    eval "$restart_cmd"
    sleep 2
  fi
}

echo "[watchdog] 启动监控（每 30 秒检查）"

while true; do
  # 1. 确保 tmux session 存在（最关键）
  command -v claude &>/dev/null && ensure_tmux "cc-claude" "claude"
  command -v codex &>/dev/null && ensure_tmux "cc-codex" "codex"
  command -v gemini &>/dev/null && ensure_tmux "cc-gemini" "gemini"

  # 2. 确保 ttyd 在线
  ensure_port "ttyd-claude" 7001 "'$DIR/ttyd-wrapper.sh' 7001 /claude cc-claude &"
  ensure_port "ttyd-codex" 7002 "'$DIR/ttyd-wrapper.sh' 7002 /codex cc-codex &"
  ensure_port "ttyd-gemini" 7003 "'$DIR/ttyd-wrapper.sh' 7003 /gemini cc-gemini &"

  # 3. 确保 API 在线
  ensure_port "api" 7100 "python3 '$DIR/api.py' &"

  # 4. 确保 Caddy 在线
  ensure_port "caddy" 8443 "caddy run --config /tmp/cc-remote-Caddyfile --adapter caddyfile &"

  # 5. 日志轮转
  bash "$DIR/logrotate.sh" 2>/dev/null

  sleep 30
done
