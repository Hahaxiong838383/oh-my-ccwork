#!/bin/bash
# ==============================================
# mycc 从 GitHub 拉取最新代码（记忆/技能/配置）
# 每小时执行一次，确保 NAS 始终有最新版本
# ==============================================

REPO_DIR="/home/hahaxiong83/mycc"
LOG_FILE="$REPO_DIR/4-Assets/pull-from-github.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

cd "$REPO_DIR"

# 清理残留 rebase
git rebase --abort 2>/dev/null || true

# stash 本地未提交的修改
STASHED=false
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  git stash >> "$LOG_FILE" 2>&1 && STASHED=true
fi

# 拉取最新代码
BEFORE=$(git rev-parse HEAD 2>/dev/null)
git pull --rebase origin main >> "$LOG_FILE" 2>&1 || {
  git rebase --skip >> "$LOG_FILE" 2>&1 || git rebase --abort >> "$LOG_FILE" 2>&1 || true
  log "WARN: pull 冲突已自动处理"
}
AFTER=$(git rev-parse HEAD 2>/dev/null)

# 恢复 stash
if [ "$STASHED" = true ]; then
  git stash pop >> "$LOG_FILE" 2>&1 || {
    git checkout --theirs . >> "$LOG_FILE" 2>&1 || true
    git stash drop >> "$LOG_FILE" 2>&1 || true
    log "WARN: stash pop 冲突，已保留远端版本"
  }
fi

# 记录更新
if [ "$BEFORE" != "$AFTER" ]; then
  COMMITS=$(git log --oneline "$BEFORE".."$AFTER" 2>/dev/null | wc -l)
  log "已更新 ${COMMITS} 个提交 (${BEFORE:0:7} → ${AFTER:0:7})"
else
  # 不记录"无更新"，避免日志膨胀
  :
fi
