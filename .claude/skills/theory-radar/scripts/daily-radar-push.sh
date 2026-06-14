#!/bin/bash
# theory-radar → 个人站 每日推送（mini cron 调用）。
# 抓 arXiv（走 xray proxy）→ gemini 5 段式 → POST 站点 webhook。独立于 multica 飞书流。
set -uo pipefail
LOG="/tmp/radar-push-$(date +%Y%m%d).log"
{
  echo "===== $(date '+%F %T') radar push start ====="
  export HTTPS_PROXY=http://127.0.0.1:10808 HTTP_PROXY=http://127.0.0.1:10808 NO_PROXY=localhost,127.0.0.1
  # secret（RADAR_WEBHOOK_TOKEN / GEMINI_PROXY_KEY）只在 mini 本地，不进 git
  # shellcheck disable=SC1090
  source "$HOME/.theory-radar-push.env"
  cd "$HOME/theory-radar" || exit 1
  echo "--- 抓 arXiv ---"
  python3 arxiv-theory-radar.py > /tmp/tr-fetch.log 2>&1 && echo "fetch ok" || { echo "fetch FAIL"; tail -3 /tmp/tr-fetch.log; exit 1; }
  echo "--- 分析 + 推送 ---"
  python3 push-to-site.py
  echo "===== $(date '+%F %T') done (exit $?) ====="
} >> "$LOG" 2>&1
