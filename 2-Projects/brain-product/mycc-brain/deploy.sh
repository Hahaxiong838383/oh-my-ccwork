#!/bin/bash
# mycc-brain 一键部署到 Studio
set -e

REMOTE="studio"
APP_DIR="/Users/fu-121/mycc-brain"
# SSH 非登录 shell 的 PATH 不含 /usr/local/bin，需要显式设置
SSH_ENV="export PATH=/usr/local/bin:/opt/homebrew/bin:\$PATH"

echo "📦 同步代码到 Studio..."
rsync -avz --exclude node_modules --exclude dist --exclude .env \
  ./ ${REMOTE}:${APP_DIR}/

echo "📥 安装依赖..."
ssh ${REMOTE} "${SSH_ENV} && cd ${APP_DIR} && npm install"

echo "🔨 构建..."
ssh ${REMOTE} "${SSH_ENV} && cd ${APP_DIR} && npx tsc && mkdir -p dist/admin && cp src/admin/*.html dist/admin/"

echo "🔄 启动/重启服务..."
ssh ${REMOTE} "${SSH_ENV} && cd ${APP_DIR} && npx pm2 delete brain 2>/dev/null; npx pm2 start dist/server.js --name brain --interpreter node && npx pm2 save"

echo ""
echo "✅ 部署完成!"
echo "   API:   http://10.9.1.155:19080/v1/chat/completions"
echo "   Admin: http://10.9.1.155:19080/admin"
echo ""
ssh ${REMOTE} "${SSH_ENV} && npx pm2 status brain"
