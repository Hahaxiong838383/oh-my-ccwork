import { sha256 } from './protocol.mjs'
import { classifyGovernedIntent } from './governed-intent.mjs'
import { purposeForTurn } from './authority.mjs'

export const WORK_PROTOCOL_VERSION = '1.1.0'
export const ONTOLOGY_SCHEMA_VERSION = '3.3.0'

export const WORK_STAGES = Object.freeze([
  'intake',
  'scope',
  'authority',
  'context',
  'evidence',
  'synthesis',
  'response',
  'decision',
  'plan',
  'execution',
  'verification',
  'learning',
])

export const ACTIVE_STAGES = Object.freeze([...WORK_STAGES])
export const CONTRACT_ONLY_STAGES = Object.freeze([])

const TRANSITIONS = Object.freeze({
  received: new Set(['scoped', 'clarification_required', 'blocked']),
  scoped: new Set(['authority_checked', 'clarification_required', 'blocked']),
  authority_checked: new Set(['evidence_collecting', 'permission_denied', 'blocked']),
  evidence_collecting: new Set(['evidence_ready', 'insufficient_evidence', 'blocked']),
  evidence_ready: new Set(['synthesizing', 'review_required', 'blocked']),
  insufficient_evidence: new Set(['synthesizing', 'evidence_collecting', 'blocked']),
  synthesizing: new Set(['response_ready', 'review_required', 'blocked']),
  review_required: new Set(['response_ready', 'blocked']),
  response_ready: new Set(['decision_pending', 'completed', 'blocked']),
  decision_pending: new Set(['decision_approved', 'review_required', 'blocked']),
  decision_approved: new Set(['planning', 'blocked']),
  planning: new Set(['plan_ready', 'review_required', 'blocked']),
  plan_ready: new Set(['executing', 'blocked']),
  executing: new Set(['verification_pending', 'blocked']),
  verification_pending: new Set(['verified', 'review_required', 'blocked']),
  verified: new Set(['learning', 'completed', 'blocked']),
  learning: new Set(['completed', 'review_required', 'blocked']),
  clarification_required: new Set(['scoped', 'blocked']),
  blocked: new Set(['evidence_collecting', 'synthesizing']),
  permission_denied: new Set(),
  completed: new Set(),
})

function redactRequest(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[phone]')
    .replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

export function inferWorkMode(turn = {}) {
  const governed = classifyGovernedIntent(turn)
  if (['operating_model_explanation', 'system_role_explanation'].includes(governed?.kind)) return 'situation_analysis'
  if (governed) return 'answer_query'
  const intent = String(turn.intent || '').toLowerCase()
  const message = String(turn.message || '')
  if (intent === 'decision') return 'decision_support'
  if (intent === 'task_assist') return 'p2_orchestration'
  if (/(分析|趋势|风险|原因|对比|复盘|洞察)/u.test(message)) return 'situation_analysis'
  return 'answer_query'
}

export function riskLevelFor(workMode) {
  if (workMode === 'governed_action') return 'critical'
  if (['decision_support', 'p2_orchestration'].includes(workMode)) return 'high'
  if (workMode === 'situation_analysis') return 'medium'
  return 'low'
}

export function createWorkCaseDraft({ requestId, personId, turn, authoritySnapshot = null, processingMode = 'shadow', now = () => new Date() } = {}) {
  const workMode = inferWorkMode(turn)
  const requestSummary = redactRequest(turn?.message)
  const conversationReference = String(turn?.conversationId || '')
  return {
    externalCaseId: `workcase:${requestId}`,
    principalExternalKey: personId,
    purpose: purposeForTurn(turn),
    workMode,
    requestSummary: requestSummary || '未提供可用请求摘要',
    requestFingerprint: sha256(String(turn?.message || '')),
    requestedOutcome: workMode === 'answer_query' ? '可解释回答' : '可审计分析与后续建议',
    status: 'received',
    riskLevel: riskLevelFor(workMode),
    policySnapshotId: `policy:${requestId}`,
    policySnapshot: {
      principalBound: true,
      purposeBound: true,
      authorityRuleVersion: authoritySnapshot?.ruleVersion || null,
      conversationAuthorityDecision: authoritySnapshot?.decision || null,
      conversationAuthorityReasonCode: authoritySnapshot?.reasonCode || null,
      permissionedRetrievalRequired: true,
      directBusinessWriteAllowed: false,
      hiddenChainOfThoughtStorageAllowed: false,
    },
    ontologySchemaVersion: ONTOLOGY_SCHEMA_VERSION,
    protocolVersion: WORK_PROTOCOL_VERSION,
    processingMode,
    conversationReferenceHash: conversationReference ? sha256(conversationReference) : null,
    startedAt: now().toISOString(),
  }
}

export function assertWorkCaseTransition(fromStatus, toStatus) {
  const allowed = TRANSITIONS[fromStatus]
  if (!allowed || !allowed.has(toStatus)) {
    const error = new Error(`invalid work case transition: ${fromStatus} -> ${toStatus}`)
    error.code = 'invalid_work_case_transition'
    throw error
  }
  return true
}

export function stageContract(workMode = 'answer_query') {
  const knowledgeOnly = ['answer_query', 'situation_analysis'].includes(workMode)
  return WORK_STAGES.map((stageType, sequenceNo) => ({
    sequenceNo,
    stageType,
    status: knowledgeOnly && sequenceNo >= 7 ? 'skipped' : 'pending',
  }))
}
