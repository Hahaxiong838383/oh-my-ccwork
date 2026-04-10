#!/bin/bash
# run-gemini-extraction.sh
# 对 samples/ 下的 5 篇文档调 Gemini Flash 抽取原子事实，
# 使用 brain 项目的 .env.local 里的 GEMINI_PROXY_KEY + GEMINI_PROXY_BASE。
#
# 预算硬顶：$0.50（超过则中止）
# 输出：
#   samples/${doc_token}-extraction.json   — Gemini 原始响应
#   samples/${doc_token}-facts.json        — 抽取出的 facts 数组
#   samples/extraction-summary.tsv         — 汇总表

set -euo pipefail

SPIKE_DIR="/Users/rayman.chen/mycc/tasks/knowledge-spike"
SAMPLES_DIR="$SPIKE_DIR/samples"
ENV_FILE="/Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/.env.local"
BUDGET_HARD_CAP="0.50"  # USD

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found" >&2
  exit 1
fi

# Base URL 硬编码在 brain 的 src/config.ts:64 (与其一致)
BASE="${GEMINI_PROXY_BASE:-http://23.226.135.149:4000/v1}"
MODEL="${GEMINI_PROXY_MODEL:-gemini-2.5-flash}"

# 只从 .env.local 提取 KEY（避免 source 整个文件）
KEY=$(grep -E '^GEMINI_PROXY_KEY=' "$ENV_FILE" | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")

if [ -z "$KEY" ]; then
  echo "ERROR: GEMINI_PROXY_KEY not found in $ENV_FILE" >&2
  exit 1
fi

echo "Gemini proxy: $BASE"
echo "Model: $MODEL"
echo "Budget cap: \$$BUDGET_HARD_CAP"
echo

# 5 篇文档（与 fetch 脚本一致）
declare -a DOCS=(
  "1.0 公司愿景 & 使命|E8zPdHyNQoCdXtxs7jnc2iLfnNd"
  "2.0 公司战略管理 主页|PWQQd3VPRojuR7xT8cpcqteBnyg"
  "公司治理与方法论|Yv1JdL4whoPHe6xMy4uc0T8OnDe"
  "员工学习与发展|Nq89dT6bzoHi81x3y8HcnC1vnih"
  "Futurus技术知识库入口|Xo0gd0EpWoVFe7xRErEctATFnQe"
)

SUMMARY="$SAMPLES_DIR/extraction-summary.tsv"
printf "title\tdoc_token\tbytes\ttoken_in\ttoken_out\tcost_usd\tfacts\tlatency_ms\tstatus\n" > "$SUMMARY"

# 累计成本
TOTAL_COST="0"

# system prompt（抽取器角色）
SYSTEM_PROMPT='你是一个精确的知识抽取器。从飞书文档正文中抽取"原子事实"。
每个事实必须：
1. 是 1-2 句话的独立断言
2. 包含具体信息（名词/数字/决策），不是空洞套话或目录标题
3. 跳过导航、目录、"同步块"标记、空白占位
4. 如果文档只是目录或空壳，返回空的 facts 数组

输出必须是严格合法 JSON，格式：
{
  "facts": [
    {
      "content": "一段原子事实，1-2 句话，包含具体信息",
      "keywords": ["词1", "词2", "词3"],
      "confidence": 0.0-1.0 的数字,
      "namespace": "类别路径，如 公司/战略/目标"
    }
  ]
}

confidence 低于 0.5 的事实不要输出。keywords 3-6 个中文关键词。namespace 用 / 分层的中文路径。'

for entry in "${DOCS[@]}"; do
  TITLE="${entry%%|*}"
  TOK="${entry#*|}"
  TXT_FILE="$SAMPLES_DIR/${TOK}-pass1.txt"

  if [ ! -f "$TXT_FILE" ]; then
    echo "  [skip] $TITLE (no text file)"
    printf "%s\t%s\t0\t0\t0\t0\t0\t0\tNO_TEXT\n" "$TITLE" "$TOK" >> "$SUMMARY"
    continue
  fi

  BYTES=$(wc -c < "$TXT_FILE" | tr -d ' ')
  CONTENT=$(cat "$TXT_FILE")

  echo "  [extract] $TITLE ($BYTES bytes)"

  # 预算检查
  BUDGET_OK=$(awk -v t="$TOTAL_COST" -v c="$BUDGET_HARD_CAP" 'BEGIN { print (t < c) ? "yes" : "no" }')
  if [ "$BUDGET_OK" = "no" ]; then
    echo "  [budget exceeded] total=\$$TOTAL_COST cap=\$$BUDGET_HARD_CAP"
    printf "%s\t%s\t%s\t0\t0\t0\t0\t0\tBUDGET_CAP\n" "$TITLE" "$TOK" "$BYTES" >> "$SUMMARY"
    continue
  fi

  USER_MSG="文档标题：${TITLE}"$'\n\n'"文档正文（${BYTES} 字节）："$'\n'"${CONTENT}"

  # 构造 JSON body（用 jq 确保转义正确）
  BODY=$(jq -n \
    --arg model "$MODEL" \
    --arg sys "$SYSTEM_PROMPT" \
    --arg user "$USER_MSG" \
    '{
      model: $model,
      messages: [
        {role: "system", content: $sys},
        {role: "user", content: $user}
      ],
      max_tokens: 4096,
      temperature: 0.2,
      response_format: {type: "json_object"}
    }')

  T_START=$(python3 -c 'import time; print(int(time.time()*1000))')
  RAW_FILE="$SAMPLES_DIR/${TOK}-extraction.json"

  HTTP_CODE=$(curl -sS -w "%{http_code}" -o "$RAW_FILE" \
    -X POST "$BASE/chat/completions" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d "$BODY" 2>/dev/null || echo "000")

  T_END=$(python3 -c 'import time; print(int(time.time()*1000))')
  LATENCY=$((T_END - T_START))

  if [ "$HTTP_CODE" != "200" ]; then
    echo "    HTTP $HTTP_CODE"
    printf "%s\t%s\t%s\t0\t0\t0\t0\t%s\tHTTP_%s\n" \
      "$TITLE" "$TOK" "$BYTES" "$LATENCY" "$HTTP_CODE" >> "$SUMMARY"
    continue
  fi

  # 解析响应
  T_IN=$(jq -r '.usage.prompt_tokens // 0' "$RAW_FILE")
  T_OUT=$(jq -r '.usage.completion_tokens // 0' "$RAW_FILE")
  # Gemini Flash 2.5 价格：input $0.075/1M, output $0.30/1M
  COST=$(awk -v ti="$T_IN" -v to="$T_OUT" 'BEGIN { printf "%.6f", ti/1000000*0.075 + to/1000000*0.30 }')
  TOTAL_COST=$(awk -v t="$TOTAL_COST" -v c="$COST" 'BEGIN { printf "%.6f", t + c }')

  # 提取 content 字段里的 JSON
  RESPONSE_CONTENT=$(jq -r '.choices[0].message.content // ""' "$RAW_FILE")
  FACTS_FILE="$SAMPLES_DIR/${TOK}-facts.json"

  # Gemini 可能把 JSON 包在 ```json ... ``` 里
  CLEANED=$(echo "$RESPONSE_CONTENT" | sed -E 's/^```json//; s/^```//; s/```$//')

  if echo "$CLEANED" | jq '.' > "$FACTS_FILE" 2>/dev/null; then
    FACTS_COUNT=$(jq '(.facts // []) | length' "$FACTS_FILE")
  else
    # 保留原 response 以便调试
    echo "$CLEANED" > "${FACTS_FILE}.raw"
    FACTS_COUNT="PARSE_ERR"
  fi

  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\tOK\n" \
    "$TITLE" "$TOK" "$BYTES" "$T_IN" "$T_OUT" "$COST" "$FACTS_COUNT" "$LATENCY" >> "$SUMMARY"

  echo "    T_in=$T_IN T_out=$T_OUT cost=\$$COST facts=$FACTS_COUNT latency=${LATENCY}ms"
  sleep 0.5
done

echo
echo "Total cost: \$$TOTAL_COST"
echo
echo "Summary ($SUMMARY):"
column -t -s $'\t' "$SUMMARY"
