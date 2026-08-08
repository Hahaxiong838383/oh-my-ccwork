#!/bin/sh
set -eu
exec </dev/null

docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/validation-ontology-registry}
run_id=${VALIDATION_RUN_ID:-$$}
prefix=ontology-v3-validation-$run_id
postgres_container=$prefix-postgres
registry_container=$prefix-registry
network=$prefix-network
image=$prefix-image
runtime_root=$project_root/.validation-runtime-$run_id
tenant_id=00000000-0000-4000-8000-000000000001
registry_password=validation-registry-password
registry_token=validation-registry-control-token-that-is-long-enough

cleanup() {
  if [ "${KEEP_VALIDATION_ARTIFACTS:-0}" = 1 ]; then
    printf 'validation artifacts retained: %s\n' "$runtime_root"
    return
  fi
  "$docker_path" rm -f "$registry_container" "$postgres_container" >/dev/null 2>&1 || true
  "$docker_path" network rm "$network" >/dev/null 2>&1 || true
  "$docker_path" image rm "$image" >/dev/null 2>&1 || true
  case "$runtime_root" in
    "$project_root"/.validation-runtime-*)
      "$docker_path" run --rm -v "$runtime_root:/cleanup" docker.1ms.run/library/redis:7.4.9-alpine \
        sh -c 'rm -rf /cleanup/* /cleanup/.[!.]* /cleanup/..?*' >/dev/null 2>&1 || true
      rmdir "$runtime_root" 2>/dev/null || true
      ;;
    *) printf 'refusing to clean unexpected path: %s\n' "$runtime_root" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

mkdir -p "$runtime_root/postgres"
chmod 755 "$project_root/deploy/qnap/initdb/001-foundation.sh"

"$docker_path" network create "$network" >/dev/null
"$docker_path" run -d \
  --name "$postgres_container" \
  --network "$network" \
  -e POSTGRES_DB=ontology \
  -e POSTGRES_USER=ontology_admin \
  -e POSTGRES_PASSWORD=validation-postgres-password \
  -e POSTGRES_BACKUP_PASSWORD=validation-backup-password \
  -e ONTOLOGY_APP_PASSWORD=validation-app-password \
  -e ONTOLOGY_READONLY_PASSWORD=validation-readonly-password \
  -e ACTION_GATEWAY_PASSWORD=validation-action-password \
  -e FUTURUS_TENANT_ID="$tenant_id" \
  -v "$runtime_root/postgres:/var/lib/postgresql/data" \
  -v "$project_root/deploy/qnap/initdb:/docker-entrypoint-initdb.d:ro" \
  docker.1ms.run/pgvector/pgvector:pg17-bookworm >/dev/null

attempt=0
until "$docker_path" exec "$postgres_container" pg_isready -U ontology_admin -d ontology >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 90 ]; then
    "$docker_path" logs --tail 120 "$postgres_container" >&2
    exit 1
  fi
  sleep 1
done

