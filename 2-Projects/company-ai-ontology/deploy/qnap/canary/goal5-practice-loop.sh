#!/bin/sh
set -eu
exec </dev/null

project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
run_id=${GOAL5_RUN_ID:-goal5-$(date +%Y%m%d%H%M%S)}
dri_display_name=${GOAL5_DRI_DISPLAY_NAME:-陈川}
p2_external_key=${GOAL5_P2_EXTERNAL_KEY:-company-ai-ontology-goal5-$run_id}
decision_external_key=$p2_external_key-decision-$run_id

case "$run_id:$p2_external_key" in
  *[!A-Za-z0-9:_-]*) echo 'invalid Goal 5 identifier' >&2; exit 2 ;;
esac

cd "$project_root"
set -a
. ./.env
set +a

dri_person_key=$(
  "$docker_path" compose exec -T postgres psql -U ontology_admin -d ontology -At \
    --set=tenant_id="$FUTURUS_TENANT_ID" --set=dri_display_name="$dri_display_name" <<'SQL'
SELECT external_key
  FROM iam.principals
 WHERE tenant_id=:'tenant_id'::uuid
   AND principal_type='person'
   AND status='active'
   AND display_name=:'dri_display_name'
 ORDER BY created_at
 LIMIT 2;
SQL
)

[ "$(printf '%s\n' "$dri_person_key" | sed '/^$/d' | wc -l | tr -d ' ')" -eq 1 ] || {
  echo 'Goal 5 DRI must resolve to exactly one active real employee' >&2
  exit 1
}

"$docker_path" compose exec -T postgres psql \
  --set=ON_ERROR_STOP=1 \
  --username ontology_admin \
  --dbname ontology \
  --set=tenant_id="$FUTURUS_TENANT_ID" \
  --set=dri_person_key="$dri_person_key" \
  --set=p2_external_key="$p2_external_key" \
  --set=decision_external_key="$decision_external_key" <<'SQL' >/dev/null
SELECT set_config('app.tenant_id', :'tenant_id', false);

INSERT INTO iam.grants (tenant_id, principal_id, resource_scope, permission, constraints)
SELECT :'tenant_id'::uuid, id, 'workflow:p2', 'approve', '{"goal5Pilot":true}'::jsonb
  FROM iam.principals
 WHERE tenant_id=:'tenant_id'::uuid AND external_key=:'dri_person_key' AND status='active'
ON CONFLICT (tenant_id, principal_id, resource_scope, permission) DO UPDATE SET
  constraints=iam.grants.constraints || '{"goal5Pilot":true}'::jsonb;

INSERT INTO iam.principals (
  tenant_id, principal_type, external_key, display_name, department_key, status, attributes
) VALUES (
  :'tenant_id'::uuid, 'person', 'goal5-reviewer-fixture', 'Goal 5 Reviewer Fixture', 'goal5-fixture', 'active',
  '{"simulation":true,"purpose":"non-dri-negative-test"}'::jsonb
) ON CONFLICT (tenant_id, principal_type, external_key) DO UPDATE SET status='active', updated_at=now();

INSERT INTO iam.grants (tenant_id, principal_id, resource_scope, permission, constraints)
SELECT :'tenant_id'::uuid, id, 'workflow:p2', 'approve', '{"simulation":true}'::jsonb
  FROM iam.principals
 WHERE tenant_id=:'tenant_id'::uuid AND external_key='goal5-reviewer-fixture'
ON CONFLICT (tenant_id, principal_id, resource_scope, permission) DO NOTHING;

INSERT INTO ontology.entities (
  tenant_id, entity_type, external_key, display_name, classification, attributes, ontology_version_id
)
SELECT :'tenant_id'::uuid, 'p2', :'p2_external_key', '完成公司 AI Ontology Goal 5 决策实践闭环', 'internal',
       jsonb_build_object(
         'sourceSystem', 'company-ai-ontology',
         'goalLevel', 'P2',
         'pilotScope', 'single-real-dri',
         'decision_case_external_key', :'decision_external_key'
       ), version.id
  FROM ontology_registry.versions version
 WHERE version.tenant_id=:'tenant_id'::uuid AND version.status='active'
ON CONFLICT (tenant_id, entity_type, external_key) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  attributes=ontology.entities.attributes || EXCLUDED.attributes,
  ontology_version_id=EXCLUDED.ontology_version_id,
  updated_at=now();
SQL

"$docker_path" compose exec -T \
  -e GOAL5_RUN_ID="$run_id" \
  -e GOAL5_DRI_PERSON_KEY="$dri_person_key" \
  -e GOAL5_P2_EXTERNAL_KEY="$p2_external_key" \
  -e GOAL5_DECISION_EXTERNAL_KEY="$decision_external_key" \
  h-lite node --input-type=module <<'NODE'
import crypto from 'node:crypto'

