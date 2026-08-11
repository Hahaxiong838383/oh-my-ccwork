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
backup_archive=$backup_root/previous-runtime.tar.gz
backup_checksum=$backup_root/previous-runtime.tar.gz.sha256
[ -f "$backup_archive" ] || { echo 'internal engineering backup archive missing' >&2; exit 1; }
[ -f "$backup_checksum" ] || { echo 'internal engineering backup checksum missing' >&2; exit 1; }
(cd "$backup_root" && sha256sum -c previous-runtime.tar.gz.sha256 >/dev/null) || { echo 'internal engineering backup checksum mismatch' >&2; exit 1; }
tar -tzf "$backup_archive" >/dev/null || { echo 'internal engineering backup archive invalid' >&2; exit 1; }
tar -tzf "$backup_archive" | grep -q '^package/' || { echo 'internal engineering backup missing package' >&2; exit 1; }
tar -tzf "$backup_archive" | grep -q '^config/' || { echo 'internal engineering backup missing config' >&2; exit 1; }
tar -tzf "$backup_archive" | grep -q '^\.env\.internal$' || { echo 'internal engineering backup missing env' >&2; exit 1; }

retired=$internal_root/retired-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$retired"
for entry in package config .env.internal; do
  [ ! -e "$internal_root/$entry" ] || mv "$internal_root/$entry" "$retired/$entry"
done
tar -C "$internal_root" -xzf "$backup_archive"
[ -d "$internal_root/package" ] && [ -d "$internal_root/config" ] && [ -f "$internal_root/.env.internal" ] || { echo 'internal engineering rollback restore incomplete' >&2; exit 1; }
printf 'internal_engineering_rollback=completed\ncontainer_stop_count=0\ndatabase_restore_count=0\nexisting_service_restart_count=0\nrestored_backup=%s\n' "$backup_root"
