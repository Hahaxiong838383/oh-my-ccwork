import test from 'node:test'
import assert from 'node:assert/strict'

import { assessEvidencePackage, buildEvidencePackageV2 } from '../src/evidence-package.mjs'
import { validateStructuredResponse } from '../src/response-validator.mjs'
import {
  ERP_FRESH_SUPPORT_FIXTURE,
  ERP_STALE_FIXTURE,
  SOCIAL_CONTRADICTION_FIXTURE,
  UNAUTHORIZED_RETRIEVAL_FIXTURE,
} from './fixtures/company-brain-evidence.mjs'

const now = () => new Date('2026-08-09T02:00:00Z')

function packageFor(evidence) {
  return buildEvidencePackageV2({
    caseId: 'fixture-case',
    principalId: 'fixture-person',
    purpose: 'fixture-validation',
    ontologyVersion: '3.1.0',
    retrieval: { evidence, excludedReasonCounts: {}, limit: 8, truncated: false },
    now,
  })
}

test('ERP 支持证据与社媒反证同时存在时阻止确定性结论', () => {
  const evidencePackage = packageFor([ERP_FRESH_SUPPORT_FIXTURE, SOCIAL_CONTRADICTION_FIXTURE])
  const assessment = assessEvidencePackage(evidencePackage)
  const validation = validateStructuredResponse({
    evidencePackage,
    assessment,
    rawResponse: JSON.stringify({
      conclusion: '目标已经确定达成。', factBasis: ['ERP 已完成'], derivedSummary: '忽略反证', assumptions: [], contradictions: [], unknowns: [],
      confidenceLevel: 'high', validityWindow: { validUntil: evidencePackage.validUntil }, recommendedNextAction: '直接推广', approvalRequired: false,
      evidenceReferences: [ERP_FRESH_SUPPORT_FIXTURE.evidenceId],
    }),
  })
  assert.equal(assessment.deterministicConclusionAllowed, false)
  assert.equal(validation.status, 'fallback')
  assert.match(validation.response.conclusion, /证据存在冲突/)
})

test('过期 ERP fixture 不能形成 medium/high 结论', () => {
  const evidencePackage = packageFor([ERP_STALE_FIXTURE])
  const assessment = assessEvidencePackage(evidencePackage)
  assert.equal(assessment.freshnessStatus, 'stale')
  assert.equal(assessment.confidenceLevel, 'low')
  assert.equal(assessment.deterministicConclusionAllowed, false)
})

test('无权限 fixture 仅保留聚合计数，不包含标题、人员、URL 或正文', () => {
  const evidencePackage = buildEvidencePackageV2({
    caseId: 'fixture-denied', principalId: 'fixture-person', purpose: 'fixture-validation', ontologyVersion: '3.1.0',
    retrieval: UNAUTHORIZED_RETRIEVAL_FIXTURE, now,
  })
  const serialized = JSON.stringify(evidencePackage)
  assert.equal(evidencePackage.facts.length, 0)
  assert.equal(evidencePackage.excludedReasonCounts.permission_denied, 4)
  assert.doesNotMatch(serialized, /title|sourceUrl|displayName|excerpt|机密正文/)
})
