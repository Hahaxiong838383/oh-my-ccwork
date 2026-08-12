#!/bin/sh
set -eu
exec </dev/null
umask 077

[ "${GOAL7_SERVICE_RECREATION_APPROVED:-}" = YES ] || { echo 'Goal 7 service recreation requires explicit GOAL7_SERVICE_RECREATION_APPROVED=YES' >&2; exit 2; }
evidence_root=${GOAL7_DEPLOYMENT_EVIDENCE_ROOT:?GOAL7_DEPLOYMENT_EVIDENCE_ROOT is required}
approved_source_commit=${GOAL7_APPROVED_SOURCE_COMMIT:?GOAL7_APPROVED_SOURCE_COMMIT is required}
approved_h_lite_source_commit=${GOAL7_APPROVED_H_LITE_SOURCE_COMMIT:?GOAL7_APPROVED_H_LITE_SOURCE_COMMIT is required}
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
node_bin=${NODE_BIN:-$script_root/node-runtime.sh}
[ -x "$node_bin" ] || { echo 'Goal 7 deployment Node runtime unavailable' >&2; exit 2; }
case "$evidence_root" in "$shadow_root"/approvals/*) ;; *) echo 'deployment evidence must remain under strategic intelligence approvals root' >&2; exit 2 ;; esac
case "$evidence_root" in *'/../'*|*/..|*'//'*) echo 'Goal 7 deployment evidence path is not normalized' >&2; exit 2 ;; esac

migration_validation=$($node_bin "$script_root/validate-goal7-migration.mjs" \
  "$evidence_root" "$approved_source_commit" "$approved_h_lite_source_commit")
run_id=$(printf '%s\n' "$migration_validation" | awk -F= '/^run_id=/{print $2;exit}')
source_commit=$(printf '%s\n' "$migration_validation" | awk -F= '/^source_commit=/{print $2;exit}')
h_lite_source_commit=$(printf '%s\n' "$migration_validation" | awk -F= '/^h_lite_source_commit=/{print $2;exit}')
agent_core_version=$(printf '%s\n' "$migration_validation" | awk -F= '/^agent_core_version=/{print $2;exit}')
knowledge_connector_version=$(printf '%s\n' "$migration_validation" | awk -F= '/^knowledge_connector_version=/{print $2;exit}')
h_lite_version=$(printf '%s\n' "$migration_validation" | awk -F= '/^h_lite_version=/{print $2;exit}')
runtime_root=$(printf '%s\n' "$migration_validation" | awk -F= '/^runtime_root=/{print $2;exit}')
runtime_evidence_root=$(printf '%s\n' "$migration_validation" | awk -F= '/^runtime_evidence_root=/{print $2;exit}')
backup_root=$(printf '%s\n' "$migration_validation" | awk -F= '/^backup_root=/{print $2;exit}')
backup_env_sha=$(printf '%s\n' "$migration_validation" | awk -F= '/^backup_env_sha256=/{print $2;exit}')
backup_compose_sha=$(printf '%s\n' "$migration_validation" | awk -F= '/^backup_compose_sha256=/{print $2;exit}')
preparation_evidence_sha=$(printf '%s\n' "$migration_validation" | awk -F= '/^preparation_evidence_sha256=/{print $2;exit}')
migration_evidence_sha=$(printf '%s\n' "$migration_validation" | awk -F= '/^migration_evidence_sha256=/{print $2;exit}')
[ -n "$run_id" ] && [ -n "$runtime_root" ] && [ -n "$backup_root" ] || { echo 'Goal 7 migration evidence is incomplete' >&2; exit 2; }
[ "${GOAL7_DEPLOY_RUN_ID:-$run_id}" = "$run_id" ] || { echo 'Goal 7 service recreation run id drift' >&2; exit 2; }

before_file=$evidence_root/pre-deployment-state.json
after_file=$evidence_root/post-deployment-state.json
side_effect_file=$evidence_root/deployment-side-effects.json
deployment_file=$evidence_root/deployment-evidence.json
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
h_lite_switched=0
h_lite_draining=0
agent_core_switched=0
knowledge_connector_switched=0
agent_core_draining=0

