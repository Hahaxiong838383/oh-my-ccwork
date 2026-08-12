#!/bin/sh
set -eu
exec </dev/null
umask 077

[ "${GOAL7_WORKER_READBACK_APPROVED:-}" = YES ] || { echo 'Goal 7 worker readback requires GOAL7_WORKER_READBACK_APPROVED=YES' >&2; exit 1; }

project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
control_root=${GOAL7_CONTROL_ROOT:-$project_root}
report_root=${GOAL7_WORKER_REPORT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/goal7-acceptance}
source_commit=${GOAL7_SOURCE_COMMIT:-}
h_lite_source_commit=${GOAL7_H_LITE_SOURCE_COMMIT:-}
run_id=${GOAL7_WORKER_RUN_ID:-goal7-worker-$(date +%Y%m%d-%H%M%S)-$$}
run_key=$(printf '%s' "$run_id" | sha256sum | cut -c1-16)
request_id=goal7-worker-readback-$run_key
request_id_hash=$(printf '%s' "$request_id" | sha256sum | awk '{print $1}')
evidence_root=${GOAL7_EVIDENCE_ROOT:-$report_root/$run_key}
http_file=$evidence_root/worker-http-response.json
ledger_file=$evidence_root/worker-ledger-row.json
compiled_file=$evidence_root/worker-readback.json

case "$source_commit:$h_lite_source_commit" in
  *[!0-9a-f:]*) echo 'Goal 7 source commits must be lowercase hexadecimal' >&2; exit 1 ;;
esac
[ "${#source_commit}" -eq 40 ] || { echo 'GOAL7_SOURCE_COMMIT must be an explicit pushed 40-character commit' >&2; exit 1; }
[ "${#h_lite_source_commit}" -eq 40 ] || { echo 'GOAL7_H_LITE_SOURCE_COMMIT must be an explicit pushed 40-character commit' >&2; exit 1; }

DOCKER_PATH="$docker_path" FOUNDATION_ROOT="$project_root" \
  "$control_root/deploy/qnap/strategic-intelligence/scripts/preflight-company-qnap.sh" >/dev/null

cd "$project_root"
set -a
. ./.env
set +a
mkdir -p "$evidence_root"
chmod 700 "$report_root" "$evidence_root" 2>/dev/null || true

cleanup() {
  "$docker_path" compose exec -T postgres psql \
    --set=ON_ERROR_STOP=1 --username ontology_admin --dbname ontology \
    --set=tenant_id="$FUTURUS_TENANT_ID" --set=run_key="$run_key" \
    --file=- < "$control_root/deploy/qnap/canary/goal7-worker-readback-cleanup.sql" >/dev/null 2>&1 || true
  rm -f "$http_file.tmp" "$ledger_file.tmp" "$compiled_file.tmp"
}
trap cleanup EXIT INT TERM

for container in company-ai-foundation-postgres-1 company-ai-foundation-agent-core-1 company-ai-foundation-h-lite-1; do
  status=$($docker_path inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || true)
  [ "$status" = healthy ] || { echo "required container is not healthy: $container" >&2; exit 1; }
done

"$docker_path" compose exec -T agent-core node -e \
  "fetch('http://127.0.0.1:8080/readyz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.productionReady===true&&p.sourceCommit===process.argv[1]?0:1)}).catch(()=>process.exit(1))" \
  "$source_commit" </dev/null >/dev/null
"$docker_path" compose exec -T h-lite node -e \
  "fetch('http://127.0.0.1:8081/healthz').then(async r=>{const p=await r.json();process.exit(r.ok&&p.sourceCommit===process.argv[1]&&p.mode==='active'?0:1)}).catch(()=>process.exit(1))" \
  "$h_lite_source_commit" </dev/null >/dev/null

"$docker_path" compose exec -T postgres psql \
  --set=ON_ERROR_STOP=1 --username ontology_admin --dbname ontology \
  --set=tenant_id="$FUTURUS_TENANT_ID" --set=run_key="$run_key" \
  --file=- < "$control_root/deploy/qnap/canary/goal7-worker-readback-seed.sql" >/dev/null

