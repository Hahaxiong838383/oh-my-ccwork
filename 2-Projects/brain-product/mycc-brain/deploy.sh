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
NODE_BIN="${NODE_BIN:-$(command -v node || echo "$HOME/local/node/bin/node")}"
"$NODE_BIN" -e "
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

// 收集配置层文件内容预览（前 200 行）
snapshot.contentPreviews = {};
function addPreview(relPath) {
  try {
    const full = path.join(myccRoot, relPath);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return;
    const raw = fs.readFileSync(full, 'utf-8');
    const lines = raw.split('\\n');
    snapshot.contentPreviews[relPath] = lines.length > 200 ? lines.slice(0, 200).join('\\n') + '\\n... (截断，共 ' + lines.length + ' 行)' : raw;
  } catch {}
}
if (snapshot.claudeMd) addPreview('CLAUDE.md');
for (const item of snapshot.docs) { if (item.type === 'file') addPreview(item.path); }
for (const item of snapshot.multiAgent) { if (item.type === 'file') addPreview(item.path); }

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

echo "📦 同步代码到 Studio（精细排除运行时数据，避免覆盖 Studio 产生的最新数据）..."
# 关键原则：
# - 保留 Air 上的代码/模板文件（需要部署到 Studio）
# - 排除 Studio 运行时产生的数据（eval 结果、trust state、审计日志等）
# - 排除不该部署的临时文件（log、virtual env、.DS_Store）
#
# data/ 目录特殊情况：
#   - graph-config-snapshot.json  ← deploy.sh 前面刚生成，必须同步
#   - SOUL.md, constitutional.yaml ← 模板，首次部署时复制，之后不覆盖（--ignore-existing 单独处理）
#   - 其他全部排除（运行时数据）
# eval/ 目录特殊情况：
#   - baseline.tsv  ← 首次部署时复制，之后不覆盖
#   - 其他全部排除
rsync -avz \
  --exclude node_modules \
  --exclude dist \
  --exclude .env \
  --exclude .env.local \
  --exclude .git \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  --exclude 'tools/vision/.venv-vision' \
  --exclude 'data/activity' \
  --exclude 'data/experiences' \
  --exclude 'data/predictions' \
  --exclude 'data/session-archives' \
  --exclude 'data/skills' \
  --exclude 'data/evolution-tests' \
  --exclude 'data/evolution-log.jsonl' \
  --exclude 'data/evolution-actions.jsonl' \
  --exclude 'data/audit-log.jsonl' \
  --exclude 'data/trust-events.jsonl' \
  --exclude 'data/trust-state.json' \
  --exclude 'data/veto-state.json' \
  --exclude 'data/curiosity-state.json' \
  --exclude 'data/diagnosis-confidence.json' \
  --exclude 'data/admin-sessions.json' \
  --exclude 'data/last-stable-commit.txt' \
  --exclude 'data/rollback-target.txt' \
  --exclude 'data/status.json' \
  --exclude 'data/visual-memory-last.json' \
  --exclude 'data/latest.json' \
  --exclude 'data/latest.jpg' \
  --exclude 'data/eval-stderr.log' \
  --exclude 'data/eval-stdout.log' \
  --exclude 'data/eval-cron.log' \
  --exclude 'data/deploy-cron.log' \
  --exclude 'data/deploy.log' \
  --exclude 'data/health.log' \
  --exclude 'data/sync-cron.log' \
  --exclude 'data/sync.log' \
  --exclude 'data/2026-*.jsonl' \
  --exclude 'data/model-config-overrides.json' \
  --exclude 'eval/eval-result.json' \
  --exclude 'eval/eval-*.tsv' \
  --exclude 'eval/EVAL-REPORT.md' \
  ./ ${REMOTE}:${APP_DIR}/

# 确保必需目录存在（首次部署时 Studio 可能没有）
ssh ${REMOTE} "mkdir -p ${APP_DIR}/data ${APP_DIR}/eval"

# SOUL.md 和 constitutional.yaml 仅在 Studio 不存在时同步（不覆盖 Studio 上的运行时版本）
rsync -az --ignore-existing data/SOUL.md ${REMOTE}:${APP_DIR}/data/SOUL.md 2>/dev/null || true
rsync -az --ignore-existing data/constitutional.yaml ${REMOTE}:${APP_DIR}/data/constitutional.yaml 2>/dev/null || true
rsync -az --ignore-existing eval/baseline.tsv ${REMOTE}:${APP_DIR}/eval/baseline.tsv 2>/dev/null || true
# graph-config-snapshot.json 是 deploy.sh 每次生成的，必须同步（已经在上面的 rsync 中未被排除）

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
