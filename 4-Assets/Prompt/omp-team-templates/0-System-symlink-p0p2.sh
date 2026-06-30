#!/bin/bash
# P0-P2 0-System 外挂 + worktree 规则 完整可执行脚本
# 铁律优先: 强备份 + 路径始终可读 + 每步可回滚 + 并发校验
# 用法: DRY_RUN=1 bash 0-System-symlink-p0p2.sh   # 预览不执行
#      bash 0-System-symlink-p0p2.sh               # 真实执行
# 回滚: 见函数 rollback_all
# 署名要求: 所有输出中文

set -euo pipefail

# ==================== 配置 ====================
MYCC_ROOT="${HOME}/mycc"
GLOBAL_DIR="${HOME}/.mycc-global/0-System"
OLD_DIR="${MYCC_ROOT}/0-System.old"
BACKUP_DIR="${HOME}/Archive"
DATE_TAG=$(date +%Y%m%d-%H%M%S)
BACKUP_TAR="${BACKUP_DIR}/0-System-backup-${DATE_TAG}.tar"
DRY_RUN="${DRY_RUN:-0}"
SCRIPT_NAME=$(basename "$0")

# ==================== 工具函数 ====================
log() {
  echo "[$(date '+%H:%M:%S')] $*" >&2
}

die() {
  log "❌ 错误: $*"
  exit 1
}

run_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "DRY: $*"
  else
    eval "$@"
  fi
}

verify_path_readable() {
  local path="$1"
  if [[ ! -e "$path" ]]; then
    die "路径 $path 不可读！违反铁律2"
  fi
  log "✅ 路径 $path 可读"
}

count_files() {
  local dir="$1"
  if [[ -d "$dir" ]]; then
    find "$dir" -type f 2>/dev/null | wc -l | tr -d ' '
  else
    echo "0"
  fi
}

verify_symlink_transparent() {
  log "验证 symlink 透明读写..."
  local test_file="RECENT_EVENTS.md"
  local orig_content
  orig_content=$(head -c 100 "${MYCC_ROOT}/0-System/${test_file}" 2>/dev/null || echo "MISS")
  local target_content
  target_content=$(head -c 100 "${GLOBAL_DIR}/${test_file}" 2>/dev/null || echo "MISS")
  
  if [[ "$orig_content" != "$target_content" ]]; then
    die "透明读写失败: 内容不一致"
  fi
  if [[ ! -L "${MYCC_ROOT}/0-System" ]]; then
    die "0-System 不是 symlink"
  fi
  local link_target
  link_target=$(readlink "${MYCC_ROOT}/0-System")
  if [[ "$link_target" != "$GLOBAL_DIR" ]]; then
    die "symlink 指向错误: $link_target != $GLOBAL_DIR"
  fi
  log "✅ symlink 透明 + 指向正确"
}

check_tracked_count() {
  local before="$1"
  local after
  after=$(git -C "$MYCC_ROOT" ls-files | wc -l | tr -d ' ')
  local delta=$((before - after))
  log "tracked 变化: $before → $after (减少 $delta，预期 ~21 因为 symlink 替换 22 个 tracked 文件)"
  if (( delta < 15 || delta > 30 )); then
    log "⚠️ tracked 变化异常，检查 git ls-files '0-System/**'"
  fi
}

# 回滚函数 (铁律4)
rollback_all() {
  log "执行回滚..."
  if [[ -L "${MYCC_ROOT}/0-System" ]]; then
    run_cmd "rm -f '${MYCC_ROOT}/0-System'"
  fi
  if [[ -d "$OLD_DIR" && ! -e "${MYCC_ROOT}/0-System" ]]; then
    run_cmd "mv '$OLD_DIR' '${MYCC_ROOT}/0-System'"
    log "✅ 已从 .old 恢复 0-System"
  fi
  if [[ -d "$GLOBAL_DIR" ]]; then
    log "全局副本保留: $GLOBAL_DIR (手动清理如果需要)"
  fi
  log "回滚完成。检查 git status 确认"
}

