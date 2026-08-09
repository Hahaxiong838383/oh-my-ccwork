#!/bin/sh
set -eu
exec </dev/null

project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
expected_mode=${EXPECTED_WORK_PROTOCOL_MODE:-shadow}
run_id=${GOAL4_RUN_ID:-goal4-$(date +%s)}

cd "$project_root"
set -a
. ./.env
set +a

cleanup() {
  "$docker_path" compose exec -T postgres psql \
    --set=ON_ERROR_STOP=1 \
    --username ontology_admin \
    --dbname ontology \
    --set=tenant_id="$FUTURUS_TENANT_ID" <<'SQL' >/dev/null
DELETE FROM knowledge.resources
WHERE tenant_id = :'tenant_id'::uuid
  AND provider = 'fixture'
  AND external_key LIKE 'goal4-fixture-%';

UPDATE iam.principals
SET status = 'disabled', updated_at = now()
WHERE tenant_id = :'tenant_id'::uuid
  AND external_key IN ('goal4-fixture-reader', 'goal4-fixture-noacl');
SQL
}
trap cleanup EXIT INT TERM

"$docker_path" compose exec -T postgres psql \
  --set=ON_ERROR_STOP=1 \
  --username ontology_admin \
  --dbname ontology \
  --set=tenant_id="$FUTURUS_TENANT_ID" <<'SQL' >/dev/null
INSERT INTO iam.principals (
  tenant_id, principal_type, external_key, display_name, department_key, status, attributes
)
VALUES
  (:'tenant_id'::uuid, 'person', 'goal4-fixture-reader', 'Goal 4 Fixture Reader', 'fixture', 'active', '{"simulation":true,"fixture":"goal4"}'::jsonb),
  (:'tenant_id'::uuid, 'person', 'goal4-fixture-noacl', 'Goal 4 Fixture No ACL', 'fixture', 'active', '{"simulation":true,"fixture":"goal4"}'::jsonb)
