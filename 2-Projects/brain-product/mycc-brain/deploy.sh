#!/bin/bash
# mycc-brain 一键部署到 Studio
# 支持内网(studio)和公网(mini-pub→studio)两种路径
set -e

APP_DIR="/Users/fu-121/mycc-brain"
SSH_ENV="export PATH=/usr/local/bin:/opt/homebrew/bin:\$PATH"

# 检测网络：能直连 Studio 就走内网，否则走公网跳板
if ssh -o ConnectTimeout=3 -o BatchMode=yes studio true 2>/dev/null; then
  REMOTE="studio"
  echo "🏠 内网模式 (直连 Studio)"
else
  REMOTE="studio-pub"
  echo "🌐 公网模式 (经 Mini 跳板)"
  # 确保 ~/.ssh/config 有 studio-pub 条目：
  #   Host studio-pub
  #     ProxyJump mini-pub
  #     HostName 192.168.100.2
  #     User fu-121
fi

echo "📦 同步代码到 Studio..."
rsync -avz --exclude node_modules --exclude dist --exclude .env \
  ./ ${REMOTE}:${APP_DIR}/

echo "📥 安装依赖..."
ssh ${REMOTE} "${SSH_ENV} && cd ${APP_DIR} && npm install --ignore-scripts"

echo "📦 同步 native 模块（从 Air 预编译）..."
rsync -avz node_modules/better-sqlite3/ ${REMOTE}:${APP_DIR}/node_modules/better-sqlite3/

echo "🔨 构建..."
ssh ${REMOTE} "${SSH_ENV} && cd ${APP_DIR} && npx tsc && mkdir -p dist/admin && cp src/admin/*.html dist/admin/"

echo "🔄 启动/重启服务..."
ssh ${REMOTE} "${SSH_ENV} && cd ${APP_DIR} && npx pm2 delete brain 2>/dev/null; npx pm2 start dist/server.js --name brain --interpreter node && npx pm2 save"

echo "🔥 预热 Ollama 模型（后台）..."
ssh ${REMOTE} "curl -s http://localhost:11434/api/generate -d '{\"model\":\"gemma4:26b\",\"prompt\":\"hi\",\"stream\":false}' > /dev/null 2>&1 &"

echo ""
echo "✅ 部署完成!"
echo "   API:   http://10.9.1.155:19080/v1/chat/completions"
echo "   Admin: http://10.9.1.155:19080/admin"
echo ""
ssh ${REMOTE} "${SSH_ENV} && npx pm2 status brain"
