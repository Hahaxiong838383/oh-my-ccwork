#!/bin/bash
# ttyd 启动包装器 — CJK 字体修复 + Apple 暗色主题 + 自动重连
# V4: 修复中文不可见（black=#cccccc）+ CJK 系统字体优先
PORT=$1
BASE=$2
SESSION=$3

exec ttyd -p "$PORT" -W -b "$BASE" \
  -t 'fontFamily=PingFang SC, Noto Sans CJK SC, Microsoft YaHei, SF Mono, SFMono-Regular, ui-monospace, Menlo, Monaco, monospace' \
  -t 'fontSize=14' \
  -t 'cursorBlink=true' \
  -t 'cursorStyle=bar' \
  -t 'scrollback=10000' \
  -t 'reconnect=2' \
  -t 'disableReconnect=false' \
  -t 'theme={"background":"#1e1e1e","foreground":"#cccccc","cursor":"#ffffff","selectionBackground":"#264f78","black":"#cccccc","red":"#cd3131","green":"#0dbc79","yellow":"#e5e510","blue":"#2472c8","magenta":"#bc3fbc","cyan":"#11a8cd","white":"#e5e5e5","brightBlack":"#666666","brightRed":"#f14c4c","brightGreen":"#23d18b","brightYellow":"#f5f543","brightBlue":"#3b8eea","brightMagenta":"#d670d6","brightCyan":"#29b8db","brightWhite":"#ffffff"}' \
  "$(dirname "$0")/tmux-session.sh" "$SESSION" "$(echo $SESSION | sed 's/^cc-//' | sed 's/-[0-9]*$//')"
