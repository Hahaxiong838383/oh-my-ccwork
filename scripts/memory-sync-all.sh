#!/usr/bin/env bash
# memory-sync-all.sh — 三引擎统一记忆同步入口
# 用法: bash scripts/memory-sync-all.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="$ROOT/scripts/memory-sync-all.log"
mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"

now() { date '+%Y-%m-%d %H:%M:%S'; }
append_log() { echo "$(now) $*" >> "$LOG_FILE"; }

RESULT="OK"

required_files=(
  "CLAUDE.md"
  "AGENTS.md"
  "GEMINI.md"
  "0-System/status.md"
  "0-System/user-profile.md"
  "0-System/RECENT_EVENTS.md"
  "0-System/memory-items.md"
  "0-System/agent-memory/cc.md"
  "0-System/agent-memory/codex.md"
  "0-System/agent-memory/gemini.md"
)

for rel in "${required_files[@]}"; do
  if [[ ! -e "$ROOT/$rel" ]]; then
    RESULT="$RESULT missing=$rel"
  fi
done

# 校验 AGENTS 与 CLAUDE 同源
if [[ -L "$ROOT/AGENTS.md" ]]; then
  target="$(readlink "$ROOT/AGENTS.md" || true)"
  if [[ "$target" == "CLAUDE.md" ]]; then
    RESULT="$RESULT agents=link_ok"
  else
    RESULT="$RESULT agents=link_BAD($target)"
  fi
elif cmp -s "$ROOT/AGENTS.md" "$ROOT/CLAUDE.md"; then
  RESULT="$RESULT agents=file_equal"
else
  RESULT="$RESULT agents=file_diff"
fi

# 1) Air -> Mini 同步（已有脚本）
if [[ -x "$ROOT/scripts/sync-to-mini.sh" ]]; then
  if bash "$ROOT/scripts/sync-to-mini.sh" >/dev/null 2>&1; then
    RESULT="$RESULT air2mini=ok"
  else
    RESULT="$RESULT air2mini=FAIL"
  fi
else
  RESULT="$RESULT air2mini=skip(no-script)"
fi

# 2) Mini -> Studio 同步（可选；仅当可达时执行）
BRAIN_SYNC="$ROOT/2-Projects/brain-product/mycc-brain/scripts/sync-data.sh"
if [[ -x "$BRAIN_SYNC" ]]; then
  SHOULD_RUN_BRAIN_SYNC=0
  if [[ "${FORCE_BRAIN_SYNC:-0}" == "1" ]]; then
    SHOULD_RUN_BRAIN_SYNC=1
  elif ssh -o BatchMode=yes -o ConnectTimeout=2 studio true >/dev/null 2>&1; then
    SHOULD_RUN_BRAIN_SYNC=1
  elif ssh -o BatchMode=yes -o ConnectTimeout=2 studio-pub true >/dev/null 2>&1; then
    SHOULD_RUN_BRAIN_SYNC=1
  fi

  if [[ "$SHOULD_RUN_BRAIN_SYNC" == "1" ]]; then
    if bash "$BRAIN_SYNC" >/dev/null 2>&1; then
      RESULT="$RESULT mini2studio=ok"
    else
      RESULT="$RESULT mini2studio=FAIL"
    fi
  else
    RESULT="$RESULT mini2studio=skip(unreachable)"
  fi
else
  RESULT="$RESULT mini2studio=skip(no-script)"
fi

# 3) 健康检查（不阻断主流程）
check_health() {
  local name="$1"
  local url="$2"
  if curl -sS --max-time 5 --connect-timeout 2 --noproxy '*' "$url" >/dev/null 2>&1; then
    RESULT="$RESULT ${name}=ok"
  else
    RESULT="$RESULT ${name}=FAIL"
  fi
}

check_health "h18080" "http://127.0.0.1:18080/health"
check_health "h19080" "http://10.9.1.155:19080/health"
check_health "h4000" "http://23.226.135.149:4000/health"

append_log "$RESULT"
echo "$RESULT"

