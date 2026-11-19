#!/usr/bin/env bash
# B104 全量接入观测（Air 上跑，一条命令看两端；只读）。用法：bash b104-oneshot-adoption-report.sh [SINCE_UTC_ISO]（默认今天 00:00Z）
set -u
SINCE="${1:-$(date -u +%Y-%m-%dT00:00:00Z)}"
echo "===== One-shot 接入观测 since $SINCE (UTC) ====="
echo; echo "##### aliyun-hk（签发 / OTA）"; ssh aliyun-hk "bash /root/b104-adoption-server.sh '$SINCE'"
echo; echo "##### hk2 64.90.13.177（单池 voice-worker-rust，2026-09-23 阶段 3 起；One-shot 房与普通房同池，按 ordered_pcm 行分流）"; ssh root@64.90.13.177 "bash /root/rust-worker/b104-adoption-worker.sh '$SINCE'"
