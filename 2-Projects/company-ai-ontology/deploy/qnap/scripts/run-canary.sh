#!/bin/sh
set -eu

docker_path=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
report_root=${CANARY_REPORT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/canary-reports}
run_id=${CANARY_RUN_ID:-p0-f-$(date +%Y%m%d-%H%M%S)}
report_dir=$report_root/$run_id

cd "$project_root"
set -a
. ./.env
set +a
mkdir -p "$report_dir"
chmod 750 "$report_root" "$report_dir"

wait_healthy() {
  container=$1
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    status=$("$docker_path" inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || true)
    [ "$status" = healthy ] && return 0
    sleep 5
  done
  return 1
}

wait_healthy company-ai-foundation-agent-core-1
wait_healthy company-ai-foundation-action-gateway-1
wait_healthy company-ai-foundation-h-lite-1

"$docker_path" compose exec -T -e CANARY_RUN_ID="$run_id" -e CANARY_LEVELS=5,10,20 h-lite \
  node --input-type=module - < canary/load.mjs > "$report_dir/load.json"

"$docker_path" compose exec -T postgres psql \
  --username ontology_admin --dbname ontology \
  --set=tenant_id="$FUTURUS_TENANT_ID" --set=run_id="$run_id" --file=- \
  < canary/seed-retry.sql > "$report_dir/retry-seed.txt"

"$docker_path" compose exec -T -e CANARY_RUN_ID="$run_id" h-lite \
  node --input-type=module - < canary/retry-delivery.mjs > "$report_dir/retry.json"

"$docker_path" compose restart agent-core h-lite > "$report_dir/restart.txt"
wait_healthy company-ai-foundation-agent-core-1
wait_healthy company-ai-foundation-h-lite-1

"$docker_path" compose exec -T -e CANARY_RUN_ID="$run_id" h-lite \
  node --input-type=module - < canary/recovery.mjs > "$report_dir/recovery.json"

"$docker_path" compose exec -T postgres psql \
  --username ontology_admin --dbname ontology \
  --set=tenant_id="$FUTURUS_TENANT_ID" --set=run_id="$run_id" --file=- \
  < canary/readback.sql > "$report_dir/readback.txt"

"$docker_path" stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' \
  company-ai-foundation-agent-core-1 company-ai-foundation-action-gateway-1 \
  company-ai-foundation-h-lite-1 company-ai-foundation-postgres-1 \
  > "$report_dir/resources.txt"

printf 'run_id=%s\nreport_dir=%s\n' "$run_id" "$report_dir"
cat "$report_dir/load.json"
cat "$report_dir/retry.json"
cat "$report_dir/recovery.json"
cat "$report_dir/readback.txt"
cat "$report_dir/resources.txt"