sha256_file() { sha256sum "$1" | awk '{print $1}'; }
[ "$(sha256_file "$foundation_root/.env")" = "$backup_env_sha" ] || { echo 'Foundation .env drifted after Goal 7 preparation' >&2; exit 2; }
[ "$(sha256_file "$foundation_root/docker-compose.yml")" = "$backup_compose_sha" ] || { echo 'Foundation compose drifted after Goal 7 preparation' >&2; exit 2; }
for service in agent-core knowledge-connector h-lite; do
  previous=company-ai-foundation-$service:goal7-pre-$run_id
  candidate=company-ai-foundation-$service:goal7-candidate-$run_id
  case "$service" in
    agent-core) evidence_service=agent_core ;;
    knowledge-connector) evidence_service=knowledge_connector ;;
    h-lite) evidence_service=h_lite ;;
  esac
  expected_previous=$(printf '%s\n' "$migration_validation" | awk -F= -v key="previous_${evidence_service}_image_id" '$1==key{print $2;exit}')
  expected_candidate=$(printf '%s\n' "$migration_validation" | awk -F= -v key="candidate_${evidence_service}_image_id" '$1==key{print $2;exit}')
  [ "$("$docker_path" image inspect --format '{{.Id}}' "$previous")" = "$expected_previous" ] || { echo "Goal 7 previous image drift: $service" >&2; exit 2; }
  [ "$("$docker_path" image inspect --format '{{.Id}}' "$candidate")" = "$expected_candidate" ] || { echo "Goal 7 candidate image drift: $service" >&2; exit 2; }
  container_id=$(cd "$foundation_root" && "$docker_path" compose ps -q "$service")
  [ -n "$container_id" ] || { echo "Foundation active service missing after Goal 7 preparation: $service" >&2; exit 2; }
  current_id=$("$docker_path" inspect --format '{{.Image}}' "$container_id")
  [ "$current_id" = "$expected_previous" ] || { echo "Foundation active image drifted after Goal 7 preparation: $service" >&2; exit 2; }
done
[ "$(sha256_file "$backup_root/.env")" = "$backup_env_sha" ] || { echo 'Goal 7 preparation .env backup drift' >&2; exit 2; }
[ "$(sha256_file "$backup_root/docker-compose.yml")" = "$backup_compose_sha" ] || { echo 'Goal 7 preparation compose backup drift' >&2; exit 2; }
"$script_root/verify-goal7-migration-012-live.sh" >/dev/null
cp "$runtime_evidence_root/runtime-component-versions.json" "$evidence_root/runtime-component-versions.json"
chmod 600 "$evidence_root/runtime-component-versions.json"
"$script_root/capture-goal7-deployment-state.sh" before "$before_file" >/dev/null

