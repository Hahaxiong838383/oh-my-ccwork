#!/bin/sh
set -eu
exec </dev/null

[ "${SHADOW_DEPLOY_APPROVED:-NO}" = YES ] || { echo 'explicit shadow deployment approval missing' >&2; exit 1; }
[ "${SHADOW_DATABASE_MIGRATION_APPROVED:-NO}" = YES ] || { echo 'explicit shadow database migration approval missing' >&2; exit 1; }
[ "${GOAL7_STATUS:-}" = complete ] || { echo 'Goal 7 P1-PROD-READINESS is not complete' >&2; exit 1; }
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
goal7_acceptance=${SI_GOAL7_ACCEPTANCE_FILE:?SI_GOAL7_ACCEPTANCE_FILE is required}
reviewer_role_access_acceptance=${SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE:?SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE is required}
[ -f "$goal7_acceptance" ] || { echo 'Goal 7 acceptance evidence missing' >&2; exit 1; }
[ -f "$reviewer_role_access_acceptance" ] || { echo 'reviewer role access acceptance evidence missing' >&2; exit 1; }
node "$script_root/validate-goal7-acceptance.mjs" "$goal7_acceptance" >/dev/null
node "$script_root/validate-reviewer-role-access-acceptance.mjs" "$reviewer_role_access_acceptance" >/dev/null
release_project_root=${SI_RELEASE_PROJECT_ROOT:?SI_RELEASE_PROJECT_ROOT is required}
case "$release_project_root" in "$shadow_root"/release/*/company-ai-ontology) ;; *) echo 'refusing unexpected release project root' >&2; exit 1 ;; esac
for migration in 010-pestim-strategic-intelligence.sql 011-pestim-reporting.sql; do
  [ -f "$release_project_root/deploy/qnap/candidate-migrations/$migration" ] || { echo "candidate migration missing: $migration" >&2; exit 1; }
done

cd "$foundation_root"
set -a
. ./.env
set +a
"$docker_path" compose exec -T postgres-backup /scripts/postgres-backup.sh >/dev/null
for migration in 010-pestim-strategic-intelligence.sql 011-pestim-reporting.sql; do
  "$docker_path" compose exec -T postgres psql \
    --set=ON_ERROR_STOP=1 \
    --username ontology_admin \
    --dbname ontology \
    --set=tenant_id="$FUTURUS_TENANT_ID" \
    < "$release_project_root/deploy/qnap/candidate-migrations/$migration" >/dev/null
done
table_count=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='strategic_intelligence';")
[ "$table_count" -ge 16 ] || { echo 'strategic intelligence migration verification failed' >&2; exit 1; }
printf 'strategic_intelligence_migrations=applied\ntables=%s\nfoundation_restart_count=0\n' "$table_count"
