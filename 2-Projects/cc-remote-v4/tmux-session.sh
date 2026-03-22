#!/bin/bash
# 确保 tmux session 存在并 attach
# 如果 session 不存在，自动创建
SESSION=$1
CLI=$2
CWD="${3:-/Users/rayman.chen/mycc}"

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux new-session -d -s "$SESSION" -c "$CWD" "$CLI"
  sleep 1
fi

exec tmux attach-session -t "$SESSION"