set_env() {
  key=$1
  value=$2
  temporary=$foundation_root/.env.goal7-$run_id
  awk -v key="$key" -v value="$value" '
    BEGIN { found=0 }
    index($0,key "=")==1 { print key "=" value; found=1; next }
    { print }
    END { if(!found) print key "=" value }
  ' "$foundation_root/.env" > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$foundation_root/.env"
}
h_lite_admin_available() {
  "$docker_path" compose exec -T h-lite node -e \
    "fetch('http://127.0.0.1:8081/healthz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.serviceVersion===process.argv[1]&&p.sourceCommit===process.argv[2]?0:1)}).catch(()=>process.exit(1))" \
    "$h_lite_version" "$h_lite_source_commit" </dev/null >/dev/null 2>&1
}
h_lite_admin() {
  action=$1
  stop_transport=${2:-0}
  "$docker_path" compose exec -T h-lite node -e \
    "const action=process.argv[1],stop=process.argv[2];fetch('http://127.0.0.1:8081/v1/admin/'+action,{method:'POST',headers:{'x-h-lite-shadow-token':process.env.H_LITE_SHADOW_TOKEN,'x-h-lite-stop-transport':stop}}).then(async r=>{const p=await r.json();process.exit(r.ok&&((action==='drain'&&p.status==='drained'&&p.inFlight===0)||(action==='resume'&&p.status==='resumed'))?0:1)}).catch(()=>process.exit(1))" \
    "$action" "$stop_transport" </dev/null >/dev/null 2>&1
}
wait_h_lite_recovered() {
  attempt=0
  until "$docker_path" compose exec -T h-lite node -e \
    "fetch('http://127.0.0.1:8081/healthz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.draining===false&&p.inFlight===0&&p.pendingDeliveries===0?0:1)}).catch(()=>process.exit(1))" \
    </dev/null >/dev/null 2>&1; do
    attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1; sleep 2
  done
}
prepare_h_lite_full_rollback() {
  h_lite_admin drain 1 || return 1
  if ! "$docker_path" compose exec -T h-lite node -e \
    "fetch('http://127.0.0.1:8081/healthz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.pendingDeliveries===0?0:1)}).catch(()=>process.exit(1))" \
    </dev/null >/dev/null 2>&1; then
    h_lite_admin resume 0 || return 1
    wait_h_lite_recovered || return 1
    h_lite_admin drain 1 || return 1
  fi
  "$docker_path" compose exec -T h-lite node -e \
    "fetch('http://127.0.0.1:8081/healthz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.draining===true&&p.inFlight===0&&p.pendingDeliveries===0?0:1)}).catch(()=>process.exit(1))" \
    </dev/null >/dev/null 2>&1
}
agent_core_admin_available() {
  "$docker_path" compose exec -T agent-core node -e \
    "fetch('http://127.0.0.1:8080/healthz').then(async r=>{const p=await r.json();process.exit(r.ok&&typeof p.activeRequests==='number'&&typeof p.draining==='boolean'?0:1)}).catch(()=>process.exit(1))" \
    </dev/null >/dev/null 2>&1
}
drain_agent_core() {
  attempt=0
  stable_samples=0
  until [ "$stable_samples" -ge 2 ]; do
    if "$docker_path" compose exec -T agent-core node -e \
      "fetch('http://127.0.0.1:8080/healthz').then(async r=>{const p=await r.json();const idle=Number(p.activeRequests??p.admission?.active??0)===0&&Number(p.admission?.queued||0)===0;if(!r.ok||!idle)process.exit(1);if(typeof p.activeRequests!=='number')process.exit(0);return fetch('http://127.0.0.1:8080/v1/admin/drain',{method:'POST',headers:{'x-agent-core-drain-token':process.env.AGENT_CORE_HMAC_SECRET,'x-agent-core-drain-timeout-ms':'90000'}}).then(async x=>{const q=await x.json();process.exit(x.ok&&q.status==='drained'&&q.activeRequests===0?0:1)})}).catch(()=>process.exit(1))" \
      </dev/null >/dev/null 2>&1; then
      stable_samples=$((stable_samples+1))
    else
      stable_samples=0
    fi
    attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1
    [ "$stable_samples" -ge 2 ] || sleep 2
  done
}
resume_agent_core() {
  "$docker_path" compose exec -T agent-core node -e \
    "fetch('http://127.0.0.1:8080/v1/admin/resume',{method:'POST',headers:{'x-agent-core-drain-token':process.env.AGENT_CORE_HMAC_SECRET}}).then(async r=>{const p=await r.json();process.exit(r.ok&&p.status==='resumed'&&p.draining===false?0:1)}).catch(()=>process.exit(1))" \
    </dev/null >/dev/null 2>&1
}
service_uses_image() {
  service=$1
  image=$2
  container_id=$("$docker_path" compose ps -q "$service" 2>/dev/null || true)
  [ -n "$container_id" ] || return 1
  running_image=$("$docker_path" inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true)
  expected_image=$("$docker_path" image inspect --format '{{.Id}}' "$image" 2>/dev/null || true)
  [ -n "$running_image" ] && [ "$running_image" = "$expected_image" ]
}

