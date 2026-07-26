#!/usr/bin/env bash
# 分发器: 把 cc 组织好的 prompt 并发发给 grok + codex, 收集两家意见。
# 用法: bash dispatch.sh <prompt文件>   (prompt 由 cc 现场按需组织)
# 输出: per-run 唯一文件(2026-07-26 P2④ 防并发互踩), 实际路径以本脚本 stdout 报告为准
set -uo pipefail
PF="${1:-}"
[ -z "$PF" ] || [ ! -f "$PF" ] && { echo "❌ 用法: bash dispatch.sh <prompt文件>"; exit 1; }

# per-run 产物路径: 时间戳+PID 保证并发 dispatch 互不覆盖
RUN_TAG="$(date +%m%d-%H%M%S).$$"
OUT_GROK="/tmp/team-grok.$RUN_TAG.md";  ERR_GROK="/tmp/team-grok.$RUN_TAG.err"
OUT_CODEX="/tmp/team-codex.$RUN_TAG.md"; ERR_CODEX="/tmp/team-codex.$RUN_TAG.err"

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

run_grok_lane "$PROMPT" "$OUT_GROK" "$ERR_GROK" "grok" "$CLEAN_CWD" &
GROK_PID=$!
sleep 0.8   # 错开 omp SQLite race
run_codex_lane "$PROMPT" "$OUT_CODEX" "$ERR_CODEX" "codex" &
CODEX_PID=$!
wait $GROK_PID; GROK_RC=$?
wait $CODEX_PID; CODEX_RC=$?

echo ""
echo "grok:  RC=$GROK_RC, $(wc -l <"$OUT_GROK" 2>/dev/null||echo 0) 行 → $OUT_GROK"
echo "codex: RC=$CODEX_RC, $(wc -l <"$OUT_CODEX" 2>/dev/null||echo 0) 行 → $OUT_CODEX"
echo "耗时 = $(($(date +%s)-START))s"
[ "$GROK_RC" -ne 0 ] && echo "⚠️ grok: $(tail -3 "$ERR_GROK" 2>/dev/null)"
[ "$CODEX_RC" -ne 0 ] && echo "⚠️ codex: $(tail -3 "$ERR_CODEX" 2>/dev/null)"

# 退出码: 至少一家成功就算 dispatch 完成(cc 综合时看到另一家失败); 两家都失败才是真失败。
if [ "$GROK_RC" -eq 0 ] || [ "$CODEX_RC" -eq 0 ]; then
  exit 0
else
  exit 1
fi
