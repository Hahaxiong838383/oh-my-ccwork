#!/usr/bin/env bash
# B103：off 复验窗口——切 off 前先落有效策略快照，并用 systemd 一次性定时器到时自动恢复（不依赖聊天转发）。
# 依赖：/root/b93-oneshot-switch.sh（view|off|clear，token 只在进程内）。
# 用法：bash b93-oneshot-window.sh start <分钟 1..5> ["note"]   # 快照 → 定时 clear → 切 off
#       bash b93-oneshot-window.sh status                          # 待触发的恢复定时器 + 最近窗口日志
#       bash b93-oneshot-window.sh restore-now                     # 立即 clear 并撤掉定时器
set -euo pipefail
SW=/root/b93-oneshot-switch.sh
CMD="${1:?usage: start <minutes 1..5> [note] | status | restore-now}"
case "$CMD" in
  start)
    MIN="${2:?minutes 1..5}"; NOTE="${3:-B103 off 复验窗口 by cc}"
    [[ "$MIN" =~ ^[1-5]$ ]] || { echo "minutes must be 1..5"; exit 2; }
    TS=$(date -u +%Y%m%dT%H%M%SZ); SNAP=/root/oneshot-window-$TS.json; LOG=/root/oneshot-window-$TS.log
    bash "$SW" view | sed -n 's/^before: //p' > "$SNAP"
    echo "snapshot: $SNAP"; cat "$SNAP"
    UNIT=p003-oneshot-restore-$TS
    systemd-run --on-active="${MIN}min" --unit="$UNIT" --description="P003 One-shot off 窗口到时自动恢复 ($TS)" \
      /bin/bash -c "echo \"fired \$(date -u +%Y-%m-%dT%H:%M:%SZ)\" >> $LOG; bash $SW clear >> $LOG 2>&1; echo RESTORE_RC=\$? >> $LOG"
    echo "timer: $UNIT.timer fires in ${MIN}min → clear → log $LOG"
    bash "$SW" off "$NOTE（到时自动恢复 $UNIT）"
    ;;
  status)
    systemctl list-timers 'p003-oneshot-restore-*' --all --no-legend || true
    last=$(ls -1t /root/oneshot-window-*.log 2>/dev/null | head -n 1 || true)
    if [ -n "${last:-}" ]; then echo "--- $last ---"; tail -n 6 "$last"; fi
    bash "$SW" view
    ;;
  restore-now)
    systemctl list-units 'p003-oneshot-restore-*.timer' --all --no-legend --plain | awk '{print $1}' | while read -r t; do [ -n "$t" ] && { systemctl stop "$t" || true; echo "stopped $t"; }; done
    bash "$SW" clear
    ;;
  *) echo "unknown: $CMD"; exit 2 ;;
esac
