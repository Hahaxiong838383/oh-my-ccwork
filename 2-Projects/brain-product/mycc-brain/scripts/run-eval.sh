#!/bin/bash
# run-eval.sh — 每日 eval 跑分 + P4 回归检测 + 飞书告警
# 运行环境：Mini (Mac Mini M4)
# 调用链：Mini eval.ts → Studio brain API (10.9.1.155:19080) → Mini Judge (Gemini via proxy)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRAIN_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$BRAIN_DIR/data/evolution-log.jsonl"
EVAL_RESULT="$BRAIN_DIR/eval/eval-result.json"
TIMESTAMP=$(date '+%Y-%m-%dT%H:%M:%S')

# 飞书 webhook（进化日报群）
FEISHU_WEBHOOK="${FEISHU_EVAL_WEBHOOK:-}"

# 加载 nvm
source "$HOME/.nvm/nvm.sh"

# 代理设置（Mini 环境，访问 Gemini API 需要代理）
export http_proxy="${http_proxy:-http://127.0.0.1:7890}"
export https_proxy="${https_proxy:-http://127.0.0.1:7890}"
# Studio 内网不走代理
export NO_PROXY="10.9.1.155,localhost,127.0.0.1"
export no_proxy="$NO_PROXY"

# 确保 data 目录存在
mkdir -p "$BRAIN_DIR/data"

