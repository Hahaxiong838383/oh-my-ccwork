#!/bin/bash
# xray 健康检查守护 — 放到 VPS /usr/local/bin/ 由 systemd timer 每 2 分钟触发
# 判据：xray 进程存在 + :443 和 :10086 均在 listen
# 任一不满足则 systemctl restart x-ui + syslog 记录
set -u
if ! pgrep -f xray-linux-amd64 >/dev/null 2>&1 || \
   ! ss -tlnp 2>/dev/null | grep -q ':443 ' || \
   ! ss -tlnp 2>/dev/null | grep -q ':10086 '; then
  logger -t xray-healthcheck "FAIL xray/port down, restarting x-ui"
  systemctl restart x-ui
  sleep 2
  if ss -tlnp 2>/dev/null | grep -q ':443 '; then
    logger -t xray-healthcheck "OK recovered"
  else
    logger -t xray-healthcheck "ERROR still down after restart"
  fi
fi
