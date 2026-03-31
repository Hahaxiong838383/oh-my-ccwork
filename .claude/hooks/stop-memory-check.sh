#!/bin/bash
# Stop hook: 检查本次 session 是否已写入记忆 + 自动学习提醒
# 灵感来源：so-c-claude 的 auto_learn 机制（用 fast_model 从对话自动提取用户偏好）

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/home/hahaxiong83/mycc}"
EVENTS_FILE="$PROJECT_DIR/0-System/RECENT_EVENTS.md"
ITEMS_FILE="$PROJECT_DIR/0-System/memory-items.md"
TODAY=$(date '+%Y-%m-%d')

WARNINGS=""

# 1. 检查 RECENT_EVENTS.md 是否有今天的记录
if ! grep -q "## $TODAY" "$EVENTS_FILE" 2>/dev/null; then
  WARNINGS="${WARNINGS}⚠️ RECENT_EVENTS.md 没有今天 ($TODAY) 的记录。\n"
fi

# 2. 检查最近1小时是否有记录
CURRENT_HOUR=$(date '+%H')
if grep -q "## $TODAY" "$EVENTS_FILE" 2>/dev/null; then
  if ! grep -A 50 "## $TODAY" "$EVENTS_FILE" | grep -q "\`${CURRENT_HOUR}:"; then
    WARNINGS="${WARNINGS}⚠️ 最近1小时没有新事件记录。\n"
  fi
fi

# 3. 输出提醒（合并所有警告 + 自动学习提示）
if [ -n "$WARNINGS" ]; then
  echo -e "$WARNINGS"
  echo "📝 Session 结束前必做三步："
  echo "  1) 追加本次操作到 RECENT_EVENTS.md"
  echo "  2) 提取新事实到 memory-items.md"
  echo "  3) 自动学习：回顾本次对话，提取以下内容写入 memory-items.md："
  echo "     - [user/偏好] 用户表达的新偏好（如「以后这样做」「不要这样」）"
  echo "     - [user/方法论] 用户认可的工作方式（如「这个方法不错」）"
  echo "     - [project/*] 项目中发现的新规律/技术事实"
  echo "     只写跨会话可复用的事实，不写本次会话特有的临时状态。"
  exit 0
fi

# 一切正常，仍然输出自动学习提示（静默版）
echo "✅ 记忆已写入。请检查是否有未提取的用户偏好或新 pattern 可写入 memory-items.md。"
exit 0
