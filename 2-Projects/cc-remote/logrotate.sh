#!/bin/bash
# cc-remote 日志轮转 — 保留最近 3 个日志文件，每个最大 10MB
LOG="/tmp/cc-remote.log"
MAX_SIZE=$((10 * 1024 * 1024))  # 10MB
KEEP=3

if [ -f "$LOG" ]; then
  size=$(stat -f%z "$LOG" 2>/dev/null || stat -c%s "$LOG" 2>/dev/null)
  if [ "$size" -gt "$MAX_SIZE" ] 2>/dev/null; then
    # 轮转
    for i in $(seq $((KEEP-1)) -1 1); do
      [ -f "${LOG}.$i" ] && mv "${LOG}.$i" "${LOG}.$((i+1))"
    done
    mv "$LOG" "${LOG}.1"
    echo "[logrotate] $(date '+%Y-%m-%d %H:%M') 日志已轮转" > "$LOG"
  fi
fi
