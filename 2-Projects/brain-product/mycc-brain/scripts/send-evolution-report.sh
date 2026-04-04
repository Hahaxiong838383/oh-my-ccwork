#!/bin/bash
# send-evolution-report.sh — P5 飞书进化日报
# 运行环境：Mini (Mac Mini M4)
# 在 run-eval.sh 之后执行，读取 eval-result.json + evolution-log.jsonl 生成日报

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRAIN_DIR="$(dirname "$SCRIPT_DIR")"
EVAL_RESULT="$BRAIN_DIR/eval/eval-result.json"
EVOLUTION_LOG="$BRAIN_DIR/data/evolution-log.jsonl"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M')

# 飞书 webhook
FEISHU_WEBHOOK="${FEISHU_EVOLUTION_WEBHOOK:-}"

if [ -z "$FEISHU_WEBHOOK" ]; then
  echo "[$TIMESTAMP] FEISHU_EVOLUTION_WEBHOOK not set, skipping daily report"
  exit 0
fi

# 生成报告内容
REPORT=$(python3 << 'PYEOF'
import json, sys, os
from datetime import datetime, timedelta

brain_dir = os.environ.get("BRAIN_DIR", ".")
eval_path = os.path.join(brain_dir, "eval/eval-result.json")
log_path = os.path.join(brain_dir, "data/evolution-log.jsonl")

lines = []
lines.append("**mycc-brain 进化日报**")
lines.append(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
lines.append("")

# 1. Eval Result
if os.path.exists(eval_path):
    with open(eval_path) as f:
        er = json.load(f)
    status = "PASS" if er.get("pass") else "FAIL"
    hit = er.get("retrieval", {}).get("hitRate", 0)
    prec = er.get("retrieval", {}).get("precision", 0)
    lines.append(f"**Eval**: {status}")
    lines.append(f"- 检索: hitRate={hit:.3f} precision={prec:.3f}")

    gen = er.get("generation", {})
    if gen:
        scores = " | ".join(f"{k}={v:.2f}" for k, v in gen.items())
        lines.append(f"- 生成: {scores}")

    regs = er.get("regressions", [])
    if regs:
        lines.append(f"- 回归({len(regs)}):")
        for r in regs:
            icon = "CRITICAL" if r["severity"] == "critical" else "WARNING"
            lines.append(f"  {icon} {r['metric']}: {r['baseline']:.2f} -> {r['current']:.2f} ({r['deltaPct']:+.1f}%)")

    if er.get("needsRollback"):
        lines.append("- **ROLLBACK TRIGGERED**")
else:
    lines.append("**Eval**: No result file")

lines.append("")

# 2. Evolution Log summary (last 24h)
if os.path.exists(log_path):
    cutoff = (datetime.now() - timedelta(hours=24)).isoformat()
    entries = []
    with open(log_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
                if e.get("timestamp", "") >= cutoff:
                    entries.append(e)
            except:
                pass

    eval_count = sum(1 for e in entries if e.get("type") == "eval")
    action_count = sum(1 for e in entries if e.get("type") == "action")
    rollback_count = sum(1 for e in entries if e.get("type") == "rollback")

    lines.append(f"**24h Activity**: eval={eval_count} actions={action_count} rollbacks={rollback_count}")
else:
    lines.append("**24h Activity**: No log file")

# 3. Stable commit
stable_path = os.path.join(brain_dir, "data/last-stable-commit.txt")
if os.path.exists(stable_path):
    with open(stable_path) as f:
        commit = f.read().strip()
    lines.append(f"**Stable Commit**: {commit}")

print("\\n".join(lines))
PYEOF
)

# 发送到飞书
curl -s -X POST "$FEISHU_WEBHOOK" \
  -H "Content-Type: application/json" \
  -d "{\"msg_type\":\"interactive\",\"card\":{\"header\":{\"title\":{\"tag\":\"plain_text\",\"content\":\"Brain Evolution Daily\"},\"template\":\"blue\"},\"elements\":[{\"tag\":\"markdown\",\"content\":\"$REPORT\"}]}}" \
  --noproxy '*' >/dev/null 2>&1 || echo "[$TIMESTAMP] Feishu send failed"

echo "[$TIMESTAMP] Evolution daily report sent"