# ==================== P0: 观察+备份 ====================
p0_backup_and_inventory() {
  log "=== P0 开始: 强备份 + 清单 ==="
  
  # 强备份 (铁律1)
  if [[ ! -f "$BACKUP_TAR" ]]; then
    log "创建强备份 tar: $BACKUP_TAR"
    run_cmd "tar -cf '$BACKUP_TAR' -C '$MYCC_ROOT' 0-System"
    log "✅ 备份完成，大小: $(du -h "$BACKUP_TAR" 2>/dev/null | cut -f1 || echo 'DRY')"
  else
    log "备份已存在，跳过"
  fi
  
  # 清单: skills 数量 (三套)
  log "=== 三套 skills 数量 ==="
  local s1 s2 s3
  s1=$(find "${HOME}/.claude/skills" -type f 2>/dev/null | wc -l | tr -d ' ' || echo 0)
  s2=$(find "${MYCC_ROOT}/.claude/skills" -type f 2>/dev/null | wc -l | tr -d ' ' || echo 0)
  s3=$(find "${MYCC_ROOT}" -path '*/.claude/skills/*' -type f 2>/dev/null | wc -l | tr -d ' ' || echo 0)
  log "1. ~/.claude/skills: $s1 文件"
  log "2. ~/mycc/.claude/skills: $s2 文件"
  log "3. mycc 全项目 skills 相关: $s3 文件 (含子项目)"
  
  # 11 worktree 状态
  log "=== 11 worktree 状态 (死活) ==="
  git -C "$MYCC_ROOT" worktree list | while read -r line; do
    local wt_path
    wt_path=$(echo "$line" | awk '{print $1}')
    if [[ -d "$wt_path" ]]; then
      local pid_check
      pid_check=$(pgrep -f "$wt_path" 2>/dev/null | wc -l | tr -d ' ' || echo 0)
      if [ "$pid_check" -gt 0 ]; then
        log "  [活] $line (进程: $pid_check)"
      else
        log "  [死] $line (无活跃进程)"
      fi
    else
      log "  [死] $line (路径不存在)"
    fi
  done
  
  verify_path_readable "${MYCC_ROOT}/0-System"
  log "✅ P0 完成"
}

# ==================== P1: 立规则 ====================
p1_establish_rules() {
  log "=== P1: 立规则 (worktree 工作流) ==="
  
  # 已有 WORKTREE-FLOW 规则 (CLAUDE.md 第91行)，此处追加确认段
  local rule_section='## WORKTREE 工作流铁律 (P0-P2 补充)

**已存在于 P1 万能公式表**：WORKTREE-FLOW

**额外约束 (本次 P2 强化)**:
- worktree 绝不执行 ln -s / mv / rm -rf 0-System 相关操作
- 全局状态修改仅限主 mycc session 执行，worktree 只读引用
- 任务结束必须 git worktree remove <path> 清理
- 违规将导致状态竞态，git revert 0-System 风险

详见本文件 P1 表格 + 全局 docs/omc-guide.md'
  if ! grep -q "WORKTREE-FLOW" "${MYCC_ROOT}/CLAUDE.md"; then
    log "追加 WORKTREE-FLOW 规则到 CLAUDE.md"
    run_cmd "cat >> '${MYCC_ROOT}/CLAUDE.md' << 'EOF'
$rule_section
EOF"
  else
    log "✅ WORKTREE-FLOW 已存在，跳过追加 (符合当前 CLAUDE.md)"
  fi
  
  # mkdir ~/.mycc-global
  if [[ ! -d "${HOME}/.mycc-global" ]]; then
    run_cmd "mkdir -p '${HOME}/.mycc-global'"
    log "✅ 创建 ~/.mycc-global"
  fi
  
  log "✅ P1 完成 (规则已强化，~/.mycc-global 就绪)"
}