for migration in "$project_root"/deploy/qnap/migrations/*.sql; do
  "$docker_path" exec -i "$postgres_container" psql \
    --set=ON_ERROR_STOP=1 \
    --username ontology_admin \
    --dbname ontology \
    --set=tenant_id="$tenant_id" \
    --set=knowledge_connector_password=validation-knowledge-password \
    --set=ontology_registry_password="$registry_password" \
    < "$migration" >/dev/null
done

"$docker_path" exec -i "$postgres_container" psql \
  --set=ON_ERROR_STOP=1 \
  --username ontology_admin \
  --dbname ontology \
  --set=ontology_registry_password="$registry_password" \
  < "$project_root/deploy/qnap/migrations/006-ontology-v3-skeleton.sql" >/dev/null

schema_result=$("$docker_path" exec "$postgres_container" psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM information_schema.schemata WHERE schema_name IN ('ontology_registry','ontology_runtime','epistemic','decision','security','work','action');")
[ "$schema_result" -eq 7 ]

view_result=$("$docker_path" exec "$postgres_container" psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM pg_views WHERE (schemaname, viewname) IN (('ontology_runtime','objects'),('ontology_runtime','links'),('security','principals'),('security','grants'),('work','tasks'),('work','task_events'),('action','intents'));")
[ "$view_result" -eq 7 ]

policy_result=$("$docker_path" exec "$postgres_container" psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM pg_policies WHERE policyname='tenant_isolation' AND schemaname IN ('ontology_registry','epistemic','audit');")
[ "$policy_result" -ge 5 ]

delete_privilege=$("$docker_path" exec "$postgres_container" psql -U ontology_admin -d ontology -Atc \
  "SELECT has_table_privilege('ontology_registry','ontology_registry.versions','DELETE');")
[ "$delete_privilege" = f ]

domain_event_update=$("$docker_path" exec "$postgres_container" psql -U ontology_admin -d ontology -Atc \
  "SELECT has_table_privilege('ontology_registry','audit.domain_events','UPDATE');")
[ "$domain_event_update" = f ]

entity_select=$("$docker_path" exec "$postgres_container" psql -U ontology_admin -d ontology -Atc \
  "SELECT has_table_privilege('ontology_registry','ontology.entities','SELECT');")
[ "$entity_select" = f ]

cd "$project_root"
"$docker_path" build -t "$image" -f services/ontology-registry/Dockerfile . >/dev/null
"$docker_path" run -d \
  --name "$registry_container" \
  --network "$network" \
  -e ONTOLOGY_REGISTRY_CONTROL_TOKEN="$registry_token" \
  -e FUTURUS_TENANT_ID="$tenant_id" \
  -e PGHOST="$postgres_container" \
  -e PGDATABASE=ontology \
  -e PGUSER=ontology_registry \
  -e PGPASSWORD="$registry_password" \
  "$image" >/dev/null

attempt=0
until "$docker_path" exec "$registry_container" node -e \
  "fetch('http://127.0.0.1:8084/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    "$docker_path" logs --tail 120 "$registry_container" >&2
    exit 1
  fi
  sleep 1
done

"$docker_path" exec -i \
  -e ONTOLOGY_REGISTRY_CONTROL_TOKEN="$registry_token" \
  "$registry_container" node --input-type=module - <<'NODE'
const response = await fetch('http://127.0.0.1:8084/v1/deploy', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-ontology-registry-token': process.env.ONTOLOGY_REGISTRY_CONTROL_TOKEN,
  },
  body: JSON.stringify({
    proposalId: 'isolated-bootstrap',
    approvedBy: 'ontology-owner',
    sourceCommit: 'abcdef1',
  }),
})
const payload = await response.json()
if (!response.ok || payload.status !== 'deployed') throw new Error(JSON.stringify(payload))
NODE

"$docker_path" exec -i "$registry_container" node --input-type=module - <<'NODE'
const response = await fetch('http://127.0.0.1:8084/readyz')
const payload = await response.json()
if (!response.ok || payload.status !== 'in_sync' || payload.local.contentHash !== payload.active.contentHash) {
  throw new Error(JSON.stringify(payload))
}
NODE

"$docker_path" exec -i "$registry_container" node --input-type=module - <<'NODE'
import { compileDefinition, loadDefinitionDirectory } from '@futurus/ontology-contracts'
import { createPostgresRegistryStore } from './src/store.mjs'

const tenantId = process.env.FUTURUS_TENANT_ID
const baseline = await loadDefinitionDirectory('/app/packages/ontology-contracts/definitions')
const candidate = structuredClone(baseline)
candidate.objectTypes.find((entry) => entry.qualifiedName === 'core.work.Task').properties.push({
  name: 'integrationOptionalField', type: 'string', required: false,
})
const first = compileDefinition(baseline).bundle
const second = compileDefinition(candidate).bundle
const store = createPostgresRegistryStore({
  database: {
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  },
})
await store.deploy({
  tenantId, bundle: second, sourceCommit: 'abcdef2', proposalId: 'isolated-candidate',
  approvedBy: 'ontology-owner', compatibility: 'compatible', migrationPlan: {},
})
const reactivated = await store.deploy({
  tenantId, bundle: first, sourceCommit: 'abcdef3', proposalId: 'isolated-rollback',
  approvedBy: 'ontology-owner', compatibility: 'migration_required',
  migrationPlan: { steps: ['verify optional field is unused', 'reactivate baseline'] },
})
if (!reactivated.reactivated) throw new Error('historical version was not reactivated')
await store.close()
NODE

version_result=$("$docker_path" exec "$postgres_container" psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) || ':' || count(*) FILTER (WHERE status='active') FROM ontology_registry.versions;")
[ "$version_result" = 2:1 ]

audit_result=$("$docker_path" exec "$postgres_container" psql -U ontology_admin -d ontology -Atc \
  "SELECT (SELECT count(*) FROM audit.domain_events WHERE event_type='ontology.version.deployed') || ':' || (SELECT count(*) FROM audit.events WHERE event_type='ontology_version_deployed');")
[ "$audit_result" = 3:3 ]

rls_without_tenant=$("$docker_path" exec -e PGPASSWORD="$registry_password" "$postgres_container" \
  psql -h 127.0.0.1 -U ontology_registry -d ontology -Atc "SELECT count(*) FROM ontology_registry.versions;")
[ "$rls_without_tenant" -eq 0 ]

rls_with_tenant=$("$docker_path" exec -e PGPASSWORD="$registry_password" "$postgres_container" \
  psql -h 127.0.0.1 -U ontology_registry -d ontology -Atc \
  "SELECT set_config('app.tenant_id','$tenant_id',false); SELECT count(*) FROM ontology_registry.versions;" | tail -1)
[ "$rls_with_tenant" -eq 2 ]

printf 'isolated ontology registry validation passed: schemas=%s views=%s policies=%s versions=%s audits=%s\n' \
  "$schema_result" "$view_result" "$policy_result" "$version_result" "$audit_result"
