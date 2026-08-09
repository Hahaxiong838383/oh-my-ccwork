import { sha256 } from './protocol.mjs'

export const EVIDENCE_PACKAGE_VERSION = '2.0.0'

function iso(value) {
  const date = new Date(value || '')
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function text(value, max = 1600) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
}

function normalizeCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).map(([key, raw]) => [
    text(key, 80),
    Math.max(0, Math.min(1_000_000, Math.trunc(Number(raw) || 0))),
  ]).filter(([key]) => key))
}

function normalizeEvidence(item, nowMs, maxAgeMs) {
  const evidenceId = text(item?.evidenceId || item?.id, 180)
  if (!evidenceId || item?.permissionSnapshot === false) return null
  const updatedAt = iso(item?.updatedAt || item?.observedAt || item?.recordedAt)
  const explicitValidUntil = iso(item?.validUntil)
  const inferredValidUntil = updatedAt ? new Date(new Date(updatedAt).getTime() + maxAgeMs).toISOString() : null
  const validUntil = explicitValidUntil || inferredValidUntil
  const stale = validUntil ? new Date(validUntil).getTime() < nowMs : false
  const contradicts = item?.contradicts === true || item?.supports === false
  return {
    evidenceId,
    source: text(item?.source || 'ontology', 80),
    objectType: text(item?.objectType || 'unknown', 100),
    classification: text(item?.classification || 'internal', 40),
    title: text(item?.title, 300),
    content: text(item?.excerpt || item?.summary || item?.content, 1600),
    sourceReference: text(item?.sourceUrl || item?.sourceReference || item?.externalKey, 500),
    epistemicType: text(item?.epistemicType || 'source_fact', 40),
    updatedAt,
    validUntil,
    freshnessStatus: stale ? 'stale' : updatedAt ? 'fresh' : 'unknown',
    relation: contradicts ? 'contradicts' : 'supports',
    permissionSnapshot: {
      allowed: true,
      policyDecisionReference: text(item?.policyDecisionReference || 'permissioned-retrieval-gateway', 160),
    },
    provenance: {
      sourceSystem: text(item?.source || 'ontology', 80),
      sourceReference: text(item?.externalKey || item?.resourceId || evidenceId, 300),
      recordedAt: updatedAt,
    },
  }
}

