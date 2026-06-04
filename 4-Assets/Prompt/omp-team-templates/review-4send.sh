#!/usr/bin/env bash
# B 四发评审顶级: B4 grok + B5 gpt + B2 gemini-pro + B3 VPS proxy 3.5-flash (付费档)
# 用法: bash review-4send.sh <review-prompt-file>
# ⚠️ 仅顶级 stake 用 (川哥手动触发或 cc 风险预警确认后)
# 输出: /tmp/r-grok.md + /tmp/r-gpt.md + /tmp/r-gem.md + /tmp/r-gem35.md (四家独立 finding)

set -uo pipefail
PROMPT_FILE="${1:-/tmp/review.md}"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "❌ review prompt file 不存在: $PROMPT_FILE"
  echo "用法: bash review-4send.sh <review-prompt-file>"
  exit 1
fi

# 先跑前三家 (复用 review-3send.sh)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "===== 第一阶段: B 三发 (B4+B5+B2) ====="
bash "$SCRIPT_DIR/review-3send.sh" "$PROMPT_FILE"

# 然后跑 B3 VPS proxy 3.5-flash (付费档,thinking 最强)
echo ""
echo "===== 第二阶段: + B3 VPS proxy gemini-3.5-flash (付费档,thinking=high) ====="
START=$(date +%s)

PROMPT_JSON=$(python3 -c "
import json, sys
content = open('$PROMPT_FILE').read()
print(json.dumps({
    'model': 'gemini-3.5-flash',
    'messages': [{'role': 'user', 'content': content}],
    'max_tokens': 65535,
    'reasoning_effort': 'high'
}))
")

curl -s -X POST \
  -H "Authorization: Bearer fq8-1NLtsbVsiJhZaISmNeobvqY0bIZMoafPnKfkuz4" \
  -H "Content-Type: application/json" \
  -d "$PROMPT_JSON" \
  http://23.226.135.149:4000/v1/chat/completions 2>/tmp/r-gem35.err | \
  python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d['choices'][0]['message']['content'])
except Exception as e:
    print(f'❌ 解析失败: {e}', file=sys.stderr)
    sys.exit(1)
" > /tmp/r-gem35.md 2>>/tmp/r-gem35.err
RC=$?

END=$(date +%s)
echo "B3 gemini-3.5-flash (付费): RC=$RC, 输出 $(wc -l </tmp/r-gem35.md 2>/dev/null || echo 0) 行, 耗时 $((END-START))s"
if [ $RC -ne 0 ] || [ ! -s /tmp/r-gem35.md ]; then
  echo "⚠️ B3 失败:"
  tail -5 /tmp/r-gem35.err
fi

echo ""
echo "===== 顶级评审 4 家结果 ====="
echo "  /tmp/r-grok.md (B4 推理,免费)"
echo "  /tmp/r-gpt.md  (B5 严谨,免费)"
echo "  /tmp/r-gem.md  (B2 学术,免费)"
echo "  /tmp/r-gem35.md (B3 顶级深度,💴 付费)"
echo ""
echo "cc 综合 4 家 finding + 跑测试验证 + 写 REVIEW.md"
