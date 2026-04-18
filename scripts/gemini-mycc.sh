#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/rayman.chen/mycc"
LOCAL_GEMINI="$ROOT/node_modules/.bin/gemini"
MEMORY_SYNC_FILE="$ROOT/.gemini/memory-sync.md"

if [[ ! -x "$LOCAL_GEMINI" ]]; then
  echo "[gemini-mycc] 未找到本地 Gemini CLI: $LOCAL_GEMINI" >&2
  echo "[gemini-mycc] 请先执行: npm install --save-dev @google/gemini-cli" >&2
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
    echo "[gemini-mycc] 记忆入口缺失: $f" >&2
    exit 1
  fi
done

build_memory_sync() {
  local tmp_file
  tmp_file="$(mktemp)"

  {
    echo "# mycc 共享记忆快照（自动生成）"
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

  # 避免 Gemini Import Processor 将正文中的 @ 误判为导入语法
  sed 's/@/＠/g' "$tmp_file" > "$MEMORY_SYNC_FILE"
  rm -f "$tmp_file"
}

build_memory_sync

mkdir -p "$HOME/.gemini"

# Gemini CLI 本身会自动合并用户级 ~/.gemini/settings.json 和项目级
# $ROOT/.gemini/settings.json。不要在启动时覆盖用户设置，否则会清掉
# CLI 持久化写入的认证选择，导致每次启动都重新弹浏览器授权。

if [[ "${PWD}" != "$ROOT"* ]]; then
  cd "$ROOT"
fi

exec "$LOCAL_GEMINI" "$@"
