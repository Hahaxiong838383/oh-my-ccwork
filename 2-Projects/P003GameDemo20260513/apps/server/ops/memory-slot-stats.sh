#!/usr/bin/env bash
# D2.1 记忆槽位观察计数（2026-09-23 川哥「先数频率再决定」）：只数 pm2 日志里的 [memory-slot] 行，
# 不读记忆库、不打印孩子原话。行格式见 src/memory-item-store.ts addItems。
# 用法：bash apps/server/ops/memory-slot-stats.sh [ssh目标，默认 aliyun-hk] [日志文件，默认 /root/.pm2/logs/p003-voice-out.log]
set -euo pipefail
T="${1:-aliyun-hk}"
F="${2:-/root/.pm2/logs/p003-voice-out.log}"
ssh -n "$T" "cat ${F}* 2>/dev/null | grep -F '[memory-slot]' | awk '
  { n++; for (i = 1; i <= NF; i++) { split(\$i, kv, \"=\");
      if (kv[1] == \"type\") t[kv[2]]++;
      if (kv[1] == \"new\" && kv[2] == 1) nw++;
      if (kv[1] == \"cond\" && kv[2] == 1) c++;
      if (kv[1] == \"modal\" && kv[2] == 1) m++;
      if (kv[1] == \"due\") d[kv[2]]++;
      if (kv[1] == \"due_text\") u[kv[2]]++ } }
  END { printf \"rows=%d new=%d cond=%d modal=%d\\n\", n, nw, c, m;
        for (k in t) printf \"type.%s=%d\\n\", k, t[k];
        for (k in d) printf \"due.%s=%d\\n\", k, d[k];
        for (k in u) printf \"due_unknown_text %s=%d\\n\", k, u[k] }'"
