#!/bin/sh
set -eu
exec </dev/null

docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
backup_root=${ONTOLOGY_CONTRACTS_BACKUP_ROOT:?ONTOLOGY_CONTRACTS_BACKUP_ROOT is required}
manifest=$backup_root/release-manifest.txt

[ "$(hostname)" = PRNas ] || { echo 'refusing non-company QNAP host' >&2; exit 1; }
[ "$project_root" = /share/CACHEDEV1_DATA/ai-ontology/foundation ] || { echo 'refusing unexpected company ontology root' >&2; exit 1; }
[ -f "$backup_root/.env" ] || { echo 'ontology contracts backup env missing' >&2; exit 1; }
[ -f "$manifest" ] || { echo 'ontology contracts release manifest missing' >&2; exit 1; }

previous_image=$(awk -F= '/^previous_image=/{print $2; exit}' "$manifest")
active_schema=$(awk -F= '/^active_schema=/{print $2; exit}' "$manifest")
active_hash=$(awk -F= '/^active_hash=/{print $2; exit}' "$manifest")
[ -n "$previous_image" ] || { echo 'previous image missing from manifest' >&2; exit 1; }
"$docker_path" image inspect "$previous_image" >/dev/null

cp "$backup_root/.env" "$project_root/.env"
chmod 600 "$project_root/.env"
"$docker_path" image tag "$previous_image" company-ai-foundation-ontology-registry:latest
cd "$project_root"
"$docker_path" compose config >/dev/null
"$docker_path" compose up -d --no-deps --force-recreate --no-build ontology-registry

attempt=0
until "$docker_path" compose exec -T ontology-registry node --input-type=module - "$active_schema" "$active_hash" <<'NODE'
const [schema, hash] = process.argv.slice(2)
const response = await fetch('http://127.0.0.1:8084/readyz')
const payload = await response.json()
console.log(JSON.stringify(payload))
process.exit(response.ok && payload.status === 'in_sync' && payload.local?.schemaVersion === schema && payload.local?.contentHash === hash ? 0 : 1)
NODE
do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || { "$docker_path" compose logs --tail 160 ontology-registry; exit 1; }
  sleep 2
done

container_id=$("$docker_path" compose ps -q ontology-registry)
[ -n "$container_id" ]
[ "$("$docker_path" inspect --format '{{.RestartCount}}' "$container_id")" = 0 ]

printf 'ontology_contracts_rollback=%s\nrestored_schema=%s\nrestart_count=0\n' "$backup_root" "$active_schema"
