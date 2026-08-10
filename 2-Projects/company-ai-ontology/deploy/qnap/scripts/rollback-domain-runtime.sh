#!/bin/sh
set -eu
exec </dev/null

docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
backup_root=${DOMAIN_RUNTIME_BACKUP_ROOT:?DOMAIN_RUNTIME_BACKUP_ROOT is required}
expected_version=${DOMAIN_RUNTIME_EXPECTED_VERSION:-}
manifest=$backup_root/release-manifest.txt

[ "$(hostname)" = PRNas ] || { echo 'refusing non-company QNAP host' >&2; exit 1; }
[ "$project_root" = /share/CACHEDEV1_DATA/ai-ontology/foundation ] || { echo 'refusing unexpected company ontology root' >&2; exit 1; }
[ -f "$backup_root/.env" ] || { echo 'domain runtime backup env missing' >&2; exit 1; }
[ -f "$manifest" ] || { echo 'domain runtime backup manifest missing' >&2; exit 1; }

previous_image=$(awk -F= '/^previous_image=/{print $2; exit}' "$manifest")
previous_version=$(awk -F= '/^previous_version=/{print $2; exit}' "$manifest")
[ -n "$previous_image" ] || { echo 'previous image missing from manifest' >&2; exit 1; }
"$docker_path" image inspect "$previous_image" >/dev/null

cp "$backup_root/.env" "$project_root/.env"
chmod 600 "$project_root/.env"
"$docker_path" image tag "$previous_image" company-ai-foundation-domain-connector:latest
cd "$project_root"
"$docker_path" compose config >/dev/null
"$docker_path" compose up -d --no-build domain-connector

target_version=${expected_version:-$previous_version}
attempt=0
until "$docker_path" compose exec -T domain-connector node -e \
  "fetch('http://127.0.0.1:8085/readyz').then(async r=>{const p=await r.json();console.log(JSON.stringify(p));process.exit(r.ok&&p.status==='ready'&&(!process.argv[1]||p.version===process.argv[1])?0:1)}).catch(()=>process.exit(1))" \
  "$target_version" \
  </dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || { "$docker_path" compose logs --tail 160 domain-connector; exit 1; }
  sleep 2
done

container_id=$("$docker_path" compose ps -q domain-connector)
[ -n "$container_id" ]
[ "$("$docker_path" inspect --format '{{.RestartCount}}' "$container_id")" = 0 ]

printf 'domain_runtime_rollback=%s\nrestored_version=%s\nrestart_count=0\n' "$backup_root" "$target_version"
