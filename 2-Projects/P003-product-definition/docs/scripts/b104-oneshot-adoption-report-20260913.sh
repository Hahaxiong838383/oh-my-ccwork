#!/usr/bin/env bash
# B104 全量接入观测（Air 上跑，一条命令看两端；只读）。用法：bash b104-oneshot-adoption-report.sh [SINCE_UTC_ISO]（默认今天 00:00Z）
set -u
SINCE="${1:-$(date -u +%Y-%m-%dT00:00:00Z)}"
echo "===== One-shot 接入观测 since $SINCE (UTC) ====="
echo; echo "##### aliyun-hk（签发 / OTA）"; ssh aliyun-hk "bash /root/b104-adoption-server.sh '$SINCE'"
echo; echo "##### 64.90（两池 worker）"; ssh root@64.90.13.117 "bash /root/b104-adoption-worker.sh '$SINCE'"
