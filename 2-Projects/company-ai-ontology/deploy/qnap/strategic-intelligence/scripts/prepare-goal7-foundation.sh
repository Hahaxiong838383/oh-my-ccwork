#!/bin/sh
set -eu
exec </dev/null
umask 077

[ "${GOAL7_DEPLOY_APPROVED:-}" = YES ] || { echo 'Goal 7 preparation requires explicit GOAL7_DEPLOY_APPROVED=YES' >&2; exit 2; }
runtime_evidence_root=${GOAL7_RUNTIME_EVIDENCE_ROOT:?GOAL7_RUNTIME_EVIDENCE_ROOT is required}
evidence_root=${GOAL7_DEPLOYMENT_EVIDENCE_ROOT:?GOAL7_DEPLOYMENT_EVIDENCE_ROOT is required}
approved_source_commit=${GOAL7_APPROVED_SOURCE_COMMIT:?GOAL7_APPROVED_SOURCE_COMMIT is required}
approved_h_lite_source_commit=${GOAL7_APPROVED_H_LITE_SOURCE_COMMIT:?GOAL7_APPROVED_H_LITE_SOURCE_COMMIT is required}
requested_run_id=${GOAL7_DEPLOY_RUN_ID:-}
run_id=${requested_run_id:-$(date +%Y%m%d%H%M%S)}
case "$run_id" in
  [A-Za-z0-9]*) ;;
  *) echo 'Goal 7 preparation run id is unsafe' >&2; exit 2 ;;
esac
case "$run_id" in *[!A-Za-z0-9._-]*) echo 'Goal 7 preparation run id is unsafe' >&2; exit 2 ;; esac
[ "${#run_id}" -le 64 ] || { echo 'Goal 7 preparation run id is too long' >&2; exit 2; }
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
node_bin=${NODE_BIN:-$script_root/node-runtime.sh}
[ -x "$node_bin" ] || { echo 'Goal 7 preparation Node runtime unavailable' >&2; exit 2; }
case "$runtime_evidence_root" in "$shadow_root"/release/*) ;; *) echo 'runtime evidence must remain under strategic intelligence release root' >&2; exit 2 ;; esac
case "$evidence_root" in "$shadow_root"/approvals/*) ;; *) echo 'preparation evidence must remain under strategic intelligence approvals root' >&2; exit 2 ;; esac
case "$runtime_evidence_root:$evidence_root" in *'/../'*|*/..:*|*'//'*|*:*'/../'*|*:*/..) echo 'Goal 7 preparation path is not normalized' >&2; exit 2 ;; esac

runtime_validation=$($node_bin "$script_root/validate-goal7-runtime-release.mjs" \
  "$runtime_evidence_root" "$approved_source_commit" "$approved_h_lite_source_commit")
source_commit=$(printf '%s\n' "$runtime_validation" | awk -F= '/^source_commit=/{print $2;exit}')
h_lite_source_commit=$(printf '%s\n' "$runtime_validation" | awk -F= '/^h_lite_source_commit=/{print $2;exit}')
agent_core_version=$(printf '%s\n' "$runtime_validation" | awk -F= '/^agent_core_version=/{print $2;exit}')
knowledge_connector_version=$(printf '%s\n' "$runtime_validation" | awk -F= '/^knowledge_connector_version=/{print $2;exit}')
h_lite_version=$(printf '%s\n' "$runtime_validation" | awk -F= '/^h_lite_version=/{print $2;exit}')
[ "$source_commit" = "$approved_source_commit" ] || { echo 'approved Ontology sourceCommit drift' >&2; exit 2; }
[ "$h_lite_source_commit" = "$approved_h_lite_source_commit" ] || { echo 'approved H-Lite sourceCommit drift' >&2; exit 2; }
[ -n "$agent_core_version" ] && [ -n "$knowledge_connector_version" ] && [ -n "$h_lite_version" ] || { echo 'runtime component versions missing' >&2; exit 2; }

runtime_root=$shadow_root/foundation-releases/$source_commit-$h_lite_source_commit
temporary_runtime=$runtime_root.partial-$run_id
backup_root=/share/CACHEDEV2_DATA/ai-ontology-backup/goal7/$run_id
baseline_file=$evidence_root/preparation-baseline-state.json
preparation_file=$evidence_root/preparation-evidence.json
input_file=$evidence_root/.preparation-input-$run_id.json
preparation_lock=$shadow_root/.goal7-foundation-preparation.lock

