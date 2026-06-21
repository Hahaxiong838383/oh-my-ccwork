#!/usr/bin/env bash
# P0 · 下载流式 Zipformer-zh ASR 候选模型(type9 / type20),解压,列真实文件结构 + 量体积。
#
# 用途:docs/32 §11.F P0 门槛——为 smoke 验证(单 .so 同进程跑 KWS+OnlineRecognizer)+ type9/20
#       童声 CER 对比准备模型。下载完看真实结构,再挑 encoder.int8/decoder/joiner/tokens 入 assets。
#
# URL 已 cc 核实(2026-06-21):GitHub releases tag=asr-models,302→release-assets.githubusercontent.com 有效。
#   type9  tar.bz2 ≈ 70.6MB / type20 tar.bz2 ≈ 126.5MB(含 test_wavs + 多量化版,真入 APK 文件需解压后挑)。
#
# 用法: bash download-asr-models.sh [工作目录,默认 /tmp/asr-models]
set -euo pipefail

BASE="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
WORK="${1:-/tmp/asr-models}"
mkdir -p "$WORK"; cd "$WORK"

# 候选模型(modelDir 名 = OnlineRecognizer.kt getModelConfig 注册表 type9 / type20)。
# bash 3.2(macOS 默认)不支持关联数组 → 用 "key:name" 字面循环。
for entry in \
  "v9:sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23" \
  "v20:sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"; do
  key="${entry%%:*}"
  name="${entry#*:}"
  echo "============================================================"
  echo "=== [$key] $name ==="
  echo "============================================================"
  if [ ! -f "$name.tar.bz2" ]; then
    echo "下载中 (curl --retry 3)..."
    curl -fSL --retry 3 -o "$name.tar.bz2" "$BASE/$name.tar.bz2"
  else
    echo "已存在 $name.tar.bz2,跳过下载"
  fi
  echo "tar.bz2 体积: $(du -h "$name.tar.bz2" | cut -f1)"
  rm -rf "$name"
  tar xjf "$name.tar.bz2"
  echo "--- 解压后全部 .onnx / tokens / test wav(真实文件名,smoke + assets 据此配)---"
  find "$name" -type f \( -name '*.onnx' -o -name 'tokens.txt' -o -name '*.wav' \) | sort | while read -r f; do
    printf '  %8s  %s\n' "$(du -h "$f" | cut -f1)" "${f#"$name"/}"
  done
  echo "解压总体积: $(du -sh "$name" | cut -f1)"
  echo ""
done

echo "============================================================"
echo "完成。下一步(cc):按上面真实文件名,挑 int8 encoder + decoder + joiner + tokens"
echo "  → apps/android-shell/app/src/main/assets/asr-model-v9/ 和 asr-model-v20/"
echo "  → 量这几个文件合计大小 = APK 真实增量(非 tar.bz2 体积)"
echo "  → 挑一条 test wav 给 smoke 验证用"
echo "============================================================"
