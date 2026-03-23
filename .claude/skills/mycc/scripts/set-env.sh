#!/bin/bash
# mycc 环境变量配置脚本
# 用于 Claude Code 会话中设置正确的 PATH

# 加载 nvm
export NVM_DIR="$HOME/.nvm"
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

# 验证
echo "=== mycc 环境变量已配置 ==="
echo "NODE: $(which node 2>/dev/null || echo 'not found')"
echo "NPM: $(which npm 2>/dev/null || echo 'not found')"
echo "CODEX: $(which codex 2>/dev/null || echo 'not found')"
echo "GEMINI: $(which gemini 2>/dev/null || echo 'not found')"
