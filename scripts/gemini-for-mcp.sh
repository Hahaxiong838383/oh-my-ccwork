#!/usr/bin/env bash
# gemini-for-mcp.sh —— 给 Claude Code MCP (mcp-gemini-cli) 调用用的 Gemini 入口。
# 与 scripts/gemini-mycc.sh 的核心差别：
#   - 本脚本 exec 到「独立官方 CLI」 ~/local/node/bin/gemini (0.38.1)
#   - 原 gemini-mycc.sh exec 到 mycc/node_modules/.bin/gemini（项目本地依赖，可能旧版）
# 目标：让 MCP 调用的 gemini 也共享 mycc 记忆架构（AGENTS.md / GEMINI.md / memory-sync.md / agent-memory）。
# 依赖：~/local/node/bin/gemini 必须已安装（npm i -g --prefix=~/local/node @google/gemini-cli）
set -euo pipefail

ROOT="/Users/rayman.chen/mycc"
LOCAL_GEMINI="/Users/rayman.chen/local/node/bin/gemini"
MEMORY_SYNC_FILE="$ROOT/.gemini/memory-sync.md"

if [[ ! -x "$LOCAL_GEMINI" ]]; then
  echo "[gemini-for-mcp] 未找到独立 Gemini CLI: $LOCAL_GEMINI" >&2
  echo "[gemini-for-mcp] 执行: npm i -g --prefix=/Users/rayman.chen/local/node @google/gemini-cli@0.38.1" >&2
  exit 1
fi

required_files=(
  "$ROOT/AGENTS.md"
  "$ROOT/GEMINI.md"
  "$ROOT/docs/memory-system.md"
  "$ROOT/0-System/status.md"
  "$ROOT/0-System/user-profile.md"
  "$ROOT/0-System/RECENT_EVENTS.md"
  "$ROOT/0-System/memory-items.md"
  "$ROOT/0-System/agent-memory/cc.md"
  "$ROOT/0-System/agent-memory/codex.md"
  "$ROOT/0-System/agent-memory/gemini.md"
)

for f in "${required_files[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "[gemini-for-mcp] 记忆入口缺失: $f" >&2
    exit 1
  fi
done

build_memory_sync() {
  local tmp_file
  tmp_file="$(mktemp)"

  {
    echo "# mycc 共享记忆快照（自动生成 · MCP 通道）"
    echo "> 生成时间: $(date '+%Y-%m-%d %H:%M:%S %z')"
    echo "> 来源: 0-System + agent-memory（与 cc/codex 同源）"
    echo
    echo "## 当前状态（status.md）"
    cat "$ROOT/0-System/status.md"
    echo
    echo "## 用户画像（user-profile.md）"
    cat "$ROOT/0-System/user-profile.md"
    echo
    echo "## 最近事件（RECENT_EVENTS，尾部 120 行）"
    tail -n 120 "$ROOT/0-System/RECENT_EVENTS.md"
    echo
    echo "## 原子记忆（memory-items）"
    echo "### user/agent 类别（全量）"
    awk '
      /^\[(user|agent)\// {in_section=1; print; next}
      /^\[/ {in_section=0}
      {if (in_section) print}
    ' "$ROOT/0-System/memory-items.md"
    echo
    echo "### project 类别索引（仅类别名）"
    awk '/^\[project\// {print "- " $0}' "$ROOT/0-System/memory-items.md"
    echo
    echo "## 多引擎独立记忆（agent-memory）"
    echo "### cc"
    cat "$ROOT/0-System/agent-memory/cc.md"
    echo
    echo "### codex"
    cat "$ROOT/0-System/agent-memory/codex.md"
    echo
    echo "### gemini"
    cat "$ROOT/0-System/agent-memory/gemini.md"
  } > "$tmp_file"

  # 避免 Gemini Import Processor 误解析 @ 为 import 指令
  sed 's/@/＠/g' "$tmp_file" > "$MEMORY_SYNC_FILE"
  rm -f "$tmp_file"
}

build_memory_sync

# 关键：cd 到 mycc，gemini 启动时会自动读取项目级 .gemini/settings.json、
# AGENTS.md、GEMINI.md、.gemini/memory-sync.md 作为 context（与用户级 ~/.gemini 合并）。
cd "$ROOT"

exec "$LOCAL_GEMINI" "$@"
