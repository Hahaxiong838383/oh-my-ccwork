#!/bin/sh
set -eu
exec </dev/null

docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
release_root=${DOMAIN_RUNTIME_RELEASE_ROOT:?DOMAIN_RUNTIME_RELEASE_ROOT is required}
runtime_commit=${DOMAIN_RUNTIME_COMMIT:?DOMAIN_RUNTIME_COMMIT is required}
run_id=${DOMAIN_RUNTIME_RUN_ID:-$(date +%Y%m%d%H%M%S)}
backup_root=/share/CACHEDEV2_DATA/ai-ontology-backup/domain-runtime/$run_id
previous_image=company-ai-foundation-domain-connector:pre-$run_id

[ "$(hostname)" = PRNas ] || { echo 'refusing non-company QNAP host' >&2; exit 1; }
[ "$project_root" = /share/CACHEDEV1_DATA/ai-ontology/foundation ] || { echo 'refusing unexpected company ontology root' >&2; exit 1; }
[ -f "$release_root/services/domain-connector/Dockerfile" ] || { echo 'domain runtime release incomplete' >&2; exit 1; }
case "$runtime_commit" in *[!0-9a-fA-F]*|'') echo 'DOMAIN_RUNTIME_COMMIT must be a Git commit hash' >&2; exit 2 ;; esac
[ "${#runtime_commit}" -ge 7 ] || { echo 'DOMAIN_RUNTIME_COMMIT must contain at least 7 hex characters' >&2; exit 2; }

mkdir -p "$backup_root"
chmod 700 "$backup_root"
cp "$project_root/.env" "$backup_root/.env"
chmod 600 "$backup_root/.env"
previous_context=$(awk -F= '/^DOMAIN_CONNECTOR_BUILD_CONTEXT=/{print $2; exit}' "$project_root/.env")
previous_version=$("$docker_path" compose -f "$project_root/docker-compose.yml" exec -T domain-connector node -e \
  "fetch('http://127.0.0.1:8085/readyz').then(async r=>{const p=await r.json();process.stdout.write(String(p.version||''))}).catch(()=>process.exit(1))" \
  </dev/null 2>/dev/null || true)
[ -n "$previous_version" ] || { echo 'current domain runtime version is unavailable' >&2; exit 1; }
"$docker_path" image inspect company-ai-foundation-domain-connector:latest >/dev/null
"$docker_path" image tag company-ai-foundation-domain-connector:latest "$previous_image"

rollback_on_error() {
  status=$?
  trap - EXIT HUP INT TERM
  [ "$status" -ne 0 ] || exit 0
  set +e
  cp "$backup_root/.env" "$project_root/.env"
  chmod 600 "$project_root/.env"
  if "$docker_path" image inspect "$previous_image" >/dev/null 2>&1; then
    "$docker_path" image tag "$previous_image" company-ai-foundation-domain-connector:latest
    cd "$project_root"
    "$docker_path" compose up -d --no-build domain-connector
    attempt=0
    until "$docker_path" compose exec -T domain-connector node -e \
      "fetch('http://127.0.0.1:8085/readyz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.status==='ready'&&p.version===process.argv[1]?0:1)}).catch(()=>process.exit(1))" \
      "$previous_version" \
      </dev/null 2>/dev/null; do
      attempt=$((attempt + 1))
      [ "$attempt" -lt 60 ] || break
      sleep 2
    done
  fi
  printf 'domain runtime deployment failed; previous env and image were restored\n' >&2
  exit "$status"
}
trap rollback_on_error EXIT HUP INT TERM

temp=$project_root/.env.domain-runtime-$run_id
awk -v value="$release_root/services/domain-connector" '
  BEGIN { found=0 }
  /^DOMAIN_CONNECTOR_BUILD_CONTEXT=/ { print "DOMAIN_CONNECTOR_BUILD_CONTEXT=" value; found=1; next }
  { print }
  END { if (!found) print "DOMAIN_CONNECTOR_BUILD_CONTEXT=" value }
' "$project_root/.env" > "$temp"
chmod 600 "$temp"
mv "$temp" "$project_root/.env"

cd "$project_root"
"$docker_path" compose config >/dev/null
"$docker_path" compose build domain-connector
"$docker_path" compose up -d domain-connector

attempt=0
until "$docker_path" compose exec -T domain-connector node -e \
  "fetch('http://127.0.0.1:8085/readyz').then(async r=>{const p=await r.json();console.log(JSON.stringify(p));process.exit(r.ok&&p.status==='ready'&&p.version===process.argv[1]?0:1)}).catch(()=>process.exit(1))" \
  "${DOMAIN_RUNTIME_EXPECTED_VERSION:-2026-08-10.1}" \
  </dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || { "$docker_path" compose logs --tail 160 domain-connector; exit 1; }
  sleep 2
done

container_id=$("$docker_path" compose ps -q domain-connector)
[ -n "$container_id" ]
[ "$("$docker_path" inspect --format '{{.RestartCount}}' "$container_id")" = 0 ]

cat > "$backup_root/release-manifest.txt" <<EOF
runtime_commit=$runtime_commit
release_root=$release_root
previous_context=$previous_context
previous_version=$previous_version
previous_image=$previous_image
EOF

trap - EXIT HUP INT TERM
printf 'domain_runtime_run_id=%s\nbackup_root=%s\nruntime_commit=%s\nversion=%s\nrestart_count=0\n' "$run_id" "$backup_root" "$runtime_commit" "${DOMAIN_RUNTIME_EXPECTED_VERSION:-2026-08-10.1}"
