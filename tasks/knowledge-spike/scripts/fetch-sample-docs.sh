#!/bin/bash
# fetch-sample-docs.sh
# 从 ⌘FUTURUS知识库 (space_id=7224326117803425820) 拉 5 篇典型文档，
# 每篇拉 3 次，验证 content-hash 稳定性。
#
# 输出：
#   samples/${doc_token}-pass${N}.json   — 原始 API 响应
#   samples/${doc_token}-pass${N}.txt    — 抽取的纯文本正文
#   samples/fetch-report.tsv             — 汇总表（title/bytes/hash x 3/stable）

set -euo pipefail

SPIKE_DIR="/Users/rayman.chen/mycc/tasks/knowledge-spike"
SAMPLES_DIR="$SPIKE_DIR/samples"
mkdir -p "$SAMPLES_DIR"

# 5 篇根节点文档（title|obj_token）
declare -a DOCS=(
  "1.0 公司愿景 & 使命|E8zPdHyNQoCdXtxs7jnc2iLfnNd"
  "2.0 公司战略管理 主页|PWQQd3VPRojuR7xT8cpcqteBnyg"
  "公司治理与方法论|Yv1JdL4whoPHe6xMy4uc0T8OnDe"
  "员工学习与发展|Nq89dT6bzoHi81x3y8HcnC1vnih"
  "Futurus技术知识库入口|Xo0gd0EpWoVFe7xRErEctATFnQe"
)

REPORT="$SAMPLES_DIR/fetch-report.tsv"
printf "title\tdoc_token\tbytes\thash1\thash2\thash3\tstable\n" > "$REPORT"

echo "Fetching ${#DOCS[@]} docs x 3 passes..."

for entry in "${DOCS[@]}"; do
  TITLE="${entry%%|*}"
  TOK="${entry#*|}"
  echo "  [fetch] $TITLE ($TOK)"

  HASHES=()
  for i in 1 2 3; do
    JSON_OUT="$SAMPLES_DIR/${TOK}-pass${i}.json"
    TXT_OUT="$SAMPLES_DIR/${TOK}-pass${i}.txt"

    if ! lark-cli api GET "/open-apis/docx/v1/documents/$TOK/raw_content" --format json 2>/dev/null > "$JSON_OUT"; then
      echo "    FAILED pass $i"
      HASHES+=("FETCH_FAIL")
      continue
    fi

    # 检查 API 错误
    CODE=$(jq -r '.code // "null"' "$JSON_OUT")
    if [ "$CODE" != "0" ]; then
      MSG=$(jq -r '.msg // "unknown"' "$JSON_OUT")
      echo "    API ERROR pass $i: code=$CODE msg=$MSG"
      HASHES+=("API_ERR_$CODE")
      continue
    fi

    # 抽取 content 字段到 txt 文件（统一格式）
    jq -r '.data.content // ""' "$JSON_OUT" > "$TXT_OUT"

    # 对 txt 算 sha256
    HASH=$(shasum -a 256 "$TXT_OUT" | cut -d' ' -f1)
    HASHES+=("$HASH")
    sleep 0.25
  done

  # 取 pass1 的字节数
  if [ -f "$SAMPLES_DIR/${TOK}-pass1.txt" ]; then
    BYTES=$(wc -c < "$SAMPLES_DIR/${TOK}-pass1.txt" | tr -d ' ')
  else
    BYTES=0
  fi

  # 稳定性判断
  if [ "${HASHES[0]}" = "${HASHES[1]}" ] && [ "${HASHES[1]}" = "${HASHES[2]}" ] && [[ "${HASHES[0]}" != FETCH_FAIL* && "${HASHES[0]}" != API_ERR* ]]; then
    STABLE="YES"
  else
    STABLE="NO"
  fi

  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
    "$TITLE" "$TOK" "$BYTES" \
    "${HASHES[0]:0:12}" "${HASHES[1]:0:12}" "${HASHES[2]:0:12}" \
    "$STABLE" >> "$REPORT"
done

echo
echo "Report ($REPORT):"
column -t -s $'\t' "$REPORT"
