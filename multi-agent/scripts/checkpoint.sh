#!/bin/bash
# 多智能体协同 - checkpoint 管理脚本
# 支持精确回滚到指定 checkpoint

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CHECKPOINT_FILE=".claude/multi-agent/.checkpoints"

# 检查是否为 git 仓库
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo -e "${RED}错误: 当前目录不是 git 仓库${NC}"
    exit 1
fi

# 初始化 checkpoint 文件
init_checkpoint_file() {
    if [ ! -f "$CHECKPOINT_FILE" ]; then
        mkdir -p "$(dirname "$CHECKPOINT_FILE")"
        echo "# checkpoint 记录" > "$CHECKPOINT_FILE"
        echo "# 格式: <id> <hash> <timestamp> <description>" >> "$CHECKPOINT_FILE"
    fi
}

# 创建 checkpoint
create_checkpoint() {
    local msg="$1"
    if [ -z "$msg" ]; then
        echo -e "${RED}错误: 请提供 checkpoint 描述${NC}"
        echo "用法: checkpoint.sh create \"描述信息\""
        exit 1
    fi

    init_checkpoint_file

    # 生成 ID
    local id=$(date +%Y%m%d%H%M%S)
    local hash=$(git rev-parse HEAD)
    local timestamp=$(date +"%Y-%m-%d %H:%M:%S")

    echo -e "${YELLOW}创建 checkpoint: $msg${NC}"

    # 提交所有更改
    git add -A
    git commit -m "checkpoint: $msg" || echo "没有需要提交的更改"

    # 获取最新 hash
    local new_hash=$(git rev-parse HEAD)

    # 记录到文件
    echo "$id $new_hash $timestamp $msg" >> "$CHECKPOINT_FILE"

    echo -e "${GREEN}✓ checkpoint 创建成功${NC}"
    echo "  ID: $id"
    echo "  Hash: $new_hash"
    echo ""
    echo "回滚命令: checkpoint.sh rollback $id"
}

# 回滚到指定 checkpoint
rollback() {
    local target_id="$1"

    if [ -z "$target_id" ]; then
        echo -e "${RED}错误: 请指定 checkpoint ID${NC}"
        echo ""
        echo "用法: checkpoint.sh rollback <checkpoint-id>"
        echo ""
        list_checkpoints
        exit 1
    fi

    init_checkpoint_file

    # 查找目标 hash
    local target_hash=$(grep "^$target_id " "$CHECKPOINT_FILE" | awk '{print $2}' | head -1)

    if [ -z "$target_hash" ]; then
        echo -e "${RED}错误: 未找到 checkpoint ID: $target_id${NC}"
        list_checkpoints
        exit 1
    fi

    echo -e "${YELLOW}⚠️  危险操作：回滚到 checkpoint $target_id${NC}"
    echo "目标: $target_hash"
    echo ""
    read -p "确认执行? (yes/no): " confirm

    if [ "$confirm" = "yes" ]; then
        git reset --hard "$target_hash"
        echo -e "${GREEN}✓ 已回滚到 checkpoint: $target_id${NC}"
    else
        echo "已取消"
    fi
}

# 紧急回滚：回退一个提交（快捷方式）
emergency_rollback() {
    echo -e "${YELLOW}⚠️  紧急回退：回退一个提交${NC}"
    read -p "确认执行? (yes/no): " confirm

    if [ "$confirm" = "yes" ]; then
        git reset --hard HEAD~1
        echo -e "${GREEN}✓ 已回退一个提交${NC}"
    else
        echo "已取消"
    fi
}

# 查看 checkpoint 历史
show_history() {
    echo -e "${YELLOW}Checkpoint 历史:${NC}"
    git log --oneline --all | grep "checkpoint" | head -20
}

# 列出可用的 checkpoint
list_checkpoints() {
    init_checkpoint_file

    echo -e "${YELLOW}可用 checkpoints:${NC}"
    echo ""
    printf "%-12s %-12s %-20s %s\n" "ID" "Hash" "时间" "描述"
    echo "----------------------------------------------------------------"

    while read -r line; do
        # 跳过注释行
        [[ "$line" =~ ^# ]] && continue
        [[ -z "$line" ]] && continue

        local id=$(echo "$line" | awk '{print $1}')
        local hash=$(echo "$line" | awk '{print $2}')
        local timestamp=$(echo "$line" | awk '{print $3 " " $4}')
        local msg=$(echo "$line" | sed 's/^[^ ]* [^ ]* [^ ]* [^ ]* //')

        printf "%-12s %-12s %-20s %s\n" "$id" "${hash:0:8}" "$timestamp" "$msg"
    done < "$CHECKPOINT_FILE"

    echo ""
    echo "回滚命令: checkpoint.sh rollback <id>"
}

# 显示帮助
show_help() {
    echo "多智能体协同 - checkpoint 管理脚本"
    echo ""
    echo "用法:"
    echo "  $0 create <描述>       创建 checkpoint"
    echo "  $0 rollback <id>       回滚到指定 checkpoint（推荐）"
    echo "  $0 emergency          紧急回退一个提交（快捷方式）"
    echo "  $0 history            查看 checkpoint 历史"
    echo "  $0 list               列出所有 checkpoints"
    echo "  $0 help               显示帮助"
}

# 主命令处理
case "${1:-help}" in
    create)
        create_checkpoint "$2"
        ;;
    rollback)
        rollback "$2"
        ;;
    emergency)
        emergency_rollback
        ;;
    history)
        show_history
        ;;
    list)
        list_checkpoints
        ;;
    help|*)
        show_help
        ;;
esac
