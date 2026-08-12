#!/bin/sh
set -eu
exec </dev/null

docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
release_root=${GOAL5_RELEASE_ROOT:?GOAL5_RELEASE_ROOT is required}
h_release_root=${GOAL5_H_RELEASE_ROOT:?GOAL5_H_RELEASE_ROOT is required}
source_commit=${GOAL5_SOURCE_COMMIT:?GOAL5_SOURCE_COMMIT is required}
h_source_commit=${GOAL5_H_SOURCE_COMMIT:?GOAL5_H_SOURCE_COMMIT is required}
run_id=${GOAL5_DEPLOY_RUN_ID:-$(date +%Y%m%d%H%M%S)}
backup_root=/share/CACHEDEV2_DATA/ai-ontology-backup/goal5/$run_id

[ "$(hostname)" = PRNas ] || { echo 'refusing non-company QNAP host' >&2; exit 1; }
[ -d "$project_root" ] || { echo 'company ontology project root missing' >&2; exit 1; }
[ -f "$release_root/deploy/qnap/docker-compose.yml" ] || { echo 'ontology release incomplete' >&2; exit 1; }
[ -f "$h_release_root/deploy/company-qnap-lite/Dockerfile" ] || { echo 'H release incomplete' >&2; exit 1; }

mkdir -p "$backup_root/config"
chmod 700 "$backup_root" "$backup_root/config"
cp "$project_root/.env" "$backup_root/config/.env"
cp "$project_root/docker-compose.yml" "$backup_root/config/docker-compose.yml"
cp "$project_root/config/Caddyfile" "$backup_root/config/Caddyfile"
chmod 600 "$backup_root/config/.env"

for image in agent-core action-gateway ontology-registry h-lite; do
  current=company-ai-foundation-$image:latest
  if "$docker_path" image inspect "$current" >/dev/null 2>&1; then
    "$docker_path" image tag "$current" "company-ai-foundation-$image:goal5-pre-$run_id"
  fi
done

cp "$release_root/deploy/qnap/docker-compose.yml" "$project_root/docker-compose.yml"
cp "$release_root/deploy/qnap/config/Caddyfile" "$project_root/config/Caddyfile"
cp "$release_root/deploy/qnap/migrations/008-decision-practice-loop.sql" "$project_root/migrations/008-decision-practice-loop.sql"
cp "$release_root/deploy/qnap/canary/goal5-practice-loop.sh" "$project_root/canary/goal5-practice-loop.sh"
cp "$release_root/deploy/qnap/canary/goal5-db-validation.sql" "$project_root/canary/goal5-db-validation.sql"
cp "$release_root/deploy/qnap/scripts/verify.sh" "$project_root/scripts/verify.sh"
chmod 755 "$project_root/canary/goal5-practice-loop.sh" "$project_root/scripts/verify.sh"

set_env() {
  key=$1
  value=$2
  temp=$project_root/.env.goal5-$run_id
  awk -v key="$key" -v value="$value" '
    BEGIN { found=0 }
    index($0, key "=") == 1 { print key "=" value; found=1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$project_root/.env" > "$temp"
  chmod 600 "$temp"
  mv "$temp" "$project_root/.env"
}

set_env AGENT_CORE_BUILD_CONTEXT "$release_root/services/agent-core"
set_env ACTION_GATEWAY_BUILD_CONTEXT "$release_root/services/action-gateway"
set_env ONTOLOGY_REGISTRY_BUILD_CONTEXT "$release_root"
set_env H_LITE_BUILD_CONTEXT "$h_release_root"
set_env ONTOLOGY_SOURCE_COMMIT "$source_commit"
set_env H_LITE_SOURCE_COMMIT "$h_source_commit"
set_env WORK_PROTOCOL_MODE active
set_env PRACTICE_PROTOCOL_MODE shadow
set_env ONTOLOGY_SCHEMA_VERSION 3.2.0

cd "$project_root"
PROJECT_ROOT="$project_root" ./scripts/migrate.sh >/dev/null
"$docker_path" compose build agent-core action-gateway ontology-registry h-lite
"$docker_path" compose up -d agent-core action-gateway ontology-registry h-lite gateway

attempt=0
until "$docker_path" compose exec -T agent-core node -e \
  "fetch('http://127.0.0.1:8080/status/practice-protocol').then(async r=>{const p=await r.json();process.exit(r.ok&&p.status==='shadow'?0:1)}).catch(()=>process.exit(1))" \
  </dev/null >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 90 ] || { "$docker_path" compose logs --tail 160 agent-core action-gateway ontology-registry h-lite gateway; exit 1; }
  sleep 2
done

ONTOLOGY_SOURCE_COMMIT="$source_commit" \
ONTOLOGY_PROPOSAL_ID="goal5-$run_id" \
ONTOLOGY_APPROVED_BY=company-ai-ontology-owner \
PROJECT_ROOT="$project_root" \
  ./scripts/deploy-ontology-registry.sh >/dev/null

cat > "$backup_root/release-manifest.txt" <<EOF
run_id=$run_id
ontology_source_commit=$source_commit
h_source_commit=$h_source_commit
release_root=$release_root
h_release_root=$h_release_root
previous_agent_core_image=company-ai-foundation-agent-core:goal5-pre-$run_id
previous_action_gateway_image=company-ai-foundation-action-gateway:goal5-pre-$run_id
previous_ontology_registry_image=company-ai-foundation-ontology-registry:goal5-pre-$run_id
previous_h_lite_image=company-ai-foundation-h-lite:goal5-pre-$run_id
EOF

printf 'goal5_deploy_run_id=%s\nbackup_root=%s\nsource_commit=%s\nh_source_commit=%s\n' \
  "$run_id" "$backup_root" "$source_commit" "$h_source_commit"
