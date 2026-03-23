#!/bin/bash
# worktree-spawn.sh — 为并行 Agent 创建隔离的 Git Worktree
#
# 用法:
#   ./worktree-spawn.sh spawn <agent> <task-slug>   创建 worktree
#   ./worktree-spawn.sh merge <agent> <task-slug>   合并回当前分支
#   ./worktree-spawn.sh cleanup <agent> <task-slug> 清理 worktree + 分支
#   ./worktree-spawn.sh list                        列出活跃的 agent worktree
#
# 示例:
#   ./worktree-spawn.sh spawn codex feature-auth
#   → 创建 /tmp/mycc-codex-feature-auth（独立 worktree）
#   → 分支: agent/codex-feature-auth
#   → 打印路径，供 MCP working_directory 使用

set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AGENT="${2:-}"
TASK="${3:-}"
WORKTREE_BASE="/tmp"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

usage() {
  echo "Usage: $0 spawn|merge|cleanup|list [agent] [task-slug]"
  echo ""
  echo "Commands:"
  echo "  spawn   <agent> <task>   创建隔离 worktree（返回路径）"
  echo "  merge   <agent> <task>   squash-merge 回当前分支"
  echo "  cleanup <agent> <task>   移除 worktree + 删分支"
  echo "  list                     列出所有活跃 agent worktree"
  echo ""
  echo "Agents: codex, gemini, cc"
  exit 1
}

worktree_path() {
  echo "${WORKTREE_BASE}/mycc-${AGENT}-${TASK}"
}

branch_name() {
  echo "agent/${AGENT}-${TASK}"
}

cmd_spawn() {
  [[ -z "$AGENT" || -z "$TASK" ]] && usage
  local wt_path branch
  wt_path="$(worktree_path)"
  branch="$(branch_name)"

  if [ -d "$wt_path" ]; then
    echo -e "${YELLOW}[worktree]${NC} 已存在: $wt_path"
    echo "$wt_path"
    return 0
  fi

  echo -e "${GREEN}[worktree]${NC} 创建分支 $branch..."
  cd "$REPO_ROOT"
  git worktree add "$wt_path" -b "$branch" 2>&1

  # 复制 .env（本地凭证，不在 git 中）
  if [ -f "$REPO_ROOT/.env" ]; then
    cp "$REPO_ROOT/.env" "$wt_path/.env"
    echo -e "${GREEN}[worktree]${NC} .env 已复制到 worktree"
  fi

  echo -e "${GREEN}[worktree]${NC} ✓ Worktree 就绪: $wt_path"
  echo -e "${GREEN}[worktree]${NC} 分支: $branch"
  echo -e "${GREEN}[worktree]${NC} MCP 调用时 working_directory: $wt_path"
  echo ""
  # 最后一行输出路径，方便脚本捕获
  echo "$wt_path"
}

cmd_merge() {
  [[ -z "$AGENT" || -z "$TASK" ]] && usage
  local wt_path branch current_branch
  wt_path="$(worktree_path)"
  branch="$(branch_name)"

  if [ ! -d "$wt_path" ]; then
    echo -e "${RED}[worktree]${NC} Worktree 不存在: $wt_path"
    exit 1
  fi

  cd "$REPO_ROOT"
  current_branch="$(git branch --show-current)"

  echo -e "${GREEN}[worktree]${NC} 将 $branch squash-merge 到 $current_branch..."
  git merge --squash "$branch" --no-edit
  echo ""
  echo -e "${GREEN}[worktree]${NC} ✓ 合并完成。变更已暂存（staged），请检查后 commit："
  echo -e "  git diff --cached --stat"
  echo -e "  git commit -m \"feat: [${AGENT}] ${TASK}\""
}

cmd_cleanup() {
  [[ -z "$AGENT" || -z "$TASK" ]] && usage
  local wt_path branch
  wt_path="$(worktree_path)"
  branch="$(branch_name)"

  cd "$REPO_ROOT"

  if [ -d "$wt_path" ]; then
    git worktree remove "$wt_path" --force 2>&1
    echo -e "${GREEN}[worktree]${NC} ✓ Worktree 已移除: $wt_path"
  else
    echo -e "${YELLOW}[worktree]${NC} Worktree 不存在，跳过"
  fi

  if git branch --list "$branch" | grep -q .; then
    git branch -D "$branch"
    echo -e "${GREEN}[worktree]${NC} ✓ 分支已删除: $branch"
  fi
}

cmd_list() {
  echo -e "${GREEN}[worktree]${NC} 活跃的 agent worktree："
  git -C "$REPO_ROOT" worktree list | grep "agent/" || echo "  （无）"
}

case "${1:-}" in
  spawn)   cmd_spawn ;;
  merge)   cmd_merge ;;
  cleanup) cmd_cleanup ;;
  list)    cmd_list ;;
  *)       usage ;;
esac