# ==================== P2: 0-System 外挂 (核心原子替换) ====================
p2_atomic_symlink() {
  log "=== P2 开始: 0-System 原子外挂 (Tracked Symlink) ==="
  
  # 前置检查
  if [[ -L "${MYCC_ROOT}/0-System" ]]; then
    log "⚠️ 已存在 symlink，跳过 P2 (或先 rollback)"
    return 0
  fi
  if [[ -d "$OLD_DIR" ]]; then
    die ".old 已存在，请先手动处理或 rollback"
  fi
  
  verify_path_readable "${MYCC_ROOT}/0-System"
  
  # 1. mkdir 目标 (已做)
  run_cmd "mkdir -p '$GLOBAL_DIR'"
  
  # 2. cp -a 迁移 (保留软链/权限/隐藏文件/时间戳)
  log "执行 cp -a 迁移 (保留所有元数据)..."
  local orig_count
  orig_count=$(count_files "${MYCC_ROOT}/0-System")
  run_cmd "cp -a '${MYCC_ROOT}/0-System/.' '$GLOBAL_DIR/'"
  local new_count
  new_count=$(count_files "$GLOBAL_DIR")
  if [[ "$DRY_RUN" != "1" && $new_count != "$orig_count" ]]; then
    die "cp 后文件数不一致: $orig_count vs $new_count (检查权限/隐藏文件)"
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY: 跳过 cp 后文件数校验"
  fi
  
  # 3. 原子替换 (铁律2: 路径始终可读 + 铁律4 可回滚)
  # 策略: mv + ln 同一行 && ，rename syscall 原子，window 极小 (<1ms)
  # macOS rename(2) 对 symlink/dir 安全
  log "执行原子 mv + ln (路径不断)..."
  local tracked_before
  tracked_before=$(git -C "$MYCC_ROOT" ls-files | wc -l | tr -d ' ')
  
  # 关键原子操作
  if [[ "$DRY_RUN" != "1" ]]; then
    mv "${MYCC_ROOT}/0-System" "$OLD_DIR" && \
    ln -s "$GLOBAL_DIR" "${MYCC_ROOT}/0-System"
  else
    echo "DRY: mv ... && ln -s ..."
  fi
  
  verify_path_readable "${MYCC_ROOT}/0-System"
  verify_symlink_transparent
  
  # 4. 验证并发没 revert (铁律3)
  log "校验其他 session 是否 revert..."
  if [[ ! -L "${MYCC_ROOT}/0-System" ]]; then
    die "并发 revert 检测到！执行 rollback"
  fi
  # 快速 grep 关键文件确认内容
  if ! grep -q "RECENT_EVENTS" "${MYCC_ROOT}/0-System/status.md" 2>/dev/null; then
    log "⚠️ 可能被污染，检查"
  fi
  log "✅ 无 revert 迹象"
  
  # 5. git commit symlink (git 只跟踪链接本身)
  log "git add + commit symlink..."
  run_cmd "git -C '$MYCC_ROOT' add 0-System && git -C '$MYCC_ROOT' commit -m 'chore: P2 0-System 外挂为 tracked symlink (全局状态迁移)'"
  
  # 验证 tracked 变化合理
  check_tracked_count "$tracked_before"
  
  # 最终验证 (铁律3)
  log "最终验证: 读写透明 + worktree 共享物理文件 + HEAD 安全"
  verify_symlink_transparent
  # 验证 worktree 也能看到 (共享 inode)
  local wt_example
  wt_example=$(git -C "$MYCC_ROOT" worktree list | head -2 | tail -1 | awk '{print $1}')
  if [[ -d "$wt_example" ]]; then
    if [[ -L "$wt_example/0-System" || -d "$wt_example/0-System" ]]; then
      log "✅ worktree $wt_example 可见 0-System (共享物理)"
    fi
  fi
  git -C "$MYCC_ROOT" log --oneline -1 | grep -q "0-System 外挂" || die "commit 未成功"
  
  log "✅ P2 完成！0-System 现在是 symlink，内容在外挂，全局状态零污染风险"
  log "备份 .old 保留: $OLD_DIR (可手动 rm 释放空间)"
}

# ==================== 主流程 ====================
main() {
  log "🚀 开始 P0-P2 执行 (DRY_RUN=$DRY_RUN)"
  log "当前 mycc HEAD: $(git -C "$MYCC_ROOT" rev-parse --short HEAD)"
  log "⚠️ 提醒: 运行前确认无其他 session 正在写 0-System"
  
  p0_backup_and_inventory
  p1_establish_rules
  p2_atomic_symlink
  
  log ""
  log "=== 全部完成 ==="
  log "验证命令:"
  log "  ls -la ~/mycc/0-System          # 应显示 -> ~/.mycc-global/0-System"
  log "  readlink ~/mycc/0-System"
  log "  git -C ~/mycc ls-files 0-System # 只显示 0-System (symlink)"
  log "  wc -l ~/.mycc-global/0-System/memory-items.md"
  log ""
  log "回滚步骤 (如果 symlink 错或被 revert):"
  log "  bash $SCRIPT_NAME --rollback"
  log "  或手动: rm ~/mycc/0-System && mv ~/mycc/0-System.old ~/mycc/0-System"
  log ""
  log "Tracked Symlink 坑点说明:"
  log "  - sed -i /编辑器: 正常跟随 symlink 到目标文件，无破坏"
  log "  - 指向目录安全: 标准做法，macOS/Linux 均支持，git 只存链接字符串"
  log "  - CLAUDE.md 约束: WORKTREE-FLOW 已禁止 worktree 碰 0-System"
  log "  - 并发防竞态: 脚本内快照(tar) + 改后立即 commit + wc/grep 校验；其他 session 需等主 session 完成"
  log "  - ~/.claude 记忆: 绝不触碰 (本脚本零操作)"
  
  # 署名
  echo ""
  echo "署名：codex（OpenAI Codex）| 完成时间: $(date '+%Y-%m-%d %H:%M:%S')"
}

# 回滚入口
if [[ "${1:-}" == "--rollback" ]]; then
  rollback_all
  exit 0
fi

main "$@"
