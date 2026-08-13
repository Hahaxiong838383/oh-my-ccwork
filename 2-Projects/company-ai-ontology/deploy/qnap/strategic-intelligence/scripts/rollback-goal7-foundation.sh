#!/bin/sh
set -eu
exec </dev/null
umask 077

[ "${GOAL7_ROLLBACK_APPROVED:-}" = YES ] || { echo 'Goal 7 rollback requires explicit GOAL7_ROLLBACK_APPROVED=YES' >&2; exit 2; }
backup_root=${GOAL7_BACKUP_ROOT:?GOAL7_BACKUP_ROOT is required}
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
node_bin=${NODE_BIN:-$script_root/node-runtime.sh}
[ -x "$node_bin" ] || { echo 'Goal 7 rollback Node runtime unavailable' >&2; exit 2; }
manifest=$backup_root/release-manifest.txt
[ -f "$manifest" ] && [ ! -L "$manifest" ] || { echo 'Goal 7 backup manifest missing' >&2; exit 2; }
[ -f "$backup_root/.env" ] && [ -f "$backup_root/docker-compose.yml" ] || { echo 'Goal 7 backup config incomplete' >&2; exit 2; }

manifest_value() {
  key=$1
  awk -F= -v key="$key" '$1==key{print substr($0,length(key)+2);exit}' "$manifest"
}
run_id=$(manifest_value run_id)
source_commit=$(manifest_value source_commit)
h_lite_source_commit=$(manifest_value h_lite_source_commit)
agent_core_version=$(manifest_value agent_core_version)
knowledge_connector_version=$(manifest_value knowledge_connector_version)
h_lite_version=$(manifest_value h_lite_version)
runtime_root=$(manifest_value runtime_root)
evidence_root=$(manifest_value evidence_root)
[ -n "$run_id" ] && [ -n "$source_commit" ] && [ -n "$h_lite_source_commit" ] || { echo 'Goal 7 rollback release identity missing' >&2; exit 2; }
[ -n "$runtime_root" ] && [ -n "$evidence_root" ] || { echo 'Goal 7 rollback controlled roots missing' >&2; exit 2; }
case "$runtime_root" in "$shadow_root"/foundation-releases/*) ;; *) echo 'Goal 7 rollback runtime root is outside controlled release root' >&2; exit 2 ;; esac
case "$evidence_root" in "$shadow_root"/approvals/*) ;; *) echo 'Goal 7 rollback evidence root is outside controlled approvals root' >&2; exit 2 ;; esac
[ -f "$evidence_root/deployment-evidence.json" ] || { echo 'Goal 7 deployment evidence missing before rollback drill' >&2; exit 2; }
"$node_bin" "$script_root/validate-goal7-deployment-evidence.mjs" "$evidence_root/deployment-evidence.json" >/dev/null

candidate_env=$backup_root/candidate.env
candidate_compose=$backup_root/candidate-docker-compose.yml
before_file=$evidence_root/rollback-before-state.json
previous_file=$evidence_root/rollback-previous-state.json
restored_file=$evidence_root/rollback-restored-state.json
side_effect_file=$evidence_root/rollback-side-effects.json
rollback_evidence_file=$evidence_root/rollback-drill-evidence.json
for service in agent-core knowledge-connector h-lite; do
  previous=company-ai-foundation-$service:goal7-pre-$run_id
  candidate=company-ai-foundation-$service:goal7-candidate-$run_id
  "$docker_path" image inspect "$previous" >/dev/null || { echo "Goal 7 rollback previous image missing: $service" >&2; exit 2; }
  "$docker_path" image inspect "$candidate" >/dev/null || { echo "Goal 7 rollback candidate image missing: $service" >&2; exit 2; }
done

cp "$foundation_root/.env" "$candidate_env"
cp "$foundation_root/docker-compose.yml" "$candidate_compose"
chmod 600 "$candidate_env" "$candidate_compose"
"$script_root/capture-goal7-deployment-state.sh" rollback_before "$before_file" >/dev/null
started_at=$($node_bin -e "const x=require(process.argv[1]);process.stdout.write(x.capturedAt)" "$before_file")

cd "$foundation_root"
"$docker_path" compose config >/dev/null
h_lite_admin() {
  action=$1
  stop_transport=${2:-0}
  "$docker_path" compose exec -T h-lite node -e \
    "const action=process.argv[1],stop=process.argv[2];fetch('http://127.0.0.1:8081/v1/admin/'+action,{method:'POST',headers:{'x-h-lite-shadow-token':process.env.H_LITE_SHADOW_TOKEN,'x-h-lite-stop-transport':stop}}).then(async r=>{const p=await r.json();process.exit(r.ok&&((action==='drain'&&p.status==='drained'&&p.inFlight===0)||(action==='resume'&&p.status==='resumed'))?0:1)}).catch(()=>process.exit(1))" \
    "$action" "$stop_transport" </dev/null >/dev/null 2>&1
}
drain_agent_core() {
  "$docker_path" compose exec -T agent-core node -e \
    "fetch('http://127.0.0.1:8080/v1/admin/drain',{method:'POST',headers:{'x-agent-core-drain-token':process.env.AGENT_CORE_HMAC_SECRET,'x-agent-core-drain-timeout-ms':'90000'}}).then(async r=>{const p=await r.json();process.exit(r.ok&&p.status==='drained'&&p.activeRequests===0?0:1)}).catch(()=>process.exit(1))" \
    </dev/null >/dev/null 2>&1
}
wait_generic_release() {
  attempt=0
  until "$docker_path" compose exec -T agent-core node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" </dev/null >/dev/null 2>&1 \
    && "$docker_path" compose exec -T knowledge-connector node -e "fetch('http://127.0.0.1:8083/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" </dev/null >/dev/null 2>&1 \
    && "$docker_path" compose exec -T h-lite node -e "Promise.all([fetch('http://127.0.0.1:8081/healthz'),fetch('http://127.0.0.1:8081/readyz')]).then(rs=>process.exit(rs.every(r=>r.ok)?0:1)).catch(()=>process.exit(1))" </dev/null >/dev/null 2>&1; do
    attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1; sleep 2
  done
}
wait_legacy_release_quiet() {
  attempt=0
  stable_samples=0
  until [ "$stable_samples" -ge 2 ]; do
    if "$docker_path" compose exec -T h-lite node -e \
      "Promise.all([fetch('http://127.0.0.1:8081/healthz'),fetch('http://agent-core:8080/readyz')]).then(async rs=>{const [h,a]=await Promise.all(rs.map(r=>r.json()));const cutoff=Date.now()-Number(process.argv[1]);const inbound=Date.parse(h.feishu?.lastInboundAt||0);const outbound=Date.parse(h.feishu?.lastOutboundAt||0);const quiet=(!Number.isFinite(inbound)||inbound<=cutoff)&&(!Number.isFinite(outbound)||outbound<=cutoff);process.exit(rs.every(r=>r.ok)&&quiet&&Number(a.admission?.active||0)===0&&Number(a.admission?.queued||0)===0?0:1)}).catch(()=>process.exit(1))" \
      "${GOAL7_LEGACY_QUIET_MS:-30000}" </dev/null >/dev/null 2>&1; then
      stable_samples=$((stable_samples+1))
    else
      stable_samples=0
    fi
    attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1
    [ "$stable_samples" -ge 2 ] || sleep 2
  done
}
wait_candidate_h_lite_recovery() {
  attempt=0
  until "$docker_path" compose exec -T h-lite node -e \
    "Promise.all([fetch('http://127.0.0.1:8081/healthz'),fetch('http://127.0.0.1:8081/readyz')]).then(async rs=>{const p=await Promise.all(rs.map(r=>r.json()));process.exit(rs.every(r=>r.ok)&&p[0].serviceVersion===process.argv[1]&&p[0].sourceCommit===process.argv[2]&&p[0].mode==='active'&&p[0].subscriptionEnabled===true&&p[0].draining===false&&p[0].inFlight===0&&p[0].pendingDeliveries===0?0:1)}).catch(()=>process.exit(1))" \
    "$h_lite_version" "$h_lite_source_commit" </dev/null >/dev/null 2>&1; do
    attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1; sleep 2
  done
}
wait_agent_core_idle() {
  attempt=0
  until "$docker_path" compose exec -T agent-core node -e \
    "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const p=await r.json();process.exit(r.ok&&Number(p.admission?.active||0)===0&&Number(p.admission?.queued||0)===0?0:1)}).catch(()=>process.exit(1))" \
    </dev/null >/dev/null 2>&1; do
    attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1; sleep 2
  done
}
wait_candidate_agent_core() {
  attempt=0
  until "$docker_path" compose exec -T agent-core node -e \
    "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.productionReady===true&&p.contractVersion===process.argv[1]&&p.sourceCommit===process.argv[2]?0:1)}).catch(()=>process.exit(1))" \
    "$agent_core_version" "$source_commit" </dev/null >/dev/null 2>&1; do
    attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1; sleep 2
  done
}
wait_candidate_connector() {
  attempt=0
  until "$docker_path" compose exec -T knowledge-connector node -e \
    "fetch('http://127.0.0.1:8083/readyz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.version===process.argv[1]&&p.sourceCommit===process.argv[2]?0:1)}).catch(()=>process.exit(1))" \
    "$knowledge_connector_version" "$source_commit" </dev/null >/dev/null 2>&1; do
    attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1; sleep 2
  done
}
wait_candidate_release() {
  attempt=0
  until "$docker_path" compose exec -T agent-core node -e \
      "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.productionReady===true&&p.contractVersion===process.argv[1]&&p.sourceCommit===process.argv[2]?0:1)}).catch(()=>process.exit(1))" \
      "$agent_core_version" "$source_commit" </dev/null >/dev/null 2>&1 \
    && "$docker_path" compose exec -T knowledge-connector node -e \
      "fetch('http://127.0.0.1:8083/readyz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.version===process.argv[1]&&p.sourceCommit===process.argv[2]?0:1)}).catch(()=>process.exit(1))" \
      "$knowledge_connector_version" "$source_commit" </dev/null >/dev/null 2>&1 \
    && "$docker_path" compose exec -T h-lite node -e \
      "Promise.all([fetch('http://127.0.0.1:8081/healthz'),fetch('http://127.0.0.1:8081/readyz')]).then(async rs=>{const p=await Promise.all(rs.map(r=>r.json()));process.exit(rs.every(r=>r.ok)&&p[0].serviceVersion===process.argv[1]&&p[0].sourceCommit===process.argv[2]&&p[0].mode==='active'&&p[0].subscriptionEnabled===true&&p[0].draining===false&&p[0].inFlight===0&&p[0].pendingDeliveries===0?0:1)}).catch(()=>process.exit(1))" \
      "$h_lite_version" "$h_lite_source_commit" </dev/null >/dev/null 2>&1; do
    attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1; sleep 2
  done
}
wait_foundation_stable() {
  attempt=0
  stable_samples=0
  while [ "$attempt" -lt 90 ]; do
    count=0
    stable=1
    for container_id in $($docker_path ps -q --filter label=com.docker.compose.project=company-ai-foundation); do
      count=$((count+1))
      row=$($docker_path inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}' "$container_id")
      case "$row" in running\|healthy\|0|running\|none\|0) ;; *) stable=0 ;; esac
    done
    if [ "$count" -eq 13 ] && [ "$stable" -eq 1 ]; then
      stable_samples=$((stable_samples+1)); [ "$stable_samples" -ge 2 ] && return 0
    else
      stable_samples=0
    fi
    attempt=$((attempt+1)); sleep 2
  done
  return 1
}
switch_release() {
  env_file=$1
  compose_file=$2
  tag_kind=$3
  cp "$env_file" "$foundation_root/.env"
  cp "$compose_file" "$foundation_root/docker-compose.yml"
  chmod 600 "$foundation_root/.env" "$foundation_root/docker-compose.yml"
  for service in agent-core knowledge-connector h-lite; do
    "$docker_path" image tag "company-ai-foundation-$service:goal7-$tag_kind-$run_id" "company-ai-foundation-$service:latest"
  done
  "$docker_path" compose config >/dev/null
  "$docker_path" compose up -d --no-deps --no-build agent-core >/dev/null
  "$docker_path" compose up -d --no-deps --no-build knowledge-connector >/dev/null
  "$docker_path" compose up -d --no-deps --no-build h-lite >/dev/null
}
switch_candidate_from_legacy() {
  wait_legacy_release_quiet || { echo 'Goal 7 rollback previous release never reached the required quiet window' >&2; return 1; }
  cp "$candidate_env" "$foundation_root/.env"
  cp "$candidate_compose" "$foundation_root/docker-compose.yml"
  chmod 600 "$foundation_root/.env" "$foundation_root/docker-compose.yml"
  for service in agent-core knowledge-connector h-lite; do
    "$docker_path" image tag "company-ai-foundation-$service:goal7-candidate-$run_id" "company-ai-foundation-$service:latest"
  done
  "$docker_path" compose config >/dev/null
  "$docker_path" compose up -d --no-deps --no-build h-lite >/dev/null
  wait_candidate_h_lite_recovery || { echo 'Goal 7 rollback recovery H-Lite verification timed out' >&2; return 1; }
  h_lite_admin drain 0 || { echo 'Goal 7 rollback recovery H-Lite drain failed' >&2; return 1; }
  wait_agent_core_idle || { echo 'Goal 7 rollback previous Agent Core did not become idle behind recovery H-Lite' >&2; return 1; }
  "$docker_path" compose up -d --no-deps --no-build agent-core >/dev/null
  wait_candidate_agent_core || { echo 'Goal 7 rollback candidate Agent Core verification timed out' >&2; return 1; }
  "$docker_path" compose up -d --no-deps --no-build knowledge-connector >/dev/null
  wait_candidate_connector || { echo 'Goal 7 rollback candidate Knowledge Connector verification timed out' >&2; return 1; }
  h_lite_admin resume 0 || { echo 'Goal 7 rollback restored H-Lite resume failed' >&2; return 1; }
  wait_candidate_release || { echo 'Goal 7 rollback candidate restore health verification timed out' >&2; return 1; }
}
drain_current_release() {
  h_lite_admin drain 1 || return 1
  "$docker_path" compose exec -T h-lite node -e \
    "fetch('http://127.0.0.1:8081/healthz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.draining===true&&p.inFlight===0&&p.pendingDeliveries===0?0:1)}).catch(()=>process.exit(1))" \
    </dev/null >/dev/null 2>&1 || return 1
  drain_agent_core
}

switched_from_candidate=0
restore_candidate_on_error() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ] && [ "$switched_from_candidate" -eq 1 ]; then
    switch_release "$candidate_env" "$candidate_compose" candidate >/dev/null 2>&1 || true
    h_lite_admin resume 0 >/dev/null 2>&1 || true
    wait_candidate_release >/dev/null 2>&1 || true
    printf 'Goal 7 rollback drill failed; attempted to restore the approved candidate release. Migration 012 was retained.\n' >&2
  fi
  exit "$status"
}
trap restore_candidate_on_error EXIT HUP INT TERM

drain_current_release || { echo 'Goal 7 rollback candidate drain gate failed' >&2; exit 1; }
switched_from_candidate=1
switch_release "$backup_root/.env" "$backup_root/docker-compose.yml" pre
wait_generic_release || { echo 'Goal 7 rollback previous release health verification timed out' >&2; exit 1; }
wait_foundation_stable || { echo 'Goal 7 rollback previous Foundation did not stabilize' >&2; exit 1; }
"$script_root/capture-goal7-deployment-state.sh" rollback_previous "$previous_file" >/dev/null

switch_candidate_from_legacy || exit 1
wait_foundation_stable || { echo 'Goal 7 rollback restored Foundation did not stabilize' >&2; exit 1; }
"$script_root/capture-goal7-deployment-state.sh" rollback_restored "$restored_file" >/dev/null
completed_at=$($node_bin -e "const x=require(process.argv[1]);process.stdout.write(x.capturedAt)" "$restored_file")
"$script_root/capture-shadow-side-effects.sh" "$started_at" "$completed_at" "$side_effect_file"
"$node_bin" "$script_root/compile-goal7-rollback-drill.mjs" "$evidence_root" "$rollback_evidence_file" >/dev/null
"$node_bin" "$script_root/validate-goal7-rollback-drill.mjs" "$rollback_evidence_file" >/dev/null
trap - EXIT HUP INT TERM
printf 'goal7_rollback_drill=%s\nprevious_release_verified=true\ncandidate_release_restored=true\nmigration012_retained=true\n' "$rollback_evidence_file"
