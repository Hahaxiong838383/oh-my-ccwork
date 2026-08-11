#!/bin/sh
set -eu
exec </dev/null

script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_root=$(CDPATH= cd -- "$script_root/.." && pwd)
. "$script_root/preflight-company-qnap.sh"

compose_file=$package_root/docker-compose.shadow.yml
env_file=${SI_ENV_FILE:-$shadow_root/.env.shadow}
queue_root=$shadow_root/state/queue
evidence_root=$shadow_root/evidence
lock_dir=$shadow_root/state/dispatcher.lock
policy_file=$package_root/config/shadow-policy.json

[ -f "$env_file" ] || { echo 'shadow env file missing' >&2; exit 1; }
[ "$(stat -c '%a' "$env_file")" = 600 ] || { echo 'shadow env file must be mode 600' >&2; exit 1; }
[ ! -f "$shadow_root/FROZEN" ] || { echo 'shadow is frozen' >&2; exit 1; }
mkdir -p "$queue_root/pending" "$queue_root/running" "$queue_root/done" "$queue_root/failed" "$evidence_root"
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo 'dispatcher already active' >&2
  exit 0
fi
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT INT TERM

request=$(find "$queue_root/pending" -maxdepth 1 -type f -name '*.json' | sort | head -1)
[ -n "$request" ] || { echo 'no pending shadow request'; exit 0; }
request_key=$(node "$script_root/validate-request.mjs" "$request")
running=$queue_root/running/$request_key.json
mv "$request" "$running"

set -a
. "$env_file"
set +a
[ "${PUBLISH:-}" = false ] || { echo 'PUBLISH must remain false' >&2; exit 1; }
[ -n "${SI_COLLECTOR_IMAGE:-}" ] || { echo 'SI_COLLECTOR_IMAGE missing' >&2; exit 1; }
case "$SI_COLLECTOR_IMAGE" in sha256:*|*@sha256:*) ;; *) echo 'collector image must be immutable' >&2; exit 1 ;; esac

container=company-si-shadow-$(printf '%s' "$request_key" | tr -cd 'a-z0-9-' | cut -c1-52)
stdout_file=$shadow_root/state/$request_key.stdout.json
stderr_file=$shadow_root/state/$request_key.stderr.log
stats_file=$shadow_root/state/$request_key.docker-stats.jsonl
collector_metrics_file=$shadow_root/state/$request_key.collector-metrics.json
runtime_metrics_file=$shadow_root/state/$request_key.runtime-metrics.json
pre_last_good_file=$shadow_root/state/$request_key.pre-last-good.json
revocation_evidence_file=$shadow_root/state/$request_key.revocation-audit.json
side_effect_evidence_file=$shadow_root/state/$request_key.side-effect-audit.json
audit_metrics_file=$shadow_root/state/$request_key.audit-metrics.json
domain_batch_file=$SI_REPORT_ROOT/domain-$request_key.json
domain_metrics_file=$shadow_root/state/$request_key.domain-metrics.json
domain_stderr_file=$shadow_root/state/$request_key.domain-stderr.log
chmod 750 "$shadow_root/state"
node "$script_root/snapshot-last-good.mjs" "$SI_STATE_ROOT/collector" "$pre_last_good_file"
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
started_epoch=$(date +%s)

cd "$package_root"
"$docker_path" compose --env-file "$env_file" -f "$compose_file" --profile worker run \
  --name "$container" --no-deps intelligence-collector >"$stdout_file" 2>"$stderr_file" &
worker_pid=$!
deadline=$((started_epoch + 300))
timed_out=0
while kill -0 "$worker_pid" 2>/dev/null; do
  "$docker_path" stats --no-stream --format '{"cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}","net":"{{.NetIO}}"}' "$container" >> "$stats_file" 2>/dev/null || true
  if [ "$(date +%s)" -ge "$deadline" ]; then
    timed_out=1
    "$docker_path" stop -t 10 "$container" >/dev/null 2>&1 || true
    break
  fi
  sleep 2
