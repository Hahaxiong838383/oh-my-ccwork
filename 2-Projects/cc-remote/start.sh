#!/bin/bash
# cc-remote 启动脚本
# tmux 持久化 + ttyd Web 终端 + Caddy 认证反代 + Named Tunnel 公网穿透

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# 配置
PASSWORD="${CC_REMOTE_PASSWORD:-Hahaxiong83*#}"
CF_TUNNEL_TOKEN="${CF_TUNNEL_TOKEN:-eyJhIjoiMGFmZjQyZTVkMDA2ODExMzg3MGNlNWUwZmI0MzlkMGIiLCJ0IjoiZDMxYjdiZGItNjdiYi00MjQwLTlhOTItOThhNDM4ODU5NWFhIiwicyI6ImcxMUZNM1hlVkdiQ0w1WTJIc2FROGc5akI2ZEdaclJKTlI5NGVJWVoxTm89In0=}"
PROJECT_DIR="${CC_REMOTE_CWD:-/Users/rayman.chen/mycc}"

echo "=== cc-remote 启动 ==="

# 停掉旧的 ttyd/caddy/cloudflared（但保留 tmux session！）
echo "清理旧进程（保留 tmux session）..."
pkill -f "ttyd -p 700" 2>/dev/null || true
pkill -f "caddy run.*cc-remote" 2>/dev/null || true
pkill -f "cloudflared tunnel run" 2>/dev/null || true
sleep 1

# ============ tmux 持久化 Session ============
# 如果 tmux session 已存在 → 复用（关浏览器后 CLI 继续跑）
# 如果不存在 → 创建新的

ensure_tmux_session() {
  local name=$1
  local cmd=$2

  if tmux has-session -t "cc-$name" 2>/dev/null; then
    echo "  ♻ cc-$name tmux session 已存在（复用）"
  else
    tmux new-session -d -s "cc-$name" -c "$PROJECT_DIR" "$cmd"
    echo "  ✓ cc-$name tmux session 已创建"
  fi
}

echo "确保 tmux session..."

if command -v claude &>/dev/null; then
  ensure_tmux_session "claude" "claude"
fi

if command -v codex &>/dev/null; then
  ensure_tmux_session "codex" "codex"
fi

if command -v gemini &>/dev/null; then
  ensure_tmux_session "gemini" "gemini"
fi

# ============ ttyd 连接 tmux session ============
# ttyd 只是 Web 前端，连到已有的 tmux session
# 关浏览器 → ttyd 断开 → tmux 继续跑
# 重新打开 → ttyd 重连 → 恢复原来的会话

echo "启动 ttyd 实例（连接 tmux）..."

if tmux has-session -t "cc-claude" 2>/dev/null; then
  "$DIR/ttyd-wrapper.sh" 7001 /claude cc-claude &
  echo "  ✓ claude → :7001 (tmux: cc-claude)"
fi

if tmux has-session -t "cc-codex" 2>/dev/null; then
  "$DIR/ttyd-wrapper.sh" 7002 /codex cc-codex &
  echo "  ✓ codex → :7002 (tmux: cc-codex)"
fi

if tmux has-session -t "cc-gemini" 2>/dev/null; then
  "$DIR/ttyd-wrapper.sh" 7003 /gemini cc-gemini &
  echo "  ✓ gemini → :7003 (tmux: cc-gemini)"
fi

sleep 1

# ============ 按键注入 API ============
echo "启动按键注入 API..."
python3 "$DIR/api.py" &
echo "  ✓ API → :7100"

# ============ Caddy 反代 + 认证 ============
echo "启动 Caddy 反代..."
HASH=$(caddy hash-password --plaintext "$PASSWORD")
sed "s|HASH_PLACEHOLDER|$HASH|g" Caddyfile > /tmp/cc-remote-Caddyfile
caddy run --config /tmp/cc-remote-Caddyfile --adapter caddyfile &
echo "  ✓ Caddy → :8443"

sleep 1

# ============ Named Tunnel ============
echo "启动 Named Tunnel..."
HTTP_PROXY="" HTTPS_PROXY="" ALL_PROXY="" NO_PROXY="*" \
  cloudflared tunnel run --token "$CF_TUNNEL_TOKEN" &
echo "  ✓ cloudflared → cli.hahaxiong.top"

sleep 3

echo ""
echo "========== cc-remote 就绪 =========="
echo "  管理面板: https://cli.hahaxiong.top/"
echo "  Claude:   https://cli.hahaxiong.top/claude/"
echo "  Codex:    https://cli.hahaxiong.top/codex/"
echo "  Gemini:   https://cli.hahaxiong.top/gemini/"
echo ""
echo "  用户名: admin"
echo "  密码: (CC_REMOTE_PASSWORD)"
echo ""
echo "  tmux session: cc-claude, cc-codex, cc-gemini"
echo "  关浏览器后 CLI 继续运行，重新打开自动恢复"
echo "====================================="
echo ""
echo "按 Ctrl+C 停止 Web 服务（tmux session 保留）"

# 启动 watchdog 进程守护
"$DIR/watchdog.sh" &

wait
