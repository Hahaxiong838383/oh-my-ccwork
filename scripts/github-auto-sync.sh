#!/bin/bash
# github-auto-sync.sh — Air 每天自动推记忆到 GitHub（保底同步）
# 用法: crontab 每天执行一次

set -euo pipefail

MYCC_DIR="$HOME/mycc"
LOG_FILE="$MYCC_DIR/scripts/github-auto-sync.log"

# 确保日志文件存在
mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"
}

# 日志轮转：超过 500 行时保留最近 200 行
if [[ -f "$LOG_FILE" ]] && [[ $(wc -l < "$LOG_FILE") -gt 500 ]]; then
    tail -200 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi

cd "$MYCC_DIR" || { log "FAIL cd_mycc"; exit 1; }

# 确保在 main 分支（避免在其他分支误提交）
current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
if [[ "$current_branch" != "main" ]]; then
    log "SKIP branch=$current_branch"
    exit 0
fi

# 拉取远端最新（fast-forward only，冲突时不覆盖本地）
if ! git pull --ff-only origin main 2>/dev/null; then
    log "WARN pull_ff_failed, push_only"
fi

# 暂存记忆文件
git add 0-System/*.md docs/*.md 2>/dev/null || true

# 检查是否有实际变更
if git diff --cached --quiet; then
    # 无变更，静默退出
    exit 0
fi

# 统计变更文件数
changed_count=$(git diff --cached --name-only | wc -l | tr -d ' ')

# 提交 + 推送
if git commit -m "chore: auto-sync memory [skip ci]" --no-gpg-sign >/dev/null 2>&1; then
    if git push origin main >/dev/null 2>&1; then
        log "OK pushed ${changed_count} files"
    else
        log "FAIL push (commit saved locally)"
    fi
else
    log "FAIL commit"
    git reset HEAD >/dev/null 2>&1 || true
fi

exit 0
