import { createHash } from 'node:crypto'

export const AUTHORITY_RULE_VERSION = '1.0.0'
export const AUTHORITY_PURPOSES = Object.freeze([
  'company_knowledge_query',
  'task_execution_support',
  'decision_support',
  'result_submission',
])

const SAFE_KEY = /^[A-Za-z0-9_.:@-]{1,240}$/

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex')
}

function bounded(value, max = 240) {
  return String(value || '').trim().slice(0, max)
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : null
}

export function purposeForTurn(turn = {}) {
  const explicit = bounded(turn?.context?.purpose, 64)
  if (AUTHORITY_PURPOSES.includes(explicit)) return explicit
  if (turn.intent === 'decision') return 'decision_support'
  if (turn.intent === 'task_assist') {
    return turn?.context?.submission === true ? 'result_submission' : 'task_execution_support'
  }
  return 'company_knowledge_query'
}

function normalizeConversation(context = {}) {
  const source = context?.conversation && typeof context.conversation === 'object'
    ? context.conversation
    : context
  const type = bounded(source?.type || source?.conversationType, 16).toLowerCase()
  if (!type || type === 'private' || type === 'p2p') return { type: 'private', key: null }
  if (!['chat', 'group'].includes(type)) return { type: 'unknown', key: null }
  const key = bounded(source?.chatId || source?.conversationKey || source?.chatKey, 240)
  return SAFE_KEY.test(key) ? { type: 'chat', key } : { type: 'unknown', key: null }
}

function membershipDecision(context, conversation, nowMs, maxAgeMs) {
  if (conversation.type === 'private') return { status: 'not_applicable', observedAt: null, expiresAt: null }
  if (conversation.type !== 'chat') return { status: 'unknown', observedAt: null, expiresAt: null }
  const source = context?.membership && typeof context.membership === 'object'
    ? context.membership
    : context?.conversation?.membership && typeof context.conversation.membership === 'object'
      ? context.conversation.membership
      : {}
  const rawStatus = bounded(source.status, 16).toLowerCase()
  const observedAtMs = timestamp(source.observedAt)
  const explicitExpiresAtMs = timestamp(source.expiresAt)
  const expiresAtMs = explicitExpiresAtMs ?? (observedAtMs === null ? null : observedAtMs + maxAgeMs)
  if (!['active', 'inactive'].includes(rawStatus) || observedAtMs === null || expiresAtMs === null) {
    return { status: 'unknown', observedAt: null, expiresAt: null }
  }
  if (observedAtMs > nowMs + 5_000 || expiresAtMs < nowMs || nowMs - observedAtMs > maxAgeMs) {
    return { status: 'unknown', observedAt: new Date(observedAtMs).toISOString(), expiresAt: new Date(expiresAtMs).toISOString() }
  }
  return {
    status: rawStatus,
    observedAt: new Date(observedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  }
}

export function compileConversationAuthority({ personId, context = {}, purpose, now = () => new Date(), maxMembershipAgeMs = 60_000 } = {}) {
  const normalizedPersonId = bounded(personId, 128)
  if (!SAFE_KEY.test(normalizedPersonId)) throw Object.assign(new Error('invalid request principal'), { code: 'authority_invalid_principal' })
  const normalizedPurpose = AUTHORITY_PURPOSES.includes(purpose) ? purpose : 'company_knowledge_query'
  const nowValue = now()
  const nowMs = new Date(nowValue).getTime()
  const conversation = normalizeConversation(context)
  const membership = membershipDecision(context, conversation, nowMs, Math.max(1_000, Number(maxMembershipAgeMs) || 60_000))
  const membershipAllowsChat = conversation.type === 'chat' && membership.status === 'active'
  const conversationDecision = conversation.type === 'private'
    ? 'allow'
    : membership.status === 'active' ? 'allow' : membership.status === 'inactive' ? 'deny' : 'unknown'
  const reasonCode = conversation.type === 'private'
    ? 'private_sender_only'
    : membership.status === 'active' ? 'current_sender_membership_verified'
      : membership.status === 'inactive' ? 'sender_not_current_member' : 'membership_evidence_unavailable'
  const conversationKeyHash = conversation.key ? sha256(conversation.key) : null
  const snapshot = {
    ruleVersion: AUTHORITY_RULE_VERSION,
    requestPrincipal: `user:${normalizedPersonId}`,
    conversationPrincipal: conversationKeyHash ? `chat-sha256:${conversationKeyHash}` : null,
    conversationType: conversation.type,
    purpose: normalizedPurpose,
    membershipObservedAt: membership.observedAt,
    expiresAt: membership.expiresAt,
    decision: conversationDecision,
    reasonCode,
    mentionsAffectAuthority: false,
  }
  return {
    snapshot,
    searchScope: {
      chatKey: membershipAllowsChat ? conversation.key : '',
      chatMembershipActive: membershipAllowsChat,
      purpose: normalizedPurpose,
    },
  }
}

export function purposeAllowsResource(resourceAllowedPurposes, purpose) {
  if (resourceAllowedPurposes === null || resourceAllowedPurposes === undefined) return true
  if (!Array.isArray(resourceAllowedPurposes)) return false
  const normalized = resourceAllowedPurposes.map((item) => bounded(item, 64)).filter(Boolean)
  return normalized.includes('*') || normalized.includes(purpose)
}
