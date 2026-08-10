#!/bin/sh
set -eu
exec </dev/null

[ "${SHADOW_ROLLBACK_APPROVED:-NO}" = YES ] || { echo 'explicit shadow rollback approval missing' >&2; exit 1; }
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_root=$(CDPATH= cd -- "$script_root/.." && pwd)
. "$script_root/preflight-company-qnap.sh"
backup_root=${SI_ROLLBACK_BACKUP_ROOT:?SI_ROLLBACK_BACKUP_ROOT is required}
case "$backup_root" in /share/CACHEDEV2_DATA/ai-ontology-backup/strategic-intelligence/*) ;; *) echo 'refusing unexpected backup root' >&2; exit 1 ;; esac
[ -f "$backup_root/manifest.txt" ] || { echo 'backup manifest missing' >&2; exit 1; }
[ -f "$backup_root/config/.env.shadow" ] || { echo 'backup env missing' >&2; exit 1; }
[ -f "$backup_root/config/package.tar.gz" ] || { echo 'backup package missing' >&2; exit 1; }
previous_image=$(awk -F= '/^collector_image=/{print $2; exit}' "$backup_root/manifest.txt")
[ -n "$previous_image" ] || { echo 'previous collector image missing' >&2; exit 1; }
"$docker_path" image inspect "$previous_image" >/dev/null

current_env=${SI_ENV_FILE:-$shadow_root/.env.shadow}
"$docker_path" compose --env-file "$current_env" -f "$package_root/docker-compose.shadow.yml" stop intelligence-orchestrator >/dev/null 2>&1 || true
rm -rf "$shadow_root/package.rollback-partial"
mkdir -p "$shadow_root/package.rollback-partial"
tar -C "$shadow_root/package.rollback-partial" -xzf "$backup_root/config/package.tar.gz"
cp "$backup_root/config/.env.shadow" "$current_env"
chmod 600 "$current_env"
rm -rf "$shadow_root/package.previous"
[ ! -d "$shadow_root/package" ] || mv "$shadow_root/package" "$shadow_root/package.previous"
mv "$shadow_root/package.rollback-partial" "$shadow_root/package"
umask 077
printf 'rolled_back_at=%s\nbackup_root=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$backup_root" > "$shadow_root/FROZEN"
printf 'strategic_intelligence_shadow=rolled_back_and_frozen\nbackup_root=%s\n' "$backup_root"
