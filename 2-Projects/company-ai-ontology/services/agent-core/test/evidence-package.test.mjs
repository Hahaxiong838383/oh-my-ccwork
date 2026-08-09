import test from 'node:test'
import assert from 'node:assert/strict'

import { assessEvidencePackage, buildEvidencePackageV2 } from '../src/evidence-package.mjs'

const now = () => new Date('2026-08-09T02:00:00Z')

test('Evidence Package v2 区分支持、反证、过期与权限快照', () => {
  const evidencePackage = buildEvidencePackageV2({
    caseId: 'case-001', principalId: 'person-001', purpose: 'analysis', ontologyVersion: '3.1.0', now,
    retrieval: {
      evidence: [
        { evidenceId: 'erp:1', source: 'aishike-erp-fixture', title: '订单完成', excerpt: '订单已完成', updatedAt: '2026-08-08T10:00:00Z', validUntil: '2026-08-10T10:00:00Z', permissionSnapshot: true },
        { evidenceId: 'market:1', source: 'social-monitor-fixture', title: '负面反馈', excerpt: '用户反馈未改善', updatedAt: '2026-07-01T10:00:00Z', validUntil: '2026-07-02T10:00:00Z', permissionSnapshot: true, contradicts: true },
      ],
      excludedReasonCounts: { permission_denied: 3 },
    },
  })
  assert.equal(evidencePackage.packageVersion, '2.0.0')
  assert.equal(evidencePackage.supportingEvidence.length, 1)
  assert.equal(evidencePackage.contradictingEvidence.length, 1)
  assert.equal(evidencePackage.freshnessSummary.stale, 1)
  assert.equal(evidencePackage.excludedReasonCounts.permission_denied, 3)
  assert.equal(evidencePackage.facts.every((fact) => fact.permissionSnapshot.allowed === true), true)
  const assessment = assessEvidencePackage(evidencePackage)
  assert.equal(assessment.deterministicConclusionAllowed, false)
  assert.equal(assessment.confidenceLevel, 'low')
})

test('无权限员工 Evidence 为 0 且包内无资源元数据', () => {
  const evidencePackage = buildEvidencePackageV2({
    caseId: 'case-denied', principalId: 'person-denied', purpose: 'query', ontologyVersion: '3.1.0', now,
    retrieval: { evidence: [], excludedReasonCounts: { permission_denied: 7 } },
  })
  assert.equal(evidencePackage.facts.length, 0)
  assert.equal(evidencePackage.supportingEvidence.length, 0)
  assert.equal(evidencePackage.contradictingEvidence.length, 0)
  assert.doesNotMatch(JSON.stringify(evidencePackage), /机密标题|https?:\/\/|某某员工/)
  const assessment = assessEvidencePackage(evidencePackage)
  assert.equal(assessment.confidenceLevel, 'insufficient')
  assert.equal(assessment.deterministicConclusionAllowed, false)
})
