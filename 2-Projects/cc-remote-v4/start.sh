#!/bin/bash
# cc-remote V4 启动脚本
# V0 底座（tmux + ttyd + Caddy）+ FRP 阿里云香港中转
# 修复：CJK 中文显示 + 手机端触摸体验

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# 配置
PASSWORD="${CC_REMOTE_PASSWORD:?请设置环境变量 CC_REMOTE_PASSWORD}"
PROJECT_DIR="${CC_REMOTE_CWD:-/Users/rayman.chen/mycc}"

echo "=== cc-remote V4 启动 ==="

# 停掉旧进程（保留 tmux session！）
echo "清理旧进程（保留 tmux session）..."
pkill -f "ttyd -p 190" 2>/dev/null || true
pkill -f "caddy run.*cc-remote" 2>/dev/null || true
pkill -f "frpc.*cc-remote-v4" 2>/dev/null || true
sleep 1

# ============ tmux 持久化 Session ============
ensure_tmux_session() {
  local name=$1
  local cmd=$2
  if tmux has-session -t "cc-$name" 2>/dev/null; then
    echo "  ♻ cc-$name tmux session 已存在（复用）"
  else
    # 先创建纯 shell session，再在里面启动 CLI（防止 CLI 退出导致 session 消失）
    tmux new-session -d -s "cc-$name" -c "$PROJECT_DIR"
    tmux send-keys -t "cc-$name" "$cmd" Enter
    echo "  ✓ cc-$name tmux session 已创建"
  fi
}

echo "确保 tmux session..."
command -v claude &>/dev/null && ensure_tmux_session "claude" "claude"
command -v codex &>/dev/null && ensure_tmux_session "codex" "codex"
command -v gemini &>/dev/null && ensure_tmux_session "gemini" "gemini"

# ============ ttyd 连接 tmux（CJK 字体已修复） ============
echo "启动 ttyd 实例..."
tmux has-session -t "cc-claude" 2>/dev/null && { "$DIR/ttyd-wrapper.sh" 19001 /claude cc-claude & echo "  ✓ claude → :19001"; }
tmux has-session -t "cc-codex" 2>/dev/null && { "$DIR/ttyd-wrapper.sh" 19002 /codex cc-codex & echo "  ✓ codex → :19002"; }
tmux has-session -t "cc-gemini" 2>/dev/null && { "$DIR/ttyd-wrapper.sh" 19003 /gemini cc-gemini & echo "  ✓ gemini → :19003"; }
sleep 1

# ============ 按键注入 API ============
echo "启动 API..."
python3 "$DIR/api.py" &
echo "  ✓ API → :19100"

# ============ Caddy 反代 + 认证 ============
echo "启动 Caddy 反代..."
HASH=$(caddy hash-password --plaintext "$PASSWORD")
sed "s|HASH_PLACEHOLDER|$HASH|g" Caddyfile > /tmp/cc-remote-v4-Caddyfile
caddy run --config /tmp/cc-remote-v4-Caddyfile --adapter caddyfile &
echo "  ✓ Caddy → :19443"
sleep 1

# ============ FRP 隧道（阿里云香港中转） ============
echo "启动 FRP 隧道..."
# 查找 frpc 二进制：优先本目录，其次 V3 目录，最后系统 PATH
FRPC=""
if [ -f "$DIR/frpc" ]; then
  FRPC="$DIR/frpc"
elif [ -f "$DIR/../cc-remote-v3/frpc" ]; then
  FRPC="$DIR/../cc-remote-v3/frpc"
elif command -v frpc &>/dev/null; then
  FRPC="frpc"
fi

if [ -z "$FRPC" ]; then
  echo "  ✗ frpc 未找到！请下载 frpc 放到 $DIR/"
  echo "    brew install frpc 或从 https://github.com/fatedier/frp/releases 下载"
else
  HTTP_PROXY="" HTTPS_PROXY="" ALL_PROXY="" NO_PROXY="*" \
    "$FRPC" -c "$DIR/frpc.toml" &
  echo "  ✓ frpc → 阿里云香港:7000 (阿里云香港)"
fi

sleep 2

echo ""
echo "========== cc-remote V4 就绪 =========="
echo "  管理面板: https://cli4.hahaxiong.cc/"
echo "  Claude:   https://cli4.hahaxiong.cc/claude/"
echo "  Codex:    https://cli4.hahaxiong.cc/codex/"
echo "  Gemini:   https://cli4.hahaxiong.cc/gemini/"
echo ""
echo "  用户名: admin"
echo "  密码: (CC_REMOTE_PASSWORD)"
echo ""
echo "  中转: 阿里云香港 阿里云香港（FRP）"
echo "  tmux session: cc-claude, cc-codex, cc-gemini"
echo "  关浏览器后 CLI 继续运行，重新打开自动恢复"
echo "========================================="
echo ""
echo "按 Ctrl+C 停止 Web 服务（tmux session 保留）"

# 启动 watchdog 进程守护
"$DIR/watchdog.sh" &

wait
