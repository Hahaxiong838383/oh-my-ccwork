#!/bin/bash
# sync-to-mini.sh — Air 每 15 分钟推记忆到 Mini（全量）
# 用法: crontab 调用，静默失败（合盖不报错）

set -euo pipefail

MYCC_DIR="$HOME/mycc"
LOG_FILE="$MYCC_DIR/scripts/sync-to-mini.log"
TIMEOUT=5

mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"
}

# 日志轮转
if [[ -f "$LOG_FILE" ]] && [[ $(wc -l < "$LOG_FILE") -gt 1000 ]]; then
    tail -500 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi

# rsync 同步函数（带重试：内网→公网）
do_sync() {
    local src="$1"
    local dest="$2"
    rsync -az --timeout="$TIMEOUT" --exclude='*.db' --exclude='*.db-shm' --exclude='*.db-wal' \
        "$src" "mini:${dest}" 2>/dev/null \
    || rsync -az --timeout=10 --exclude='*.db' --exclude='*.db-shm' --exclude='*.db-wal' \
        "$src" "mini-pub:${dest}" 2>/dev/null
}

RESULT="OK"

# 1. 0-System 全量同步（含子目录）
if [[ -d "$MYCC_DIR/0-System/" ]]; then
    if do_sync "$MYCC_DIR/0-System/" "mycc/0-System/"; then
        RESULT="${RESULT} 0sys=ok"
    else
        RESULT="${RESULT} 0sys=FAIL"
    fi
fi

# 2. Claude Code 记忆同步（Air 上 cc 产生的 memory 文件）
CLAUDE_MEM="$HOME/.claude/projects/-Users-rayman-chen-mycc/memory"
if [[ -d "$CLAUDE_MEM" ]]; then
    # 同步到 Mini 的 Claude memory 目录（合并，不覆盖 Mini 自己的）
    # Mini 的 sync-data.sh 会把合并后的结果推到 Studio
    if do_sync "$CLAUDE_MEM/" ".claude/projects/-Users-rayman-chen-mycc/memory/"; then
        RESULT="${RESULT} claude-mem=ok"
    else
        RESULT="${RESULT} claude-mem=FAIL"
    fi
fi

log "$RESULT"
exit 0
