#!/bin/bash
# run-eval.sh — 每日 eval 跑分，结果入 evolution-log.jsonl
# 运行环境：Mini (Mac Mini M4)
# 调用链：Mini eval.ts → Studio brain API (10.9.1.155:19080) → Mini Judge (Gemini via proxy)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRAIN_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$BRAIN_DIR/data/evolution-log.jsonl"
TIMESTAMP=$(date '+%Y-%m-%dT%H:%M:%S')

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

# 运行 eval（TypeScript via tsx/node）
# eval 输出 JSON 到 stdout，错误到 stderr
EVAL_OUTPUT=$(npx tsx src/eval/eval.ts 2>"$BRAIN_DIR/data/eval-stderr.log" || true)

if [ -z "$EVAL_OUTPUT" ]; then
  # stderr 内容做 JSON 转义，防止双引号/反斜杠破坏 JSONL
  STDERR_ESCAPED=$(tail -5 "$BRAIN_DIR/data/eval-stderr.log" 2>/dev/null | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo '"(read failed)"')
  echo "{\"timestamp\":\"$TIMESTAMP\",\"type\":\"eval\",\"status\":\"error\",\"reason\":\"empty_output\",\"stderr\":$STDERR_ESCAPED}" >> "$LOG_FILE"
  echo "[$TIMESTAMP] Eval produced no output"
  exit 1
fi

# 追加结果到 evolution-log.jsonl
echo "{\"timestamp\":\"$TIMESTAMP\",\"type\":\"eval\",\"status\":\"done\",\"result\":$EVAL_OUTPUT}" >> "$LOG_FILE"
echo "[$TIMESTAMP] Eval complete, results appended to evolution-log.jsonl"
