#!/bin/sh
set -eu
exec </dev/null

docker_path=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}

cd "$project_root"
set -a
. ./.env
set +a

printf '=== compose ===\n'
"$docker_path" compose ps

printf '\n=== health ===\n'
failed=0
for container in company-ai-foundation-postgres-1 company-ai-foundation-qdrant-1 company-ai-foundation-redis-1 company-ai-foundation-agent-core-1 company-ai-foundation-ontology-registry-1 company-ai-foundation-knowledge-connector-1 company-ai-foundation-action-gateway-1 company-ai-foundation-h-lite-1 company-ai-foundation-prometheus-1 company-ai-foundation-gateway-1; do
  attempt=0
  status=missing
  while [ "$attempt" -lt 30 ]; do
    status=$("$docker_path" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || echo missing)
    [ "$status" = healthy ] && break
    attempt=$((attempt + 1))
    sleep 2
  done
  printf '%s=%s\n' "$container" "$status"
  [ "$status" = healthy ] || failed=1
done

printf '\n=== isolation ===\n'
published=$("$docker_path" compose ps --format json | grep -Eo '0\.0\.0\.0:[0-9]+|192\.168\.61\.18:[0-9]+' || true)
printf '%s\n' "${published:-only-gateway-expected}"
if [ "$published" != "192.168.61.18:19080" ]; then
  echo 'unexpected published ports' >&2
  exit 1
fi

printf '\n=== postgres ===\n'
"$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','vector') ORDER BY extname;"
"$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM pg_tables WHERE schemaname IN ('iam','ontology','workflow','evidence','delivery','actions','audit','runtime');"
"$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM pg_policies WHERE policyname='tenant_isolation';"
registry_active=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM ontology_registry.versions WHERE status='active';")
registry_elements=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM ontology_registry.elements;")
registry_active_elements=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM ontology_registry.elements e JOIN ontology_registry.versions v ON v.tenant_id=e.tenant_id AND v.id=e.version_id WHERE v.status='active';")
registry_domain_events=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM audit.domain_events WHERE event_type='ontology.version.deployed';")
registry_legacy_events=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM audit.events WHERE event_type='ontology_version_deployed';")
printf 'registry_active=%s registry_elements=%s registry_active_elements=%s domain_events=%s legacy_events=%s\n' "$registry_active" "$registry_elements" "$registry_active_elements" "$registry_domain_events" "$registry_legacy_events"
[ "$registry_active" -eq 1 ]
[ "$registry_active_elements" -gt 0 ]
[ "$registry_elements" -ge "$registry_active_elements" ]
[ "$registry_domain_events" -ge 1 ]
[ "$registry_legacy_events" -eq "$registry_domain_events" ]
"$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT archived_count, failed_count FROM pg_stat_archiver;"

printf '\n=== ontology registry ===\n'
"$docker_path" compose exec -T ontology-registry node -e "fetch('http://127.0.0.1:8084/readyz').then(async r=>{const body=await r.json();console.log(JSON.stringify(body));if(!r.ok||body.status!=='in_sync'||!body.local?.contentHash||body.local.contentHash!==body.active?.contentHash)process.exit(1)})"
registry_gateway_status=$(curl --silent --show-error --fail --connect-timeout 5 --max-time 10 "http://192.168.61.18:19080/ontology/status/registry")
printf '%s\n' "$registry_gateway_status"
printf '%s' "$registry_gateway_status" | grep -q '"status":"in_sync"'

printf '\n=== agent core ===\n'
"$docker_path" compose exec -T agent-core node -e "fetch('http://127.0.0.1:8080/healthz').then(async r=>{console.log(await r.text());if(!r.ok)process.exit(1)})"
"$docker_path" compose exec -T agent-core node -e "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const body=await r.json();console.log(JSON.stringify(body));const mode=body.runtime?.mode;if(r.status!==200||!['ready','demo_ready'].includes(body.status))process.exit(1);if(mode==='remote'&&body.productionReady!==true)process.exit(1);if(mode!=='remote'&&body.productionReady!==false)process.exit(1)})"

printf '\n=== knowledge connector ===\n'
"$docker_path" compose exec -T knowledge-connector node -e "fetch('http://127.0.0.1:8083/readyz').then(async r=>{const body=await r.json();console.log(JSON.stringify(body));if(!r.ok||body.status!=='ready'||body.database?.ready!==true)process.exit(1)})"

printf '\n=== action gateway ===\n'
"$docker_path" compose exec -T action-gateway node -e "fetch('http://127.0.0.1:8082/healthz').then(async r=>{const body=await r.json();console.log(JSON.stringify(body));if(!r.ok||body.component!=='mandatory-action-gateway')process.exit(1)})"

