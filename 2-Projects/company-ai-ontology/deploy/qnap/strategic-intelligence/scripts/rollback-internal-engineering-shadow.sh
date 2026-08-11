#!/bin/sh
set -eu
exec </dev/null

[ "${INTERNAL_ENGINEERING_ROLLBACK_APPROVED:-NO}" = YES ] || { echo 'explicit internal engineering rollback approval missing' >&2; exit 1; }
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
internal_root=$shadow_root/internal-engineering
[ -f "$internal_root/.previous-backup" ] || { echo 'internal engineering backup pointer missing' >&2; exit 1; }
backup_root=$(cat "$internal_root/.previous-backup")
case "$backup_root" in /share/CACHEDEV2_DATA/ai-ontology-backup/strategic-intelligence/internal-engineering/*) ;; *) echo 'refusing unexpected internal backup root' >&2; exit 1 ;; esac

retired=$internal_root/retired-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$retired"
for entry in package config .env.internal; do
  [ ! -e "$internal_root/$entry" ] || mv "$internal_root/$entry" "$retired/$entry"
done
if [ -f "$backup_root/previous-runtime.tar.gz" ]; then
  tar -C "$internal_root" -xzf "$backup_root/previous-runtime.tar.gz"
fi
printf 'internal_engineering_rollback=completed\ncontainer_stop_count=0\ndatabase_restore_count=0\nexisting_service_restart_count=0\nrestored_backup=%s\n' "$backup_root"
