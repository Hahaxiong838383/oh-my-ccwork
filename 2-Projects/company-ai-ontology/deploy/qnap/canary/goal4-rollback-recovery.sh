#!/bin/sh
set -eu
exec </dev/null

project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
rollback_suffix=${GOAL4_ROLLBACK_SUFFIX:-20260809-goal4-16c400531}
current_source_commit=${GOAL4_CURRENT_SOURCE_COMMIT:-16c400531}
run_id=${GOAL4_RUN_ID:-$(date +%Y%m%d%H%M%S)}

cd "$project_root"
set -a
. ./.env
set +a

agent_image=company-ai-foundation-agent-core
registry_image=company-ai-foundation-ontology-registry
saved_agent_tag=$agent_image:goal4-recovery-$run_id
saved_registry_tag=$registry_image:goal4-recovery-$run_id
rollback_agent_tag=$agent_image:rollback-$rollback_suffix
rollback_registry_tag=$registry_image:rollback-$rollback_suffix
gateway_config_backup=/tmp/goal4-caddy-current-$run_id
rollback_source=/share/CACHEDEV2_DATA/ai-ontology-backup/goal4/$rollback_suffix/source
restored=0

wait_health() {
  service=$1
  url=$2
  attempt=0
  until "$docker_path" compose exec -T "$service" node -e "fetch('$url').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" </dev/null >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 60 ] || { "$docker_path" compose logs --tail 120 "$service"; return 1; }
    sleep 2
  done
}

deploy_local_registry() {
  source_commit=$1
  proposal_id=$2
  allow_migration=$3
  "$docker_path" compose exec -T \
    -e GOAL4_SOURCE_COMMIT="$source_commit" \
    -e GOAL4_PROPOSAL_ID="$proposal_id" \
    -e GOAL4_ALLOW_MIGRATION="$allow_migration" \
    ontology-registry node --input-type=module <<'NODE'
const body = {
  proposalId: process.env.GOAL4_PROPOSAL_ID,
  approvedBy: 'ontology-owner',
  sourceCommit: process.env.GOAL4_SOURCE_COMMIT,
}
if (process.env.GOAL4_ALLOW_MIGRATION === '1') {
  body.allowMigration = true
  body.migrationPlan = { steps: ['reactivate verified additive baseline', 'preserve newer tables for forward recovery'] }
}
const response = await fetch('http://127.0.0.1:8084/v1/deploy', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-ontology-registry-token': process.env.ONTOLOGY_REGISTRY_CONTROL_TOKEN,
  },
  body: JSON.stringify(body),
})
const payload = await response.json()
if (!response.ok || !['deployed', 'reactivated', 'already_active'].includes(payload.status)) throw new Error(JSON.stringify(payload))
console.log(JSON.stringify({ status: payload.status, schemaVersion: payload.active?.schemaVersion, contentHash: payload.active?.contentHash?.slice(0, 12) }))
NODE
}

restore_current() {
  [ "$restored" = 0 ] || return 0
  cp "$gateway_config_backup" config/Caddyfile
  "$docker_path" image tag "$saved_registry_tag" "$registry_image"
  "$docker_path" compose up -d --no-deps --force-recreate ontology-registry gateway
  wait_health ontology-registry http://127.0.0.1:8084/healthz
  deploy_local_registry "$current_source_commit" "goal4-recovery-$run_id" 0
  "$docker_path" image tag "$saved_agent_tag" "$agent_image"
  "$docker_path" compose up -d --no-deps --force-recreate agent-core
  wait_health agent-core http://127.0.0.1:8080/healthz
  attempt=0
  until curl --silent --fail --max-time 5 http://192.168.61.18:19080/ontology/status/work-protocol | grep -q '"status":"active"'; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 30 ] || return 1
    sleep 1
  done
  restored=1
}
trap 'restore_current || true' EXIT INT TERM

test -f "$rollback_source/config/Caddyfile"
"$docker_path" image inspect "$rollback_agent_tag" "$rollback_registry_tag" >/dev/null
cp config/Caddyfile "$gateway_config_backup"
"$docker_path" image tag "$agent_image" "$saved_agent_tag"
"$docker_path" image tag "$registry_image" "$saved_registry_tag"

baseline_source_commit=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT source_commit FROM ontology_registry.versions WHERE schema_version='3.0.0' ORDER BY created_at DESC LIMIT 1;")
case "$baseline_source_commit" in *[!0-9a-fA-F]*|'') echo 'baseline source commit unavailable' >&2; exit 1 ;; esac

"$docker_path" image tag "$rollback_registry_tag" "$registry_image"
"$docker_path" compose up -d --no-deps --force-recreate ontology-registry
wait_health ontology-registry http://127.0.0.1:8084/healthz
deploy_local_registry "$baseline_source_commit" "goal4-rollback-$run_id" 1

"$docker_path" image tag "$rollback_agent_tag" "$agent_image"
cp "$rollback_source/config/Caddyfile" config/Caddyfile
"$docker_path" compose up -d --no-deps --force-recreate agent-core gateway
wait_health agent-core http://127.0.0.1:8080/healthz
attempt=0
until curl --silent --fail --max-time 5 http://192.168.61.18:19080/ontology/status/registry | grep -q '"schemaVersion":"3.0.0"'; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || exit 1
  sleep 1
done
rollback_agent_status=$("$docker_path" compose exec -T agent-core node -e "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const p=await r.json();if(!r.ok)process.exit(1);console.log(JSON.stringify({contractVersion:p.contractVersion,status:p.status,productionReady:p.productionReady}))})")
rollback_work_http=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 http://192.168.61.18:19080/ontology/status/work-protocol || true)
printf 'rollback registry=3.0.0 agent=%s work_protocol_http=%s\n' "$rollback_agent_status" "$rollback_work_http"
[ "$rollback_work_http" = 404 ]

restore_current
trap - EXIT INT TERM

current_status=$(curl --silent --show-error --fail --max-time 10 http://192.168.61.18:19080/ontology/status/work-protocol)
printf '%s' "$current_status" | grep -q '"ontologySchemaVersion":"3.1.0"'
printf '%s' "$current_status" | grep -q '"status":"active"'

for service in agent-core ontology-registry gateway; do
  container=$("$docker_path" compose ps -q "$service")
  restart_count=$("$docker_path" inspect --format '{{.RestartCount}}' "$container")
  printf '%s_restart_count=%s\n' "$service" "$restart_count"
  [ "$restart_count" -eq 0 ]
done

"$docker_path" image rm "$saved_agent_tag" "$saved_registry_tag" >/dev/null 2>&1 || true
rm -f "$gateway_config_backup"
