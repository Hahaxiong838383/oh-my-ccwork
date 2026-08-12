#!/bin/sh
set -eu
exec </dev/null
umask 077

[ "${GOAL7_DEPLOY_APPROVED:-}" = YES ] || { echo 'Goal 7 deployment requires explicit GOAL7_DEPLOY_APPROVED=YES' >&2; exit 2; }
[ "${GOAL7_MIGRATION_012_APPROVED:-}" = YES ] || { echo 'Goal 7 migration 012 requires explicit GOAL7_MIGRATION_012_APPROVED=YES' >&2; exit 2; }
[ "${GOAL7_SERVICE_RECREATION_APPROVED:-}" = YES ] || { echo 'Goal 7 service recreation requires explicit GOAL7_SERVICE_RECREATION_APPROVED=YES' >&2; exit 2; }
runtime_evidence_root=${GOAL7_RUNTIME_EVIDENCE_ROOT:?GOAL7_RUNTIME_EVIDENCE_ROOT is required}
evidence_root=${GOAL7_DEPLOYMENT_EVIDENCE_ROOT:?GOAL7_DEPLOYMENT_EVIDENCE_ROOT is required}
approved_source_commit=${GOAL7_APPROVED_SOURCE_COMMIT:?GOAL7_APPROVED_SOURCE_COMMIT is required}
approved_h_lite_source_commit=${GOAL7_APPROVED_H_LITE_SOURCE_COMMIT:?GOAL7_APPROVED_H_LITE_SOURCE_COMMIT is required}
run_id=${GOAL7_DEPLOY_RUN_ID:-$(date +%Y%m%d%H%M%S)}
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
node_bin=${NODE_BIN:-$script_root/node-runtime.sh}
[ -x "$node_bin" ] || { echo 'Goal 7 deployment Node runtime unavailable' >&2; exit 2; }
case "$runtime_evidence_root" in "$shadow_root"/release/*) ;; *) echo 'runtime evidence must remain under strategic intelligence release root' >&2; exit 2 ;; esac
case "$evidence_root" in "$shadow_root"/approvals/*) ;; *) echo 'deployment evidence must remain under strategic intelligence approvals root' >&2; exit 2 ;; esac

runtime_validation=$($node_bin "$script_root/validate-goal7-runtime-release.mjs" \
  "$runtime_evidence_root" "$approved_source_commit" "$approved_h_lite_source_commit")
source_commit=$(printf '%s\n' "$runtime_validation" | awk -F= '/^source_commit=/{print $2;exit}')
h_lite_source_commit=$(printf '%s\n' "$runtime_validation" | awk -F= '/^h_lite_source_commit=/{print $2;exit}')
[ "$source_commit" = "$approved_source_commit" ] || { echo 'approved Ontology sourceCommit drift' >&2; exit 2; }
[ "$h_lite_source_commit" = "$approved_h_lite_source_commit" ] || { echo 'approved H-Lite sourceCommit drift' >&2; exit 2; }

runtime_root=$shadow_root/foundation-releases/$source_commit-$h_lite_source_commit
temporary_runtime=$runtime_root.partial-$run_id
backup_root=/share/CACHEDEV2_DATA/ai-ontology-backup/goal7/$run_id
before_file=$evidence_root/pre-deployment-state.json
after_file=$evidence_root/post-deployment-state.json
side_effect_file=$evidence_root/deployment-side-effects.json
deployment_file=$evidence_root/deployment-evidence.json
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

[ ! -e "$runtime_root" ] || { echo 'Goal 7 immutable runtime root already exists' >&2; exit 2; }
mkdir -p "$temporary_runtime/company-ai-ontology" "$temporary_runtime/feishu-grok-bridge" "$evidence_root" "$backup_root/images"
chmod 700 "$temporary_runtime" "$evidence_root" "$backup_root" "$backup_root/images"
tar -xzf "$runtime_evidence_root/source.tar.gz" -C "$temporary_runtime"
tar -xzf "$runtime_evidence_root/h-lite-source.tar.gz" --strip-components=1 -C "$temporary_runtime/feishu-grok-bridge"
[ -f "$temporary_runtime/company-ai-ontology/deploy/qnap/docker-compose.yml" ] || { echo 'Ontology release archive incomplete' >&2; exit 2; }
[ -f "$temporary_runtime/company-ai-ontology/deploy/qnap/candidate-migrations/012-goal7-authority-runtime.sql" ] || { echo 'Goal 7 migration missing' >&2; exit 2; }
[ -f "$temporary_runtime/feishu-grok-bridge/deploy/company-qnap-lite/Dockerfile" ] || { echo 'H-Lite release archive incomplete' >&2; exit 2; }
mv "$temporary_runtime" "$runtime_root"

"$script_root/capture-goal7-deployment-state.sh" before "$before_file" >/dev/null
cp "$foundation_root/.env" "$backup_root/.env"
cp "$foundation_root/docker-compose.yml" "$backup_root/docker-compose.yml"
chmod 600 "$backup_root/.env" "$backup_root/docker-compose.yml"

for service in agent-core knowledge-connector h-lite; do
  current=company-ai-foundation-$service:latest
  previous=company-ai-foundation-$service:goal7-pre-$run_id
  "$docker_path" image inspect "$current" >/dev/null
  "$docker_path" image tag "$current" "$previous"
  printf '%s=%s\n' "$service" "$previous" >> "$backup_root/images/tags.txt"
done

rollback_on_error() {
  status=$?
  trap - EXIT HUP INT TERM
  [ "$status" -ne 0 ] || exit 0
  set +e
  cp "$backup_root/.env" "$foundation_root/.env"
  cp "$backup_root/docker-compose.yml" "$foundation_root/docker-compose.yml"
  chmod 600 "$foundation_root/.env" "$foundation_root/docker-compose.yml"
  for service in agent-core knowledge-connector h-lite; do
    previous=company-ai-foundation-$service:goal7-pre-$run_id
    "$docker_path" image inspect "$previous" >/dev/null 2>&1 && "$docker_path" image tag "$previous" company-ai-foundation-$service:latest
  done
  cd "$foundation_root"
  for service in agent-core knowledge-connector h-lite; do
    "$docker_path" compose up -d --no-build "$service" >/dev/null 2>&1 || true
  done
  printf 'Goal 7 deployment failed; previous config and service images were restored. Migration 012 is additive and was not dropped.\n' >&2
  exit "$status"
}
trap rollback_on_error EXIT HUP INT TERM

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
"$docker_path" compose exec -T postgres psql --set=ON_ERROR_STOP=1 --username ontology_admin --dbname ontology \
  < "$runtime_root/company-ai-ontology/deploy/qnap/candidate-migrations/012-goal7-authority-runtime.sql" >/dev/null
"$docker_path" compose build agent-core knowledge-connector h-lite >/dev/null

verify_image_readable() {
  image=$1
  path=$2
  "$docker_path" run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --entrypoint node "$image" \
    -e "require('fs').accessSync(process.argv[1], require('fs').constants.R_OK)" "$path" >/dev/null
}
verify_image_readable company-ai-foundation-agent-core:latest /app/src/server.mjs
verify_image_readable company-ai-foundation-knowledge-connector:latest /app/src/server.mjs
verify_image_readable company-ai-foundation-h-lite:latest /app/company-qnap-lite.mjs

wait_agent_core() {
  attempt=0
  until "$docker_path" compose exec -T agent-core node -e \
    "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.status==='ready'&&p.productionReady===true&&p.contractVersion==='2026-08-11.1'&&p.sourceCommit===process.argv[1]?0:1)}).catch(()=>process.exit(1))" \
    "$source_commit" </dev/null >/dev/null 2>&1; do
    attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1; sleep 2
  done
}
wait_connector() {
  attempt=0
  until "$docker_path" compose exec -T knowledge-connector node -e \
    "fetch('http://127.0.0.1:8083/readyz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.status==='ready'&&p.version==='2026-08-11.1'&&p.sourceCommit===process.argv[1]?0:1)}).catch(()=>process.exit(1))" \
    "$source_commit" </dev/null >/dev/null 2>&1; do
    attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1; sleep 2
  done
}
wait_h_lite() {
  attempt=0
  until "$docker_path" compose exec -T h-lite node -e \
    "Promise.all([fetch('http://127.0.0.1:8081/healthz'),fetch('http://127.0.0.1:8081/readyz')]).then(async rs=>{const p=await Promise.all(rs.map(r=>r.json()));process.exit(rs.every(r=>r.ok)&&p[0].serviceVersion==='2026-08-11.1'&&p[0].sourceCommit===process.argv[1]&&p[0].mode==='active'&&p[0].subscriptionEnabled===true&&p[1].status==='active_ready'?0:1)}).catch(()=>process.exit(1))" \
    "$h_lite_source_commit" </dev/null >/dev/null 2>&1; do
    attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || return 1; sleep 2
  done
}

"$docker_path" compose up -d agent-core >/dev/null
wait_agent_core || { "$docker_path" compose logs --tail 160 agent-core >&2; exit 1; }
"$docker_path" compose up -d knowledge-connector >/dev/null
wait_connector || { "$docker_path" compose logs --tail 160 knowledge-connector >&2; exit 1; }
"$docker_path" compose up -d h-lite >/dev/null
wait_h_lite || { "$docker_path" compose logs --tail 160 h-lite >&2; exit 1; }

"$script_root/capture-goal7-deployment-state.sh" after "$after_file" >/dev/null
completed_at=$($node_bin -e "const x=require(process.argv[1]);process.stdout.write(x.capturedAt)" "$after_file")
"$script_root/capture-shadow-side-effects.sh" "$started_at" "$completed_at" "$side_effect_file"
"$node_bin" "$script_root/compile-goal7-deployment-evidence.mjs" "$evidence_root" "$deployment_file" >/dev/null

cat > "$backup_root/release-manifest.txt" <<EOF
run_id=$run_id
source_commit=$source_commit
h_lite_source_commit=$h_lite_source_commit
runtime_root=$runtime_root
runtime_evidence_root=$runtime_evidence_root
evidence_root=$evidence_root
migration012_retained_on_rollback=true
EOF
chmod 600 "$backup_root/release-manifest.txt"
trap - EXIT HUP INT TERM
printf 'goal7_deploy_run_id=%s\nbackup_root=%s\nsource_commit=%s\nh_lite_source_commit=%s\ndeployment_evidence=%s\n' \
  "$run_id" "$backup_root" "$source_commit" "$h_lite_source_commit" "$deployment_file"