rollback_on_error() {
  status=$?
  trap - EXIT HUP INT TERM
  [ "$status" -ne 0 ] || exit 0
  set +e
  preserve_recovery_h_lite=0
  preserve_agent_core=0
  agent_core_resume_failed=0
  if [ "$h_lite_switched" -eq 1 ]; then
    previous_h_lite=company-ai-foundation-h-lite:goal7-pre-$run_id
    if ! h_lite_admin_available; then
      if service_uses_image h-lite "$previous_h_lite"; then
        h_lite_switched=0
      else
        "$docker_path" compose up -d --no-deps --no-build h-lite >/dev/null 2>&1 || true
      fi
    fi
    if [ "$h_lite_switched" -eq 1 ]; then
      if h_lite_admin_available; then
        prepare_h_lite_full_rollback || preserve_recovery_h_lite=1
      else
        preserve_recovery_h_lite=1
      fi
    fi
  fi
  if [ "$agent_core_switched" -eq 1 ]; then
    previous_agent_core=company-ai-foundation-agent-core:goal7-pre-$run_id
    if service_uses_image agent-core "$previous_agent_core"; then
      agent_core_switched=0
      if [ "$agent_core_draining" -eq 1 ]; then
        if resume_agent_core; then
          agent_core_draining=0
        else
          agent_core_resume_failed=1
          preserve_recovery_h_lite=1
        fi
      fi
    elif ! drain_agent_core; then
      preserve_agent_core=1
      preserve_recovery_h_lite=1
    fi
  elif [ "$agent_core_draining" -eq 1 ]; then
    if resume_agent_core; then
      agent_core_draining=0
    else
      agent_core_resume_failed=1
      preserve_recovery_h_lite=1
    fi
  fi
  if [ "$knowledge_connector_switched" -eq 1 ]; then
    previous_knowledge_connector=company-ai-foundation-knowledge-connector:goal7-pre-$run_id
    if service_uses_image knowledge-connector "$previous_knowledge_connector"; then
      knowledge_connector_switched=0
    fi
  fi
  cp "$backup_root/.env" "$foundation_root/.env"
  if [ "$preserve_recovery_h_lite" -eq 1 ] || [ "$preserve_agent_core" -eq 1 ]; then
    cp "$runtime_root/company-ai-ontology/deploy/qnap/docker-compose.yml" "$foundation_root/docker-compose.yml"
  else
    cp "$backup_root/docker-compose.yml" "$foundation_root/docker-compose.yml"
  fi
  if [ "$preserve_recovery_h_lite" -eq 1 ]; then
    set_env H_LITE_BUILD_CONTEXT "$runtime_root/feishu-grok-bridge"
    set_env H_LITE_SOURCE_COMMIT "$h_lite_source_commit"
  fi
  if [ "$preserve_agent_core" -eq 1 ]; then
    set_env AGENT_CORE_BUILD_CONTEXT "$runtime_root/company-ai-ontology/services/agent-core"
    set_env ONTOLOGY_SOURCE_COMMIT "$source_commit"
  fi
  chmod 600 "$foundation_root/.env" "$foundation_root/docker-compose.yml"
  for service in agent-core knowledge-connector h-lite; do
    [ "$service" = h-lite ] && [ "$preserve_recovery_h_lite" -eq 1 ] && continue
    [ "$service" = agent-core ] && [ "$preserve_agent_core" -eq 1 ] && continue
    previous=company-ai-foundation-$service:goal7-pre-$run_id
    "$docker_path" image inspect "$previous" >/dev/null 2>&1 && "$docker_path" image tag "$previous" company-ai-foundation-$service:latest
  done
  cd "$foundation_root"
  restore_services=
  [ "$agent_core_switched" -eq 1 ] && [ "$preserve_agent_core" -eq 0 ] && restore_services="$restore_services agent-core"
  [ "$knowledge_connector_switched" -eq 1 ] && restore_services="$restore_services knowledge-connector"
  [ "$h_lite_switched" -eq 1 ] && [ "$preserve_recovery_h_lite" -eq 0 ] && restore_services="$restore_services h-lite"
  for service in $restore_services; do
    "$docker_path" compose up -d --no-deps --no-build "$service" >/dev/null 2>&1 || true
  done
  agent_core_intake_ready=1
  if [ "$preserve_agent_core" -eq 1 ] || [ "$agent_core_resume_failed" -eq 1 ]; then
    if ! resume_agent_core >/dev/null 2>&1; then
      agent_core_intake_ready=0
    fi
  fi
  if [ "$preserve_recovery_h_lite" -eq 1 ]; then
    if [ "$agent_core_intake_ready" -eq 1 ]; then
      h_lite_admin resume 0 >/dev/null 2>&1 || true
      wait_h_lite_recovered >/dev/null 2>&1 || true
      printf 'Goal 7 deployment failed; recovery-capable components with in-flight work were preserved, while safely drainable switched services were restored. Migration 012 is additive and was not dropped.\n' >&2
    else
      printf 'Goal 7 deployment failed; Agent Core intake could not be resumed, so recovery H-Lite remains drained and no new Feishu work is admitted. Migration 012 is additive and was not dropped.\n' >&2
    fi
  else
    printf 'Goal 7 deployment failed; previous config and service images were restored. Migration 012 is additive and was not dropped.\n' >&2
  fi
  exit "$status"
}
trap rollback_on_error EXIT HUP INT TERM

