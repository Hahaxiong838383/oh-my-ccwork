#!/bin/sh
set -eu
exec </dev/null

docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/validation-decision-practice}
run_id=${VALIDATION_RUN_ID:-$$}
container=ontology-goal5-validation-$run_id
runtime_root=$project_root/.validation-runtime-$run_id
tenant_id=00000000-0000-4000-8000-000000000001

cleanup() {
  "$docker_path" rm -f "$container" >/dev/null 2>&1 || true
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

"$docker_path" run -d \
  --name "$container" \
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
until "$docker_path" exec "$container" psql -U ontology_admin -d ontology -Atc 'SELECT 1' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 90 ]; then
    "$docker_path" logs --tail 120 "$container" >&2
    exit 1
  fi
  sleep 1
done

for migration in "$project_root"/deploy/qnap/migrations/*.sql; do
  "$docker_path" exec -i "$container" psql \
    --set=ON_ERROR_STOP=1 \
    --username ontology_admin \
    --dbname ontology \
    --set=tenant_id="$tenant_id" \
    --set=knowledge_connector_password=validation-knowledge-password \
    --set=ontology_registry_password=validation-registry-password \
    < "$migration" >/dev/null
done

"$docker_path" exec -i "$container" psql \
  --set=ON_ERROR_STOP=1 \
  --username ontology_admin \
  --dbname ontology \
  --set=tenant_id="$tenant_id" \
  < "$project_root/deploy/qnap/migrations/008-decision-practice-loop.sql" >/dev/null

validation_output=$("$docker_path" exec -i "$container" psql \
  --set=ON_ERROR_STOP=1 \
  --username ontology_admin \
  --dbname ontology \
  --set=tenant_id="$tenant_id" \
  < "$project_root/deploy/qnap/canary/goal5-db-validation.sql")

printf '%s\n' "$validation_output"

rls_without_tenant=$("$docker_path" exec -e PGPASSWORD=validation-app-password "$container" \
  psql -h 127.0.0.1 -U ontology_app -d ontology -Atc 'SELECT count(*) FROM decision.cases;')
[ "$rls_without_tenant" -eq 0 ]

lineage_result=$(printf '%s\n' "$validation_output" | awk -F '|' '/goal5-decision[[:space:]]*\|/{gsub(/[[:space:]]/, "", $0); print; exit}')
case "$lineage_result" in
  goal5-decision\|2\|2\|2\|2\|t\|t\|t\|goal_verified) ;;
  *) printf 'unexpected lineage result: %s\n' "$lineage_result" >&2; exit 1 ;;
esac

printf 'isolated decision practice validation passed: rls_without_tenant=%s lineage=%s\n' \
  "$rls_without_tenant" "$lineage_result"