# 前置健康检查
echo "[$TIMESTAMP] Checking Studio brain health..."
HEALTH=$(curl -s --noproxy '10.9.1.155' http://10.9.1.155:19080/health 2>/dev/null || echo '{"status":"error"}')
if ! echo "$HEALTH" | grep -q '"ok"'; then
  echo "{\"timestamp\":\"$TIMESTAMP\",\"type\":\"eval\",\"status\":\"skip\",\"reason\":\"studio_unhealthy\",\"detail\":\"$HEALTH\"}" >> "$LOG_FILE"
  echo "[$TIMESTAMP] Studio unhealthy, skipping eval"
  exit 0
fi

echo "[$TIMESTAMP] Running eval..."
cd "$BRAIN_DIR"

# 运行 eval — stdout=JSON, stderr=人类可读日志
# eval.ts v1.1: console.log → JSON, console.error → 人类日志
EVAL_EXIT=0
EVAL_JSON=$(npx tsx src/eval/eval.ts 2>"$BRAIN_DIR/data/eval-stderr.log") || EVAL_EXIT=$?

# stdout 为空时降级读文件
if [ -z "$EVAL_JSON" ]; then
  if [ -f "$EVAL_RESULT" ]; then
    EVAL_JSON=$(cat "$EVAL_RESULT")
  else
    STDERR_ESCAPED=$(tail -5 "$BRAIN_DIR/data/eval-stderr.log" 2>/dev/null | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo '"(read failed)"')
    EVAL_JSON="{\"error\":\"empty_output\",\"stderr\":$STDERR_ESCAPED}"
  fi
fi

# 追加结果到 evolution-log.jsonl
echo "{\"timestamp\":\"$TIMESTAMP\",\"type\":\"eval\",\"status\":\"done\",\"exitCode\":$EVAL_EXIT,\"result\":$EVAL_JSON}" >> "$LOG_FILE"
echo "[$TIMESTAMP] Eval complete (exit=$EVAL_EXIT), results appended to evolution-log.jsonl"

# ─── P4: 回归检测 + 飞书告警 + 回滚 ───

send_feishu() {
  local title="$1"
  local content="$2"
  if [ -z "$FEISHU_WEBHOOK" ]; then
    echo "[$TIMESTAMP] FEISHU_EVAL_WEBHOOK not set, skipping notification"
    return 0
  fi
  curl -s -X POST "$FEISHU_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d "{\"msg_type\":\"interactive\",\"card\":{\"header\":{\"title\":{\"tag\":\"plain_text\",\"content\":\"$title\"},\"template\":\"red\"},\"elements\":[{\"tag\":\"markdown\",\"content\":\"$content\"}]}}" \
    --noproxy '*' >/dev/null 2>&1 || true
}

if [ $EVAL_EXIT -eq 3 ]; then
  # CRITICAL 回归 → 飞书告警 + 回滚
  echo "[$TIMESTAMP] 🚨 CRITICAL regression detected! Triggering rollback..."

  # 提取回归详情
  REGRESSIONS=$(echo "$EVAL_JSON" | python3 -c '
import json,sys
d = json.load(sys.stdin)
lines = []
for r in d.get("regressions", []):
    icon = "🔴" if r["severity"] == "critical" else "🟡"
    lines.append(f"{icon} {r[\"metric\"]}: {r[\"baseline\"]:.2f} → {r[\"current\"]:.2f} ({r[\"deltaPct\"]:+.1f}%)")
print("\\n".join(lines))
' 2>/dev/null || echo "parse failed")

  # 飞书告警
  send_feishu "🚨 Brain Eval 回归告警" "**时间**: $TIMESTAMP\\n**状态**: CRITICAL 回归，已触发回滚\\n\\n$REGRESSIONS"

  # 回滚：恢复上一个稳定版本
  if [ -f "$BRAIN_DIR/data/last-stable-commit.txt" ]; then
    STABLE_COMMIT=$(cat "$BRAIN_DIR/data/last-stable-commit.txt")
    echo "[$TIMESTAMP] Rolling back to stable commit: $STABLE_COMMIT"
    echo "{\"timestamp\":\"$TIMESTAMP\",\"type\":\"rollback\",\"target\":\"$STABLE_COMMIT\",\"reason\":\"regression\"}" >> "$LOG_FILE"
    # 注意：实际回滚需要在 Studio 上执行 git checkout + rebuild + pm2 restart
    # 这里仅记录标记，由 deploy-to-studio.sh 根据此文件决定是否回退
    echo "$STABLE_COMMIT" > "$BRAIN_DIR/data/rollback-target.txt"
  else
    echo "[$TIMESTAMP] No last-stable-commit.txt found, cannot auto-rollback"
  fi

elif [ $EVAL_EXIT -eq 0 ]; then
  # 通过 → 记录稳定版本
  CURRENT_COMMIT=$(git -C "$BRAIN_DIR" log -1 --format=%h 2>/dev/null || echo "unknown")
  echo "$CURRENT_COMMIT" > "$BRAIN_DIR/data/last-stable-commit.txt"
  echo "[$TIMESTAMP] ✅ Eval passed, stable commit: $CURRENT_COMMIT"

  # 检查是否有非 critical 的 warning 回归
  WARNING_COUNT=$(echo "$EVAL_JSON" | python3 -c '
import json,sys
d = json.load(sys.stdin)
print(len([r for r in d.get("regressions", []) if r["severity"] == "warning"]))
' 2>/dev/null || echo "0")

  if [ "$WARNING_COUNT" -gt 0 ]; then
    WARNINGS=$(echo "$EVAL_JSON" | python3 -c '
import json,sys
d = json.load(sys.stdin)
lines = []
for r in d.get("regressions", []):
    if r["severity"] == "warning":
        lines.append(f"🟡 {r[\"metric\"]}: {r[\"baseline\"]:.2f} → {r[\"current\"]:.2f} ({r[\"deltaPct\"]:+.1f}%)")
print("\\n".join(lines))
' 2>/dev/null || echo "")
    send_feishu "⚠️ Brain Eval 轻微回归" "**时间**: $TIMESTAMP\\n**状态**: 通过，但有 $WARNING_COUNT 项轻微回归\\n\\n$WARNINGS"
  fi

elif [ $EVAL_EXIT -eq 1 ]; then
  # 评测未通过（但非回归）
  echo "[$TIMESTAMP] ❌ Eval failed (not a regression, thresholds not met)"
  FAILURES=$(echo "$EVAL_JSON" | python3 -c '
import json,sys
d = json.load(sys.stdin)
print(f"pass={d.get(\"pass\",False)}, hitRate={d.get(\"retrieval\",{}).get(\"hitRate\",0):.3f}, precision={d.get(\"retrieval\",{}).get(\"precision\",0):.3f}")
' 2>/dev/null || echo "unknown")
  send_feishu "❌ Brain Eval 未通过" "**时间**: $TIMESTAMP\\n**状态**: 阈值未达标（非回归）\\n\\n$FAILURES"
fi
