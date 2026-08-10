#!/bin/sh
set -eu
exec </dev/null

docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
backup_root=${AGENT_RUNTIME_BACKUP_ROOT:?AGENT_RUNTIME_BACKUP_ROOT is required}
expected_version=${AGENT_RUNTIME_EXPECTED_VERSION:-}
manifest=$backup_root/release-manifest.txt

[ "$(hostname)" = PRNas ] || { echo 'refusing non-company QNAP host' >&2; exit 1; }
[ "$project_root" = /share/CACHEDEV1_DATA/ai-ontology/foundation ] || { echo 'refusing unexpected company ontology root' >&2; exit 1; }
[ -f "$backup_root/.env" ] || { echo 'agent runtime backup env missing' >&2; exit 1; }
[ -f "$manifest" ] || { echo 'agent runtime backup manifest missing' >&2; exit 1; }

previous_image=$(awk -F= '/^previous_image=/{print $2; exit}' "$manifest")
previous_version=$(awk -F= '/^previous_version=/{print $2; exit}' "$manifest")
[ -n "$previous_image" ] || { echo 'previous image missing from manifest' >&2; exit 1; }
"$docker_path" image inspect "$previous_image" >/dev/null

cp "$backup_root/.env" "$project_root/.env"
chmod 600 "$project_root/.env"
"$docker_path" image tag "$previous_image" company-ai-foundation-agent-core:latest
cd "$project_root"
"$docker_path" compose config >/dev/null
"$docker_path" compose up -d --no-build agent-core

target_version=${expected_version:-$previous_version}
attempt=0
until "$docker_path" compose exec -T agent-core node -e \
  "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const p=await r.json();console.log(JSON.stringify(p));process.exit(r.ok&&p.status==='ready'&&p.productionReady===true&&(!process.argv[1]||p.contractVersion===process.argv[1])?0:1)}).catch(()=>process.exit(1))" \
  "$target_version" \
  </dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || { "$docker_path" compose logs --tail 160 agent-core; exit 1; }
  sleep 2
done

container_id=$("$docker_path" compose ps -q agent-core)
[ -n "$container_id" ]
[ "$("$docker_path" inspect --format '{{.RestartCount}}' "$container_id")" = 0 ]

printf 'agent_runtime_rollback=%s\nrestored_version=%s\nrestart_count=0\n' "$backup_root" "$target_version"
