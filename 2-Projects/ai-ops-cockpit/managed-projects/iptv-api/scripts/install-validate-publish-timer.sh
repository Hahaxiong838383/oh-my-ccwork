#!/usr/bin/env bash
set -euo pipefail

ROOT="${IPTV_ROOT:-/opt/stacks/iptv-api}"
UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
RUN_NOW=false
[[ "${1:-}" == "--run-now" ]] && RUN_NOW=true

test -x "$ROOT/scripts/validate-and-publish.sh"
test -f "$ROOT/systemd/iptv-validate-publish.service"
test -f "$ROOT/systemd/iptv-validate-publish.timer"

stamp="$(date +%Y%m%d-%H%M%S)"
backup="/var/backups/iptv-aiops/pre-validate-timer-$stamp"
install -d -m 700 "$backup"
for name in iptv-validate-publish.service iptv-validate-publish.timer; do
  [[ -f "$UNIT_DIR/$name" ]] && cp -a "$UNIT_DIR/$name" "$backup/"
  install -m 0644 "$ROOT/systemd/$name" "$UNIT_DIR/$name"
done

systemd-analyze verify "$UNIT_DIR/iptv-validate-publish.service" "$UNIT_DIR/iptv-validate-publish.timer"
systemctl daemon-reload
systemctl enable --now iptv-validate-publish.timer

if $RUN_NOW; then
  systemctl start iptv-validate-publish.service
fi

systemctl is-enabled --quiet iptv-validate-publish.timer
systemctl is-active --quiet iptv-validate-publish.timer
printf 'IPTV_VALIDATE_TIMER_OK backup=%s next=%s\n' "$backup" "$(systemctl show iptv-validate-publish.timer --property=NextElapseUSecRealtime --value)"
