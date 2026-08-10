#!/bin/sh
set -eu
exec </dev/null
umask 077

docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
release_root=${ONTOLOGY_CONTRACTS_RELEASE_ROOT:?ONTOLOGY_CONTRACTS_RELEASE_ROOT is required}
source_commit=${ONTOLOGY_CONTRACTS_SOURCE_COMMIT:?ONTOLOGY_CONTRACTS_SOURCE_COMMIT is required}
run_id=${ONTOLOGY_CONTRACTS_DEPLOY_RUN_ID:-$(date +%Y%m%d%H%M%S)}
expected_active_schema=${ONTOLOGY_CONTRACTS_ACTIVE_SCHEMA:-3.3.0}
expected_active_hash=${ONTOLOGY_CONTRACTS_ACTIVE_HASH:-41689393289d9514d1ed9cd22455a164f1bc59286f0db16deb9235e703e6ae77}
expected_candidate_schema=${ONTOLOGY_CONTRACTS_CANDIDATE_SCHEMA:-3.4.0}
backup_root=/share/CACHEDEV2_DATA/ai-ontology-backup/p1-si-a/$run_id
previous_image=company-ai-foundation-ontology-registry:p1-si-a-pre-$run_id
current_image=company-ai-foundation-ontology-registry:latest

[ "$(hostname)" = PRNas ] || { echo 'refusing non-company QNAP host' >&2; exit 1; }
[ "$project_root" = /share/CACHEDEV1_DATA/ai-ontology/foundation ] || { echo 'refusing unexpected company ontology root' >&2; exit 1; }
[ -d "$project_root" ] || { echo 'company ontology project root missing' >&2; exit 1; }
[ -f "$release_root/packages/ontology-contracts/contracts/pestim-strategic-intelligence-v1.json" ] || { echo 'PESTIM contract missing' >&2; exit 1; }
[ -f "$release_root/packages/ontology-contracts/bin/pestim-compile.mjs" ] || { echo 'PESTIM compiler missing' >&2; exit 1; }
[ -f "$release_root/services/ontology-registry/Dockerfile" ] || { echo 'ontology registry release missing' >&2; exit 1; }
[ -f "$project_root/.env" ] || { echo 'foundation env missing' >&2; exit 1; }

case "$source_commit" in
  *[!0-9a-fA-F]*|'') echo 'ONTOLOGY_CONTRACTS_SOURCE_COMMIT must be a Git commit hash' >&2; exit 2 ;;
esac
[ "${#source_commit}" -ge 7 ] || { echo 'ONTOLOGY_CONTRACTS_SOURCE_COMMIT must contain at least 7 hex characters' >&2; exit 2; }

grep -q '"schemaVersion": "3.3.0"' "$release_root/packages/ontology-contracts/definitions/manifest.json" || {
  echo 'active definition manifest must remain on schema 3.3.0' >&2
  exit 1
}

mkdir -p "$backup_root"
chmod 700 "$backup_root"
cp "$project_root/.env" "$backup_root/.env"
chmod 600 "$backup_root/.env"
previous_context=$(awk -F= '/^ONTOLOGY_REGISTRY_BUILD_CONTEXT=/{print $2; exit}' "$project_root/.env")

"$docker_path" image inspect "$current_image" >/dev/null
previous_image_id=$("$docker_path" image inspect --format '{{.Id}}' "$current_image")
"$docker_path" image tag "$current_image" "$previous_image"

rollback_on_error() {
  status=$?
  trap - EXIT HUP INT TERM
  [ "$status" -ne 0 ] || exit 0
  set +e
  cp "$backup_root/.env" "$project_root/.env"
  chmod 600 "$project_root/.env"
  "$docker_path" image tag "$previous_image" "$current_image"
  cd "$project_root"
  "$docker_path" compose up -d --no-deps --force-recreate --no-build ontology-registry
  attempt=0
  until "$docker_path" compose exec -T ontology-registry node --input-type=module - "$expected_active_schema" "$expected_active_hash" <<'NODE'
const [schema, hash] = process.argv.slice(2)
const response = await fetch('http://127.0.0.1:8084/readyz')
const payload = await response.json()
process.exit(response.ok && payload.status === 'in_sync' && payload.local?.schemaVersion === schema && payload.local?.contentHash === hash ? 0 : 1)
NODE
  do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 60 ] || break
    sleep 2
  done
  echo 'ontology contracts deployment failed; previous env and image were restored' >&2
  exit "$status"
}
trap rollback_on_error EXIT HUP INT TERM

