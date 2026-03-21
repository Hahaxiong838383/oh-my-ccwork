#!/bin/bash
# cc-remote v3 — 一键启动脚本
#
# 用法:
#   ./start.sh                    # 仅启动本地服务（端口 7681）
#   ./start.sh --tunnel           # 启动本地服务 + Relay 隧道
#   ./start.sh --tunnel --bg      # 后台运行

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 默认配置
PORT="${PORT:-7681}"
RELAY_URL="${RELAY_URL:-https://relay.hahaxiong.cc}"
DEVICE_ID="${DEVICE_ID:-cc-v3-$(hostname)}"

# 检查依赖
if [ ! -d "node_modules" ]; then
  echo "[cc-remote-v3] 安装依赖..."
  npm install
fi

# 检查 tmux
if ! command -v tmux &>/dev/null; then
  echo "[cc-remote-v3] 错误: 需要安装 tmux"
  echo "  macOS:  brew install tmux"
  echo "  Linux:  apt install tmux / yum install tmux"
  exit 1
fi

# 解析参数
TUNNEL=false
BG=false
for arg in "$@"; do
  case $arg in
    --tunnel) TUNNEL=true ;;
    --bg)     BG=true ;;
  esac
done

echo "[cc-remote-v3] 启动本地服务 port=${PORT}"

if [ "$TUNNEL" = true ]; then
  echo "[cc-remote-v3] 启动 Relay 隧道 → ${RELAY_URL}"

  if [ "$BG" = true ]; then
    # 后台运行
    PORT=$PORT node server.js &
    SERVER_PID=$!
    sleep 1

    RELAY_URL=$RELAY_URL DEVICE_ID=$DEVICE_ID PORT=$PORT node tunnel-client.js &
    TUNNEL_PID=$!

    echo "[cc-remote-v3] 后台运行中 (server=$SERVER_PID, tunnel=$TUNNEL_PID)"
    echo "$SERVER_PID $TUNNEL_PID" > /tmp/cc-remote-v3.pids
    wait
  else
    # 前台运行（server 后台，tunnel 前台）
    PORT=$PORT node server.js &
    SERVER_PID=$!

    trap "kill $SERVER_PID 2>/dev/null" EXIT

    sleep 1
    RELAY_URL=$RELAY_URL DEVICE_ID=$DEVICE_ID PORT=$PORT node tunnel-client.js
  fi
else
  # 仅本地
  PORT=$PORT node server.js
fi