mkdir -p "$evidence_root"
chmod 700 "$evidence_root"
mkdir "$preparation_lock" 2>/dev/null || { echo 'Goal 7 foundation preparation is already in progress' >&2; exit 2; }
lock_acquired=1
runtime_created=0
backup_created=0
baseline_created=0
preparation_created=0
created_image_tags=
release_lock() {
  [ "$lock_acquired" -eq 0 ] || rmdir "$preparation_lock" 2>/dev/null || true
  lock_acquired=0
}
cleanup_prepare() {
  status=$?
  trap - EXIT HUP INT TERM
  rm -f "$input_file"
  if [ "$status" -ne 0 ]; then
    for image_tag in $created_image_tags; do
      "$docker_path" image rm "$image_tag" >/dev/null 2>&1 || true
    done
    [ "$runtime_created" -eq 1 ] && rm -rf "$runtime_root"
    rm -rf "$temporary_runtime"
    [ "$backup_created" -eq 1 ] && rm -rf "$backup_root"
    [ "$baseline_created" -eq 0 ] || rm -f "$baseline_file"
    [ "$preparation_created" -eq 0 ] || rm -f "$preparation_file"
  fi
  release_lock
  exit "$status"
}
trap cleanup_prepare EXIT
trap 'exit 130' HUP INT TERM
if [ -f "$preparation_file" ] && [ ! -L "$preparation_file" ]; then
  existing=$($node_bin "$script_root/validate-goal7-preparation.mjs" "$evidence_root" "$approved_source_commit" "$approved_h_lite_source_commit")
  existing_run_id=$(printf '%s\n' "$existing" | awk -F= '/^run_id=/{print $2;exit}')
  [ -z "$requested_run_id" ] || [ "$existing_run_id" = "$requested_run_id" ] || { echo 'Goal 7 preparation evidence already binds another run id' >&2; exit 2; }
  existing_backup_root=$(printf '%s\n' "$existing" | awk -F= '/^backup_root=/{print $2;exit}')
  existing_backup_env_sha=$(printf '%s\n' "$existing" | awk -F= '/^backup_env_sha256=/{print $2;exit}')
  existing_backup_compose_sha=$(printf '%s\n' "$existing" | awk -F= '/^backup_compose_sha256=/{print $2;exit}')
  [ "$(sha256sum "$existing_backup_root/.env" | awk '{print $1}')" = "$existing_backup_env_sha" ] || { echo 'Goal 7 preparation replay .env backup drift' >&2; exit 2; }
  [ "$(sha256sum "$existing_backup_root/docker-compose.yml" | awk '{print $1}')" = "$existing_backup_compose_sha" ] || { echo 'Goal 7 preparation replay compose backup drift' >&2; exit 2; }
  for service in agent-core knowledge-connector h-lite; do
    case "$service" in
      agent-core) evidence_service=agent_core ;;
      knowledge-connector) evidence_service=knowledge_connector ;;
      h-lite) evidence_service=h_lite ;;
    esac
    previous_id=$(printf '%s\n' "$existing" | awk -F= -v key="previous_${evidence_service}_image_id" '$1==key{print $2;exit}')
    candidate_id=$(printf '%s\n' "$existing" | awk -F= -v key="candidate_${evidence_service}_image_id" '$1==key{print $2;exit}')
    [ "$("$docker_path" image inspect --format '{{.Id}}' company-ai-foundation-$service:goal7-pre-$existing_run_id)" = "$previous_id" ] || { echo "Goal 7 preparation replay previous image drift: $service" >&2; exit 2; }
    [ "$("$docker_path" image inspect --format '{{.Id}}' company-ai-foundation-$service:goal7-candidate-$existing_run_id)" = "$candidate_id" ] || { echo "Goal 7 preparation replay candidate image drift: $service" >&2; exit 2; }
  done
  release_lock
  printf '%s\npreparation_replay=accepted\n' "$existing"
  exit 0
