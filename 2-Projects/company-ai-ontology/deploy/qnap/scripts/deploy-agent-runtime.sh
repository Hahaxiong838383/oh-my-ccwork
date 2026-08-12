#!/bin/sh
set -eu
exec </dev/null
umask 077

docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
release_root=${AGENT_RUNTIME_RELEASE_ROOT:?AGENT_RUNTIME_RELEASE_ROOT is required}
runtime_commit=${AGENT_RUNTIME_COMMIT:?AGENT_RUNTIME_COMMIT is required}
expected_version=${AGENT_RUNTIME_EXPECTED_VERSION:-2026-08-12.2}
run_id=${AGENT_RUNTIME_RUN_ID:-$(date +%Y%m%d%H%M%S)}
backup_root=/share/CACHEDEV2_DATA/ai-ontology-backup/agent-runtime/$run_id
previous_image=company-ai-foundation-agent-core:pre-$run_id

[ "$(hostname)" = PRNas ] || { echo 'refusing non-company QNAP host' >&2; exit 1; }
[ "$project_root" = /share/CACHEDEV1_DATA/ai-ontology/foundation ] || { echo 'refusing unexpected company ontology root' >&2; exit 1; }
[ -f "$release_root/services/agent-core/Dockerfile" ] || { echo 'agent runtime release incomplete' >&2; exit 1; }
case "$runtime_commit" in *[!0-9a-fA-F]*|'') echo 'AGENT_RUNTIME_COMMIT must be a Git commit hash' >&2; exit 2 ;; esac
[ "${#runtime_commit}" -ge 7 ] || { echo 'AGENT_RUNTIME_COMMIT must contain at least 7 hex characters' >&2; exit 2; }

mkdir -p "$backup_root"
chmod 700 "$backup_root"
cp "$project_root/.env" "$backup_root/.env"
chmod 600 "$backup_root/.env"
previous_context=$(awk -F= '/^AGENT_CORE_BUILD_CONTEXT=/{print $2; exit}' "$project_root/.env")
previous_version=$("$docker_path" compose -f "$project_root/docker-compose.yml" exec -T agent-core node -e \
  "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const p=await r.json();process.stdout.write(String(p.contractVersion||''))}).catch(()=>process.exit(1))" \
  </dev/null 2>/dev/null || true)
[ -n "$previous_version" ] || { echo 'current agent runtime version is unavailable' >&2; exit 1; }
previous_source_commit=$("$docker_path" compose -f "$project_root/docker-compose.yml" exec -T agent-core node -e \
  "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const p=await r.json();process.stdout.write(String(p.sourceCommit||''))}).catch(()=>process.exit(1))" \
  </dev/null 2>/dev/null || true)
[ -n "$previous_source_commit" ] || { echo 'current agent runtime source commit is unavailable' >&2; exit 1; }
"$docker_path" image inspect company-ai-foundation-agent-core:latest >/dev/null
"$docker_path" image tag company-ai-foundation-agent-core:latest "$previous_image"

rollback_on_error() {
  status=$?
  trap - EXIT HUP INT TERM
  [ "$status" -ne 0 ] || exit 0
  set +e
  cp "$backup_root/.env" "$project_root/.env"
  chmod 600 "$project_root/.env"
  if "$docker_path" image inspect "$previous_image" >/dev/null 2>&1; then
    "$docker_path" image tag "$previous_image" company-ai-foundation-agent-core:latest
    cd "$project_root"
    "$docker_path" compose up -d --no-deps --force-recreate --no-build agent-core
    attempt=0
    until "$docker_path" compose exec -T agent-core node -e \
      "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.status==='ready'&&p.productionReady===true&&p.contractVersion===process.argv[1]&&p.sourceCommit===process.argv[2]?0:1)}).catch(()=>process.exit(1))" \
      "$previous_version" "$previous_source_commit" \
      </dev/null 2>/dev/null; do
      attempt=$((attempt + 1))
      [ "$attempt" -lt 60 ] || break
      sleep 2
    done
  fi
  printf 'agent runtime deployment failed; previous env and image were restored\n' >&2
  exit "$status"
}
trap rollback_on_error EXIT HUP INT TERM

temp=$project_root/.env.agent-runtime-$run_id
awk -v context="$release_root/services/agent-core" -v commit="$runtime_commit" '
  BEGIN { context_found=0; commit_found=0 }
  /^AGENT_CORE_BUILD_CONTEXT=/ { print "AGENT_CORE_BUILD_CONTEXT=" context; context_found=1; next }
  /^ONTOLOGY_SOURCE_COMMIT=/ { print "ONTOLOGY_SOURCE_COMMIT=" commit; commit_found=1; next }
  { print }
  END {
    if (!context_found) print "AGENT_CORE_BUILD_CONTEXT=" context
    if (!commit_found) print "ONTOLOGY_SOURCE_COMMIT=" commit
  }
' "$project_root/.env" > "$temp"
chmod 600 "$temp"
mv "$temp" "$project_root/.env"

cd "$project_root"
"$docker_path" compose config >/dev/null
"$docker_path" compose build agent-core
"$docker_path" compose up -d --no-deps --force-recreate agent-core

attempt=0
until "$docker_path" compose exec -T agent-core node -e \
  "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const p=await r.json();console.log(JSON.stringify(p));process.exit(r.ok&&p.status==='ready'&&p.productionReady===true&&p.contractVersion===process.argv[1]&&p.sourceCommit===process.argv[2]?0:1)}).catch(()=>process.exit(1))" \
  "$expected_version" "$runtime_commit" \
  </dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || { "$docker_path" compose logs --tail 160 agent-core; exit 1; }
  sleep 2
done

container_id=$("$docker_path" compose ps -q agent-core)
[ -n "$container_id" ]
[ "$("$docker_path" inspect --format '{{.RestartCount}}' "$container_id")" = 0 ]

cat > "$backup_root/release-manifest.txt" <<EOF
runtime_commit=$runtime_commit
release_root=$release_root
previous_context=$previous_context
previous_version=$previous_version
previous_source_commit=$previous_source_commit
previous_image=$previous_image
expected_version=$expected_version
EOF

trap - EXIT HUP INT TERM
printf 'agent_runtime_run_id=%s\nbackup_root=%s\nruntime_commit=%s\nversion=%s\nrestart_count=0\n' "$run_id" "$backup_root" "$runtime_commit" "$expected_version"
