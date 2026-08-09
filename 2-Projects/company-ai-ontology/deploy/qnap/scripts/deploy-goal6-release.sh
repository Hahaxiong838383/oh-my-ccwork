#!/bin/sh
set -eu
exec </dev/null
umask 077

docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
release_root=${GOAL6_RELEASE_ROOT:?GOAL6_RELEASE_ROOT is required}
source_commit=${GOAL6_SOURCE_COMMIT:?GOAL6_SOURCE_COMMIT is required}
erp_authorization_file=${GOAL6_ERP_AUTHORIZATION_FILE:?GOAL6_ERP_AUTHORIZATION_FILE is required}
market_token_file=${GOAL6_MARKET_TOKEN_FILE:?GOAL6_MARKET_TOKEN_FILE is required}
run_id=${GOAL6_DEPLOY_RUN_ID:-$(date +%Y%m%d%H%M%S)}
backup_root=/share/CACHEDEV2_DATA/ai-ontology-backup/goal6/$run_id

[ "$(hostname)" = PRNas ] || { echo 'refusing non-company QNAP host' >&2; exit 1; }
[ -d "$project_root" ] || { echo 'company ontology project root missing' >&2; exit 1; }
[ -f "$release_root/deploy/qnap/docker-compose.yml" ] || { echo 'ontology release incomplete' >&2; exit 1; }
[ -f "$release_root/deploy/qnap/migrations/009-domain-read-model.sql" ] || { echo 'goal6 migration missing' >&2; exit 1; }
[ -f "$release_root/services/domain-connector/Dockerfile" ] || { echo 'domain connector release missing' >&2; exit 1; }
[ -s "$erp_authorization_file" ] || { echo 'ERP authorization file missing' >&2; exit 1; }
[ -s "$market_token_file" ] || { echo 'market token file missing' >&2; exit 1; }

case "$source_commit" in
  *[!0-9a-fA-F]*|'') echo 'GOAL6_SOURCE_COMMIT must be a Git commit hash' >&2; exit 2 ;;
esac
[ "${#source_commit}" -ge 7 ] || { echo 'GOAL6_SOURCE_COMMIT must contain at least 7 hex characters' >&2; exit 2; }

erp_authorization=$(cat "$erp_authorization_file")
market_token=$(cat "$market_token_file")
case "$erp_authorization" in
  token\ *:*) ;;
  *) echo 'ERP authorization format invalid' >&2; exit 2 ;;
esac
case "$market_token" in
  *[!A-Za-z0-9._~-]*|'') echo 'market token format invalid' >&2; exit 2 ;;
esac

mkdir -p "$backup_root/config" "$backup_root/images"
chmod 700 "$backup_root" "$backup_root/config" "$backup_root/images"
cp "$project_root/.env" "$backup_root/config/.env"
cp "$project_root/docker-compose.yml" "$backup_root/config/docker-compose.yml"
cp "$project_root/config/Caddyfile" "$backup_root/config/Caddyfile"
tar -C "$project_root" -czf "$backup_root/config/foundation-files.tar.gz" scripts migrations initdb canary config
chmod 600 "$backup_root/config/.env" "$backup_root/config/foundation-files.tar.gz"

for image in agent-core ontology-registry domain-connector gateway; do
  current=company-ai-foundation-$image:latest
  if "$docker_path" image inspect "$current" >/dev/null 2>&1; then
    "$docker_path" image tag "$current" "company-ai-foundation-$image:goal6-pre-$run_id"
    printf '%s\n' "company-ai-foundation-$image:goal6-pre-$run_id" >> "$backup_root/images/tags.txt"
  fi
done

cd "$project_root"
"$docker_path" compose exec -T postgres-backup /scripts/postgres-backup.sh

cp "$release_root/deploy/qnap/docker-compose.yml" "$project_root/docker-compose.yml"
cp "$release_root/deploy/qnap/config/Caddyfile" "$project_root/config/Caddyfile"
cp "$release_root/deploy/qnap/scripts/"*.sh "$project_root/scripts/"
cp "$release_root/deploy/qnap/migrations/"*.sql "$project_root/migrations/"
cp "$release_root/deploy/qnap/initdb/"* "$project_root/initdb/"
cp "$release_root/deploy/qnap/canary/"* "$project_root/canary/"
chmod 755 "$project_root/scripts/"*.sh "$project_root/canary/"*.sh

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | sha256sum | awk '{print $1}'
  fi
}

