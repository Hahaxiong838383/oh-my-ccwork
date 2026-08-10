#!/bin/sh
set -eu
exec </dev/null

docker_path=${DOCKER_PATH:-docker}
project_root=${PROJECT_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)}
run_id=${VALIDATION_RUN_ID:-$$}
container=ontology-si-validation-$run_id
runtime_root=${TMPDIR:-/tmp}/ontology-si-validation-$run_id
tenant_id=00000000-0000-4000-8000-000000000001
image=docker.1ms.run/pgvector/pgvector:pg17-bookworm

cleanup() {
  "$docker_path" rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$runtime_root"
}
trap cleanup EXIT INT TERM

command -v "$docker_path" >/dev/null 2>&1 || [ -x "$docker_path" ] || { echo 'container runtime unavailable' >&2; exit 2; }
mkdir -p "$runtime_root/postgres"
"$docker_path" run -d \
  --name "$container" \
  --network none \
  -e POSTGRES_DB=ontology \
  -e POSTGRES_USER=ontology_admin \
  -e POSTGRES_PASSWORD=validation-postgres-password \
  -e POSTGRES_BACKUP_PASSWORD=validation-backup-password \
  -e ONTOLOGY_APP_PASSWORD=validation-app-password \
  -e ONTOLOGY_READONLY_PASSWORD=validation-readonly-password \
  -e ACTION_GATEWAY_PASSWORD=validation-action-password \
  -e KNOWLEDGE_CONNECTOR_PASSWORD=validation-knowledge-password \
  -e ONTOLOGY_REGISTRY_PASSWORD=validation-registry-password \
  -e DOMAIN_CONNECTOR_PASSWORD=validation-domain-password \
  -e FUTURUS_TENANT_ID="$tenant_id" \
  -v "$runtime_root/postgres:/var/lib/postgresql/data" \
  -v "$project_root/deploy/qnap/initdb:/docker-entrypoint-initdb.d:ro" \
  "$image" >/dev/null

attempt=0
until "$docker_path" exec "$container" psql -U ontology_admin -d ontology -Atc 'SELECT 1' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 90 ] || { "$docker_path" logs --tail 120 "$container" >&2; exit 1; }
  sleep 1
done

for migration in "$project_root"/deploy/qnap/migrations/*.sql; do
  "$docker_path" exec -i "$container" psql --set=ON_ERROR_STOP=1 -U ontology_admin -d ontology \
    --set=tenant_id="$tenant_id" \
    --set=knowledge_connector_password=validation-knowledge-password \
    --set=ontology_registry_password=validation-registry-password \
    --set=domain_connector_password=validation-domain-password \
    < "$migration" >/dev/null
done
"$docker_path" exec "$container" pg_dump -U ontology_admin -d ontology -Fc -f /tmp/baseline.dump

for migration in "$project_root"/deploy/qnap/candidate-migrations/010-pestim-strategic-intelligence.sql "$project_root"/deploy/qnap/candidate-migrations/011-pestim-reporting.sql; do
  "$docker_path" exec -i "$container" psql --set=ON_ERROR_STOP=1 -U ontology_admin -d ontology \
    --set=tenant_id="$tenant_id" < "$migration" >/dev/null
done

table_count=$($docker_path exec "$container" psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='strategic_intelligence';")
[ "$table_count" -ge 16 ] || { echo 'strategic intelligence tables missing' >&2; exit 1; }
forced_rls_count=$($docker_path exec "$container" psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='strategic_intelligence' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity;")
[ "$forced_rls_count" -eq "$table_count" ] || { echo 'not all strategic intelligence tables force RLS' >&2; exit 1; }

"$docker_path" exec "$container" createdb -U ontology_admin ontology_restore
"$docker_path" exec "$container" pg_restore -U ontology_admin -d ontology_restore /tmp/baseline.dump
restored_schema=$($docker_path exec "$container" psql -U ontology_admin -d ontology_restore -Atc \
  "SELECT coalesce(to_regnamespace('strategic_intelligence')::text,'absent');")
[ "$restored_schema" = absent ] || { echo 'baseline restore unexpectedly contains candidate schema' >&2; exit 1; }
foundation_present=$($docker_path exec "$container" psql -U ontology_admin -d ontology_restore -Atc \
  "SELECT CASE WHEN to_regclass('platform.tenants') IS NOT NULL THEN 'yes' ELSE 'no' END;")
[ "$foundation_present" = yes ] || { echo 'baseline restore is incomplete' >&2; exit 1; }

printf 'candidate_migrations=verified\ntables=%s\nforced_rls=%s\nbaseline_restore=verified\n' "$table_count" "$forced_rls_count"
