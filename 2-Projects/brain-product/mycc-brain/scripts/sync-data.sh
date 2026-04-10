#!/bin/bash
# sync-data.sh — Mini 每 15 分钟推记忆数据到 Studio
# crontab: */15 * * * * bash ~/mycc/2-Projects/brain-product/mycc-brain/scripts/sync-data.sh
set -euo pipefail

LOG_FILE="$HOME/mycc/2-Projects/brain-product/mycc-brain/data/sync-cron.log"
mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"; }

# 日志轮转
if [[ -f "$LOG_FILE" ]] && [[ $(wc -l < "$LOG_FILE") -gt 1000 ]]; then
    tail -500 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi

# rsync 到 Studio（内网→公网降级）
do_sync() {
    local src="$1"
    local dest="$2"
    rsync -az --timeout=5 --exclude='*.db' --exclude='*.db-shm' --exclude='*.db-wal' \
        "$src" "studio:${dest}" 2>/dev/null \
    || rsync -az --timeout=10 --exclude='*.db' --exclude='*.db-shm' --exclude='*.db-wal' \
        "$src" "studio-pub:${dest}" 2>/dev/null
}

RESULT="OK"

# 1. 0-System 记忆数据 → Studio mycc-data
SYSTEM_DIR="$HOME/mycc/0-System/"
if [[ -d "$SYSTEM_DIR" ]]; then
    if do_sync "$SYSTEM_DIR" "mycc-data/0-System/"; then
        RESULT="${RESULT} 0sys=ok"
    else
        RESULT="${RESULT} 0sys=FAIL"
    fi
fi

# 2. Claude Code 记忆 → Studio mycc-data/claude-memory/
# Air 已经把 Claude 记忆推到 Mini 的 ~/.claude/...，Mini 再推到 Studio
CLAUDE_MEM="$HOME/.claude/projects/-Users-rayman-chen-mycc/memory"
if [[ -d "$CLAUDE_MEM" ]]; then
    if do_sync "$CLAUDE_MEM/" "mycc-data/claude-memory/"; then
        RESULT="${RESULT} claude-mem=ok"
    else
        RESULT="${RESULT} claude-mem=FAIL"
    fi
fi

# [已停用 2026-04-10] eval-result.json 的单向覆盖被移除。
# 原因：Mini 上若 eval cron 因环境问题失败，会把 stale/错误数据覆盖 Studio 的正确版本。
# 架构原则：Studio 是 source of truth，Mini/Air 的数据应该上报给 Studio 由其合并整合，
# 而不是直接覆盖 Studio 上的运行时数据。
# 长期方案：改为 POST 到 brain API 的 /admin/api/eval/report 端点，由 brain 按时间戳合并。
# EVAL_RESULT="$HOME/mycc/2-Projects/brain-product/mycc-brain/eval/eval-result.json"
# if [[ -f "$EVAL_RESULT" ]]; then
#     if do_sync "$EVAL_RESULT" "mycc-brain/eval/eval-result.json"; then
#         RESULT="${RESULT} eval-result=ok"
#     else
#         RESULT="${RESULT} eval-result=FAIL"
#     fi
# fi
RESULT="${RESULT} eval-result=DISABLED"

log "$RESULT"
exit 0
