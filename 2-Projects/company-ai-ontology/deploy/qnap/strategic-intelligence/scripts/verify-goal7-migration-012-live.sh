#!/bin/sh
set -eu
exec </dev/null
umask 077

script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
cd "$foundation_root"
set -a
. ./.env
set +a
"$docker_path" compose config >/dev/null

table_count=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema || '.' || table_name IN ('iam.principal_memberships','work.conversation_authority_snapshots','runtime.h_engine_route_state','runtime.h_engine_usage_events');")
forced_rls_count=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname || '.' || c.relname IN ('iam.principal_memberships','work.conversation_authority_snapshots','runtime.h_engine_route_state','runtime.h_engine_usage_events') AND c.relrowsecurity AND c.relforcerowsecurity;")
tenant_policy_count=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM pg_policies WHERE schemaname || '.' || tablename IN ('iam.principal_memberships','work.conversation_authority_snapshots','runtime.h_engine_route_state','runtime.h_engine_usage_events') AND policyname='tenant_isolation';")
app_privilege_count=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM (VALUES ('iam.principal_memberships','SELECT'),('iam.principal_memberships','INSERT'),('iam.principal_memberships','UPDATE'),('work.conversation_authority_snapshots','SELECT'),('work.conversation_authority_snapshots','INSERT'),('runtime.h_engine_route_state','SELECT'),('runtime.h_engine_route_state','INSERT'),('runtime.h_engine_route_state','UPDATE'),('runtime.h_engine_usage_events','SELECT'),('runtime.h_engine_usage_events','INSERT')) AS p(name, privilege) WHERE has_table_privilege('ontology_app', name, privilege);")
delete_privilege_count=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM (VALUES ('iam.principal_memberships'),('work.conversation_authority_snapshots'),('runtime.h_engine_route_state'),('runtime.h_engine_usage_events')) AS t(name) WHERE has_table_privilege('ontology_app', name, 'DELETE');")
banned_column_count=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM information_schema.columns WHERE table_schema || '.' || table_name IN ('work.conversation_authority_snapshots','runtime.h_engine_usage_events') AND column_name IN ('prompt_text','request_body','response_body','employee_question','employee_message');")
app_role_read=$($docker_path compose exec -T -e PGPASSWORD="$ONTOLOGY_APP_PASSWORD" postgres \
  psql -h 127.0.0.1 -U ontology_app -d ontology -Atc \
  "SELECT set_config('app.tenant_id','$FUTURUS_TENANT_ID',false); SELECT ((SELECT count(*) FROM iam.principal_memberships) + (SELECT count(*) FROM work.conversation_authority_snapshots) + (SELECT count(*) FROM runtime.h_engine_route_state) + (SELECT count(*) FROM runtime.h_engine_usage_events) >= 0)::text;" | tail -1)
principal_membership_row_count=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM iam.principal_memberships;")
authority_snapshot_row_count=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM work.conversation_authority_snapshots;")
route_state_row_count=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM runtime.h_engine_route_state;")
usage_event_row_count=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc "SELECT count(*) FROM runtime.h_engine_usage_events;")

[ "$table_count" -eq 4 ] || { echo 'Goal 7 migration table verification failed' >&2; exit 1; }
[ "$forced_rls_count" -eq 4 ] || { echo 'Goal 7 migration forced RLS verification failed' >&2; exit 1; }
[ "$tenant_policy_count" -eq 4 ] || { echo 'Goal 7 migration tenant policy verification failed' >&2; exit 1; }
[ "$app_privilege_count" -eq 10 ] || { echo 'Goal 7 migration application privilege verification failed' >&2; exit 1; }
[ "$delete_privilege_count" -eq 0 ] || { echo 'Goal 7 migration DELETE privilege verification failed' >&2; exit 1; }
[ "$banned_column_count" -eq 0 ] || { echo 'Goal 7 migration banned column verification failed' >&2; exit 1; }
[ "$app_role_read" = true ] || { echo 'Goal 7 migration ontology_app read verification failed' >&2; exit 1; }

printf 'table_count=%s\nforced_rls_count=%s\ntenant_policy_count=%s\napp_privilege_count=%s\ndelete_privilege_count=%s\nbanned_column_count=%s\napp_role_read_verified=true\nprincipal_membership_row_count=%s\nauthority_snapshot_row_count=%s\nroute_state_row_count=%s\nusage_event_row_count=%s\n' \
  "$table_count" "$forced_rls_count" "$tenant_policy_count" "$app_privilege_count" "$delete_privilege_count" "$banned_column_count" \
  "$principal_membership_row_count" "$authority_snapshot_row_count" "$route_state_row_count" "$usage_event_row_count"
