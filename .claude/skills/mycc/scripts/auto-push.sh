#!/bin/bash
# 每晚自动 commit + push 本地改动到 origin
# launchd 调度：每天 23:00

LOCAL_MYCC="/Users/rayman.chen/mycc"
LOG_FILE="/Users/rayman.chen/mycc/.claude/skills/mycc/scripts/auto-push.log"

echo "========== $(date) ==========" >> "$LOG_FILE"

cd "$LOCAL_MYCC" || { echo "cd 失败" >> "$LOG_FILE"; exit 1; }

# 检查是否有改动
CHANGES=$(git status --short 2>/dev/null | wc -l | tr -d ' ')
if [ "$CHANGES" = "0" ]; then
    echo "无改动，跳过" >> "$LOG_FILE"
    exit 0
fi

echo "发现 $CHANGES 个改动文件" >> "$LOG_FILE"

# 记忆向量增量重建（根治向量静默死亡：每日同步前让向量跟上记忆，更新的 vectors.json/health 随本次一起提交）
# 增量模式秒级（仅 embed 新增/变更条目）；失败不阻断 git 同步，告警已由脚本写入 RECENT_EVENTS
echo "触发记忆向量增量重建..." >> "$LOG_FILE"
( cd "$LOCAL_MYCC/.claude/skills/mycc/scripts" && npx tsx src/scripts/rebuild-index.ts "$LOCAL_MYCC" >> "$LOG_FILE" 2>&1 ) || echo "向量重建失败（不阻断同步）" >> "$LOG_FILE"

# 添加所有改动（尊重 .gitignore）
git add -A >> "$LOG_FILE" 2>&1

# 生成 commit message
DATE=$(date '+%Y-%m-%d')
SUMMARY=$(git diff --cached --stat | tail -1)
git commit -m "chore: 每日自动同步 $DATE

$SUMMARY" >> "$LOG_FILE" 2>&1

if [ $? -ne 0 ]; then
    echo "commit 失败或无需提交" >> "$LOG_FILE"
    exit 0
fi

# 推送到 origin
git push origin main >> "$LOG_FILE" 2>&1

if [ $? -eq 0 ]; then
    echo "推送成功" >> "$LOG_FILE"
else
    echo "推送失败，可能是网络问题" >> "$LOG_FILE"
fi

echo "========== 完成 ==========" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"
