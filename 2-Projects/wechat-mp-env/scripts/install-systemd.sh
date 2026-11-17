#!/usr/bin/env bash
# install-systemd.sh — 把 wxdt-ide 的保活单元装进 systemd user（幂等）
set -euo pipefail
MP_ENV="${MP_ENV:-$HOME/mycc/2-Projects/wechat-mp-env}"
SRC="$MP_ENV/systemd"
DST="$HOME/.config/systemd/user"

[[ -d "$SRC" ]] || { echo "[x] 找不到 $SRC" >&2; exit 2; }
mkdir -p "$DST"
for f in "$SRC"/wxdt-ide-*.service "$SRC"/wxdt-ide-*.timer; do
  # 单元里写死了 /home/hahaxiong83，换用户时自动改
  sed "s#/home/hahaxiong83#$HOME#g" "$f" > "$DST/$(basename "$f")"
  echo "  安装 $(basename "$f")"
done
systemctl --user daemon-reload
systemctl --user enable --now wxdt-ide-ensure.timer wxdt-ide-backup.timer
echo
echo "[✓] 已启用："
systemctl --user list-timers 'wxdt-ide-*' --no-pager | head -4
