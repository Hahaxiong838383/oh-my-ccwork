#!/bin/bash
# run-eval.sh — 每日 eval 跑分 + P4 回归检测 + 飞书告警
# 运行环境：Mini (Mac Mini M4)
# 调用链：Mini eval.ts → Studio brain API (10.9.1.155:19080) → Mini Judge (Gemini via proxy)

set -uo pipefail
# 注意：不用 set -e，因为 eval.ts 的非零退出码（1=未达标, 3=回归）是正常业务状态，
# 不应中断后续的结果写入和日志追加流程。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRAIN_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$BRAIN_DIR/data/evolution-log.jsonl"
EVAL_RESULT="$BRAIN_DIR/eval/eval-result.json"
EVAL_STDOUT_FILE="$BRAIN_DIR/data/eval-stdout.log"
EVAL_STDERR_FILE="$BRAIN_DIR/data/eval-stderr.log"
TIMESTAMP=$(date '+%Y-%m-%dT%H:%M:%S')

# 紧凑化 JSON（输入 stdin，输出单行 JSON）
compact_json_stdin() {
  python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), separators=(",",":"), ensure_ascii=False))'
}

# 转义原始字符串为 JSON 字符串字面量（输入 stdin）
escape_json_string_stdin() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

# 加载项目运行时环境：
# 1) 先加载 .env.local
# 2) 再加载 .env
# 3) 还原 .env.local 中的同名变量，保证 .env.local 优先
load_project_env() {
  local env_local="$BRAIN_DIR/.env.local"
  local env_file="$BRAIN_DIR/.env"
  local -a local_keys=()
  local key=""

  if [ -f "$env_local" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_local"
    set +a

    # 记录 .env.local 中定义的变量及其已生效值
    while IFS= read -r key; do
      [ -n "$key" ] || continue
      local_keys+=("$key")
      if [ "${!key+x}" = "x" ]; then
        eval "__MYCC_ENVLOCAL_VAL_${key}=$(printf '%q' "${!key}")"
      fi
    done < <(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' "$env_local")
  fi

  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi

  # 回放 .env.local 的值，防止被 .env 覆盖
  for key in "${local_keys[@]}"; do
    eval "export ${key}=\${__MYCC_ENVLOCAL_VAL_${key}-}"
  done
}

load_project_env

# 飞书 webhook（进化日报群）
FEISHU_WEBHOOK="${FEISHU_EVAL_WEBHOOK:-}"

# 加载 nvm（容错：不存在或加载失败时仅告警，不中断后续）
NVM_SH="${NVM_DIR:-${HOME:-}/.nvm}/nvm.sh"
if [ -s "$NVM_SH" ]; then
  # shellcheck disable=SC1090
  if ! . "$NVM_SH"; then
    echo "[$TIMESTAMP] WARNING: nvm 加载失败，继续使用当前 PATH 中的 Node.js"
  fi
else
  echo "[$TIMESTAMP] WARNING: 未找到 nvm.sh，继续使用当前 PATH 中的 Node.js"
fi

# 代理设置（Mini 环境，访问 Gemini Proxy VPS 需要代理）
export http_proxy="${http_proxy:-http://127.0.0.1:7890}"
export https_proxy="${https_proxy:-http://127.0.0.1:7890}"
# Studio 内网 + Gemini Proxy VPS 不走代理
export NO_PROXY="10.9.1.155,23.226.135.149,localhost,127.0.0.1"
export no_proxy="$NO_PROXY"

# Admin 认证（eval 需要调 /admin/api/memory-preview）
export ADMIN_USER="${ADMIN_USER:-admin}"
export ADMIN_PASS="${ADMIN_PASS:-}"

# Gemini Judge 走 Proxy（litellm OpenAI 兼容格式）
export GEMINI_PROXY_BASE="${GEMINI_PROXY_BASE:-http://23.226.135.149:4000/v1}"

if [ -z "${GEMINI_PROXY_KEY:-}" ] && [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "[$TIMESTAMP] GEMINI_PROXY_KEY / GEMINI_API_KEY 未配置，生成层评测将跳过（仅检索层）"
fi

# 确保 data 目录存在
mkdir -p "$BRAIN_DIR/data"

# 前置健康检查
echo "[$TIMESTAMP] Checking Studio brain health..."
HEALTH=$(curl -s --noproxy '10.9.1.155' http://10.9.1.155:19080/health 2>/dev/null || echo '{"status":"error"}')
if ! printf '%s' "$HEALTH" | grep -q '"ok"'; then
  HEALTH_ESCAPED=$(printf '%s' "$HEALTH" | escape_json_string_stdin 2>/dev/null || echo '"(health read failed)"')
  printf '%s\n' "{\"timestamp\":\"$TIMESTAMP\",\"type\":\"eval\",\"status\":\"skip\",\"reason\":\"studio_unhealthy\",\"detail\":$HEALTH_ESCAPED}" >> "$LOG_FILE"
  echo "[$TIMESTAMP] Studio unhealthy, skipping eval"
  exit 0
fi

echo "[$TIMESTAMP] Running eval..."
cd "$BRAIN_DIR"

# 运行 eval — stdout=JSON, stderr=人类可读日志
# run-eval.sh 支持透传参数（例如 --dry-run）
EVAL_ARGS=("$@")
EVAL_EXIT=0
EVAL_STDOUT=""
: >"$EVAL_STDOUT_FILE"
: >"$EVAL_STDERR_FILE"

if command -v npx >/dev/null 2>&1; then
  if npx tsx src/eval/eval.ts "${EVAL_ARGS[@]}" >"$EVAL_STDOUT_FILE" 2>"$EVAL_STDERR_FILE"; then
    EVAL_EXIT=0
  else
    EVAL_EXIT=$?
  fi
else
  EVAL_EXIT=127
  printf '%s\n' "npx 未找到，无法执行评测" >"$EVAL_STDERR_FILE"
fi

EVAL_STDOUT=$(cat "$EVAL_STDOUT_FILE" 2>/dev/null || true)

# 验证 stdout 是否为有效 JSON（修复：混入非 JSON 文本时降级到 eval-result.json）
EVAL_JSON=""
if [ -n "$EVAL_STDOUT" ]; then
  if EVAL_JSON_COMPACT=$(printf '%s' "$EVAL_STDOUT" | compact_json_stdin 2>/dev/null); then
    EVAL_JSON="$EVAL_JSON_COMPACT"
  fi
fi

# stdout 无效时降级到 eval-result.json
if [ -z "$EVAL_JSON" ] && [ -f "$EVAL_RESULT" ]; then
  if EVAL_JSON_COMPACT=$(compact_json_stdin <"$EVAL_RESULT" 2>/dev/null); then
    EVAL_JSON="$EVAL_JSON_COMPACT"
  fi
fi

# 仍然为空时构造错误 JSON
if [ -z "$EVAL_JSON" ]; then
  STDERR_ESCAPED=$(tail -20 "$EVAL_STDERR_FILE" 2>/dev/null | escape_json_string_stdin 2>/dev/null || echo '"(read failed)"')
  EVAL_JSON="{\"error\":\"empty_output\",\"exitCode\":$EVAL_EXIT,\"stderr\":$STDERR_ESCAPED}"
fi

# 追加结果到 evolution-log.jsonl（确保是有效 JSONL）
printf '%s\n' "{\"timestamp\":\"$TIMESTAMP\",\"type\":\"eval\",\"status\":\"done\",\"exitCode\":$EVAL_EXIT,\"result\":$EVAL_JSON}" >> "$LOG_FILE"
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

if [ "$EVAL_EXIT" -eq 3 ]; then
  echo "[$TIMESTAMP] CRITICAL regression detected! Triggering rollback..."
  REGRESSIONS=$(printf '%s' "$EVAL_JSON" | python3 -c '
import json,sys
d = json.load(sys.stdin)
lines = []
for r in d.get("regressions", []):
    icon = "🔴" if r["severity"] == "critical" else "🟡"
    lines.append(f"{icon} {r[\"metric\"]}: {r[\"baseline\"]:.2f} → {r[\"current\"]:.2f} ({r[\"deltaPct\"]:+.1f}%)")
print("\\n".join(lines))
' 2>/dev/null || echo "parse failed")
  send_feishu "🚨 Brain Eval 回归告警" "**时间**: $TIMESTAMP\\n**状态**: CRITICAL 回归，已触发回滚\\n\\n$REGRESSIONS"
  if [ -f "$BRAIN_DIR/data/last-stable-commit.txt" ]; then
    STABLE_COMMIT=$(cat "$BRAIN_DIR/data/last-stable-commit.txt")
    echo "[$TIMESTAMP] Rolling back to stable commit: $STABLE_COMMIT"
    printf '%s\n' "{\"timestamp\":\"$TIMESTAMP\",\"type\":\"rollback\",\"target\":\"$STABLE_COMMIT\",\"reason\":\"regression\"}" >> "$LOG_FILE"
    echo "$STABLE_COMMIT" > "$BRAIN_DIR/data/rollback-target.txt"
  fi

elif [ "$EVAL_EXIT" -eq 0 ]; then
  CURRENT_COMMIT=$(git -C "$BRAIN_DIR" log -1 --format=%h 2>/dev/null || echo "unknown")
  echo "$CURRENT_COMMIT" > "$BRAIN_DIR/data/last-stable-commit.txt"
  echo "[$TIMESTAMP] Eval passed, stable commit: $CURRENT_COMMIT"
  WARNING_COUNT=$(printf '%s' "$EVAL_JSON" | python3 -c '
import json,sys
d = json.load(sys.stdin)
print(len([r for r in d.get("regressions", []) if r["severity"] == "warning"]))
' 2>/dev/null || echo "0")
  if [ "$WARNING_COUNT" -gt 0 ]; then
    WARNINGS=$(printf '%s' "$EVAL_JSON" | python3 -c '
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

elif [ "$EVAL_EXIT" -eq 1 ]; then
  echo "[$TIMESTAMP] Eval failed (not a regression, thresholds not met)"
  FAILURES=$(printf '%s' "$EVAL_JSON" | python3 -c '
import json,sys
d = json.load(sys.stdin)
print(f"pass={d.get(\"pass\",False)}, hitRate={d.get(\"retrieval\",{}).get(\"hitRate\",0):.3f}, precision={d.get(\"retrieval\",{}).get(\"precision\",0):.3f}")
' 2>/dev/null || echo "unknown")
  send_feishu "❌ Brain Eval 未通过" "**时间**: $TIMESTAMP\\n**状态**: 阈值未达标（非回归）\\n\\n$FAILURES"

else
  echo "[$TIMESTAMP] Eval exited unexpectedly (exit=$EVAL_EXIT)"
  LAST_STDERR=$(tail -20 "$EVAL_STDERR_FILE" 2>/dev/null || echo "stderr unavailable")
  send_feishu "❗ Brain Eval 异常退出" "**时间**: $TIMESTAMP\\n**状态**: 异常退出（exit=$EVAL_EXIT）\\n\\n\`\`\`\\n$LAST_STDERR\\n\`\`\`"
fi
