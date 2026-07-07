#!/bin/bash
# github-radar → 个人站 每日推送（mini launchd cc.github-radar-push 调用，每日 23:30）。
# 抓 GitHub API（走 xray proxy）→ POST 站点 webhook(type=github)。独立于飞书流。
set -uo pipefail
LOG="/tmp/github-radar-push-$(date +%Y%m%d).log"
{
  echo "===== $(date '+%F %T') github-radar push start ====="
  export HTTPS_PROXY=http://127.0.0.1:10808 HTTP_PROXY=http://127.0.0.1:10808 NO_PROXY=localhost,127.0.0.1
  # secret（RADAR_WEBHOOK_TOKEN）复用 theory-radar 的本地 env，不进 git
  # shellcheck disable=SC1090
  source "$HOME/.theory-radar-push.env"
  cd "$HOME/github-radar" || exit 1
  echo "--- 抓 GitHub ---"
  python3 github-radar.py > /tmp/gh-radar-fetch.log 2>&1 && echo "fetch ok" || { echo "fetch FAIL"; tail -3 /tmp/gh-radar-fetch.log; exit 1; }
  echo "--- 推送 ---"
  python3 push-github-to-site.py
  echo "===== $(date '+%F %T') done (exit $?) ====="
} >> "$LOG" 2>&1
