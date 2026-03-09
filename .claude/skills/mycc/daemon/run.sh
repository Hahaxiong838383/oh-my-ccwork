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

CWD="/Users/rayman.chen/mycc"
SCRIPTS_DIR="$CWD/.claude/skills/mycc/scripts"
LOG="$CWD/.claude/skills/mycc/daemon.log"
TSX="$SCRIPTS_DIR/node_modules/.bin/tsx"

# 日志超 10MB 截断（保留最后 1MB）
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 10485760 ]; then
  tail -c 1048576 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

cd "$CWD" || exit 1
exec "$TSX" "$SCRIPTS_DIR/src/index.ts" start >> "$LOG" 2>&1
