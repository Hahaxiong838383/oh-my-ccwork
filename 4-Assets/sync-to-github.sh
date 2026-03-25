#!/bin/bash
# ==============================================
# mycc 记忆 & 技能同步脚本
# 每日凌晨 3:00 由 cron 触发
# 来源：家里 NAS (hahafeiniu2)
# ==============================================

set -euo pipefail

REPO_DIR="/home/hahaxiong83/mycc"
LOG_FILE="$REPO_DIR/4-Assets/sync-to-github.log"
SOURCE_TAG="nas-home"
HOSTNAME=$(hostname)

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

cd "$REPO_DIR"

log "=== 开始同步 ==="

# 1. 拉取远端最新（避免冲突）
git pull --rebase origin main >> "$LOG_FILE" 2>&1 || {
  log "ERROR: git pull 失败，跳过本次同步"
  exit 1
}

# 2. 添加记忆文件
git add -f \
  0-System/MEMORY.md \
  0-System/RECENT_EVENTS.md \
  0-System/memory-items.md \
  0-System/context.md \
  0-System/status.md \
  0-System/task-log.md \
  0-System/about-me/ \
  0-System/chat-memory/ \
  2>/dev/null || true

# 3. 添加技能文件
git add -f \
  .claude/skills/ \
  2>/dev/null || true

# 4. 添加 CLAUDE.md（核心配置）
git add -f CLAUDE.md 2>/dev/null || true

# 5. 检查是否有变更
if git diff --cached --quiet; then
  log "无变更，跳过提交"
  log "=== 同步结束（无变更）==="
  exit 0
fi

# 6. 提交
TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
COMMIT_MSG="sync($SOURCE_TAG): 记忆&技能自动同步 from $HOSTNAME @ $TIMESTAMP"
git commit -m "$COMMIT_MSG" >> "$LOG_FILE" 2>&1

# 7. 打标签（每周一个，避免标签爆炸）
WEEK_TAG="$SOURCE_TAG/$(date '+%Y-W%V')"
if ! git tag -l "$WEEK_TAG" | grep -q .; then
  git tag -a "$WEEK_TAG" -m "Weekly sync from $HOSTNAME (NAS home)" >> "$LOG_FILE" 2>&1
  log "新建周标签: $WEEK_TAG"
fi

# 8. 推送（代码 + 标签）
git push origin main --tags >> "$LOG_FILE" 2>&1

log "=== 同步完成 ==="
