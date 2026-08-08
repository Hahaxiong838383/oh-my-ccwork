#!/bin/sh
set -eu

if [ "$(id -u)" != "0" ]; then
  echo 'configure-host.sh must run as root.' >&2
  exit 1
fi

project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
backup_root=${BACKUP_ROOT:-/share/CACHEDEV2_DATA/ai-ontology-backup}
autorun_target=/mnt/boot_config/autorun.sh
autorun_source=$project_root/config/autorun.sh
backup_dir=$backup_root/system/qnap-config-$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$backup_dir"
chmod 700 "$backup_root/system" "$backup_dir"
cp -p /etc/config/uLinux.conf "$backup_dir/uLinux.conf.before"

if [ -f "$autorun_target" ]; then
  cp -p "$autorun_target" "$backup_dir/autorun.sh.before"
  if ! grep -q 'BEGIN company-ai-ontology' "$autorun_target"; then
    echo 'Existing autorun.sh has no managed block; refusing to overwrite.' >&2
    exit 2
  fi
fi

cp "$autorun_source" "$autorun_target"
chmod 755 "$autorun_target"
/sbin/setcfg Misc Autorun TRUE -f /etc/config/uLinux.conf
/sbin/sysctl -w vm.overcommit_memory=1 >/dev/null
sync

printf 'autorun_enabled=%s overcommit=%s backup=%s\n' \
  "$(/sbin/getcfg Misc Autorun -d FALSE -f /etc/config/uLinux.conf)" \
  "$(cat /proc/sys/vm/overcommit_memory)" \
  "$backup_dir"
