#!/usr/bin/env bash
# openclaw-bropdca-feishu 安装脚本
# 将 BRO-PDCA 方法论文件部署到 openclaw agent 目录
# 用法：bash install.sh [--dry-run]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# ── 解析 openclaw 目录 ──────────────────────────────────────────
resolve_openclaw_dir() {
  if [[ -n "${OPENCLAW_STATE_DIR:-}" ]]; then
    echo "$OPENCLAW_STATE_DIR"
    return
  fi
  for dir in ".openclaw" ".clawdbot" ".moldbot" ".moltbot"; do
    local p="$HOME/$dir"
    if [[ -d "$p" ]]; then
      echo "$p"
      return
    fi
  done
  echo "$HOME/.openclaw"
}

OPENCLAW_DIR="$(resolve_openclaw_dir)"
AGENT_DIR="$OPENCLAW_DIR/agents/main"
INSTRUCTIONS_DIR="$AGENT_DIR/instructions"
TIMESTAMP="$(date '+%Y%m%d_%H%M%S')"

log() { echo "[install] $*"; }
dry_log() { echo "[DRY-RUN] $*"; }

# ── 备份现有 instructions ──────────────────────────────────────
backup_existing() {
  if [[ -d "$INSTRUCTIONS_DIR" ]]; then
    local backup="$AGENT_DIR/instructions.backup.$TIMESTAMP"
    if $DRY_RUN; then
      dry_log "Would backup $INSTRUCTIONS_DIR → $backup"
    else
      cp -r "$INSTRUCTIONS_DIR" "$backup"
      log "备份原有 instructions → $backup"
    fi
  fi
}

# ── 安装文件 ───────────────────────────────────────────────────
install_files() {
  if $DRY_RUN; then
    dry_log "Would create $INSTRUCTIONS_DIR/"
    dry_log "Would copy: SYSTEM.md → $INSTRUCTIONS_DIR/SYSTEM.md"
    dry_log "Would copy: bropdca-feishu.md → $INSTRUCTIONS_DIR/bropdca-feishu.md"
    dry_log "Would copy: quick-reference.md → $INSTRUCTIONS_DIR/quick-reference.md"
    return
  fi

  mkdir -p "$INSTRUCTIONS_DIR"
  cp "$SCRIPT_DIR/SYSTEM.md"           "$INSTRUCTIONS_DIR/SYSTEM.md"
  cp "$SCRIPT_DIR/bropdca-feishu.md"   "$INSTRUCTIONS_DIR/bropdca-feishu.md"
  cp "$SCRIPT_DIR/quick-reference.md"  "$INSTRUCTIONS_DIR/quick-reference.md"

  log "✅ 已安装："
  log "   $INSTRUCTIONS_DIR/SYSTEM.md          ← 主系统指令（核心）"
  log "   $INSTRUCTIONS_DIR/bropdca-feishu.md  ← BRO-PDCA 详细参考"
  log "   $INSTRUCTIONS_DIR/quick-reference.md ← 快速决策卡"
}

# ── 写入 openclaw.json system_prompt 引用 ─────────────────────
update_config() {
  local config_file=""
  for fname in "openclaw.json" "clawdbot.json" "moldbot.json"; do
    [[ -f "$OPENCLAW_DIR/$fname" ]] && config_file="$OPENCLAW_DIR/$fname" && break
  done

  if [[ -z "$config_file" ]]; then
    log "未找到 openclaw.json，跳过 config 更新（手动将 SYSTEM.md 内容粘贴到 system_prompt 配置）"
    return
  fi

  if $DRY_RUN; then
    dry_log "Would update system_prompt in $config_file"
    return
  fi

  # 用 python3 原子更新 JSON（避免 jq 依赖）
  python3 - "$config_file" "$INSTRUCTIONS_DIR/SYSTEM.md" <<'PYEOF'
import json, sys, pathlib, tempfile, os

config_path = pathlib.Path(sys.argv[1])
system_md   = pathlib.Path(sys.argv[2]).read_text()

config = json.loads(config_path.read_text()) if config_path.exists() else {}
config.setdefault("agent", {})["system_prompt"] = system_md
config["agent"]["instructions_dir"] = str(pathlib.Path(sys.argv[2]).parent)

# 原子写
tmp = config_path.with_suffix(".tmp")
tmp.write_text(json.dumps(config, ensure_ascii=False, indent=2))
os.replace(tmp, config_path)
print(f"[install] ✅ 更新 {config_path}")
PYEOF
}

# ── 主流程 ─────────────────────────────────────────────────────
main() {
  log "OpenClaw BRO-PDCA 安装脚本 v1.0"
  log "目标目录：$OPENCLAW_DIR"
  $DRY_RUN && log "DRY-RUN 模式，不写入任何文件"
  echo ""

  backup_existing
  install_files
  update_config

  echo ""
  log "安装完成。重启 openclaw 后生效。"
  log ""
  log "验证方法："
  log "  openclaw 'BRO-PDCA 是什么？' （应该返回方法论概述）"
  log "  openclaw '帮我拆这个任务：...' （应该走三档位判断）"
}

main "$@"
