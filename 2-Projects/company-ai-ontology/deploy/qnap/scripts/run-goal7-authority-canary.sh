#!/bin/sh
set -eu
exec </dev/null
umask 077

[ "${GOAL7_WORKER_READBACK_APPROVED:-}" = YES ] || { echo 'Goal 7 authority canary requires shared D-stage GOAL7_WORKER_READBACK_APPROVED=YES' >&2; exit 1; }

project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
control_root=${GOAL7_CONTROL_ROOT:-$project_root}
report_root=${GOAL7_CANARY_REPORT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/goal7-acceptance}
source_commit=${GOAL7_SOURCE_COMMIT:-}
run_id=${GOAL7_RUN_ID:-goal7-authority-$(date +%Y%m%d-%H%M%S)-$$}
run_key=$(printf '%s' "$run_id" | sha256sum | cut -c1-16)
report_dir=$report_root/$run_key
evidence_file=${GOAL7_AUTHORITY_EVIDENCE_FILE:-$report_dir/authority-canary.json}
temporary_file=$evidence_file.tmp

case "$source_commit" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo 'GOAL7_SOURCE_COMMIT must be an explicit pushed 40-character commit' >&2; exit 1 ;;
esac

DOCKER_PATH="$docker_path" FOUNDATION_ROOT="$project_root" \
  "$control_root/deploy/qnap/strategic-intelligence/scripts/preflight-company-qnap.sh" >/dev/null

cd "$project_root"
set -a
. ./.env
set +a
mkdir -p "$report_dir" "$(dirname "$evidence_file")"
chmod 700 "$report_root" "$report_dir" 2>/dev/null || true

cleanup() {
  "$docker_path" compose exec -T postgres psql \
    --set=ON_ERROR_STOP=1 \
    --username ontology_admin \
    --dbname ontology \
    --set=tenant_id="$FUTURUS_TENANT_ID" \
    --set=run_key="$run_key" \
    --file=- < "$control_root/deploy/qnap/canary/goal7-authority-canary-cleanup.sql" >/dev/null 2>&1 || true
  rm -f "$temporary_file"
}
trap cleanup EXIT INT TERM

for container in company-ai-foundation-postgres-1 company-ai-foundation-agent-core-1 company-ai-foundation-h-lite-1; do
  status=$($docker_path inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || true)
  [ "$status" = healthy ] || { echo "required container is not healthy: $container" >&2; exit 1; }
done

"$docker_path" compose exec -T postgres psql \
  --set=ON_ERROR_STOP=1 \
  --username ontology_admin \
  --dbname ontology \
  --set=tenant_id="$FUTURUS_TENANT_ID" \
  --set=run_key="$run_key" \
  --file=- < "$control_root/deploy/qnap/canary/goal7-authority-canary.sql" >/dev/null

"$docker_path" compose exec -T \
  -e GOAL7_SOURCE_COMMIT="$source_commit" \
  -e GOAL7_RUN_ID="$run_id" \
  -e GOAL7_RUN_KEY="$run_key" \
  h-lite node /app/ops/goal7-authority-canary.mjs > "$temporary_file"

"$docker_path" compose exec -T postgres psql \
  --set=ON_ERROR_STOP=1 \
  --username ontology_admin \
  --dbname ontology \
  --set=tenant_id="$FUTURUS_TENANT_ID" \
  --set=run_key="$run_key" \
  --file=- < "$control_root/deploy/qnap/canary/goal7-authority-canary-cleanup.sql" >/dev/null
trap - EXIT INT TERM
chmod 600 "$temporary_file"
mv "$temporary_file" "$evidence_file"
chmod 600 "$evidence_file"
evidence_sha256=$(sha256sum "$evidence_file" | awk '{print $1}')
printf 'evidence_file=%s\nevidence_sha256=%s\n' "$evidence_file" "$evidence_sha256"
