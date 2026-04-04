#!/bin/bash
# sync-to-mini.sh — Air 每 15 分钟推记忆到 Mini
# 用法: crontab 调用，静默失败（合盖不报错）

set -euo pipefail

MYCC_DIR="$HOME/mycc"
SRC_DIR="$MYCC_DIR/0-System/"
DEST_DIR="mycc/0-System/"
LOG_FILE="$MYCC_DIR/scripts/sync-to-mini.log"
TIMEOUT=3

# 确保日志文件存在
mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"

# 日志精简：只记时间戳 + 结果
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"
}

# 日志轮转：超过 1000 行时保留最近 500 行
if [[ -f "$LOG_FILE" ]] && [[ $(wc -l < "$LOG_FILE") -gt 1000 ]]; then
    tail -500 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi

# 检查源目录是否存在
if [[ ! -d "$SRC_DIR" ]]; then
    log "SKIP src_not_found"
    exit 0
fi

# rsync 同步函数
do_sync() {
    local host="$1"
    rsync -az --timeout="$TIMEOUT" \
        --include='*.md' \
        --exclude='*' \
        "$SRC_DIR" "${host}:${DEST_DIR}" 2>/dev/null
}

# 先尝试内网 mini（超时 3 秒），失败则尝试公网 mini-pub
if do_sync "mini"; then
    log "OK via mini"
elif do_sync "mini-pub"; then
    log "OK via mini-pub"
else
    log "FAIL both"
fi

exit 0
