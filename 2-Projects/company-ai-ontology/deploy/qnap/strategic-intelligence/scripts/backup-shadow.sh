#!/bin/sh
set -eu
exec </dev/null

script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_root=${SI_PACKAGE_ROOT:-$(CDPATH= cd -- "$script_root/.." && pwd)}
. "$script_root/preflight-company-qnap.sh"

run_id=${SI_BACKUP_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
backup_root=${SI_BACKUP_ROOT:-/share/CACHEDEV2_DATA/ai-ontology-backup/strategic-intelligence/$run_id}
env_file=${SI_ENV_FILE:-$shadow_root/.env.shadow}
case "$backup_root" in /share/CACHEDEV2_DATA/ai-ontology-backup/strategic-intelligence/*) ;; *) echo 'refusing unexpected backup root' >&2; exit 1 ;; esac
case "$package_root" in "$shadow_root"/package|*/deploy/qnap/strategic-intelligence) ;; *) echo 'refusing unexpected strategic intelligence package root' >&2; exit 1 ;; esac
[ -f "$env_file" ] || { echo 'shadow env file missing' >&2; exit 1; }
umask 077
mkdir -p "$backup_root/config" "$backup_root/state-metadata" "$backup_root/evidence"
cp "$env_file" "$backup_root/config/.env.shadow"
tar -C "$package_root" -czf "$backup_root/config/package.tar.gz" \
  docker-compose.shadow.yml config orchestrator scripts schemas evidence package.json README.md
if [ -d "$shadow_root/state" ]; then
  find "$shadow_root/state" -maxdepth 2 -type f \( -name 'heartbeat.json' -o -name '*.evaluation.json' -o -name 'FROZEN' \) \
    -exec cp {} "$backup_root/state-metadata/" \; 2>/dev/null || true
fi
if [ -d "$shadow_root/evidence" ]; then
  find "$shadow_root/evidence" -maxdepth 1 -type f \( -name 'daily-collection-shadow-*.json' -o -name 'seven-day-shadow-summary*.json' \) \
    -exec cp {} "$backup_root/evidence/" \; 2>/dev/null || true
fi
set -a
. "$env_file"
set +a
image_id=$($docker_path image inspect --format '{{.Id}}' "$SI_COLLECTOR_IMAGE")
cat > "$backup_root/manifest.txt" <<EOF
backup_run_id=$run_id
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
foundation_root=$foundation_root
shadow_root=$shadow_root
collector_image=$SI_COLLECTOR_IMAGE
collector_image_id=$image_id
source_commit=${SI_SOURCE_COMMIT:-unknown}
database_restore_mode=preserve_append_only_data
EOF
chmod 600 "$backup_root/config/.env.shadow" "$backup_root/config/package.tar.gz" "$backup_root/manifest.txt"
printf 'strategic_intelligence_backup=%s\n' "$backup_root"
