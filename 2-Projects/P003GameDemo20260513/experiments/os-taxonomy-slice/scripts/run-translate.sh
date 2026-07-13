#!/bin/bash
# run-translate.sh [topics|reasons] [批次号...]  — 不带批次号则跑全部未完成批次
# grok(omp xai-oauth/grok-4.5) 批量翻译 + 校验 + 重试2次 + 断点续跑
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KIND="${1:-topics}"
shift || true

PROMPT_TPL="$ROOT/prompts/translate-${KIND}.md"
IN_DIR="$ROOT/batches/$KIND"
OUT_DIR="$ROOT/batches-out/$KIND"
RAW_DIR="$ROOT/batches-raw/$KIND"
mkdir -p "$OUT_DIR" "$RAW_DIR"

EXTRA_FLAG=""
[ "$KIND" = "reasons" ] && EXTRA_FLAG="--reasons"

if [ $# -gt 0 ]; then
  BATCHES=("$@")
else
  BATCHES=()
  for f in "$IN_DIR"/batch-*.json; do
    b="$(basename "$f" .json)"
    [ -s "$OUT_DIR/$b.json" ] && continue   # 已完成跳过
    BATCHES+=("$b")
  done
fi

echo "[$KIND] 待跑 ${#BATCHES[@]} 批"
FAILED=()

for b in "${BATCHES[@]}"; do
  src="$IN_DIR/$b.json"
  raw="$RAW_DIR/$b.txt"
  out="$OUT_DIR/$b.json"
  ok=0
  for attempt in 1 2 3; do
    # 组 prompt：模板 + 批次数据
    prompt_file="/tmp/xk-translate-$KIND-$b.md"
    sed "/{{BATCH_JSON}}/q" "$PROMPT_TPL" | sed 's/{{BATCH_JSON}}//' > "$prompt_file"
    cat "$src" >> "$prompt_file"

    PATH="$HOME/.bun/bin:$PATH" omp -p \
      --model xai-oauth/grok-4.5 --thinking low \
      --auto-approve --no-extensions --no-skills --no-rules \
      "$(cat "$prompt_file")" > "$raw" 2>"$RAW_DIR/$b.err"
    rc=$?
    if [ $rc -ne 0 ] || [ ! -s "$raw" ]; then
      echo "[$b] 第 $attempt 次: omp rc=$rc 或输出为空，重试"
      sleep 3; continue
    fi
    if node "$ROOT/scripts/check-batch.mjs" "$src" "$raw" "$out" $EXTRA_FLAG; then
      echo "[$b] ✓ (attempt $attempt)"
      ok=1; break
    else
      echo "[$b] 第 $attempt 次: 校验失败，重试"
      sleep 3
    fi
  done
  [ $ok -eq 0 ] && FAILED+=("$b")
done

echo "=== 完成。失败批次: ${FAILED[*]:-无} ==="
[ ${#FAILED[@]} -eq 0 ]
