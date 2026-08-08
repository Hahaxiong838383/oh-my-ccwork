#!/bin/sh
set -eu

docker_path=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}

cd "$project_root"
set -a
. ./.env
set +a

for migration in migrations/*.sql; do
  [ -f "$migration" ] || continue
  printf 'applying %s\n' "$migration"
  "$docker_path" compose exec -T postgres psql \
    --set=ON_ERROR_STOP=1 \
    --username ontology_admin \
    --dbname ontology \
    --set=tenant_id="$FUTURUS_TENANT_ID" \
    --set=knowledge_connector_password="$KNOWLEDGE_CONNECTOR_PASSWORD" \
    < "$migration"
done
