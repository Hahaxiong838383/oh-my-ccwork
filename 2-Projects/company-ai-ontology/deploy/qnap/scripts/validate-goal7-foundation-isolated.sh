#!/bin/sh
set -eu
exec </dev/null

docker_path=${DOCKER_PATH:-docker}
project_root=${PROJECT_ROOT:-$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)}
run_id=${VALIDATION_RUN_ID:-$$}
postgres_image=${VALIDATION_POSTGRES_IMAGE:-pgvector/pgvector:pg17-bookworm@sha256:7ae6051efd0e60444282c27c7e141af07f322ce033300e727a49c3dd11075e38}
container=ontology-goal7-validation-$run_id
volume=ontology-goal7-validation-$run_id
tenant_id=00000000-0000-4000-8000-000000000001

cleanup() {
  "$docker_path" rm -f "$container" >/dev/null 2>&1 || true
  "$docker_path" volume rm -f "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

command -v "$docker_path" >/dev/null 2>&1 || { printf 'Docker runtime unavailable\n' >&2; exit 1; }
[ -f "$project_root/deploy/qnap/candidate-migrations/012-goal7-authority-runtime.sql" ] || { printf 'Goal 7 candidate migration missing\n' >&2; exit 1; }

"$docker_path" volume create "$volume" >/dev/null
"$docker_path" run -d \
  --name "$container" \
  -e POSTGRES_DB=ontology \
  -e POSTGRES_USER=ontology_admin \
  -e POSTGRES_PASSWORD=validation-postgres-password \
  -e POSTGRES_BACKUP_PASSWORD=validation-backup-password \
  -e ONTOLOGY_APP_PASSWORD=validation-app-password \
  -e ONTOLOGY_READONLY_PASSWORD=validation-readonly-password \
  -e ACTION_GATEWAY_PASSWORD=validation-action-password \
  -e DOMAIN_CONNECTOR_PASSWORD=validation-domain-password \
  -e FUTURUS_TENANT_ID="$tenant_id" \
  -v "$volume:/var/lib/postgresql/data" \
  -v "$project_root/deploy/qnap/initdb:/docker-entrypoint-initdb.d:ro" \
  "$postgres_image" >/dev/null

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
    --set=domain_connector_password=validation-domain-password \
    --set=ontology_registry_password=validation-registry-password \
    < "$migration" >/dev/null
done

for pass in 1 2; do
  "$docker_path" exec -i "$container" psql \
    --set=ON_ERROR_STOP=1 \
    --username ontology_admin \
    --dbname ontology \
    < "$project_root/deploy/qnap/candidate-migrations/012-goal7-authority-runtime.sql" >/dev/null
done

table_count=$("$docker_path" exec "$container" psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema || '.' || table_name IN ('iam.principal_memberships','work.conversation_authority_snapshots','runtime.h_engine_route_state','runtime.h_engine_usage_events');")
[ "$table_count" -eq 4 ]

forced_rls_count=$("$docker_path" exec "$container" psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname || '.' || c.relname IN ('iam.principal_memberships','work.conversation_authority_snapshots','runtime.h_engine_route_state','runtime.h_engine_usage_events') AND c.relrowsecurity AND c.relforcerowsecurity;")
[ "$forced_rls_count" -eq 4 ]

banned_column_count=$("$docker_path" exec "$container" psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM information_schema.columns WHERE table_schema || '.' || table_name IN ('work.conversation_authority_snapshots','runtime.h_engine_usage_events') AND column_name IN ('prompt_text','request_body','response_body','employee_question','employee_message');")
[ "$banned_column_count" -eq 0 ]

delete_privilege_count=$("$docker_path" exec "$container" psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM (VALUES ('iam.principal_memberships'),('work.conversation_authority_snapshots'),('runtime.h_engine_route_state'),('runtime.h_engine_usage_events')) AS t(name) WHERE has_table_privilege('ontology_app', name, 'DELETE');")
[ "$delete_privilege_count" -eq 0 ]

"$docker_path" exec -i "$container" psql -U ontology_admin -d ontology --set=ON_ERROR_STOP=1 --set=tenant_id="$tenant_id" >/dev/null <<'SQL'
SELECT set_config('app.tenant_id', :'tenant_id', false);

INSERT INTO iam.principal_memberships (
  tenant_id, principal_id, subject_type, subject_key, status, valid_from, observed_at, source_version
)
SELECT :'tenant_id'::uuid, id, 'chat', 'oc_goal7_canary', 'active', now(), now(), 'goal7-validation'
FROM iam.principals
WHERE tenant_id=:'tenant_id'::uuid AND external_key='demo-person-01'
ON CONFLICT DO NOTHING;

INSERT INTO work.conversation_authority_snapshots (
  tenant_id, request_principal_id, request_principal_external_key, conversation_type,
  conversation_reference_hash, purpose, membership_observed_at, decision, reason_code,
  rule_version, expires_at
)
SELECT :'tenant_id'::uuid, id, external_key, 'chat', repeat('a', 64), 'company_knowledge_query',
       now(), 'allow', 'current_sender_membership_verified', '1.0.0', now() + interval '60 seconds'
FROM iam.principals
WHERE tenant_id=:'tenant_id'::uuid AND external_key='demo-person-01';

INSERT INTO runtime.h_engine_route_state (
  tenant_id, route_key, enabled, circuit_state, credential_mode, provider, model
) VALUES
  (:'tenant_id'::uuid, 'route-a', true, 'closed', 'temporary_personal_credential', 'cpa-openai-compatible', 'grok-4.5'),
  (:'tenant_id'::uuid, 'route-b', false, 'closed', 'company_dedicated_pending', NULL, NULL)
ON CONFLICT (tenant_id, route_key) DO UPDATE SET enabled=EXCLUDED.enabled, circuit_state=EXCLUDED.circuit_state, credential_mode=EXCLUDED.credential_mode, provider=EXCLUDED.provider, model=EXCLUDED.model;

INSERT INTO runtime.h_engine_usage_events (
  tenant_id, request_id, route_key, work_type, prompt_tokens, completion_tokens,
  estimated_cost_micros, retry_count, outcome, provider, model, credential_mode
) VALUES (
  :'tenant_id'::uuid, 'goal7-validation-request', 'route-a', 'company_knowledge_query',
  100, 20, 0, 0, 'succeeded', 'cpa-openai-compatible', 'grok-4.5', 'temporary_personal_credential'
)
ON CONFLICT DO NOTHING;
SQL

rls_without_tenant=$("$docker_path" exec -e PGPASSWORD=validation-app-password "$container" \
  psql -h 127.0.0.1 -U ontology_app -d ontology -Atc \
  "SELECT (SELECT count(*) FROM iam.principal_memberships) + (SELECT count(*) FROM work.conversation_authority_snapshots) + (SELECT count(*) FROM runtime.h_engine_usage_events);")
[ "$rls_without_tenant" -eq 0 ]

app_role_rw=$("$docker_path" exec -i -e PGPASSWORD=validation-app-password "$container" \
  psql -h 127.0.0.1 -U ontology_app -d ontology -qAt \
  --set=ON_ERROR_STOP=1 --set=tenant_id="$tenant_id" <<'SQL' | tail -1
SELECT set_config('app.tenant_id', :'tenant_id', false);

INSERT INTO iam.principal_memberships (
  tenant_id, principal_id, subject_type, subject_key, status, valid_from, observed_at, source_version
)
SELECT :'tenant_id'::uuid, id, 'chat', 'oc_goal7_app_role', 'active', now(), now(), 'goal7-app-role-validation'
FROM iam.principals
WHERE tenant_id=:'tenant_id'::uuid AND external_key='demo-person-01'
ON CONFLICT DO NOTHING;

INSERT INTO work.conversation_authority_snapshots (
  tenant_id, request_principal_external_key, conversation_type, conversation_reference_hash,
  purpose, membership_observed_at, decision, reason_code, rule_version, expires_at
) VALUES (
  :'tenant_id'::uuid, 'demo-person-01', 'chat', repeat('b', 64),
  'company_knowledge_query', now(), 'allow', 'goal7_app_role_validation', '1.0.0', now() + interval '60 seconds'
);

INSERT INTO runtime.h_engine_route_state (
  tenant_id, route_key, enabled, circuit_state, credential_mode, provider, model
) VALUES (
  :'tenant_id'::uuid, 'route-a', true, 'closed', 'temporary_personal_credential', 'cpa-openai-compatible', 'grok-4.5'
)
ON CONFLICT (tenant_id, route_key) DO UPDATE
SET enabled=EXCLUDED.enabled,
    circuit_state=EXCLUDED.circuit_state,
    credential_mode=EXCLUDED.credential_mode,
    provider=EXCLUDED.provider,
    model=EXCLUDED.model,
    updated_at=now();

INSERT INTO runtime.h_engine_usage_events (
  tenant_id, request_id, route_key, work_type, prompt_tokens, completion_tokens,
  estimated_cost_micros, retry_count, outcome, provider, model, credential_mode
) VALUES (
  :'tenant_id'::uuid, 'goal7-app-role-validation', 'route-a', 'company_knowledge_query',
  10, 2, 0, 0, 'succeeded', 'cpa-openai-compatible', 'grok-4.5', 'temporary_personal_credential'
)
ON CONFLICT DO NOTHING;

SELECT CASE WHEN
  EXISTS (SELECT 1 FROM iam.principal_memberships WHERE tenant_id=:'tenant_id'::uuid AND source_version='goal7-app-role-validation')
  AND EXISTS (SELECT 1 FROM work.conversation_authority_snapshots WHERE tenant_id=:'tenant_id'::uuid AND reason_code='goal7_app_role_validation')
  AND EXISTS (SELECT 1 FROM runtime.h_engine_route_state WHERE tenant_id=:'tenant_id'::uuid AND route_key='route-a' AND enabled)
  AND EXISTS (SELECT 1 FROM runtime.h_engine_usage_events WHERE tenant_id=:'tenant_id'::uuid AND request_id='goal7-app-role-validation')
THEN 'verified' ELSE 'failed' END;
SQL
)
[ "$app_role_rw" = 'verified' ]

route_state=$("$docker_path" exec "$container" psql -U ontology_admin -d ontology -Atc \
  "SELECT string_agg(route_key || ':' || enabled::text, ',' ORDER BY route_key) FROM runtime.h_engine_route_state WHERE tenant_id='$tenant_id'::uuid;")
[ "$route_state" = 'route-a:true,route-b:false' ]

printf 'goal7_candidate_migration=verified\n'
printf 'goal7_candidate_idempotent=verified\n'
printf 'goal7_forced_rls=%s\n' "$forced_rls_count"
printf 'goal7_acl_fail_closed=verified\n'
printf 'goal7_app_role_rw=%s\n' "$app_role_rw"
printf 'goal7_route_state=%s\n' "$route_state"
printf 'goal7_sensitive_body_columns=%s\n' "$banned_column_count"
