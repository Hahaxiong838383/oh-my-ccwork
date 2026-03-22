#!/bin/bash
# 确保 tmux session 存在并 attach
# 如果 session 不存在，自动创建
# V2: 先创建 shell session，再在里面启动 CLI（防止 CLI 退出导致 session 消失）
SESSION=$1
CLI=$2
CWD="${3:-/Users/rayman.chen/mycc}"

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  # 创建 shell session（不绑定 CLI 命令，session 不会因 CLI 退出而消失）
  tmux new-session -d -s "$SESSION" -c "$CWD"
  # 在 session 里执行 CLI
  tmux send-keys -t "$SESSION" "$CLI" Enter
  sleep 1
fi

exec tmux attach-session -t "$SESSION"