fi
[ ! -e "$preparation_file" ] || { echo 'Goal 7 preparation evidence path is unsafe' >&2; exit 2; }
[ ! -e "$baseline_file" ] || { echo 'Goal 7 preparation baseline exists without valid completion evidence' >&2; exit 2; }
[ ! -e "$backup_root" ] || { echo 'Goal 7 preparation backup root already exists without valid completion evidence' >&2; exit 2; }
[ ! -e "$temporary_runtime" ] || { echo 'Goal 7 partial runtime already exists' >&2; exit 2; }
for service in agent-core knowledge-connector h-lite; do
  "$docker_path" image inspect company-ai-foundation-$service:goal7-pre-$run_id >/dev/null 2>&1 \
    && { echo "Goal 7 preparation previous image tag already exists: $service" >&2; exit 2; }
  "$docker_path" image inspect company-ai-foundation-$service:goal7-candidate-$run_id >/dev/null 2>&1 \
    && { echo "Goal 7 preparation candidate image tag already exists: $service" >&2; exit 2; }
done

mkdir -p "$temporary_runtime/company-ai-ontology" "$temporary_runtime/feishu-grok-bridge"
chmod 700 "$temporary_runtime"
tar -xzf "$runtime_evidence_root/source.tar.gz" -C "$temporary_runtime"
tar -xzf "$runtime_evidence_root/h-lite-source.tar.gz" --strip-components=1 -C "$temporary_runtime/feishu-grok-bridge"
[ -f "$temporary_runtime/company-ai-ontology/deploy/qnap/docker-compose.yml" ] || { echo 'Ontology release archive incomplete' >&2; exit 2; }
[ -f "$temporary_runtime/company-ai-ontology/deploy/qnap/candidate-migrations/012-goal7-authority-runtime.sql" ] || { echo 'Goal 7 migration missing' >&2; exit 2; }
[ -f "$temporary_runtime/feishu-grok-bridge/deploy/company-qnap-lite/Dockerfile" ] || { echo 'H-Lite release archive incomplete' >&2; exit 2; }
if [ -e "$runtime_root" ]; then
  [ -d "$runtime_root" ] && [ ! -L "$runtime_root" ] || { echo 'Goal 7 immutable runtime root is unsafe' >&2; exit 2; }
  temporary_runtime_sha=$($node_bin "$script_root/hash-goal7-runtime-tree.mjs" "$temporary_runtime")
  existing_runtime_sha=$($node_bin "$script_root/hash-goal7-runtime-tree.mjs" "$runtime_root")
  [ "$temporary_runtime_sha" = "$existing_runtime_sha" ] || { echo 'Goal 7 immutable runtime root differs from approved archives' >&2; exit 2; }
  rm -rf "$temporary_runtime"
else
  mv "$temporary_runtime" "$runtime_root"
  runtime_created=1
fi

"$script_root/capture-goal7-deployment-state.sh" preparation "$baseline_file" >/dev/null
baseline_created=1
mkdir -p "$backup_root/images"
backup_created=1
chmod 700 "$backup_root" "$backup_root/images"
cp "$foundation_root/.env" "$backup_root/.env"
cp "$foundation_root/docker-compose.yml" "$backup_root/docker-compose.yml"
chmod 600 "$backup_root/.env" "$backup_root/docker-compose.yml"

cd "$foundation_root"
"$docker_path" compose config >/dev/null
for service in agent-core knowledge-connector h-lite; do
  container_id=$("$docker_path" compose ps -q "$service")
  [ -n "$container_id" ] || { echo "Goal 7 active service missing: $service" >&2; exit 2; }
  current_image_id=$("$docker_path" inspect --format '{{.Image}}' "$container_id")
  previous=company-ai-foundation-$service:goal7-pre-$run_id
  candidate=company-ai-foundation-$service:goal7-candidate-$run_id
  "$docker_path" image inspect "$current_image_id" >/dev/null
  created_image_tags="$created_image_tags $previous"
  "$docker_path" image tag "$current_image_id" "$previous"
  printf '%s=%s\n' "$service" "$previous" >> "$backup_root/images/tags.txt"
  case "$service" in
    agent-core)
      created_image_tags="$created_image_tags $candidate"
      "$docker_path" build --build-arg ONTOLOGY_SOURCE_COMMIT="$source_commit" -t "$candidate" "$runtime_root/company-ai-ontology/services/agent-core" >/dev/null
      ;;
    knowledge-connector)
      created_image_tags="$created_image_tags $candidate"
      "$docker_path" build --build-arg ONTOLOGY_SOURCE_COMMIT="$source_commit" -t "$candidate" "$runtime_root/company-ai-ontology/services/knowledge-connector" >/dev/null
      ;;
    h-lite)
      created_image_tags="$created_image_tags $candidate"
      "$docker_path" build --build-arg H_LITE_SOURCE_COMMIT="$h_lite_source_commit" \
        -f "$runtime_root/feishu-grok-bridge/deploy/company-qnap-lite/Dockerfile" \
        -t "$candidate" "$runtime_root/feishu-grok-bridge" >/dev/null
      ;;
  esac
