#!/bin/sh
set -eu
exec </dev/null

docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}

cd "$project_root"
set -a
. ./.env
set +a

run_sync() {
  operation=$1
  source=$2
  "$docker_path" compose exec -T domain-connector node --input-type=module - "$operation" "$source" <<'NODE'
const [operation, source] = process.argv.slice(2)
const response = await fetch(`http://127.0.0.1:8085/v1/${operation}/${source}${operation === 'replay' ? '?cursor=' : ''}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.DOMAIN_CONNECTOR_CONTROL_TOKEN}` },
})
const payload = await response.json()
console.log(JSON.stringify(payload))
if (!response.ok || payload.status !== 'completed') process.exit(1)
if (operation === 'replay' && (payload.stats.inserted !== 0 || payload.stats.updated !== 0 || payload.stats.unchanged < 1)) process.exit(1)
NODE
}

printf '=== first sync ===\n'
run_sync sync aishike-erp-m3
run_sync sync kidshub-market

printf '\n=== replay ===\n'
run_sync replay aishike-erp-m3
run_sync replay kidshub-market

printf '\n=== records ===\n'
"$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -F '|' -Atc \
  "SELECT source_system,object_type,status,count(*) FROM domain_read.records GROUP BY source_system,object_type,status ORDER BY source_system,object_type,status;"

erp_operations=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM domain_read.erp_m3_v1 WHERE object_type LIKE 'domain.operations.%';")
erp_devices=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM domain_read.erp_m3_v1 WHERE object_type LIKE 'domain.device.%';")
market_records=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM domain_read.market_signal_v1;")
sensitive_records=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM domain_read.records WHERE payload::text ~* '\"(token|cookie|password|secret|appsecret|apikey|rawpayload|recipient|customer|email|phone|mobile|personid|internalpath)\"';")
failed_runs=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM domain_read.sync_runs WHERE status='failed';")
dead_letters=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM domain_read.dead_letters;")
printf 'erp_operations=%s erp_devices=%s market_records=%s sensitive_records=%s failed_runs=%s dead_letters=%s\n' "$erp_operations" "$erp_devices" "$market_records" "$sensitive_records" "$failed_runs" "$dead_letters"
[ "$erp_operations" -gt 0 ]
[ "$erp_devices" -gt 0 ]
[ "$market_records" -gt 0 ]
[ "$sensitive_records" -eq 0 ]

printf '\n=== application role ===\n'
app_without_tenant=$($docker_path compose exec -T -e PGPASSWORD="$ONTOLOGY_APP_PASSWORD" postgres psql -h 127.0.0.1 -U ontology_app -d ontology -Atc "SELECT count(*) FROM domain_read.erp_m3_v1;")
app_with_tenant=$($docker_path compose exec -T -e PGPASSWORD="$ONTOLOGY_APP_PASSWORD" postgres psql -h 127.0.0.1 -U ontology_app -d ontology -Atc "SELECT set_config('app.tenant_id','$FUTURUS_TENANT_ID',false); SELECT count(*) FROM domain_read.erp_m3_v1;" | tail -1)
printf 'app_without_tenant=%s app_with_tenant=%s\n' "$app_without_tenant" "$app_with_tenant"
[ "$app_without_tenant" -eq 0 ]
[ "$app_with_tenant" -gt 0 ]

printf '\n=== unauthorized role ===\n'
if "$docker_path" compose exec -T -e PGPASSWORD="$ACTION_GATEWAY_PASSWORD" postgres \
  psql -h 127.0.0.1 -U action_gateway -d ontology -Atc "SELECT count(*) FROM domain_read.records;" >/dev/null 2>&1; then
  echo 'action_gateway unexpectedly read domain records' >&2
  exit 1
fi
echo 'action_gateway_domain_read=denied'