temp=$project_root/.env.p1-si-a-$run_id
awk -v value="$release_root" '
  BEGIN { found=0 }
  /^ONTOLOGY_REGISTRY_BUILD_CONTEXT=/ { print "ONTOLOGY_REGISTRY_BUILD_CONTEXT=" value; found=1; next }
  { print }
  END { if (!found) print "ONTOLOGY_REGISTRY_BUILD_CONTEXT=" value }
' "$project_root/.env" > "$temp"
chmod 600 "$temp"
mv "$temp" "$project_root/.env"

cd "$project_root"
"$docker_path" compose config >/dev/null
"$docker_path" compose build ontology-registry

new_image_id=$("$docker_path" image inspect --format '{{.Id}}' "$current_image")
[ "$new_image_id" != "$previous_image_id" ] || { echo 'ontology registry image did not change' >&2; exit 1; }

"$docker_path" run --rm -i --entrypoint node "$current_image" --input-type=module - "$expected_active_schema" "$expected_candidate_schema" <<'NODE'
const [activeSchema, candidateSchema] = process.argv.slice(2)
const { compilePestimStrategicIntelligenceProposal } = await import('file:///app/packages/ontology-contracts/src/index.mjs')
const result = await compilePestimStrategicIntelligenceProposal()
console.log(JSON.stringify({
  proposalKey: result.contract.proposalKey,
  status: result.contract.status,
  deploymentAllowed: result.contract.deploymentAllowed,
  baselineSchemaVersion: result.baseline.schemaVersion,
  candidateSchemaVersion: result.candidate.schemaVersion,
  candidateContentHash: result.candidate.contentHash,
  compatibility: result.compatibility.classification,
}))
process.exit(
  result.contract.status === 'contract_only' &&
  result.contract.deploymentAllowed === false &&
  result.baseline.schemaVersion === activeSchema &&
  result.candidate.schemaVersion === candidateSchema &&
  result.compatibility.classification === 'compatible'
    ? 0
    : 1
)
NODE

cutover_started_at=$(date +%s)
"$docker_path" compose up -d --no-deps --force-recreate ontology-registry

attempt=0
until "$docker_path" compose exec -T ontology-registry node --input-type=module - "$expected_active_schema" "$expected_active_hash" <<'NODE'
const [schema, hash] = process.argv.slice(2)
const response = await fetch('http://127.0.0.1:8084/readyz')
const payload = await response.json()
console.log(JSON.stringify(payload))
process.exit(
  response.ok &&
  payload.status === 'in_sync' &&
  payload.local?.schemaVersion === schema &&
  payload.local?.contentHash === hash &&
  payload.active?.schemaVersion === schema &&
  payload.active?.contentHash === hash
    ? 0
    : 1
)
NODE
do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || { "$docker_path" compose logs --tail 160 ontology-registry; exit 1; }
  sleep 2
done
cutover_seconds=$(( $(date +%s) - cutover_started_at ))

container_id=$("$docker_path" compose ps -q ontology-registry)
[ -n "$container_id" ]
[ "$("$docker_path" inspect --format '{{.RestartCount}}' "$container_id")" = 0 ]

"$docker_path" compose exec -T ontology-registry node --input-type=module - "$expected_candidate_schema" <<'NODE'
const [candidateSchema] = process.argv.slice(2)
const { compilePestimStrategicIntelligenceProposal } = await import('file:///app/packages/ontology-contracts/src/index.mjs')
const result = await compilePestimStrategicIntelligenceProposal()
console.log(JSON.stringify({
  proposalKey: result.contract.proposalKey,
  status: result.contract.status,
  deploymentAllowed: result.contract.deploymentAllowed,
  candidateSchemaVersion: result.candidate.schemaVersion,
  candidateContentHash: result.candidate.contentHash,
  compatibility: result.compatibility.classification,
}))
process.exit(result.contract.deploymentAllowed === false && result.candidate.schemaVersion === candidateSchema ? 0 : 1)
NODE

cat > "$backup_root/release-manifest.txt" <<EOF
source_commit=$source_commit
release_root=$release_root
previous_context=$previous_context
previous_image=$previous_image
previous_image_id=$previous_image_id
new_image_id=$new_image_id
active_schema=$expected_active_schema
active_hash=$expected_active_hash
candidate_schema=$expected_candidate_schema
cutover_seconds=$cutover_seconds
EOF

trap - EXIT HUP INT TERM
printf 'ontology_contracts_run_id=%s\nbackup_root=%s\nsource_commit=%s\nactive_schema=%s\ncandidate_schema=%s\ncutover_seconds=%s\nrestart_count=0\n' \
  "$run_id" "$backup_root" "$source_commit" "$expected_active_schema" "$expected_candidate_schema" "$cutover_seconds"
