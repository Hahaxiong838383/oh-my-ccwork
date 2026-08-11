#!/bin/sh
set -eu
exec </dev/null

[ "${INTERNAL_ENGINEERING_RUN_APPROVED:-NO}" = YES ] || { echo 'explicit internal engineering run approval missing' >&2; exit 1; }
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
internal_root=$shadow_root/internal-engineering
project_root=$internal_root/package
package_root=$project_root/deploy/qnap/strategic-intelligence
env_file=$internal_root/.env.internal
[ -d "$project_root/packages/ontology-contracts" ] || { echo 'internal engineering project package missing contracts' >&2; exit 1; }
[ -d "$project_root/services/intelligence-collector" ] || { echo 'internal engineering project package missing collector' >&2; exit 1; }
[ -d "$package_root" ] || { echo 'internal engineering deployment package missing' >&2; exit 1; }
[ -f "$env_file" ] || { echo 'internal engineering env missing' >&2; exit 1; }
[ "$(stat -c '%a' "$env_file")" = 600 ] || { echo 'internal engineering env must be mode 600' >&2; exit 1; }
set -a
. "$env_file"
set +a
[ "${PUBLISH:-}" = false ] || { echo 'PUBLISH must remain false' >&2; exit 1; }
case "$SI_COLLECTOR_IMAGE" in sha256:*|*@sha256:*) ;; *) echo 'collector image must be immutable' >&2; exit 1 ;; esac
case "${SI_NODE_RUNTIME_IMAGE:-}" in sha256:*|*@sha256:*) ;; *) echo 'QNAP Node runtime image must be immutable' >&2; exit 1 ;; esac
node_bin=${NODE_BIN:-$package_root/scripts/node-runtime.sh}
[ -x "$node_bin" ] || { echo 'internal engineering Node runtime unavailable' >&2; exit 2; }
"$node_bin" "$package_root/scripts/validate-internal-engineering-runtime.mjs" "$internal_root/config" >/dev/null

attempt_id=$(date -u +%Y%m%dT%H%M%SZ)-$$
stdout_file=$internal_root/state/$attempt_id.stdout.json
stderr_file=$internal_root/state/$attempt_id.stderr.log
runtime_before_file=$internal_root/state/$attempt_id.runtime-before.json
runtime_after_file=$internal_root/state/$attempt_id.runtime-after.json
side_effect_file=$internal_root/state/$attempt_id.side-effects.json
evidence_file=$internal_root/evidence/$attempt_id.json
container=company-si-internal-$attempt_id
mkdir -p "$internal_root/evidence"
chmod 750 "$internal_root/evidence"
cleanup_runtime() {
  "$docker_path" rm -f "$container" >/dev/null 2>&1 || true
  for network_id in $($docker_path network ls -q --filter label=com.docker.compose.project=company-strategic-intelligence-shadow 2>/dev/null || true); do
    "$docker_path" network rm "$network_id" >/dev/null 2>&1 || true
  done
}
NODE_BIN="$node_bin" "$package_root/scripts/capture-internal-engineering-runtime-state.sh" before "$runtime_before_file"
expected_foundation_count=${SI_EXPECTED_FOUNDATION_CONTAINER_COUNT:-13}
"$node_bin" -e "const x=require(process.argv[1]),n=Number(process.argv[2]),s=x.strategicIntelligence;if(x.foundation.containerCount!==n||x.foundation.runningContainerCount!==n||x.foundation.unhealthyContainerCount!==0||x.foundation.restartCountTotal!==0||s.containerCount!==0||s.runningContainerCount!==0||s.networkCount!==0||s.publishedPortCount!==0)process.exit(1)" "$runtime_before_file" "$expected_foundation_count"
trap 'cleanup_runtime' EXIT INT TERM

cd "$package_root"
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
set +e
"$docker_path" compose --env-file "$env_file" -f docker-compose.shadow.yml --profile worker run \
  --rm --name "$container" --no-deps intelligence-collector >"$stdout_file" 2>"$stderr_file"
exit_code=$?
set -e
completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cleanup_runtime
set +e
NODE_BIN="$node_bin" "$package_root/scripts/capture-internal-engineering-runtime-state.sh" after "$runtime_after_file"
runtime_after_exit=$?
set -e
[ "$runtime_after_exit" -eq 0 ] || rm -f "$runtime_after_file"
set +e
NODE_BIN="$node_bin" "$package_root/scripts/capture-shadow-side-effects.sh" "$started_at" "$completed_at" "$side_effect_file"
side_effect_exit=$?
set -e
[ "$side_effect_exit" -eq 0 ] || rm -f "$side_effect_file"
"$node_bin" "$package_root/scripts/compile-internal-engineering-run-evidence.mjs" \
  --collector-stdout "$stdout_file" \
  --collector-stderr "$stderr_file" \
  --plan "$SI_INTERNAL_ENGINEERING_PLAN_FILE" \
  --config "$SI_COLLECTOR_CONFIG_FILE" \
  --state-root "$SI_STATE_ROOT/collector" \
  --report-root "$SI_REPORT_ROOT" \
  --runtime-before "$runtime_before_file" \
  --runtime-after "$runtime_after_file" \
  --side-effect-audit "$side_effect_file" \
  --started-at "$started_at" \
  --completed-at "$completed_at" \
  --exit-code "$exit_code" \
  --output "$evidence_file" >/dev/null
"$node_bin" "$package_root/scripts/validate-internal-engineering-run-evidence.mjs" "$evidence_file" >/dev/null
for protected_file in "$stdout_file" "$stderr_file" "$runtime_before_file" "$runtime_after_file" "$side_effect_file" "$evidence_file"; do
  [ ! -f "$protected_file" ] || chmod 600 "$protected_file"
done
accepted=$("$node_bin" -e "const x=require(process.argv[1]);process.stdout.write(x.acceptance.acceptedForInternalEngineering?'YES':'NO')" "$evidence_file")
if [ "$exit_code" -ne 0 ] || [ "$accepted" != YES ]; then
  printf 'internal_engineering_run=failed\nevidence_created=1\ncounts_toward_production_shadow=0\n' >&2
  [ "$exit_code" -ne 0 ] && exit "$exit_code"
  exit 1
fi
printf 'internal_engineering_run=succeeded\nevidence_created=1\ncounts_toward_production_shadow=0\nformal_p2=0\nemployee_delivery=0\nerp_writeback=0\nsocial_writeback=0\ncausal_activation=0\n'