const tenantId = process.env.FUTURUS_TENANT_ID
const dri = process.env.GOAL5_DRI_PERSON_KEY
const p2ExternalKey = process.env.GOAL5_P2_EXTERNAL_KEY
const decisionExternalKey = process.env.GOAL5_DECISION_EXTERNAL_KEY
const runId = process.env.GOAL5_RUN_ID
const coreUrl = new URL(process.env.H_AGENT_CORE_URL)
const coreSecret = process.env.H_AGENT_CORE_SECRET
const actionUrl = new URL(process.env.H_ACTION_GATEWAY_URL)
const actionToken = process.env.H_ACTION_GATEWAY_TOKEN

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function signature(body, timestamp, requestId, personId, idempotencyKey) {
  const digest = crypto.createHash('sha256').update(body).digest('hex')
  const canonical = [timestamp, requestId, tenantId, personId, idempotencyKey, digest].join('\n')
  return `v1=${crypto.createHmac('sha256', coreSecret).update(canonical).digest('hex')}`
}

async function corePost(path, personId, label, payload, expectedStatus = 200) {
  const body = JSON.stringify(payload)
  const requestId = `${runId}-${label}`
  const timestamp = String(Date.now())
  const response = await fetch(new URL(path, coreUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-company-timestamp': timestamp,
      'x-company-request-id': requestId,
      'x-company-tenant-id': tenantId,
      'x-company-person-id': personId,
      'x-company-idempotency-key': requestId,
      'x-company-signature': signature(body, timestamp, requestId, personId, requestId),
    },
    body,
  })
  const result = await response.json()
  assert(response.status === expectedStatus, `${label}: expected ${expectedStatus}, got ${response.status} ${JSON.stringify(result)}`)
  return result
}

async function actionPost(path, label, payload, expectedStatus = 200) {
  const response = await fetch(new URL(path, actionUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-action-gateway-token': actionToken },
    body: JSON.stringify(payload),
  })
  const result = await response.json()
  assert(response.status === expectedStatus, `${label}: expected ${expectedStatus}, got ${response.status} ${JSON.stringify(result)}`)
  return result
}

const proposed = await corePost('/v1/decisions/propose', dri, 'decision-propose', {
  decisionExternalKey,
  p2ExternalKey,
  conversationId: `${runId}-decision`,
  question: '如何以扎实地基完成公司 AI Ontology Goal 5 决策实践闭环？',
  purpose: 'company-ai-ontology-goal5-production-pilot',
  riskLevel: 'high',
  evidenceReferences: ['evidence:goal5:contracts', 'evidence:goal5:isolated-db-validation'],
  alternatives: [
    {
      title: '受控单 DRI 闭环后再扩真实员工',
      expectedOutcome: {
        metricKey: 'goal5_acceptance',
        targetOperator: 'status',
        targetText: 'accepted',
        acceptanceCriteria: ['Decision Lineage 可回放', '三层结果分离', 'Learning 仅形成提案'],
      },
      assumptions: ['Goal 3 十人 Canary 继续延后'],
      risks: ['单 DRI 不能替代十人放量验收'],
      riskScore: 0.25,
    },
    {
      title: '直接扩大员工试点',
      expectedOutcome: { metricKey: 'goal5_acceptance', targetOperator: 'status', targetText: 'expanded' },
      assumptions: ['员工通道已准备'],
      risks: ['大框架未稳定即扩大影响面'],
      riskScore: 0.85,
    },
  ],
})
assert(proposed.status === 'pending_approval', 'decision proposal did not enter pending approval')

const selectedAlternativeExternalKey = `${decisionExternalKey}:alternative:1`
await corePost('/v1/decisions/approve', 'goal5-reviewer-fixture', 'decision-non-dri', {
  decisionExternalKey,
  selectedAlternativeExternalKey,
  rationale: 'negative test',
  approvalEvidenceReferences: ['evidence:goal5:negative'],
}, 403)

const approved = await corePost('/v1/decisions/approve', dri, 'decision-approve', {
  decisionExternalKey,
  selectedAlternativeExternalKey,
  rationale: '先完成单 DRI 受控闭环，Goal 3 十人 Canary 保持延后。',
  approvalEvidenceReferences: ['evidence:goal5:contracts', 'evidence:goal5:isolated-db-validation'],
})
const approvedDecisionExternalKey = approved.decision.external_key
const replay = await corePost('/v1/decisions/approve', dri, 'decision-approve-replay', {
  decisionExternalKey,
  selectedAlternativeExternalKey,
  rationale: 'retry must return existing decision',
  approvalEvidenceReferences: ['evidence:goal5:contracts'],
})
assert(replay.decision.id === approved.decision.id, 'decision approval retry created a second decision')

await corePost('/v1/p2/compile', dri, 'compile-unapproved-negative', {
  p2ExternalKey,
  decisionExternalKey: `${decisionExternalKey}:not-approved`,
  assigneePersonIds: [dri],
}, 404)

const compiled = await corePost('/v1/p2/compile', dri, 'compile', {
  p2ExternalKey,
  decisionExternalKey: approvedDecisionExternalKey,
  assigneePersonIds: [dri],
})
assert(compiled.tasks.length === 1, 'single DRI pilot must create exactly one task')
const taskExternalKey = compiled.tasks[0].external_key

