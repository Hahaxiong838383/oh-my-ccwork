#!/bin/sh
set -eu

docker_path=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
backup_root=${BACKUP_ROOT:-/share/CACHEDEV2_DATA/ai-ontology-backup}
restore_root=${RESTORE_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/restore-drill}
container_name=company-ai-postgres-restore-drill

cd "$project_root"
set -a
. "$project_root/.env"
set +a

latest_backup=$(find "$backup_root/postgres/base" -mindepth 2 -maxdepth 2 -type f -name VERIFIED -print | sed 's#/VERIFIED$##' | sort | tail -1)
if [ -z "$latest_backup" ]; then
  echo 'No verified base backup found.' >&2
  exit 1
fi

marker="restore-drill-$(date -u +%Y%m%dT%H%M%SZ)"
"$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -qAtc "INSERT INTO platform.restore_markers (tenant_id, marker) VALUES ('$FUTURUS_TENANT_ID', '$marker');" >/dev/null
lsn=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -qAtc 'SELECT pg_current_wal_lsn();')
"$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -c 'SELECT pg_switch_wal();' >/dev/null
sleep 10

"$docker_path" rm -f "$container_name" >/dev/null 2>&1 || true
"$docker_path" run --rm -u 0:0 \
  -v "$(dirname "$restore_root"):/work" \
  docker.1ms.run/pgvector/pgvector:pg17-bookworm \
  sh -ec "rm -rf /work/$(basename "$restore_root"); mkdir -p /work/$(basename "$restore_root")"

"$docker_path" run --rm -u 0:0 \
  -v "$latest_backup:/source:ro" \
  -v "$restore_root:/restore" \
  docker.1ms.run/pgvector/pgvector:pg17-bookworm \
  sh -ec 'cp -a /source/. /restore/; chown -R 999:999 /restore'

"$docker_path" run --rm -u 0:0 \
  -e RECOVERY_LSN="$lsn" \
  -v "$restore_root:/restore" \
  docker.1ms.run/pgvector/pgvector:pg17-bookworm \
  sh -ec 'printf "restore_command = '\''cp /backups/postgres/wal/%%f %%p'\''\nrecovery_target_lsn = '\''%s'\''\nrecovery_target_action = '\''promote'\''\nlisten_addresses = '\'''\''\n" "$RECOVERY_LSN" >> /restore/postgresql.auto.conf; touch /restore/recovery.signal; chown 999:999 /restore/postgresql.auto.conf /restore/recovery.signal'

"$docker_path" run -d \
  --name "$container_name" \
  --memory 768m \
  --cpus 0.75 \
  --network none \
  -v "$restore_root:/var/lib/postgresql/data" \
  -v "$backup_root:/backups:ro" \
  docker.1ms.run/pgvector/pgvector:pg17-bookworm >/dev/null

attempt=0
until "$docker_path" exec -u postgres "$container_name" pg_isready -U ontology_admin -d ontology >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    "$docker_path" logs --tail 100 "$container_name" >&2 || true
    "$docker_path" rm -f "$container_name" >/dev/null 2>&1 || true
    exit 1
  fi
  sleep 2
done

restored=$("$docker_path" exec -u postgres "$container_name" psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM platform.restore_markers WHERE marker = '$marker';")
"$docker_path" rm -f "$container_name" >/dev/null

if [ "$restored" != "1" ]; then
  echo 'PITR marker was not restored.' >&2
  exit 1
fi

printf 'pitr_restore_drill=passed marker=%s lsn=%s backup=%s\n' "$marker" "$lsn" "$latest_backup"

"$docker_path" run --rm -u 0:0 \
  -v "$(dirname "$restore_root"):/work" \
  docker.1ms.run/pgvector/pgvector:pg17-bookworm \
  sh -ec "rm -rf /work/$(basename "$restore_root")"