printf '\n=== h-lite shadow ===\n'
h_lite_expected_mode=${H_COMPANY_RUNTIME_MODE:-shadow}
"$docker_path" compose exec -T h-lite node -e "fetch('http://127.0.0.1:8081/healthz').then(async r=>{const body=await r.json();console.log(JSON.stringify(body));const active=process.argv[1]==='active';if(!r.ok||body.mode!==process.argv[1]||body.subscriptionEnabled!==active)process.exit(1)})" "$h_lite_expected_mode"
"$docker_path" compose exec -T h-lite node -e "fetch('http://127.0.0.1:8081/readyz').then(async r=>{const body=await r.json();console.log(JSON.stringify(body));const expected=process.argv[1]==='active'?'active_ready':'shadow_ready';if(!r.ok||body.status!==expected)process.exit(1)})" "$h_lite_expected_mode"

printf '\n=== p0 evidence ===\n'
accepted_tasks=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM workflow.tasks WHERE external_key LIKE 'demo-p2-2026-001:task:%' AND status='accepted';")
artifacts=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM evidence.artifacts AS artifact JOIN workflow.tasks AS task ON task.id=artifact.task_id WHERE task.external_key LIKE 'demo-p2-2026-001:task:%';")
acked_deliveries=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM delivery.outbox WHERE event_type='task_assigned' AND status='acked';")
printf 'accepted_tasks=%s artifacts=%s acked_deliveries=%s\n' "$accepted_tasks" "$artifacts" "$acked_deliveries"
[ "$accepted_tasks" -eq 10 ]
[ "$artifacts" -eq 10 ]
[ "$acked_deliveries" -eq 10 ]

for event_type in task_approve task_assign task_start task_submit task_accept; do
  event_count=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM workflow.task_events WHERE event_type='$event_type';")
  printf '%s=%s\n' "$event_type" "$event_count"
  [ "$event_count" -eq 10 ]
done

verified_rollbacks=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM actions.intents WHERE status='rolled_back' AND COALESCE((readback_receipt->>'verified')::boolean,false) AND COALESCE((rollback_receipt->>'verified')::boolean,false);")
non_terminal_actions=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM actions.intents WHERE status NOT IN ('rolled_back','rejected','failed');")
printf 'verified_rollbacks=%s non_terminal_actions=%s\n' "$verified_rollbacks" "$non_terminal_actions"
[ "$verified_rollbacks" -ge 2 ]
[ "$non_terminal_actions" -eq 0 ]

printf '\n=== privilege boundaries ===\n'
ontology_app_action_update=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT has_table_privilege('ontology_app','actions.intents','UPDATE');")
ontology_app_demo_update=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT has_table_privilege('ontology_app','actions.demo_task_status','UPDATE');")
gateway_task_update=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT has_table_privilege('action_gateway','workflow.tasks','UPDATE');")
registry_delete=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT has_table_privilege('ontology_registry','ontology_registry.versions','DELETE');")
registry_event_update=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT has_table_privilege('ontology_registry','audit.domain_events','UPDATE');")
registry_entity_select=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT has_table_privilege('ontology_registry','ontology.entities','SELECT');")
registry_audit_usage=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT has_schema_privilege('ontology_registry','audit','USAGE');")
printf 'ontology_app_action_update=%s ontology_app_demo_update=%s gateway_task_update=%s registry_delete=%s registry_event_update=%s registry_entity_select=%s registry_audit_usage=%s\n' "$ontology_app_action_update" "$ontology_app_demo_update" "$gateway_task_update" "$registry_delete" "$registry_event_update" "$registry_entity_select" "$registry_audit_usage"
[ "$ontology_app_action_update" = f ]
[ "$ontology_app_demo_update" = f ]
[ "$gateway_task_update" = f ]
[ "$registry_delete" = f ]
[ "$registry_event_update" = f ]
[ "$registry_entity_select" = f ]
[ "$registry_audit_usage" = t ]

registry_rows_without_tenant=$("$docker_path" compose exec -T -e PGPASSWORD="$ONTOLOGY_REGISTRY_PASSWORD" postgres \
  psql -h 127.0.0.1 -U ontology_registry -d ontology -Atc "SELECT count(*) FROM ontology_registry.versions;")
registry_rows_with_tenant=$("$docker_path" compose exec -T -e PGPASSWORD="$ONTOLOGY_REGISTRY_PASSWORD" postgres \
  psql -h 127.0.0.1 -U ontology_registry -d ontology -Atc "SELECT set_config('app.tenant_id','$FUTURUS_TENANT_ID',false); SELECT count(*) FROM ontology_registry.versions;" | tail -1)