ON CONFLICT (tenant_id, principal_type, external_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  department_key = EXCLUDED.department_key,
  status = 'active',
  attributes = EXCLUDED.attributes,
  updated_at = now();

INSERT INTO knowledge.resources (
  tenant_id, provider, resource_type, external_key, title, classification,
  acl_status, status, metadata, source_updated_at
)
VALUES
  (:'tenant_id'::uuid, 'fixture', 'order', 'goal4-fixture-erp-fresh', 'Fixture ERP Fresh Support', 'internal',
   'known', 'active', jsonb_build_object('simulation', true, 'sourceSystem', 'aishike-erp-fixture', 'supports', true, 'validUntil', to_jsonb(now() + interval '1 day')), now()),
  (:'tenant_id'::uuid, 'fixture', 'order', 'goal4-fixture-erp-conflict', 'Fixture ERP Conflict Support', 'internal',
   'known', 'active', jsonb_build_object('simulation', true, 'sourceSystem', 'aishike-erp-fixture', 'supports', true, 'validUntil', to_jsonb(now() + interval '1 day')), now()),
  (:'tenant_id'::uuid, 'fixture', 'market_signal', 'goal4-fixture-social-conflict', 'Fixture Social Contradiction', 'internal',
   'known', 'active', jsonb_build_object('simulation', true, 'sourceSystem', 'social-monitor-fixture', 'contradicts', true, 'validUntil', to_jsonb(now() + interval '1 day')), now()),
  (:'tenant_id'::uuid, 'fixture', 'inventory', 'goal4-fixture-erp-stale', 'Fixture ERP Stale Evidence', 'internal',
   'known', 'active', jsonb_build_object('simulation', true, 'sourceSystem', 'aishike-erp-fixture', 'supports', true, 'validUntil', to_jsonb(now() - interval '1 day')), now() - interval '200 days')
ON CONFLICT (tenant_id, provider, external_key) DO UPDATE SET
  resource_type = EXCLUDED.resource_type,
  title = EXCLUDED.title,
  classification = EXCLUDED.classification,
  acl_status = 'known',
  status = 'active',
  metadata = EXCLUDED.metadata,
  source_updated_at = EXCLUDED.source_updated_at,
  synced_at = now(),
  updated_at = now();

DELETE FROM knowledge.chunks
WHERE tenant_id = :'tenant_id'::uuid
  AND resource_id IN (
    SELECT id FROM knowledge.resources
    WHERE tenant_id = :'tenant_id'::uuid AND provider = 'fixture' AND external_key LIKE 'goal4-fixture-%'
  );
DELETE FROM knowledge.acl_entries
WHERE tenant_id = :'tenant_id'::uuid
  AND resource_id IN (
    SELECT id FROM knowledge.resources
    WHERE tenant_id = :'tenant_id'::uuid AND provider = 'fixture' AND external_key LIKE 'goal4-fixture-%'
  );

INSERT INTO knowledge.chunks (tenant_id, resource_id, chunk_index, content, token_estimate)
SELECT r.tenant_id, r.id, 0,
  CASE r.external_key
    WHEN 'goal4-fixture-erp-fresh' THEN 'GOAL4_FRESH_ONLY Fixture 订单已完成质检和出库准备。'
    WHEN 'goal4-fixture-erp-conflict' THEN 'GOAL4_CONFLICT Fixture ERP 显示目标体验已经改善。'
    WHEN 'goal4-fixture-social-conflict' THEN 'GOAL4_CONFLICT Fixture 社媒反馈显示目标体验仍未改善。'
    WHEN 'goal4-fixture-erp-stale' THEN 'GOAL4_STALE Fixture 库存快照已超过有效期。'
  END,
  32
FROM knowledge.resources r
WHERE r.tenant_id = :'tenant_id'::uuid
  AND r.provider = 'fixture'
  AND r.external_key LIKE 'goal4-fixture-%';

INSERT INTO knowledge.acl_entries (tenant_id, resource_id, subject_type, subject_key, permission, source)
SELECT r.tenant_id, r.id, 'person', 'goal4-fixture-reader', 'read', 'goal4_fixture'
FROM knowledge.resources r
WHERE r.tenant_id = :'tenant_id'::uuid
  AND r.provider = 'fixture'
  AND r.external_key LIKE 'goal4-fixture-%';
SQL

"$docker_path" compose exec -T \
  -e GOAL4_RUN_ID="$run_id" \
  -e EXPECTED_WORK_PROTOCOL_MODE="$expected_mode" \
  h-lite node --input-type=module <<'NODE'
import { createCompanyAgentCoreClient } from '/app/lib/company-agent-core-client.mjs'

const client = createCompanyAgentCoreClient({
  baseUrl: process.env.H_AGENT_CORE_URL,
  secret: process.env.H_AGENT_CORE_SECRET,
  timeoutMs: 120_000,
})
const runId = process.env.GOAL4_RUN_ID
const expectedMode = process.env.EXPECTED_WORK_PROTOCOL_MODE

async function turn(label, personId, message) {
  return client.turn({
    tenantId: process.env.FUTURUS_TENANT_ID,
    personId,
    requestId: `${runId}-${label}`,
    idempotencyKey: `${runId}-${label}`,
    conversationId: `${runId}-${label}`,
    message,
    intent: 'query',
    channel: 'goal4-fixture',
  })
}

const fresh = await turn('fresh', 'goal4-fixture-reader', '查询 GOAL4_FRESH_ONLY')
const conflict = await turn('conflict', 'goal4-fixture-reader', '查询 GOAL4_CONFLICT')
const stale = await turn('stale', 'goal4-fixture-reader', '查询 GOAL4_STALE')
const noAcl = await turn('noacl', 'goal4-fixture-noacl', '查询 GOAL4_FRESH_ONLY')
const missing = await turn('missing', 'goal4-fixture-missing', '查询 GOAL4_FRESH_ONLY')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
for (const [label, result] of Object.entries({ fresh, conflict, stale, noAcl, missing })) {
  assert(result.workCase?.processingMode === expectedMode, `${label}: processing mode mismatch`)
  assert(result.evidencePackage?.packageVersion === '2.0.0', `${label}: evidence package mismatch`)
}
assert(fresh.epistemicAssessment?.deterministicConclusionAllowed === true, 'fresh: deterministic conclusion should be allowed')
assert(fresh.evidencePackage?.facts?.some((item) => item.source === 'aishike-erp-fixture'), 'fresh: ERP fixture provenance missing')
assert(conflict.epistemicAssessment?.deterministicConclusionAllowed === false, 'conflict: deterministic conclusion must be blocked')
assert(conflict.epistemicAssessment?.contradictionStatus === 'conflicting', 'conflict: contradiction not detected')
assert(conflict.evidencePackage?.contradictingEvidence?.some((item) => item.source === 'social-monitor-fixture'), 'conflict: social fixture provenance missing')
assert(stale.epistemicAssessment?.deterministicConclusionAllowed === false, 'stale: deterministic conclusion must be blocked')
assert(stale.epistemicAssessment?.freshnessStatus === 'stale', 'stale: freshness not detected')
assert(noAcl.evidence?.length === 0 && noAcl.evidencePackage?.facts?.length === 0, 'noacl: evidence must be zero')
assert(missing.workCase?.status === 'permission_denied', 'missing: principal must be denied before runtime')
assert(missing.evidence?.length === 0 && missing.evidencePackage?.facts?.length === 0, 'missing: evidence must be zero')
const deniedPayload = JSON.stringify({ noAcl, missing })
assert(!/Fixture ERP|Fixture Social|https?:\/\//.test(deniedPayload), 'denied response leaked fixture metadata')

if (expectedMode === 'active') {
  assert(fresh.answer && ['medium', 'high'].includes(fresh.answer.confidenceLevel), 'fresh: active answer should remain deterministic')
  assert(conflict.answer && ['low', 'insufficient'].includes(conflict.answer.confidenceLevel), 'conflict: active answer must be downgraded')
  assert(stale.answer && ['low', 'insufficient'].includes(stale.answer.confidenceLevel), 'stale: active answer must be downgraded')
}

console.log(JSON.stringify({
  runId,
  mode: expectedMode,
  fresh: { evidence: fresh.evidence.length, confidence: fresh.epistemicAssessment.confidenceLevel, deterministic: fresh.epistemicAssessment.deterministicConclusionAllowed, responseValidation: fresh.workCase?.status },
  conflict: { evidence: conflict.evidence.length, confidence: conflict.epistemicAssessment.confidenceLevel, deterministic: conflict.epistemicAssessment.deterministicConclusionAllowed, contradiction: conflict.epistemicAssessment.contradictionStatus },
  stale: { evidence: stale.evidence.length, confidence: stale.epistemicAssessment.confidenceLevel, deterministic: stale.epistemicAssessment.deterministicConclusionAllowed, freshness: stale.epistemicAssessment.freshnessStatus },
  noAcl: { evidence: noAcl.evidence.length, deterministic: noAcl.epistemicAssessment.deterministicConclusionAllowed },
  missing: { evidence: missing.evidence.length, status: missing.workCase.status },
}))
NODE
