#!/usr/bin/env bash
# P003 GameDemo · mycc 主仓 ⇄ FUTURUS-ProductResearch/P003GameDemo 组织仓 双向同步
#
# 背景：mycc 保留 P003 子目录为事实主本；组织仓是团队协作镜像（标准 PR/issue 流）。
# git subtree 对该前缀不可用（历史中某路径 blob→tree 变迁，split 在 382/735 处 fatal），
# 故用"快照同步"：每个方向一次同步 = 一个以川哥 git 身份署名的提交。
#
# 用法：
#   bash 4-Assets/SOP/p003-org-sync.sh push "同步说明"   # mycc → 组织仓（发布本地改动）
#   bash 4-Assets/SOP/p003-org-sync.sh pull               # 组织仓 → mycc（回流团队改动）
#
# 规则：
#   - push 前要求 mycc 的 P003 子目录已 commit（同步的是 HEAD 跟踪树，不带未提交改动）
#   - pull 前要求 P003 子目录工作区干净（防覆盖未提交的本地工作）
#   - pull 落盘 = mycc 一个 squash 式提交（作者=当前 git 身份），团队细碎 commit 留在组织仓
set -euo pipefail

MYCC=/Users/rayman.chen/mycc
PREFIX=2-Projects/P003GameDemo20260513
ORG_URL=https://github.com/FUTURUS-ProductResearch/P003GameDemo.git
TMP=$(mktemp -d /tmp/p003-org-sync.XXXXXX)
trap 'rm -rf "$TMP"' EXIT

cmd=${1:-}
msg=${2:-"sync: 与 mycc 主仓同步"}

subdir_dirty() {
  [ -n "$(git -C "$MYCC" status --porcelain -- "$PREFIX")" ]
}

case "$cmd" in
  push)
    if subdir_dirty; then
      echo "❌ $PREFIX 有未提交改动，先在 mycc 提交后再 push 同步" >&2
      exit 1
    fi
    echo "→ clone 组织仓..."
    git clone -q --depth 1 "$ORG_URL" "$TMP/org"
    echo "→ 导出 mycc HEAD 跟踪树..."
    mkdir -p "$TMP/export"
    git -C "$MYCC" archive HEAD -- "$PREFIX" | tar -x -C "$TMP/export" --strip-components=2
    echo "→ 覆盖组织仓工作区（保留 .git）..."
    rsync -a --delete --exclude='.git' "$TMP/export/" "$TMP/org/"
    cd "$TMP/org"
    git add -A
    if git diff --cached --quiet; then
      echo "✅ 组织仓已是最新，无需推送"
      exit 0
    fi
    git commit -q -m "$msg

（自 mycc 主仓 $(git -C "$MYCC" rev-parse --short HEAD) 快照同步）"
    git push https://github.com/FUTURUS-ProductResearch/P003GameDemo.git HEAD:main
    echo "✅ push 完成：$(git rev-parse --short HEAD) → 组织仓 main"
    ;;

  pull)
    if subdir_dirty; then
      echo "❌ $PREFIX 工作区不干净，先提交/stash 本地改动再 pull 回流" >&2
      exit 1
    fi
    echo "→ clone 组织仓..."
    git clone -q --depth 1 "$ORG_URL" "$TMP/org"
    ORG_SHA=$(git -C "$TMP/org" rev-parse --short HEAD)
    echo "→ 导出组织仓跟踪树..."
    mkdir -p "$TMP/export"
    git -C "$TMP/org" archive HEAD | tar -x -C "$TMP/export"
    echo "→ 回写 mycc 子目录（保留本地 gitignore 产物：env/依赖/构建物）..."
    rsync -a --delete \
      --exclude='.env*' --exclude='node_modules/' --exclude='dist/' \
      --exclude='.venv*/' --exclude='*.log' \
      "$TMP/export/" "$MYCC/$PREFIX/"
    cd "$MYCC"
    git add "$PREFIX"
    if git diff --cached --quiet; then
      echo "✅ mycc 已是最新，无需回流"
      exit 0
    fi
    echo "→ 回流 diffstat："
    git diff --cached --stat | tail -5
    git commit -q -m "sync(p003): 回流组织仓团队改动（org $ORG_SHA）

来源：FUTURUS-ProductResearch/P003GameDemo @ $ORG_SHA
团队提交明细见组织仓历史；本提交为 mycc 侧 squash 落盘。"
    echo "✅ pull 完成：org $ORG_SHA → mycc $(git rev-parse --short HEAD)"
    echo "   （如需推 GitHub 主仓：git push origin main，按惯例需川哥口头授权）"
    ;;

  *)
    echo "用法: $0 push \"同步说明\" | pull" >&2
    exit 1
    ;;
esac