printf 'registry_rows_without_tenant=%s registry_rows_with_tenant=%s\n' "$registry_rows_without_tenant" "$registry_rows_with_tenant"
[ "$registry_rows_without_tenant" -eq 0 ]
[ "$registry_rows_with_tenant" -ge 1 ]

printf '\n=== company brain work protocol ===\n'
work_protocol_tables=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM information_schema.tables WHERE (table_schema, table_name) IN (('work','brain_cases'),('work','brain_case_stages'),('work','brain_case_events'),('epistemic','assumptions'),('epistemic','unknowns'),('epistemic','assessments'));")
work_protocol_policies=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM pg_policies WHERE policyname='tenant_isolation' AND (schemaname, tablename) IN (('work','brain_cases'),('work','brain_case_stages'),('work','brain_case_events'),('epistemic','assumptions'),('epistemic','unknowns'),('epistemic','assessments'));")
work_protocol_views=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM pg_views WHERE (schemaname, viewname) IN (('work','brain_case_status_v1'),('epistemic','answer_basis_v1'));")
work_event_update=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT has_table_privilege('ontology_app','work.brain_case_events','UPDATE');")
assessment_update=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT has_table_privilege('ontology_app','epistemic.assessments','UPDATE');")
work_status_select=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT has_table_privilege('ontology_app','work.brain_case_status_v1','SELECT');")
answer_basis_select=$("$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT has_table_privilege('ontology_app','epistemic.answer_basis_v1','SELECT');")
printf 'tables=%s policies=%s views=%s event_update=%s assessment_update=%s work_status_select=%s answer_basis_select=%s\n' "$work_protocol_tables" "$work_protocol_policies" "$work_protocol_views" "$work_event_update" "$assessment_update" "$work_status_select" "$answer_basis_select"
[ "$work_protocol_tables" -eq 6 ]
[ "$work_protocol_policies" -eq 6 ]
[ "$work_protocol_views" -eq 2 ]
[ "$work_event_update" = f ]
[ "$assessment_update" = f ]
[ "$work_status_select" = t ]
[ "$answer_basis_select" = t ]

work_protocol_http=$(curl --silent --show-error --max-time 10 http://192.168.61.18:19080/ontology/status/work-protocol || true)
printf 'work_protocol_http=%s\n' "$(printf '%s' "$work_protocol_http" | cut -c1-240)"
printf '%s' "$work_protocol_http" | grep -q '"protocolVersion":"1.1.0"'
printf '%s' "$work_protocol_http" | grep -q '"ontologySchemaVersion":"3.2.0"'

practice_protocol_http=$(curl --silent --show-error --max-time 10 http://192.168.61.18:19080/ontology/status/practice-protocol || true)
printf 'practice_protocol_http=%s\n' "$(printf '%s' "$practice_protocol_http" | cut -c1-240)"
printf '%s' "$practice_protocol_http" | grep -q '"protocolVersion":"1.1.0"'
printf '%s' "$practice_protocol_http" | grep -q '"ontologySchemaVersion":"3.2.0"'
printf '%s' "$practice_protocol_http" | grep -Eq '"status":"(shadow|active)"'

printf '\n=== h engine egress ===\n'
h_engine_proxy_url=${H_ENGINE_PROXY_URL:-socks5h://192.168.61.66:10808}
h_engine_probe_url=${H_ENGINE_EGRESS_PROBE_URL:-https://api.x.ai/v1/models}
h_engine_status=$(curl --silent --show-error --connect-timeout 10 --max-time 20 --proxy "$h_engine_proxy_url" -o /dev/null -w '%{http_code}' "$h_engine_probe_url" || true)
printf 'proxy_configured=true http_status=%s\n' "$h_engine_status"
case "$h_engine_status" in
  200|401|403) ;;
  *) echo 'H engine egress probe failed' >&2; exit 1 ;;
esac

printf '\n=== backup ===\n'
verified_backups=$(find /share/CACHEDEV2_DATA/ai-ontology-backup/postgres/base -mindepth 2 -maxdepth 2 -type f -name VERIFIED | wc -l | tr -d ' ')
wal_files=$(find /share/CACHEDEV2_DATA/ai-ontology-backup/postgres/wal -maxdepth 1 -type f | wc -l | tr -d ' ')
printf 'verified_backups=%s wal_files=%s\n' "$verified_backups" "$wal_files"
[ "$verified_backups" -gt 0 ]
[ "$wal_files" -gt 0 ]

printf '\n=== host ===\n'
printf 'vm.overcommit_memory='; cat /proc/sys/vm/overcommit_memory
[ "$(cat /proc/sys/vm/overcommit_memory)" = "1" ]

printf '\n=== resources ===\n'
"$docker_path" stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}' $("$docker_path" compose ps -q)

if [ "$failed" -ne 0 ]; then
  exit 1
fi
