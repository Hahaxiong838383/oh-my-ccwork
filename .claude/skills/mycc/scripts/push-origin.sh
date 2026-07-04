#!/bin/bash
# 每日 00:00 推送本地 main 到 origin
# origin = https://github.com/Hahaxiong838383/oh-my-ccwork（2026-07-04 迁移，旧 mycc 仓已废弃禁推）

set -e
cd /Users/rayman.chen/mycc

LOG_FILE="/Users/rayman.chen/mycc/.claude/skills/mycc/scripts/push-origin.log"
echo "$(date '+%Y-%m-%d %H:%M:%S') === 开始推送 origin ===" >> "$LOG_FILE"

# 检查是否有未推送的提交
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main 2>/dev/null || echo "none")

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') 无新提交需推送，跳过" >> "$LOG_FILE"
  exit 0
fi

# 推送
if git push origin main >> "$LOG_FILE" 2>&1; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') 推送成功: $LOCAL" >> "$LOG_FILE"
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') 推送失败!" >> "$LOG_FILE"
  exit 1
fi
