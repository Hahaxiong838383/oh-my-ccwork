#!/bin/bash
# Auto-check and merge updates from upstream mycc repository
# Run this script daily at 4 AM

LOG_FILE="/Users/rayman.chen/mycc/.claude/skills/mycc/scripts/sync-upstream.log"
UPSTREAM_REPO="https://github.com/Aster110/mycc.git"
LOCAL_MYCC="/Users/rayman.chen/mycc"
LAST_COMMIT_FILE="/Users/rayman.chen/mycc/.claude/skills/mycc/scripts/.last_upstream_commit"

echo "========== $(date) ==========" >> "$LOG_FILE"

cd "$LOCAL_MYCC" || exit 1

# Add upstream remote if not exists
if ! git remote | grep -q "^upstream$"; then
    echo "添加 upstream 远程仓库..." >> "$LOG_FILE"
    git remote add upstream "$UPSTREAM_REPO" 2>> "$LOG_FILE"
fi

# Fetch latest from upstream
echo "从 upstream 获取最新代码..." >> "$LOG_FILE"
git fetch upstream >> "$LOG_FILE" 2>&1

# Get latest upstream commit hash
LATEST_COMMIT=$(git rev-parse upstream/main 2>/dev/null || git rev-parse upstream/master 2>/dev/null)

if [ -z "$LATEST_COMMIT" ]; then
    echo "无法获取 upstream 最新提交" >> "$LOG_FILE"
    exit 1
fi

# Check if there's a new commit
if [ -f "$LAST_COMMIT_FILE" ]; then
    LAST_COMMIT=$(cat "$LAST_COMMIT_FILE")
else
    LAST_COMMIT=""
fi

if [ "$LATEST_COMMIT" = "$LAST_COMMIT" ]; then
    echo " upstream 无新提交，无需更新" >> "$LOG_FILE"
    exit 0
fi

echo "发现新提交: $LAST_COMMIT -> $LATEST_COMMIT" >> "$LOG_FILE"

# Show what changed
echo "更新内容:" >> "$LOG_FILE"
git log --oneline "$LAST_COMMIT..$LATEST_COMMIT" 2>/dev/null | head -10 >> "$LOG_FILE"

# Stash local changes
echo "暂存本地修改..." >> "$LOG_FILE"
git stash push -m "auto-sync-$(date +%Y%m%d-%H%M%S)" >> "$LOG_FILE" 2>&1

# Merge/cherry-pick upstream changes
echo "合并 upstream 更新..." >> "$LOG_FILE"
if git merge upstream/main --no-edit >> "$LOG_FILE" 2>&1; then
    echo "合并成功" >> "$LOG_FILE"
else
    echo "合并有冲突，请手动处理" >> "$LOG_FILE"
    # Try to continue with mergetool or auto-resolve
    git merge --abort >> "$LOG_FILE" 2>&1
    git stash pop >> "$LOG_FILE" 2>&1
    echo "已回滚本地更改，保留原样" >> "$LOG_FILE"
fi

# Save latest commit
echo "$LATEST_COMMIT" > "$LAST_COMMIT_FILE"

echo "========== 完成 ==========" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"