set_env_plain() {
  key=$1
  value=$2
  temp=$project_root/.env.goal6-$run_id
  awk -v key="$key" -v value="$value" '
    BEGIN { found=0 }
    index($0, key "=") == 1 { print key "=" value; found=1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$project_root/.env" > "$temp"
  chmod 600 "$temp"
  mv "$temp" "$project_root/.env"
}

set_env_quoted() {
  key=$1
  value=$2
  case "$value" in *"'"*|*"\n"*) echo "$key contains unsupported characters" >&2; exit 2 ;; esac
  set_env_plain "$key" "'$value'"
}

if ! grep -q '^DOMAIN_CONNECTOR_PASSWORD=.' "$project_root/.env"; then
  set_env_plain DOMAIN_CONNECTOR_PASSWORD "$(random_hex)"
fi
if ! grep -q '^DOMAIN_CONNECTOR_CONTROL_TOKEN=.' "$project_root/.env"; then
  set_env_plain DOMAIN_CONNECTOR_CONTROL_TOKEN "$(random_hex)"
fi

set_env_plain AGENT_CORE_BUILD_CONTEXT "$release_root/services/agent-core"
set_env_plain ONTOLOGY_REGISTRY_BUILD_CONTEXT "$release_root"
set_env_plain DOMAIN_CONNECTOR_BUILD_CONTEXT "$release_root/services/domain-connector"
set_env_plain ONTOLOGY_SCHEMA_VERSION 3.3.0
set_env_plain WORK_PROTOCOL_MODE active
set_env_plain PRACTICE_PROTOCOL_MODE active
set_env_plain AISHIKE_ERP_M3_READ_ENABLED 1
set_env_plain AISHIKE_ERP_M3_READ_URL https://erp.hahaxiong.cc/api/method/aishike_erp.ontology_read.export_m3_read_model
set_env_quoted AISHIKE_ERP_M3_READ_AUTHORIZATION "$erp_authorization"
set_env_plain KIDSHUB_MARKET_READ_ENABLED 1
set_env_plain KIDSHUB_MARKET_READ_URL https://insight.kidshub.cn/api/internal/ontology/read-model
set_env_quoted KIDSHUB_MARKET_READ_AUTHORIZATION "Bearer $market_token"
set_env_plain DOMAIN_CONNECTOR_SYNC_ON_START 0

set -a
. "$project_root/.env"
set +a

"$docker_path" compose config >/dev/null
PROJECT_ROOT="$project_root" "$project_root/scripts/migrate.sh"
"$docker_path" compose build agent-core ontology-registry domain-connector
"$docker_path" compose up -d agent-core ontology-registry domain-connector gateway
"$docker_path" compose restart gateway

attempt=0
until "$docker_path" compose exec -T domain-connector node -e \
  "fetch('http://127.0.0.1:8085/readyz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.status==='ready'&&p.database?.ready===true&&p.enabledSources?.length===2?0:1)}).catch(()=>process.exit(1))" \
  </dev/null >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 90 ] || { "$docker_path" compose logs --tail 160 agent-core ontology-registry domain-connector gateway; exit 1; }
  sleep 2
done

ONTOLOGY_SOURCE_COMMIT="$source_commit" \
ONTOLOGY_PROPOSAL_ID=goal6-domain-foundation-20260809 \
ONTOLOGY_APPROVED_BY=ontology-owner \
PROJECT_ROOT="$project_root" \
  "$project_root/scripts/deploy-ontology-registry.sh"

cat > "$backup_root/release-manifest.txt" <<EOF
run_id=$run_id
ontology_source_commit=$source_commit
release_root=$release_root
schema_version=3.3.0
previous_agent_core_image=company-ai-foundation-agent-core:goal6-pre-$run_id
previous_ontology_registry_image=company-ai-foundation-ontology-registry:goal6-pre-$run_id
previous_domain_connector_image=company-ai-foundation-domain-connector:goal6-pre-$run_id
previous_gateway_image=company-ai-foundation-gateway:goal6-pre-$run_id
EOF

rm -f "$erp_authorization_file" "$market_token_file"
erp_authorization=
market_token=

printf 'goal6_deploy_run_id=%s\nbackup_root=%s\nsource_commit=%s\n' "$run_id" "$backup_root" "$source_commit"