cp "$runtime_root/company-ai-ontology/deploy/qnap/docker-compose.yml" "$foundation_root/docker-compose.yml"
chmod 600 "$foundation_root/docker-compose.yml"
set_env AGENT_CORE_BUILD_CONTEXT "$runtime_root/company-ai-ontology/services/agent-core"
set_env KNOWLEDGE_CONNECTOR_BUILD_CONTEXT "$runtime_root/company-ai-ontology/services/knowledge-connector"
set_env H_LITE_BUILD_CONTEXT "$runtime_root/feishu-grok-bridge"
set_env ONTOLOGY_SOURCE_COMMIT "$source_commit"
set_env H_LITE_SOURCE_COMMIT "$h_lite_source_commit"
set_env AUTHORITY_MEMBERSHIP_MAX_AGE_MS 60000
set_env KNOWLEDGE_SYNC_ON_START 0
set_env H_COMPANY_RUNTIME_MODE active

cd "$foundation_root"
"$docker_path" compose config >/dev/null
for service in agent-core knowledge-connector h-lite; do
  "$docker_path" image tag company-ai-foundation-$service:goal7-candidate-$run_id company-ai-foundation-$service:latest
done

wait_legacy_h_lite_quiet() {
  attempt=0
  stable_samples=0
  until [ "$stable_samples" -ge 2 ]; do
    if "$docker_path" compose exec -T h-lite node -e \
      "Promise.all([fetch('http://127.0.0.1:8081/healthz'),fetch('http://agent-core:8080/healthz')]).then(async rs=>{const [h,a]=await Promise.all(rs.map(r=>r.json()));const cutoff=Date.now()-Number(process.argv[1]);const inbound=Date.parse(h.feishu?.lastInboundAt||0);const outbound=Date.parse(h.feishu?.lastOutboundAt||0);const quiet=(!Number.isFinite(inbound)||inbound<=cutoff)&&(!Number.isFinite(outbound)||outbound<=cutoff);process.exit(rs.every(r=>r.ok)&&quiet&&Number(a.admission?.active||0)===0&&Number(a.admission?.queued||0)===0?0:1)}).catch(()=>process.exit(1))" \
      "${GOAL7_LEGACY_QUIET_MS:-30000}" </dev/null >/dev/null 2>&1; then
      stable_samples=$((stable_samples+1))
    else
      stable_samples=0
    fi
    attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1
    [ "$stable_samples" -ge 2 ] || sleep 2
  done
}