export function buildEvidencePackageV2({ caseId, principalId, purpose, ontologyVersion, retrieval, now = () => new Date(), maxAgeDays = 180 } = {}) {
  const rawEvidence = Array.isArray(retrieval) ? retrieval : Array.isArray(retrieval?.evidence) ? retrieval.evidence : []
  const generatedAt = now().toISOString()
  const nowMs = new Date(generatedAt).getTime()
  const maxAgeMs = Math.max(1, Number(maxAgeDays) || 180) * 86_400_000
  const evidence = rawEvidence.map((item) => normalizeEvidence(item, nowMs, maxAgeMs)).filter(Boolean)
  const supportingEvidence = evidence.filter((item) => item.relation === 'supports')
  const contradictingEvidence = evidence.filter((item) => item.relation === 'contradicts')
  const staleCount = evidence.filter((item) => item.freshnessStatus === 'stale').length
  const unknownFreshnessCount = evidence.filter((item) => item.freshnessStatus === 'unknown').length
  const validUntilValues = evidence.map((item) => item.validUntil).filter(Boolean).sort()
  const excludedReasonCounts = normalizeCounts(Array.isArray(retrieval) ? {} : retrieval?.excludedReasonCounts)
  const unknowns = []
  if (evidence.length === 0) unknowns.push({ code: 'no_permissioned_evidence', impact: '无法基于公司资料形成确定性结论' })
  if (staleCount > 0) unknowns.push({ code: 'stale_evidence', impact: '结论可能不反映当前业务状态' })
  if (contradictingEvidence.length > 0) unknowns.push({ code: 'conflicting_evidence', impact: '需要补充验证或人工判断' })
  if (retrieval?.truncated === true) unknowns.push({ code: 'retrieval_truncated', impact: '当前证据覆盖不完整' })
  const packageId = `epv2:${sha256(JSON.stringify({ caseId, generatedAt, ids: evidence.map((item) => item.evidenceId) })).slice(0, 24)}`
  return {
    packageVersion: EVIDENCE_PACKAGE_VERSION,
    packageId,
    caseId,
    principalSnapshot: { principalId, permissionFiltered: true },
    purpose,
    policyDecisionReference: text(retrieval?.policyDecisionReference || 'permissioned-retrieval-gateway', 160),
    ontologyVersion,
    generatedAt,
    validUntil: validUntilValues[0] || null,
    retrievalCoverage: evidence.length === 0 ? 'none' : retrieval?.truncated === true ? 'partial' : 'available',
    facts: evidence.map((item) => ({
      evidenceId: item.evidenceId,
      epistemicType: item.epistemicType,
      statement: item.content || item.title,
      source: item.source,
      sourceReference: item.sourceReference,
      classification: item.classification,
      updatedAt: item.updatedAt,
      validUntil: item.validUntil,
      freshnessStatus: item.freshnessStatus,
      permissionSnapshot: item.permissionSnapshot,
      provenance: item.provenance,
    })),
    supportingEvidence,
    contradictingEvidence,
    assumptions: [],
    unknowns,
    freshnessSummary: {
      fresh: evidence.length - staleCount - unknownFreshnessCount,
      stale: staleCount,
      unknown: unknownFreshnessCount,
    },
    truncationSummary: {
      truncated: retrieval?.truncated === true,
      returned: evidence.length,
      limit: Math.max(evidence.length, Number(retrieval?.limit) || evidence.length),
    },
    excludedReasonCounts,
  }
}

export function assessEvidencePackage(evidencePackage) {
  const evidenceCount = evidencePackage?.facts?.length || 0
  const staleCount = Number(evidencePackage?.freshnessSummary?.stale || 0)
  const conflictCount = evidencePackage?.contradictingEvidence?.length || 0
  const truncated = evidencePackage?.truncationSummary?.truncated === true
  const reasons = []
  if (evidenceCount === 0) reasons.push('no_permissioned_evidence')
  if (staleCount > 0) reasons.push('stale_evidence_present')
  if (conflictCount > 0) reasons.push('contradicting_evidence_present')
  if (truncated) reasons.push('retrieval_truncated')
  const completeness = evidenceCount === 0 ? 'insufficient' : truncated ? 'partial' : 'sufficient'
  const freshnessStatus = evidenceCount === 0
    ? 'unknown'
    : staleCount === 0 ? 'fresh' : staleCount === evidenceCount ? 'stale' : 'mixed'
  const contradictionStatus = conflictCount === 0 ? 'none' : 'conflicting'
  const deterministicConclusionAllowed = evidenceCount > 0 && staleCount === 0 && conflictCount === 0 && !truncated
  const confidenceLevel = evidenceCount === 0
    ? 'insufficient'
    : deterministicConclusionAllowed && evidenceCount >= 3 ? 'high'
      : deterministicConclusionAllowed ? 'medium' : 'low'
  return {
    assessmentVersion: '1.0.0',
    caseId: evidencePackage.caseId,
    evidencePackageId: evidencePackage.packageId,
    completeness,
    freshnessStatus,
    contradictionStatus,
    confidenceLevel,
    deterministicConclusionAllowed,
    reasons,
    validityWindow: { validUntil: evidencePackage.validUntil },
    evidenceReferences: evidencePackage.facts.map((item) => item.evidenceId),
    excludedReasonCounts: evidencePackage.excludedReasonCounts,
    freshnessSummary: evidencePackage.freshnessSummary,
    truncationSummary: evidencePackage.truncationSummary,
  }
}
