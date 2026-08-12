#!/bin/sh
set -eu
exec </dev/null
umask 077

[ "${GOAL7_MIGRATION_012_RECONCILIATION_APPROVED:-}" = YES ] || { echo 'Goal 7 migration 012 reconciliation requires explicit GOAL7_MIGRATION_012_RECONCILIATION_APPROVED=YES' >&2; exit 2; }
evidence_root=${GOAL7_DEPLOYMENT_EVIDENCE_ROOT:?GOAL7_DEPLOYMENT_EVIDENCE_ROOT is required}
approved_source_commit=${GOAL7_APPROVED_SOURCE_COMMIT:?GOAL7_APPROVED_SOURCE_COMMIT is required}
approved_h_lite_source_commit=${GOAL7_APPROVED_H_LITE_SOURCE_COMMIT:?GOAL7_APPROVED_H_LITE_SOURCE_COMMIT is required}
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
node_bin=${NODE_BIN:-$script_root/node-runtime.sh}
[ -x "$node_bin" ] || { echo 'Goal 7 migration reconciliation Node runtime unavailable' >&2; exit 2; }
case "$evidence_root" in "$shadow_root"/approvals/*) ;; *) echo 'migration reconciliation evidence must remain under strategic intelligence approvals root' >&2; exit 2 ;; esac
case "$evidence_root" in *'/../'*|*/..|*'//'*) echo 'Goal 7 migration reconciliation evidence path is not normalized' >&2; exit 2 ;; esac

preparation=$($node_bin "$script_root/validate-goal7-preparation.mjs" "$evidence_root" "$approved_source_commit" "$approved_h_lite_source_commit")
run_id=$(printf '%s\n' "$preparation" | awk -F= '/^run_id=/{print $2;exit}')
runtime_root=$(printf '%s\n' "$preparation" | awk -F= '/^runtime_root=/{print $2;exit}')
preparation_sha=$(printf '%s\n' "$preparation" | awk -F= '/^preparation_evidence_sha256=/{print $2;exit}')
migration_file=$runtime_root/company-ai-ontology/deploy/qnap/candidate-migrations/012-goal7-authority-runtime.sql
migration_evidence=$evidence_root/migration-012-evidence.json
input_file=$evidence_root/.migration-reconciliation-input-$run_id.json
historical_release_root=$shadow_root/release/goal7-31555822727
historical_source_archive=$historical_release_root/source.tar.gz
historical_evidence_root=$shadow_root/approvals/goal7-31555822727
historical_pre_state=$historical_evidence_root/pre-deployment-state.json
historical_sql_sha=8ea8648effbd7ab6d3ef81283678afc2fb16250f526e73c6a421abcb4d723a74
historical_pre_state_sha=5c6c10e8aeb9ebd8db0e87ad30b5f8ce8ed5a5ac94be53068baca75a04b0b723

if [ -f "$migration_evidence" ] && [ ! -L "$migration_evidence" ]; then
  existing=$($node_bin "$script_root/validate-goal7-migration.mjs" "$evidence_root" "$approved_source_commit" "$approved_h_lite_source_commit")
  live_checks=$("$script_root/verify-goal7-migration-012-live.sh")
  printf '%s\n%s\nmigration_reconciliation_replay=accepted\ndatabase_sql_executed=0\n' "$existing" "$live_checks"
  exit 0
fi
[ ! -e "$migration_evidence" ] || { echo 'Goal 7 migration reconciliation evidence path is unsafe' >&2; exit 2; }
[ -f "$migration_file" ] && [ ! -L "$migration_file" ] || { echo 'Goal 7 migration file missing or unsafe' >&2; exit 2; }
[ -f "$historical_source_archive" ] && [ ! -L "$historical_source_archive" ] || { echo 'historical Goal 7 source archive missing or unsafe' >&2; exit 2; }
[ -f "$historical_pre_state" ] && [ ! -L "$historical_pre_state" ] || { echo 'historical Goal 7 pre-deployment state missing or unsafe' >&2; exit 2; }
[ "$(sha256sum "$historical_pre_state" | awk '{print $1}')" = "$historical_pre_state_sha" ] || { echo 'historical Goal 7 pre-deployment state drift' >&2; exit 2; }

