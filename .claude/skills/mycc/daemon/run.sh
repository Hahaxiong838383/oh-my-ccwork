#!/bin/bash
set -e

# 设置 PATH：nvm node + homebrew + user bin + 系统 bin
export NVM_DIR="$HOME/.nvm"

# 加载 nvm（如果存在）
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh" --no-use
fi

# 找最新的 nvm node 版本加入 PATH
if [ -d "$NVM_DIR/versions/node" ]; then
  LATEST_NODE=$(ls "$NVM_DIR/versions/node" | sort -V | tail -1)
  [ -n "$LATEST_NODE" ] && export PATH="$NVM_DIR/versions/node/$LATEST_NODE/bin:$PATH"
fi

# 添加 user bin（claude 在这里）
export PATH="$HOME/.local/bin:$PATH"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# 代理设置：确保 SDK 子进程通过 xray 代理访问 Anthropic API
# 不设置会导致直连 api.anthropic.com → 403 forbidden
export http_proxy="http://127.0.0.1:10808"
export https_proxy="http://127.0.0.1:10808"
export HTTP_PROXY="http://127.0.0.1:10808"
export HTTPS_PROXY="http://127.0.0.1:10808"
export ALL_PROXY="socks5://127.0.0.1:10808"

CWD="/Users/rayman.chen/mycc"
SCRIPTS_DIR="$CWD/.claude/skills/mycc/scripts"
LOG="$CWD/.claude/skills/mycc/daemon.log"
TSX="$SCRIPTS_DIR/node_modules/.bin/tsx"

# 日志超 10MB 截断（保留最后 1MB）
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 10485760 ]; then
  tail -c 1048576 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

cd "$CWD" || exit 1

# === 端口互斥：防止多实例 ===
PORT=18080
EXISTING_PID=$(lsof -i :$PORT -t 2>/dev/null | head -1)
if [ -n "$EXISTING_PID" ]; then
  # 检查是否是 mycc 后端进程（而不是其他服务占端口）
  EXISTING_CMD=$(ps -p "$EXISTING_PID" -o command= 2>/dev/null || true)
  if echo "$EXISTING_CMD" | grep -q "index.ts"; then
    echo "[$(date)] 端口 $PORT 已被 mycc 后端占用 (PID $EXISTING_PID)，跳过启动" >> "$LOG"
    # 退出码 0，让 launchd 不要立即重试（ThrottleInterval 生效）
    sleep 30
    exit 0
  fi
fi

exec "$TSX" "$SCRIPTS_DIR/src/index.ts" start >> "$LOG" 2>&1
