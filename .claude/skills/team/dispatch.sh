#!/usr/bin/env bash
# 分发器: 把 cc 组织好的 prompt 并发发给 grok + codex, 收集两家意见。
# 用法: bash dispatch.sh <prompt文件>   (prompt 由 cc 现场按需组织)
# 输出: /tmp/team-grok.md + /tmp/team-codex.md
set -uo pipefail
PF="${1:-}"
[ -z "$PF" ] || [ ! -f "$PF" ] && { echo "❌ 用法: bash dispatch.sh <prompt文件>"; exit 1; }

export PATH="$HOME/.bun/bin:$PATH"
export GROK_LANE_NO_TOOLS=1 CODEX_LANE_NO_TOOLS=1
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SELF_DIR/_grok_lane.sh"
source "$SELF_DIR/_codex_lane.sh"

CLEAN_CWD="$(mktemp -d)"; trap 'rm -rf "$CLEAN_CWD"' EXIT
PROMPT="$(cat "$PF")"

echo "===== team 圆桌(grok + codex) ====="
echo "prompt: $PF ($(wc -c <"$PF") 字节)"
START=$(date +%s)

run_grok_lane "$PROMPT" /tmp/team-grok.md /tmp/team-grok.err "grok" "$CLEAN_CWD" &
GROK_PID=$!
sleep 0.8   # 错开 omp SQLite race
run_codex_lane "$PROMPT" /tmp/team-codex.md /tmp/team-codex.err "codex" &
CODEX_PID=$!
wait $GROK_PID; GROK_RC=$?
wait $CODEX_PID; CODEX_RC=$?

echo ""
echo "grok:  RC=$GROK_RC, $(wc -l </tmp/team-grok.md 2>/dev/null||echo 0) 行 → /tmp/team-grok.md"
echo "codex: RC=$CODEX_RC, $(wc -l </tmp/team-codex.md 2>/dev/null||echo 0) 行 → /tmp/team-codex.md"
echo "耗时 = $(($(date +%s)-START))s"
[ "$GROK_RC" -ne 0 ] && echo "⚠️ grok: $(tail -3 /tmp/team-grok.err 2>/dev/null)"
[ "$CODEX_RC" -ne 0 ] && echo "⚠️ codex: $(tail -3 /tmp/team-codex.err 2>/dev/null)"

# 退出码: 至少一家成功就算 dispatch 完成(cc 综合时看到另一家失败); 两家都失败才是真失败。
if [ "$GROK_RC" -eq 0 ] || [ "$CODEX_RC" -eq 0 ]; then
  exit 0
else
  exit 1
fi