temporary_root=$(mktemp -d "$shadow_root/goal7-migration-reconciliation.XXXXXX")
cleanup() {
  rm -f "$input_file"
  rm -rf "$temporary_root"
}
trap cleanup EXIT HUP INT TERM
tar -xzf "$historical_source_archive" -C "$temporary_root" company-ai-ontology/deploy/qnap/candidate-migrations/012-goal7-authority-runtime.sql
historical_migration_file=$temporary_root/company-ai-ontology/deploy/qnap/candidate-migrations/012-goal7-authority-runtime.sql
[ "$(sha256sum "$historical_migration_file" | awk '{print $1}')" = "$historical_sql_sha" ] || { echo 'historical Goal 7 migration SQL drift' >&2; exit 2; }
current_sql_sha=$(sha256sum "$migration_file" | awk '{print $1}')
[ "$current_sql_sha" = "$historical_sql_sha" ] || { echo 'current Goal 7 migration SQL differs from applied historical release' >&2; exit 2; }

live_checks=$("$script_root/verify-goal7-migration-012-live.sh")
table_count=$(printf '%s\n' "$live_checks" | awk -F= '/^table_count=/{print $2;exit}')
forced_rls_count=$(printf '%s\n' "$live_checks" | awk -F= '/^forced_rls_count=/{print $2;exit}')
tenant_policy_count=$(printf '%s\n' "$live_checks" | awk -F= '/^tenant_policy_count=/{print $2;exit}')
app_privilege_count=$(printf '%s\n' "$live_checks" | awk -F= '/^app_privilege_count=/{print $2;exit}')
delete_privilege_count=$(printf '%s\n' "$live_checks" | awk -F= '/^delete_privilege_count=/{print $2;exit}')
banned_column_count=$(printf '%s\n' "$live_checks" | awk -F= '/^banned_column_count=/{print $2;exit}')
principal_membership_rows=$(printf '%s\n' "$live_checks" | awk -F= '/^principal_membership_row_count=/{print $2;exit}')
authority_snapshot_rows=$(printf '%s\n' "$live_checks" | awk -F= '/^authority_snapshot_row_count=/{print $2;exit}')
route_state_rows=$(printf '%s\n' "$live_checks" | awk -F= '/^route_state_row_count=/{print $2;exit}')
usage_event_rows=$(printf '%s\n' "$live_checks" | awk -F= '/^usage_event_row_count=/{print $2;exit}')

cat > "$input_file" <<EOF_JSON
{
  "runId": "$run_id",
  "sourceCommit": "$approved_source_commit",
  "hLiteSourceCommit": "$approved_h_lite_source_commit",
  "preparationEvidenceSha256": "$preparation_sha",
  "migrationFileSha256": "$current_sql_sha",
  "historicalApplication": {
    "status": "pre_existing_verified",
    "originalEvidenceStatus": "missing_at_source",
    "workflowRunId": "31555822727",
    "artifactId": "9125968266",
    "sourceCommit": "988472dabb4282e594375bea9062a013a23977d7",
    "hLiteSourceCommit": "0bf8aa39d49851b8574d88b6bfa0e1c6e18666e6",
    "preDeploymentStateSha256": "$historical_pre_state_sha",
    "migrationFileSha256": "$historical_sql_sha",
    "applicationWindowStart": "2026-08-12T10:13:55+08:00",
    "applicationWindowEnd": "2026-08-12T10:13:56+08:00",
    "basis": ["qnap_relation_mtime", "codex_execution_trace", "immutable_release_sql_hash"]
  },
  "checks": {
    "tableCount": $table_count,
    "forcedRlsCount": $forced_rls_count,
    "tenantPolicyCount": $tenant_policy_count,
    "appPrivilegeCount": $app_privilege_count,
    "deletePrivilegeCount": $delete_privilege_count,
    "bannedColumnCount": $banned_column_count,
    "appRoleReadVerified": true,
    "historicalSqlHashMatches": true,
    "currentSqlHashMatches": true,
    "principalMembershipRowCount": $principal_membership_rows,
    "authoritySnapshotRowCount": $authority_snapshot_rows,
    "routeStateRowCount": $route_state_rows,
    "usageEventRowCount": $usage_event_rows
  }
}
EOF_JSON
chmod 600 "$input_file"
"$node_bin" "$script_root/write-goal7-migration-evidence.mjs" "$input_file" "$migration_evidence" >/dev/null
trap - EXIT HUP INT TERM
cleanup
"$node_bin" "$script_root/validate-goal7-migration.mjs" "$evidence_root" "$approved_source_commit" "$approved_h_lite_source_commit"
printf 'goal7_migration012=pre_existing_reconciled\ndatabase_sql_executed=0\nservices_recreated=0\n'
