#!/bin/sh
set -eu
exec </dev/null
umask 077

[ "${GOAL7_MIGRATION_012_APPROVED:-}" = YES ] || { echo 'Goal 7 migration 012 requires explicit GOAL7_MIGRATION_012_APPROVED=YES' >&2; exit 2; }
evidence_root=${GOAL7_DEPLOYMENT_EVIDENCE_ROOT:?GOAL7_DEPLOYMENT_EVIDENCE_ROOT is required}
approved_source_commit=${GOAL7_APPROVED_SOURCE_COMMIT:?GOAL7_APPROVED_SOURCE_COMMIT is required}
approved_h_lite_source_commit=${GOAL7_APPROVED_H_LITE_SOURCE_COMMIT:?GOAL7_APPROVED_H_LITE_SOURCE_COMMIT is required}
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
node_bin=${NODE_BIN:-$script_root/node-runtime.sh}
[ -x "$node_bin" ] || { echo 'Goal 7 migration Node runtime unavailable' >&2; exit 2; }
case "$evidence_root" in "$shadow_root"/approvals/*) ;; *) echo 'migration evidence must remain under strategic intelligence approvals root' >&2; exit 2 ;; esac
case "$evidence_root" in *'/../'*|*/..|*'//'*) echo 'Goal 7 migration evidence path is not normalized' >&2; exit 2 ;; esac

preparation=$($node_bin "$script_root/validate-goal7-preparation.mjs" "$evidence_root" "$approved_source_commit" "$approved_h_lite_source_commit")
run_id=$(printf '%s\n' "$preparation" | awk -F= '/^run_id=/{print $2;exit}')
runtime_root=$(printf '%s\n' "$preparation" | awk -F= '/^runtime_root=/{print $2;exit}')
preparation_sha=$(printf '%s\n' "$preparation" | awk -F= '/^preparation_evidence_sha256=/{print $2;exit}')
backup_root=$(printf '%s\n' "$preparation" | awk -F= '/^backup_root=/{print $2;exit}')
backup_env_sha=$(printf '%s\n' "$preparation" | awk -F= '/^backup_env_sha256=/{print $2;exit}')
backup_compose_sha=$(printf '%s\n' "$preparation" | awk -F= '/^backup_compose_sha256=/{print $2;exit}')
migration_file=$runtime_root/company-ai-ontology/deploy/qnap/candidate-migrations/012-goal7-authority-runtime.sql
migration_evidence=$evidence_root/migration-012-evidence.json
input_file=$evidence_root/.migration-input-$run_id.json

existing_evidence=0
if [ -f "$migration_evidence" ] && [ ! -L "$migration_evidence" ]; then
  existing=$($node_bin "$script_root/validate-goal7-migration.mjs" "$evidence_root" "$approved_source_commit" "$approved_h_lite_source_commit")
  existing_evidence=1
else
[ ! -e "$migration_evidence" ] || { echo 'Goal 7 migration evidence path is unsafe' >&2; exit 2; }
fi
[ -f "$migration_file" ] && [ ! -L "$migration_file" ] || { echo 'Goal 7 migration file missing or unsafe' >&2; exit 2; }
[ "$(sha256sum "$backup_root/.env" | awk '{print $1}')" = "$backup_env_sha" ] || { echo 'Goal 7 preparation .env backup drift' >&2; exit 2; }
[ "$(sha256sum "$backup_root/docker-compose.yml" | awk '{print $1}')" = "$backup_compose_sha" ] || { echo 'Goal 7 preparation compose backup drift' >&2; exit 2; }
if [ "$existing_evidence" -eq 1 ]; then
  live_checks=$("$script_root/verify-goal7-migration-012-live.sh")
  printf '%s\n%s\nmigration_replay=accepted\n' "$existing" "$live_checks"
  exit 0
fi
[ "$(sha256sum "$foundation_root/.env" | awk '{print $1}')" = "$backup_env_sha" ] || { echo 'Foundation .env drifted after Goal 7 preparation' >&2; exit 2; }
[ "$(sha256sum "$foundation_root/docker-compose.yml" | awk '{print $1}')" = "$backup_compose_sha" ] || { echo 'Foundation compose drifted after Goal 7 preparation' >&2; exit 2; }
cd "$foundation_root"
for service in agent-core knowledge-connector h-lite; do
  case "$service" in
    agent-core) evidence_service=agent_core ;;
    knowledge-connector) evidence_service=knowledge_connector ;;
    h-lite) evidence_service=h_lite ;;
  esac
  expected_previous=$(printf '%s\n' "$preparation" | awk -F= -v key="previous_${evidence_service}_image_id" '$1==key{print $2;exit}')
  container_id=$("$docker_path" compose ps -q "$service")
  [ -n "$container_id" ] || { echo "Foundation active service missing after Goal 7 preparation: $service" >&2; exit 2; }
  [ "$("$docker_path" inspect --format '{{.Image}}' "$container_id")" = "$expected_previous" ] || { echo "Foundation active image drifted after Goal 7 preparation: $service" >&2; exit 2; }
done

"$docker_path" compose config >/dev/null
"$docker_path" compose exec -T postgres psql --set=ON_ERROR_STOP=1 --username ontology_admin --dbname ontology \
  < "$migration_file" >/dev/null
live_checks=$("$script_root/verify-goal7-migration-012-live.sh")
table_count=$(printf '%s\n' "$live_checks" | awk -F= '/^table_count=/{print $2;exit}')
forced_rls_count=$(printf '%s\n' "$live_checks" | awk -F= '/^forced_rls_count=/{print $2;exit}')
tenant_policy_count=$(printf '%s\n' "$live_checks" | awk -F= '/^tenant_policy_count=/{print $2;exit}')
app_privilege_count=$(printf '%s\n' "$live_checks" | awk -F= '/^app_privilege_count=/{print $2;exit}')
delete_privilege_count=$(printf '%s\n' "$live_checks" | awk -F= '/^delete_privilege_count=/{print $2;exit}')
banned_column_count=$(printf '%s\n' "$live_checks" | awk -F= '/^banned_column_count=/{print $2;exit}')

migration_sha=$(sha256sum "$migration_file" | awk '{print $1}')
cat > "$input_file" <<EOF_JSON
{
  "runId": "$run_id",
  "sourceCommit": "$approved_source_commit",
  "hLiteSourceCommit": "$approved_h_lite_source_commit",
  "preparationEvidenceSha256": "$preparation_sha",
  "migrationFileSha256": "$migration_sha",
  "checks": {
    "tableCount": $table_count,
    "forcedRlsCount": $forced_rls_count,
    "tenantPolicyCount": $tenant_policy_count,
    "appPrivilegeCount": $app_privilege_count,
    "deletePrivilegeCount": $delete_privilege_count,
    "bannedColumnCount": $banned_column_count,
    "appRoleReadVerified": true
  }
}
EOF_JSON
chmod 600 "$input_file"
"$node_bin" "$script_root/write-goal7-migration-evidence.mjs" "$input_file" "$migration_evidence" >/dev/null
rm -f "$input_file"
"$node_bin" "$script_root/validate-goal7-migration.mjs" "$evidence_root" "$approved_source_commit" "$approved_h_lite_source_commit"
printf 'goal7_migration012=completed\nservices_recreated=0\n'
