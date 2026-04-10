#!/bin/bash
# fetch-wiki-inventory.sh
# 对 wiki-spaces-raw.json 里每个 space 拉取顶级节点，生成 wiki-inventory.md
# 仅读操作，无写入。

set -euo pipefail

SPIKE_DIR="/Users/rayman.chen/mycc/tasks/knowledge-spike"
RAW_FILE="$SPIKE_DIR/wiki-spaces-raw.json"
NODES_DIR="$SPIKE_DIR/wiki-nodes"
OUT="$SPIKE_DIR/wiki-inventory.md"

if [ ! -f "$RAW_FILE" ]; then
  echo "ERROR: $RAW_FILE not found. Run 'lark-cli api GET /open-apis/wiki/v2/spaces --page-all --format json' first." >&2
  exit 1
fi

mkdir -p "$NODES_DIR"

# 去掉 pagination stderr 行（以 [ 开头的）
CLEAN=$(mktemp)
trap 'rm -f "$CLEAN"' EXIT
grep -v '^\[' "$RAW_FILE" > "$CLEAN"

TOTAL=$(jq '.data.items | length' "$CLEAN")
echo "Fetching nodes for $TOTAL spaces..."

# 逐个拉 root nodes
jq -r '.data.items[] | [.space_id, .name] | @tsv' "$CLEAN" | while IFS=$'\t' read -r SID NAME; do
  OUTFILE="$NODES_DIR/$SID.json"
  if [ -f "$OUTFILE" ] && jq -e '.code==0' "$OUTFILE" > /dev/null 2>&1; then
    echo "  [cached] $NAME"
    continue
  fi
  echo "  [fetch ] $NAME"
  if ! lark-cli api GET "/open-apis/wiki/v2/spaces/$SID/nodes" --format json 2>/dev/null > "$OUTFILE"; then
    echo "    FAILED: lark-cli returned error"
  fi
  sleep 0.25
done

# 生成 markdown
{
  echo "# Wiki Inventory"
  echo
  echo "> 生成时间：$(date '+%Y-%m-%d %H:%M %Z')"
  echo "> 总空间数：$TOTAL"
  echo "> 数据源：\`/open-apis/wiki/v2/spaces\` + 每个 space 的顶级节点"
  echo "> 说明：只拉了**根节点**（不递归子节点）。'根节点数' 代表顶级节点个数，'最近更新' 是根节点里 \`obj_edit_time\` 的最大值。"
  echo
  echo "| # | space 名 | space_id | 根节点 | 最近更新 | 样例 title | 描述 |"
  echo "|---|---------|----------|-------|---------|-----------|------|"

  idx=0
  jq -r '.data.items[] | [.space_id, .name, ((.description // "") | gsub("[\n\t]"; " "))] | @tsv' "$CLEAN" | while IFS=$'\t' read -r SID NAME DESC; do
    idx=$((idx+1))
    NODES_FILE="$NODES_DIR/$SID.json"
    if [ -f "$NODES_FILE" ] && jq -e '.code==0' "$NODES_FILE" > /dev/null 2>&1; then
      NODE_COUNT=$(jq '(.data.items // []) | length' "$NODES_FILE")
      LATEST_TS=$(jq '([(.data.items // [])[] | (.obj_edit_time // "0" | tonumber)] | max // 0)' "$NODES_FILE")
      if [ "$LATEST_TS" -gt 0 ] 2>/dev/null; then
        LATEST=$(date -r "$LATEST_TS" '+%Y-%m-%d')
      else
        LATEST="—"
      fi
      SAMPLE=$(jq -r '[(.data.items // [])[0:3][].title] | join(" / ")' "$NODES_FILE")
      if [ -z "$SAMPLE" ] || [ "$SAMPLE" = "null" ]; then
        SAMPLE="(空)"
      fi
    else
      NODE_COUNT="?"
      LATEST="—"
      SAMPLE="(fetch failed)"
    fi
    # 截断描述 + 去换行 + 去表格分隔符
    DESC_SHORT=$(echo "$DESC" | tr '\n|' ' /' | cut -c1-30)
    NAME_SAFE=$(echo "$NAME" | tr '|' '/')
    echo "| $idx | $NAME_SAFE | \`$SID\` | $NODE_COUNT | $LATEST | $SAMPLE | $DESC_SHORT |"
  done
} > "$OUT"

echo
echo "Done: $OUT"
wc -l "$OUT"