for (const [index, action] of ['approve', 'assign', 'start', 'submit', 'accept'].entries()) {
  const payload = { taskExternalKey, action, suppressDelivery: true }
  if (action === 'submit') payload.resultText = 'Goal 5 契约、迁移、权限负测、Decision Lineage 与三层结果验证已完成。'
  await corePost('/v1/tasks/transition', dri, `task-${index + 1}-${action}`, payload)
}

const proposedAction = await corePost('/v1/actions/propose', dri, 'action-propose', {
  targetSystem: 'feishu-demo',
  actionType: 'feishu_task_status_demo',
  decisionExternalKey: approvedDecisionExternalKey,
  taskExternalKey,
  payload: { taskExternalKey, desiredStatus: 'done' },
  riskLevel: 'low',
})
const intentId = proposedAction.action.id
await actionPost('/v1/actions/dry-run', 'action-dry-run', { intentId })
await actionPost('/v1/actions/approve', 'action-approve', { intentId, actorPersonId: dri })
const executed = await actionPost('/v1/actions/execute', 'action-execute', { intentId })
assert(executed.action.readback_receipt?.verified === true, 'action readback verification failed')

await actionPost('/v1/actions/verify-outcome', 'outcome-invalid-levels', {
  intentId,
  actorPersonId: dri,
  operationalSuccess: false,
  goalSuccess: true,
  evidenceReferences: ['evidence:goal5:invalid'],
}, 409)

const verification = await actionPost('/v1/actions/verify-outcome', 'outcome-verify', {
  intentId,
  actorPersonId: dri,
  operationalSuccess: true,
  goalSuccess: true,
  evidenceReferences: ['evidence:goal5:production-pilot', `task:${taskExternalKey}`],
  sourceSystem: 'company-ai-ontology-goal5-canary',
  sourceReference: runId,
  observedText: '单真实 DRI 的 Decision/P2/Task/Action/Verification 闭环完成。',
  confidenceLevel: 'high',
  notes: '不代表十人真实员工 Canary 已完成。',
})
const verificationReplay = await actionPost('/v1/actions/verify-outcome', 'outcome-verify-replay', {
  intentId,
  actorPersonId: dri,
  operationalSuccess: true,
  goalSuccess: true,
  evidenceReferences: ['evidence:goal5:production-pilot'],
  sourceSystem: 'company-ai-ontology-goal5-canary',
  sourceReference: runId,
  confidenceLevel: 'high',
})
assert(verificationReplay.action.id === verification.action.id, 'verification retry created a second verification')

const learning = await corePost('/v1/learnings/record', dri, 'learning-record', {
  decisionExternalKey: approvedDecisionExternalKey,
  verificationId: verification.action.id,
  finding: '实践闭环必须把技术执行、业务结果和经营目标分开验证，单 DRI 试点不能替代十人 Canary。',
  causeCategory: 'measurement',
  recommendedChange: { type: 'proposal', nextGate: 'goal3-ten-person-canary-after-framework-complete' },
  changeScope: 'process',
})
assert(learning.learning.status === 'proposed', 'learning must remain a proposal')

const practiceResponse = await fetch(new URL('/status/practice-protocol', coreUrl))
const practice = await practiceResponse.json()
assert(practiceResponse.ok, 'practice protocol status unavailable')
const lineage = practice.recentLineages.find((item) => item.decisionCaseExternalKey === decisionExternalKey)
assert(lineage?.practiceStatus === 'goal_verified', 'Decision Lineage is not goal_verified')
assert(lineage.taskCount === 1 && lineage.acceptedTaskCount === 1, 'task lineage mismatch')
assert(lineage.actionCount === 1 && lineage.verificationCount === 1 && lineage.learningCount === 1, 'practice lineage counts mismatch')
assert(lineage.executionSuccess && lineage.operationalSuccess && lineage.goalSuccess, 'three result levels are incomplete')

console.log(JSON.stringify({
  runId,
  p2ExternalKey,
  practiceMode: practice.status,
  decisionApproved: true,
  taskCount: lineage.taskCount,
  actionCount: lineage.actionCount,
  verificationCount: lineage.verificationCount,
  learningCount: lineage.learningCount,
  executionSuccess: lineage.executionSuccess,
  operationalSuccess: lineage.operationalSuccess,
  goalSuccess: lineage.goalSuccess,
  learningStatus: learning.learning.status,
  employeeCanaryExpanded: false,
}))
NODE

"$docker_path" compose exec -T postgres psql \
  --set=ON_ERROR_STOP=1 \
  --username ontology_admin \
  --dbname ontology \
  --set=tenant_id="$FUTURUS_TENANT_ID" <<'SQL' >/dev/null
UPDATE iam.principals SET status='disabled', updated_at=now()
 WHERE tenant_id=:'tenant_id'::uuid AND external_key='goal5-reviewer-fixture';
SQL
