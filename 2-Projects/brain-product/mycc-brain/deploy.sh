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

# 同步规则文件（单一真相源 → brain 副本）
if [ -f "../../docs/memory-rules.md" ]; then
  cp ../../docs/memory-rules.md docs/memory-rules.md
  echo "📋 同步 memory-rules.md"
fi

echo "📊 生成配置层图谱快照..."
MYCC_ROOT="$(cd ../../.. && pwd)"
mkdir -p data
node -e "
const fs = require('fs');
const path = require('path');
const myccRoot = '${MYCC_ROOT}';

function scanDir(dir, depth, maxDepth) {
  const result = [];
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
    const relPath = path.relative(myccRoot, path.join(dir, entry.name));
    if (entry.isDirectory()) {
      result.push({ path: relPath, type: 'dir' });
      if (depth < maxDepth) result.push(...scanDir(path.join(dir, entry.name), depth + 1, maxDepth));
    } else if (/\.(md|json|sh|mjs)$/.test(entry.name)) {
      result.push({ path: relPath, type: 'file' });
    }
  }
  return result;
}

const snapshot = {
  generatedAt: new Date().toISOString(),
  claudeMd: fs.existsSync(path.join(myccRoot, 'CLAUDE.md')),
  docs: [{path:'docs',type:'dir'}, ...scanDir(path.join(myccRoot, 'docs'), 0, 1)],
  skills: fs.existsSync(path.join(myccRoot, '.claude/skills'))
    ? fs.readdirSync(path.join(myccRoot, '.claude/skills'), { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name)
    : [],
  multiAgent: [{path:'multi-agent',type:'dir'}, ...scanDir(path.join(myccRoot, 'multi-agent'), 0, 1)],
  references: {},
};

// 解析 CLAUDE.md 引用链
if (snapshot.claudeMd) {
  const content = fs.readFileSync(path.join(myccRoot, 'CLAUDE.md'), 'utf-8');
  snapshot.references['CLAUDE.md'] = [...content.matchAll(/\[.*?\]\(\.?\\/?([\w\\/.-]+\\.md)\)/g)].map(m => m[1]);
}

// 解析 docs/*.md 引用
for (const item of snapshot.docs) {
  if (item.type === 'file' && item.path.endsWith('.md')) {
    try {
      const content = fs.readFileSync(path.join(myccRoot, item.path), 'utf-8');
      const refs = [...content.matchAll(/\[.*?\]\(\.?\\/?([\w\\/.-]+\\.md)\)/g)].map(m => m[1]);
      if (refs.length > 0) snapshot.references[item.path] = refs;
    } catch {}
  }
}

fs.writeFileSync('data/graph-config-snapshot.json', JSON.stringify(snapshot, null, 2));
console.log('快照完成: docs=' + snapshot.docs.length + ' skills=' + snapshot.skills.length + ' multiAgent=' + snapshot.multiAgent.length);
" || echo "⚠️  快照生成失败，图谱将缺少配置层数据"

echo "📦 同步代码到 Studio..."
rsync -avz --exclude node_modules --exclude dist --exclude .env \
  ./ ${REMOTE}:${APP_DIR}/

echo "📥 安装依赖..."
ssh ${REMOTE} "${SSH_ENV} && cd ${APP_DIR} && npm install --ignore-scripts"

echo "📦 同步 native 模块（从 Air 预编译）..."
rsync -avz node_modules/better-sqlite3/ ${REMOTE}:${APP_DIR}/node_modules/better-sqlite3/

echo "🔨 构建..."
ssh ${REMOTE} "${SSH_ENV} && cd ${APP_DIR} && npx tsc && mkdir -p dist/admin"

echo "📄 推送最新 HTML（Air 本地 → Studio dist，确保不被 rsync 旧版覆盖）..."
cat src/admin/admin-ui.html | ssh ${REMOTE} "cat > ${APP_DIR}/dist/admin/admin-ui.html"

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