done
set +e
wait "$worker_pid"
exit_code=$?
set -e
completed_epoch=$(date +%s)
completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
duration_seconds=$((completed_epoch - started_epoch))
restart_count=$($docker_path inspect --format '{{.RestartCount}}' "$container" 2>/dev/null || printf 0)
"$docker_path" rm -f "$container" >/dev/null 2>&1 || true
node "$script_root/extract-collector-metrics.mjs" "$stdout_file" "$SI_STATE_ROOT/collector" > "$collector_metrics_file"
node "$script_root/summarize-docker-stats.mjs" "$stats_file" > "$runtime_metrics_file"
status=failed
[ "$exit_code" -eq 0 ] && status=succeeded
[ "$timed_out" -eq 1 ] && status=timed_out
if [ "$status" = succeeded ]; then
  set +e
  {
    node "$script_root/compile-shadow-domain-batch.mjs" \
      --collector-stdout "$stdout_file" \
      --state-root "$SI_STATE_ROOT/collector" \
      --registry "$SI_SOURCE_REGISTRY_FILE" \
      --p003-review "${SI_P003_REVIEW_FILE:?SI_P003_REVIEW_FILE is required}" \
      --request "$running" \
      --output "$domain_batch_file" \
      --metrics-output "$domain_metrics_file" &&
    node "$script_root/validate-shadow-domain-batch.mjs" "$domain_batch_file" >/dev/null &&
    "$script_root/persist-shadow-domain-batch.sh" "$domain_batch_file" "$domain_metrics_file"
  } 2>"$domain_stderr_file"
  domain_exit=$?
  set -e
  if [ "$domain_exit" -ne 0 ]; then
    status=failed
    exit_code=$domain_exit
    node -e "const f=require('fs'),p=process.argv[1];let x={};try{x=JSON.parse(f.readFileSync(p))}catch{};Object.assign(x,{persisted:false,persistenceState:'not_persisted'});f.writeFileSync(p,JSON.stringify(x,null,2)+'\\n',{mode:0o600})" "$domain_metrics_file"
    [ -f "$domain_batch_file" ] || node -e "require('fs').writeFileSync(process.argv[1],JSON.stringify({batchVersion:'1.0.0',runId:'failed',requestKey:process.argv[2],publish:false,persistenceState:'json_candidate_pending_postgres'},null,2)+'\\n',{mode:0o600})" "$domain_batch_file" "$request_key"
  fi
else
  node -e "require('fs').writeFileSync(process.argv[1],JSON.stringify({compiled:false,persisted:false,persistenceState:'not_persisted',sourceEntryCount:0,sourceDecisionCount:0,rawSnapshotCount:0,observationCount:0,signalCount:0,evidenceCount:0,impactHypothesisCount:0,impactAssessmentCount:0,reportRunCount:0,reportDraftCount:0},null,2)+'\\n',{mode:0o600})" "$domain_metrics_file"
  node -e "require('fs').writeFileSync(process.argv[1],JSON.stringify({batchVersion:'1.0.0',runId:'failed',requestKey:process.argv[2],publish:false,persistenceState:'json_candidate_pending_postgres'},null,2)+'\\n',{mode:0o600})" "$domain_batch_file" "$request_key"
fi
"$script_root/run-source-revocation-audit.sh" "$request_key" "$revocation_evidence_file"
"$script_root/capture-shadow-side-effects.sh" "$started_at" "$completed_at" "$side_effect_evidence_file"
node "$script_root/compile-shadow-run-audit.mjs" \
  --collector-stdout "$stdout_file" \
  --collector-stderr "$stderr_file" \
  --state-root "$SI_STATE_ROOT/collector" \
  --report-root "$SI_REPORT_ROOT" \
  --pre-last-good "$pre_last_good_file" \
  --revocation-evidence "$revocation_evidence_file" \
  --side-effect-evidence "$side_effect_evidence_file" \
  --domain-batch "$domain_batch_file" \
  --domain-stderr "$domain_stderr_file" \
  --output "$audit_metrics_file"
evidence_file=$evidence_root/$request_key.json
node "$script_root/record-shadow-run.mjs" \
  --request "$running" \
  --output "$evidence_file" \
  --status "$status" \
  --started-at "$started_at" \
  --completed-at "$completed_at" \
  --duration-seconds "$duration_seconds" \
  --exit-code "$exit_code" \
  --collector-image "$SI_COLLECTOR_IMAGE" \
  --source-commit "${SI_SOURCE_COMMIT:-unknown}" \
  --collector-metrics-file "$collector_metrics_file" \
  --runtime-metrics-file "$runtime_metrics_file" \
  --audit-metrics-file "$audit_metrics_file" \
  --domain-metrics-file "$domain_metrics_file" \
  --container-restart-count "$restart_count" \
  --new-host-port-count 0

destination=$queue_root/failed/$request_key.json
[ "$status" = succeeded ] && destination=$queue_root/done/$request_key.json
mv "$running" "$destination"

set +e
node "$script_root/evaluate-shadow.mjs" "$policy_file" "$evidence_file" > "$evidence_file.evaluation.json"
evaluation_exit=$?
set -e
if [ "$evaluation_exit" -eq 42 ]; then
  "$script_root/freeze-shadow.sh" "critical threshold violation for $request_key"
  if [ "${SHADOW_AUTO_ROLLBACK_APPROVED:-NO}" = YES ]; then
    SHADOW_ROLLBACK_APPROVED=YES "$script_root/rollback-shadow.sh"
  fi
fi

[ "$status" = succeeded ]