wait_agent_core() {
  attempt=0
  until "$docker_path" compose exec -T agent-core node -e \
    "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.status==='ready'&&p.productionReady===true&&p.contractVersion===process.argv[1]&&p.sourceCommit===process.argv[2]?0:1)}).catch(()=>process.exit(1))" \
    "$agent_core_version" "$source_commit" </dev/null >/dev/null 2>&1; do
    attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1; sleep 2
  done
}
wait_connector() {
  attempt=0
  until "$docker_path" compose exec -T knowledge-connector node -e \
    "fetch('http://127.0.0.1:8083/readyz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.status==='ready'&&p.version===process.argv[1]&&p.sourceCommit===process.argv[2]?0:1)}).catch(()=>process.exit(1))" \
    "$knowledge_connector_version" "$source_commit" </dev/null >/dev/null 2>&1; do
    attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1; sleep 2
  done
}
wait_h_lite() {
  attempt=0
  until "$docker_path" compose exec -T h-lite node -e \
    "Promise.all([fetch('http://127.0.0.1:8081/healthz'),fetch('http://127.0.0.1:8081/readyz')]).then(async rs=>{const p=await Promise.all(rs.map(r=>r.json()));process.exit(rs.every(r=>r.ok)&&p[0].serviceVersion===process.argv[1]&&p[0].sourceCommit===process.argv[2]&&p[0].mode==='active'&&p[0].subscriptionEnabled===true&&p[0].draining===false&&p[0].inFlight===0&&p[0].pendingDeliveries===0&&p[1].status==='active_ready'?0:1)}).catch(()=>process.exit(1))" \
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
      row=$($docker_path inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")
      case "$row" in running\|healthy|running\|none) ;; *) stable=0 ;; esac
    done
    if [ "$count" -eq 13 ] && [ "$stable" -eq 1 ]; then
      stable_samples=$((stable_samples+1))
      [ "$stable_samples" -ge 2 ] && return 0
    else
      stable_samples=0
    fi
    attempt=$((attempt+1))
    sleep 2
  done
  return 1
}

wait_legacy_h_lite_quiet || { echo 'legacy H-Lite never reached a 30-second quiet window with Agent Core admission idle' >&2; exit 1; }
h_lite_switched=1
"$docker_path" compose up -d --no-deps --no-build h-lite >/dev/null
wait_h_lite || { "$docker_path" compose logs --tail 160 h-lite >&2; exit 1; }
h_lite_admin drain 0 || { echo 'H-Lite drain gate failed; no Foundation service was recreated after H-Lite' >&2; exit 1; }
h_lite_draining=1
if agent_core_admin_available; then
  agent_core_draining=1
else
  agent_core_draining=0
fi
drain_agent_core || { echo 'Agent Core active request drain gate failed' >&2; exit 1; }
agent_core_switched=1
"$docker_path" compose up -d --no-deps --no-build agent-core >/dev/null
wait_agent_core || { "$docker_path" compose logs --tail 160 agent-core >&2; exit 1; }
agent_core_draining=0
knowledge_connector_switched=1
"$docker_path" compose up -d --no-deps --no-build knowledge-connector >/dev/null
wait_connector || { "$docker_path" compose logs --tail 160 knowledge-connector >&2; exit 1; }
h_lite_admin resume 0 || { echo 'H-Lite resume gate failed' >&2; exit 1; }
h_lite_draining=0
wait_h_lite || { "$docker_path" compose logs --tail 160 h-lite >&2; exit 1; }
wait_foundation_stable || { "$docker_path" compose ps >&2; exit 1; }

"$script_root/capture-goal7-deployment-state.sh" after "$after_file" >/dev/null
completed_at=$($node_bin -e "const x=require(process.argv[1]);process.stdout.write(x.capturedAt)" "$after_file")
"$script_root/capture-shadow-side-effects.sh" "$started_at" "$completed_at" "$side_effect_file"
"$node_bin" "$script_root/compile-goal7-deployment-evidence.mjs" "$evidence_root" "$deployment_file" >/dev/null

cat > "$backup_root/release-manifest.txt" <<EOF
run_id=$run_id
source_commit=$source_commit
h_lite_source_commit=$h_lite_source_commit
agent_core_version=$agent_core_version
knowledge_connector_version=$knowledge_connector_version
h_lite_version=$h_lite_version
runtime_root=$runtime_root
runtime_evidence_root=$runtime_evidence_root
evidence_root=$evidence_root
migration012_retained_on_rollback=true
preparation_evidence_sha256=$preparation_evidence_sha
migration_evidence_sha256=$migration_evidence_sha
EOF
chmod 600 "$backup_root/release-manifest.txt"
trap - EXIT HUP INT TERM
printf 'goal7_deploy_run_id=%s\nbackup_root=%s\nsource_commit=%s\nh_lite_source_commit=%s\ndeployment_evidence=%s\n' \
  "$run_id" "$backup_root" "$source_commit" "$h_lite_source_commit" "$deployment_file"
