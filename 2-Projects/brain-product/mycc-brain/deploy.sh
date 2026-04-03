#!/bin/bash
# mycc-brain 一键部署到 Studio
set -e

REMOTE="studio"
APP_DIR="/Users/fu-121/mycc-brain"
NODE="/usr/local/bin/node"
NPM="/usr/local/bin/npm"
NPX="/usr/local/bin/npx"

echo "📦 同步代码到 Studio..."
rsync -avz --exclude node_modules --exclude dist --exclude .env \
  ./ ${REMOTE}:${APP_DIR}/

echo "📥 安装依赖..."
ssh ${REMOTE} "cd ${APP_DIR} && ${NPM} install"

echo "🔨 构建..."
ssh ${REMOTE} "cd ${APP_DIR} && ${NPX} tsc && mkdir -p dist/admin && cp src/admin/*.html dist/admin/"

echo "🔄 启动/重启服务..."
ssh ${REMOTE} "cd ${APP_DIR} && ${NPX} pm2 delete brain 2>/dev/null; ${NPX} pm2 start dist/server.js --name brain --interpreter ${NODE} && ${NPX} pm2 save"

echo ""
echo "✅ 部署完成!"
echo "   API:   http://10.9.1.155:19080/v1/chat/completions"
echo "   Admin: http://10.9.1.155:19080/admin"
echo ""
ssh ${REMOTE} "${NPX} pm2 status brain"