"$docker_path" compose exec -T \
  -e GOAL7_REQUEST_ID="$request_id" \
  -e GOAL7_REQUEST_ID_HASH="$request_id_hash" \
  -e GOAL7_RUN_KEY="$run_key" \
  -e GOAL7_SOURCE_COMMIT="$source_commit" \
  -e GOAL7_H_LITE_SOURCE_COMMIT="$h_lite_source_commit" \
  h-lite node --input-type=module -e '
    import { createHash } from "node:crypto"
    import { createCompanyAgentCoreAdapter, createCompanyAgentCoreClient } from "/app/lib/company-agent-core-client.mjs"
    const client = createCompanyAgentCoreClient({
      baseUrl: process.env.H_AGENT_CORE_URL,
      secret: process.env.H_AGENT_CORE_SECRET,
      timeoutMs: 180000,
    })
    const adapter = createCompanyAgentCoreAdapter({
      client,
      tenantId: process.env.FUTURUS_TENANT_ID,
      personId: "feishu:goal7-worker-readback",
    })
    const result = await adapter.runText(
      `请仅根据 GOAL7_WORKER_READBACK_${process.env.GOAL7_RUN_KEY.toUpperCase()} 合成证据生成简短验证结论。`,
      {
        requestId: process.env.GOAL7_REQUEST_ID,
        idempotencyKey: process.env.GOAL7_REQUEST_ID,
        sessionKey: process.env.GOAL7_REQUEST_ID,
        channel: "goal7-worker-readback",
        purpose: "company_knowledge_query",
        conversation: { type: "private" },
      },
    )
    const runtime = result.meta?.runtime || {}
    const provider = runtime.engineProvider || runtime.provider
    const usage = runtime.usage || {}
    const governance = runtime.governance || {}
    if (result.meta?.agentCoreStatus !== "completed") throw new Error("Agent Core readback request failed")
    if (createHash("sha256").update(String(result.meta?.agentCoreRequestId || "")).digest("hex") !== process.env.GOAL7_REQUEST_ID_HASH) throw new Error("Agent Core request identity drift")
    if (!provider || !runtime.model || runtime.productionReady !== true || runtime.simulation === true) throw new Error("production model readback missing")
    if (governance.ledgerRecorded !== true || governance.routeKey !== "route-a" || governance.routeBEnabled !== false) throw new Error("runtime governance readback invalid")
    const output = {
      evidenceVersion: "1.0.0",
      evidenceType: "goal7-h-worker-http-response",
      sourceCommit: process.env.GOAL7_SOURCE_COMMIT,
      hLiteSourceCommit: process.env.GOAL7_H_LITE_SOURCE_COMMIT,
      capturedAt: new Date().toISOString(),
      httpStatus: 200,
      responseStatus: result.meta.agentCoreStatus,
      requestIdHash: process.env.GOAL7_REQUEST_ID_HASH,
      provider,
      model: runtime.model,
      credentialModeTag: governance.credentialModeTag,
      productionReady: runtime.productionReady,
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        estimatedCostMicros: usage.estimatedCostMicros,
      },
      governance: {
        routeKey: governance.routeKey,
        retryCount: governance.retryCount,
        ledgerRecorded: governance.ledgerRecorded,
        routeBEnabled: governance.routeBEnabled,
      },
      sensitivePayloadPersisted: false,
    }
    process.stdout.write(`${JSON.stringify(output)}\n`)
  ' > "$http_file.tmp"
chmod 600 "$http_file.tmp"
mv "$http_file.tmp" "$http_file"

captured_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
"$docker_path" compose exec -T postgres psql -At \
  --set=ON_ERROR_STOP=1 --username ontology_admin --dbname ontology \
  --set=tenant_id="$FUTURUS_TENANT_ID" \
  --set=request_id="$request_id" \
  --set=request_id_hash="$request_id_hash" \
  --set=source_commit="$source_commit" \
  --set=h_lite_source_commit="$h_lite_source_commit" \
  --set=captured_at="$captured_at" \
  --file=- < "$control_root/deploy/qnap/canary/goal7-worker-readback-ledger.sql" > "$ledger_file.tmp"
chmod 600 "$ledger_file.tmp"
mv "$ledger_file.tmp" "$ledger_file"

node_bin=${NODE_BIN:-$control_root/deploy/qnap/strategic-intelligence/scripts/node-runtime.sh}
"$node_bin" "$control_root/deploy/qnap/strategic-intelligence/scripts/compile-goal7-worker-readback.mjs" \
  "$evidence_root" "$compiled_file.tmp" >/dev/null
chmod 600 "$compiled_file.tmp"
mv "$compiled_file.tmp" "$compiled_file"

"$docker_path" compose exec -T postgres psql \
  --set=ON_ERROR_STOP=1 --username ontology_admin --dbname ontology \
  --set=tenant_id="$FUTURUS_TENANT_ID" --set=run_key="$run_key" \
  --file=- < "$control_root/deploy/qnap/canary/goal7-worker-readback-cleanup.sql" >/dev/null
trap - EXIT INT TERM
printf 'worker_readback=%s\nrequest_id_hash=%s\n' "$compiled_file" "$request_id_hash"
