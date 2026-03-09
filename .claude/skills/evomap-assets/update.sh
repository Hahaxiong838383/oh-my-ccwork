#!/bin/bash
# EvoMap Assets 自动更新脚本
# 定时获取排名前3的高价值资产

ASSETS_DIR="/Users/rayman.chen/mycc/.claude/skills/evomap-assets"
LOG_FILE="/Users/rayman.chen/mycc/.claude/skills/evomap-assets/update.log"

echo "========== $(date) ==========" >> "$LOG_FILE"

# 1. 更新 skill.md
echo "1. 更新 evomap skill.md..." >> "$LOG_FILE"
curl -s https://evomap.ai/skill.md > "$ASSETS_DIR/SKILL.md"
if [ $? -eq 0 ]; then
    echo "   ✅ skill.md 更新成功" >> "$LOG_FILE"
else
    echo "   ❌ skill.md 更新失败" >> "$LOG_FILE"
fi

# 2. 获取排名前3的资产
echo "2. 获取排名资产..." >> "$LOG_FILE"
RANKED=$(curl -s "https://evomap.ai/a2a/assets/ranked?limit=3")
if [ $? -eq 0 ]; then
    echo "$RANKED" > "$ASSETS_DIR/ranked-top3.json"
    echo "   ✅ 排名资产获取成功" >> "$LOG_FILE"
    echo "$RANKED" | head -500 >> "$LOG_FILE"
else
    echo "   ❌ 排名资产获取失败" >> "$LOG_FILE"
fi

# 3. 获取趋势资产
echo "3. 获取趋势资产..." >> "$LOG_FILE"
TRENDING=$(curl -s "https://evomap.ai/a2a/trending?limit=3")
if [ $? -eq 0 ]; then
    echo "$TRENDING" > "$ASSETS_DIR/trending-top3.json"
    echo "   ✅ 趋势资产获取成功" >> "$LOG_FILE"
    echo "$TRENDING" | head -500 >> "$LOG_FILE"
else
    echo "   ❌ 趋势资产获取失败" >> "$LOG_FILE"
fi

echo "更新完成" >> "$LOG_FILE"

# 4. 发送飞书通知（汇报今日推荐资产）
echo "4. 发送飞书通知..." >> "$LOG_FILE"
node "$ASSETS_DIR/notify.js" >> "$LOG_FILE" 2>&1
if [ $? -eq 0 ]; then
    echo "   ✅ 飞书通知发送成功" >> "$LOG_FILE"
else
    echo "   ❌ 飞书通知发送失败" >> "$LOG_FILE"
fi

echo "---" >> "$LOG_FILE"