done
chmod 600 "$backup_root/images/tags.txt"

verify_image_readable() {
  image=$1
  readable_path=$2
  "$docker_path" run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --entrypoint node "$image" \
    -e "require('fs').accessSync(process.argv[1], require('fs').constants.R_OK)" "$readable_path" >/dev/null
}
verify_image_readable company-ai-foundation-agent-core:goal7-candidate-$run_id /app/src/server.mjs
verify_image_readable company-ai-foundation-knowledge-connector:goal7-candidate-$run_id /app/src/server.mjs
verify_image_readable company-ai-foundation-h-lite:goal7-candidate-$run_id /app/company-qnap-lite.mjs

sha256_file() { sha256sum "$1" | awk '{print $1}'; }
image_id() { "$docker_path" image inspect --format '{{.Id}}' "$1"; }
baseline_sha=$(sha256_file "$baseline_file")
runtime_release_sha=$(sha256_file "$runtime_evidence_root/SHA256SUMS")
runtime_versions_sha=$(sha256_file "$runtime_evidence_root/runtime-component-versions.json")
backup_env_sha=$(sha256_file "$backup_root/.env")
backup_compose_sha=$(sha256_file "$backup_root/docker-compose.yml")

cat > "$input_file" <<EOF_JSON
{
  "runId": "$run_id",
  "sourceCommit": "$source_commit",
  "hLiteSourceCommit": "$h_lite_source_commit",
  "agentCoreVersion": "$agent_core_version",
  "knowledgeConnectorVersion": "$knowledge_connector_version",
  "hLiteVersion": "$h_lite_version",
  "runtimeRoot": "$runtime_root",
  "runtimeEvidenceRoot": "$runtime_evidence_root",
  "backupRoot": "$backup_root",
  "runtimeReleaseSha256": "$runtime_release_sha",
  "runtimeComponentVersionsSha256": "$runtime_versions_sha",
  "baselineStateSha256": "$baseline_sha",
  "backupEnvSha256": "$backup_env_sha",
  "backupComposeSha256": "$backup_compose_sha",
  "images": {
    "agentCore": {
      "previousTag": "company-ai-foundation-agent-core:goal7-pre-$run_id",
      "previousImageId": "$(image_id company-ai-foundation-agent-core:goal7-pre-$run_id)",
      "candidateTag": "company-ai-foundation-agent-core:goal7-candidate-$run_id",
      "candidateImageId": "$(image_id company-ai-foundation-agent-core:goal7-candidate-$run_id)"
    },
    "knowledgeConnector": {
      "previousTag": "company-ai-foundation-knowledge-connector:goal7-pre-$run_id",
      "previousImageId": "$(image_id company-ai-foundation-knowledge-connector:goal7-pre-$run_id)",
      "candidateTag": "company-ai-foundation-knowledge-connector:goal7-candidate-$run_id",
      "candidateImageId": "$(image_id company-ai-foundation-knowledge-connector:goal7-candidate-$run_id)"
    },
    "hLite": {
      "previousTag": "company-ai-foundation-h-lite:goal7-pre-$run_id",
      "previousImageId": "$(image_id company-ai-foundation-h-lite:goal7-pre-$run_id)",
      "candidateTag": "company-ai-foundation-h-lite:goal7-candidate-$run_id",
      "candidateImageId": "$(image_id company-ai-foundation-h-lite:goal7-candidate-$run_id)"
    }
  }
}
EOF_JSON
chmod 600 "$input_file"
"$node_bin" "$script_root/write-goal7-preparation-evidence.mjs" "$input_file" "$preparation_file" >/dev/null
preparation_created=1
rm -f "$input_file"
"$node_bin" "$script_root/validate-goal7-preparation.mjs" "$evidence_root" "$approved_source_commit" "$approved_h_lite_source_commit"
release_lock
trap - EXIT HUP INT TERM
printf 'goal7_preparation=completed\nservices_recreated=0\nmigration012_applied=0\n'
