#!/bin/bash
# cc-remote 停止脚本
# 默认只停 Web 服务（ttyd/caddy/cloudflared），保留 tmux session
# 加 --kill-sessions 同时杀掉 tmux session

echo "停止 cc-remote Web 服务..."
pkill -f "ttyd -p 1900" 2>/dev/null
lsof -i :19100 -t | xargs kill -9 2>/dev/null  # API
pkill -f "caddy run.*cc-remote" 2>/dev/null
pkill -f "cloudflared tunnel run" 2>/dev/null
pkill -f "watchdog.sh" 2>/dev/null
echo "  ✓ ttyd + caddy + cloudflared 已停止"

if [ "$1" = "--kill-sessions" ]; then
  echo "杀掉 tmux session..."
  tmux kill-session -t cc-claude 2>/dev/null && echo "  ✓ cc-claude 已杀掉"
  tmux kill-session -t cc-codex 2>/dev/null && echo "  ✓ cc-codex 已杀掉"
  tmux kill-session -t cc-gemini 2>/dev/null && echo "  ✓ cc-gemini 已杀掉"
else
  echo ""
  echo "tmux session 已保留（CLI 继续运行）:"
  tmux ls 2>/dev/null | grep "cc-" || echo "  (无活跃 session)"
  echo ""
  echo "要完全停止：./stop.sh --kill-sessions"
fi
