import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compileP003ImpactReviewCandidate,
  loadP003ImpactReviewCatalog,
  loadP003ImpactReviewContract,
  validateP003ImpactReviewCatalog,
} from '../src/index.mjs'

test('P003 review pack contains 20-50 unique inactive candidates across six categories', async () => {
  const result = await compileP003ImpactReviewCandidate()
  assert.equal(result.validation.candidateCount, 36)
  assert.equal(Object.keys(result.validation.categoryCounts).length, 6)
  assert.ok(Object.values(result.validation.categoryCounts).every((count) => count === 6))
  assert.equal(result.contract.productionActivationAllowed, false)
})

test('every P003 candidate requires semantic rewrite, evidence and named DRI review', async () => {
  const catalog = await loadP003ImpactReviewCatalog()
  for (const candidate of catalog.candidates) {
    assert.equal(candidate.sourceSemanticQuality, 'generated_generic_requires_rewrite')
    assert.deepEqual(candidate.evidence, { support: [], challenge: [] })
    assert.equal(candidate.proposedReview.namedIndividualDri, null)
    assert.equal(candidate.state.generationStatus, 'generated_draft')
    assert.equal(candidate.state.verificationStatus, 'unverified')
    assert.equal(candidate.state.activationStatus, 'inactive')
    assert.equal(candidate.state.reviewStatus, 'pending_dri_review')
    assert.ok(Object.values(candidate.reviewChecklist).every((value) => value === false))
  }
})

test('P003 pack covers all required functional DRI roles without inventing people', async () => {
  const result = await compileP003ImpactReviewCandidate()
  for (const role of result.contract.requiredDriRolesAcrossPack) assert.ok(result.validation.driRoles.includes(role))
  assert.ok(result.catalog.candidates.every((candidate) => candidate.proposedReview.namedIndividualDri === null))
})

test('P003 review validator rejects activation, evidence fabrication and duplicate source rows', async () => {
  const contract = await loadP003ImpactReviewContract()
  const catalog = await loadP003ImpactReviewCatalog()
  const invalid = structuredClone(catalog)
  invalid.candidates[0].state.activationStatus = 'active'
  invalid.candidates[0].evidence.support.push('fabricated-evidence')
  invalid.candidates[1].source.recordId = invalid.candidates[0].source.recordId
  const validation = validateP003ImpactReviewCatalog(invalid, contract)
  assert.equal(validation.ok, false)
  assert.ok(validation.errors.some((error) => error.includes('activationStatus')))
  assert.ok(validation.errors.some((error) => error.includes('evidence must be empty')))
  assert.ok(validation.errors.some((error) => error.includes('recordId duplicate')))
})

test('P003 review source remains a 4644-row Feishu snapshot with stable hashes', async () => {
  const result = await compileP003ImpactReviewCandidate()
  assert.equal(result.catalog.source.recordCount, 4644)
  assert.match(result.catalog.source.snapshotHash, /^[0-9a-f]{64}$/)
  assert.match(result.validation.contentHash, /^[0-9a-f]{64}$/)
  assert.ok(result.catalog.candidates.every((candidate) => /^[0-9a-f]{64}$/.test(candidate.source.rowHash)))
})
