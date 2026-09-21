#!/bin/bash
# 在 64.90 安装/更新 demo 池（agent rust-worker-demo）。不碰 voice-worker-rust / voice-worker-firstturn / 共享 env。
# 前置：把 rust-worker-demo.env（可由 .example 复制）和 voice-worker-demo.service scp 到 /tmp/。换二进制：放 $D/voice-rust-worker.new 再跑本脚本。
set -eu
D=/root/rust-worker-demo; mkdir -p "$D"
[ -f "$D/voice-rust-worker" ] || cp -p /root/rust-worker/voice-rust-worker "$D/voice-rust-worker"   # 首装 = 复制现役生产二进制
if [ -f "$D/voice-rust-worker.new" ]; then cp -p "$D/voice-rust-worker" "$D/voice-rust-worker.bak-$(date +%Y%m%d-%H%M%S)"; mv "$D/voice-rust-worker.new" "$D/voice-rust-worker"; fi
chmod +x "$D/voice-rust-worker"
[ -f /tmp/rust-worker-demo.env ] && install -m 600 /tmp/rust-worker-demo.env "$D/rust-worker-demo.env" && rm -f /tmp/rust-worker-demo.env
[ -f /tmp/voice-worker-demo.service ] && install -m 644 /tmp/voice-worker-demo.service /etc/systemd/system/voice-worker-demo.service && rm -f /tmp/voice-worker-demo.service
systemctl daemon-reload
systemctl enable voice-worker-demo >/dev/null 2>&1 || true
systemctl restart voice-worker-demo
sleep 8
pid=$(systemctl show -p MainPID --value voice-worker-demo)
echo "state=$(systemctl is-active voice-worker-demo) registered=$(journalctl -u voice-worker-demo --since '-60sec' --no-pager | grep -c 'registered worker') sha=$(sha256sum "$D/voice-rust-worker" | cut -c1-16) rss=$(( $(ps -o rss= -p "$pid" 2>/dev/null || echo 0) / 1024 ))MB agent=$(tr '\0' '\n' < /proc/$pid/environ | grep '^AGENT_NAME=' | cut -d= -f2) llm_host=$(tr '\0' '\n' < /proc/$pid/environ | grep '^LLM_BASE_URL=' | sed -E 's#.*://([^/]+).*#\1#') url_query_len=$(tr '\0' '\n' < /proc/$pid/environ | grep '^LLM_URL_QUERY=' | cut -d= -f2- | wc -c) instructions_set=$(tr '\0' '\n' < /proc/$pid/environ | grep -c '^AGENT_INSTRUCTIONS=')"
