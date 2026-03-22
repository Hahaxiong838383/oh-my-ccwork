#!/bin/bash
# cc-remote v3 — ttyd + Relay Tunnel 启动脚本
#
# 用法:
#   ./start.sh                # ttyd 本地访问 (localhost:7681)
#   ./start.sh --tunnel       # ttyd + Relay 隧道（公网访问）
#   ./start.sh --tunnel --bg  # 后台运行

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-7681}"
RELAY_URL="${RELAY_URL:-https://relay.hahaxiong.cc}"
DEVICE_ID="${DEVICE_ID:-cc-v3-$(hostname)}"

# 检查 ttyd
if ! command -v ttyd &>/dev/null; then
  echo "[cc-remote-v3] 安装 ttyd..."
  if command -v brew &>/dev/null; then
    brew install ttyd
  elif command -v apt-get &>/dev/null; then
    sudo apt-get install -y ttyd
  else
    echo "[cc-remote-v3] 请手动安装 ttyd: https://github.com/tsl0922/ttyd"
    exit 1
  fi
fi

# 检查 node_modules (tunnel-client 需要 ws)
if [ ! -d "node_modules" ]; then
  echo "[cc-remote-v3] 安装依赖..."
  npm install
fi

# 清理旧进程
lsof -i :$PORT -t 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "tunnel-client.js" 2>/dev/null || true
sleep 1

TUNNEL=false
BG=false
for arg in "$@"; do
  case $arg in
    --tunnel) TUNNEL=true ;;
    --bg)     BG=true ;;
  esac
done

echo "[cc-remote-v3] 启动 ttyd on port $PORT"

# ttyd 启动参数：
#   -W        允许写入（客户端可输入）
#   -p PORT   监听端口
#   -t fontSize=14  字体大小
#   -t fontFamily='...'  字体（支持 Nerd Font）
#   bash -lc  用 login shell 确保完整 PATH
#   tmux new-session -A -s main  持久化 session
ttyd -W -p $PORT \
  -t fontSize=14 \
  -t "fontFamily='JetBrainsMono Nerd Font','JetBrains Mono',Menlo,Monaco,'Courier New',monospace" \
  bash -lc 'unset CLAUDECODE; exec tmux new-session -A -s main' &
TTYD_PID=$!
sleep 2

if ! kill -0 $TTYD_PID 2>/dev/null; then
  echo "[cc-remote-v3] ttyd 启动失败"
  exit 1
fi

echo "[cc-remote-v3] ttyd 运行中 (PID=$TTYD_PID)"
echo "[cc-remote-v3] 本地访问: http://localhost:$PORT"

if [ "$TUNNEL" = true ]; then
  echo "[cc-remote-v3] 启动 Relay 隧道 → $RELAY_URL"

  RELAY_URL=$RELAY_URL DEVICE_ID=$DEVICE_ID PORT=$PORT nohup node tunnel-client.js > /tmp/cc-v3-tunnel.log 2>&1 &
  TUNNEL_PID=$!
  sleep 3

  echo "[cc-remote-v3] Tunnel 运行中 (PID=$TUNNEL_PID)"
  cat /tmp/cc-v3-tunnel.log

  echo "$TTYD_PID $TUNNEL_PID" > /tmp/cc-remote-v3.pids
  echo "[cc-remote-v3] 停止: kill \$(cat /tmp/cc-remote-v3.pids)"

  if [ "$BG" = false ]; then
    # 前台等待，Ctrl-C 退出
    trap "kill $TTYD_PID $TUNNEL_PID 2>/dev/null; exit 0" INT TERM
    wait $TTYD_PID
  fi
else
  if [ "$BG" = false ]; then
    trap "kill $TTYD_PID 2>/dev/null; exit 0" INT TERM
    wait $TTYD_PID
  fi
fi
