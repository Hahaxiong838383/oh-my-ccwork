import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compileP003HumanReviewResults,
  compileShadowSourceRegistry,
  createP003ReviewWorkbook,
  createSourceApprovalWorkbook,
  inspectP003ReviewAssignments,
  inspectP003ReviewProgress,
  inspectSourceReviewAssignments,
  inspectSourceReviewProgress,
  loadP003ReviewContext,
  loadSourceApprovalContext,
  p003ReviewWorkbookFromCsv,
  p003ReviewWorkbookCsv,
  sourceApprovalWorkbookFromCsv,
  sourceApprovalWorkbookCsv,
  validateP003ReviewWorkbook,
  validateSourceApprovalWorkbook,
} from '../src/index.mjs'
import { parseCsv, rowsToCsv } from '../src/review-csv.mjs'

const REVIEWED_AT = '2026-08-10T09:00:00Z'

function principal(role, index = 1) {
  return {
    role,
    displayName: `${role}-reviewer-${index}`,
    principalRef: `company-directory:${role.replaceAll('_', '-')}-${index}`,
    decision: 'approve',
  }
}

function finalizeSourceWorkbook(workbook) {
  for (const review of workbook.reviews) {
    review.decision = 'keep_paused'
    review.approvedAt = REVIEWED_AT
    review.decisionReason = '公司尚未批准该来源进入 Shadow。'
    review.namedComplianceDri = principal('compliance')
  }
  return workbook
}

function approveSource(review) {
  review.decision = 'approve_for_shadow'
  review.licenseDecision = 'approved'
  review.complianceDecision = 'approved'
  review.approvedStorageLevel = review.candidateStorageLevel
  review.approvedRetentionDays = review.candidateRetentionDays
  review.licenseEvidenceRefs = [review.candidateLicenseEvidenceRef]
  review.complianceEvidenceRefs = ['feishu:doc/company-source-approval']
  review.namedLicenseReviewer = principal('license')
  review.namedComplianceDri = principal('compliance')
  review.approvedAt = REVIEWED_AT
  review.decisionReason = '批准仅用于 PUBLISH=false Shadow。'
}

function finalizeP003Workbook(workbook) {
  for (const review of workbook.reviews) {
    review.decision = 'keep_inactive'
    review.reviewedAt = REVIEWED_AT
    review.decisionReason = '暂不进入激活提案。'
    review.reviewParticipants = [principal(review.proposedDriRoles[0] || 'product')]
  }
  return workbook
}

function approveP003(review) {
  review.decision = 'approve_for_activation_proposal'
  review.semanticRewrite = '当该外部因素在目标客户、目标区域与当前产品版本同时成立时，它会通过需求优先级、研发资源和商业验证节奏影响该 GoalFacet；团队应先监测指标变化，再由 DRI 判断是否提出调整方案。'
  review.direction = 'mixed'
  review.strength = 'medium'
  review.expectedLagValue = 6
  review.expectedLagUnit = 'months'
  review.applicabilityConditions = ['P003 当前产品定义仍处于可调整窗口', '存在可复核的市场或经营指标']
  review.activationConditions = ['支持和反证完成联合审核，且验证指标已有可复核基线']
  review.pauseConditions = ['来源被撤销、证据过期冲突或关键验证指标连续不可用']
  review.invalidationConditions = ['真实指标确认不存在预期传导，或 P003 产品范围发生实质变化']
  review.supportEvidence = [{ evidenceRef: 'feishu:doc/p003-support-evidence', note: '支持证据索引' }]
  review.challengeEvidence = [{ evidenceRef: 'feishu:doc/p003-challenge-evidence', note: '反证索引' }]
  review.validationMetrics = [{
    metricKey: review.candidateValidationMetrics[0],
    baseline: 0,
    threshold: 0.1,
    observationWindowDays: 90,
  }]
  review.namedIndividualDri = principal('product', 9)
  review.reviewParticipants = review.proposedDriRoles.map((role, index) => principal(role, index + 1))
  review.reviewedAt = REVIEWED_AT
  review.decisionReason = '满足进入独立 Ontology Change Proposal 的最低审核条件。'
  for (const key of Object.keys(review.reviewChecklist)) review.reviewChecklist[key] = true
}

test('source approval template covers all sources and remains fail-closed', async () => {
  const { catalog, approvalContract } = await loadSourceApprovalContext()
  const workbook = createSourceApprovalWorkbook(catalog)
  const validation = validateSourceApprovalWorkbook(workbook, catalog, approvalContract)
  assert.equal(validation.ok, true)
  assert.equal(validation.reviewCount, 8)
  assert.equal(validation.finalDecisionCount, 0)
  assert.ok(workbook.reviews.every((review) => review.decision === 'pending'))
  assert.match(sourceApprovalWorkbookCsv(workbook), /^\uFEFF"sourceKey"/)
  assert.equal(validateSourceApprovalWorkbook(workbook, catalog, approvalContract, { requireFinal: true }).ok, false)
})

test('source assignment inspection accepts structured pending principals and leaks no identity', async () => {
  const { catalog } = await loadSourceApprovalContext()
  const workbook = createSourceApprovalWorkbook(catalog)
  for (const review of workbook.reviews) {
    review.namedLicenseReviewer = { ...principal('license'), decision: 'pending' }
    review.namedComplianceDri = { ...principal('compliance'), decision: 'pending' }
  }
  const inspection = inspectSourceReviewAssignments(workbook)
  assert.equal(inspection.assignmentReady, true)
  assert.equal(inspection.fullyAssignedReviewCount, 8)
  assert.equal(inspection.missingLicenseReviewerCount, 0)
  const output = JSON.stringify(inspection)
  assert.doesNotMatch(output, /company-directory:/)
  assert.doesNotMatch(output, /reviewer-/)
})

test('source assignment inspection rejects name strings without exposing them', async () => {
  const { catalog } = await loadSourceApprovalContext()
  const workbook = createSourceApprovalWorkbook(catalog)
  workbook.reviews[0].namedLicenseReviewer = 'named reviewer'
  const inspection = inspectSourceReviewAssignments(workbook)
  assert.equal(inspection.assignmentReady, false)
  assert.equal(inspection.invalidLicenseReviewerCount, 1)
  assert.doesNotMatch(JSON.stringify(inspection), /named reviewer/)
})

test('source progress inspection reports final readiness without identity or evidence leakage', async () => {
  const { catalog, approvalContract } = await loadSourceApprovalContext()
  const pending = createSourceApprovalWorkbook(catalog)
  pending.reviews[0].namedLicenseReviewer = { ...principal('license'), decision: 'pending' }
  pending.reviews[0].namedComplianceDri = { ...principal('compliance'), decision: 'pending' }
  const pendingProgress = inspectSourceReviewProgress(pending, catalog, approvalContract)
  assert.equal(pendingProgress.reviewReady, false)
  assert.equal(pendingProgress.pendingCount, 8)
  assert.equal(pendingProgress.finalDecisionCount, 0)
  assert.equal(pendingProgress.finalValidationOk, false)
  assert.doesNotMatch(JSON.stringify(pendingProgress), /company-directory:/)
  assert.doesNotMatch(JSON.stringify(pendingProgress), /reviewer-/)

  const completed = finalizeSourceWorkbook(createSourceApprovalWorkbook(catalog))
  const completedProgress = inspectSourceReviewProgress(completed, catalog, approvalContract)
  assert.equal(completedProgress.reviewReady, true)
  assert.equal(completedProgress.pendingCount, 0)
  assert.equal(completedProgress.finalDecisionCount, 8)
  assert.equal(completedProgress.decisionCounts.keep_paused, 8)
  assert.equal(completedProgress.finalValidationErrorCount, 0)
})

test('CSV parser preserves quoted content and ignores trailing blank records', () => {
  const parsed = parseCsv('\uFEFF"key","value"\r\n"a","line 1\nline 2, with ""quote"""\r\n\r\n')
  assert.deepEqual(parsed.headers, ['key', 'value'])
  assert.deepEqual(parsed.rows, [{ key: 'a', value: 'line 1\nline 2, with "quote"' }])
  assert.throws(() => parseCsv('"key"\n"unterminated'), /unterminated quoted CSV field/)
})

test('source approval CSV round trip preserves typed reviews and final validation', async () => {
  const { sourceContract, catalog, approvalContract } = await loadSourceApprovalContext()
  const original = finalizeSourceWorkbook(createSourceApprovalWorkbook(catalog))
  approveSource(original.reviews[0])
  const imported = sourceApprovalWorkbookFromCsv(sourceApprovalWorkbookCsv(original), catalog, { generatedAt: original.generatedAt })
  assert.deepEqual(imported.reviews, original.reviews)
  const compiled = compileShadowSourceRegistry(imported, catalog, sourceContract, approvalContract)
  assert.equal(compiled.workbookValidation.ok, true)
  assert.equal(compiled.policyDecisions.filter((decision) => decision.allowed).length, 1)
})

test('source approval CSV import exposes immutable-field tampering', async () => {
  const { catalog, approvalContract } = await loadSourceApprovalContext()
  const workbook = createSourceApprovalWorkbook(catalog)
  workbook.reviews[0].sourceName = 'tampered source name'
  const imported = sourceApprovalWorkbookFromCsv(sourceApprovalWorkbookCsv(workbook), catalog)
  const validation = validateSourceApprovalWorkbook(imported, catalog, approvalContract)
  assert.equal(validation.ok, false)
  assert.ok(validation.errors.some((error) => error.includes('sourceName mismatch')))
})

test('source approval compilation enables only explicitly approved Shadow sources', async () => {
  const { sourceContract, catalog, approvalContract } = await loadSourceApprovalContext()
  const workbook = finalizeSourceWorkbook(createSourceApprovalWorkbook(catalog))
  approveSource(workbook.reviews[0])
  const compiled = compileShadowSourceRegistry(workbook, catalog, sourceContract, approvalContract)
  assert.equal(compiled.workbookValidation.ok, true)
  assert.equal(compiled.registryValidation.ok, true)
  assert.equal(compiled.registry.status, 'shadow_reviewed')
  assert.equal(compiled.policyDecisions.filter((decision) => decision.allowed).length, 1)
  assert.equal(compiled.policyDecisions.filter((decision) => !decision.allowed).length, 7)
  assert.equal(compiled.registry.entries[0].lifecycleStatus, 'enabled')
  assert.ok(compiled.registry.entries.slice(1).every((entry) => entry.lifecycleStatus === 'paused'))
})

test('source approval rejects missing evidence and retention escalation', async () => {
  const { catalog, approvalContract } = await loadSourceApprovalContext()
  const workbook = finalizeSourceWorkbook(createSourceApprovalWorkbook(catalog))
  approveSource(workbook.reviews[0])
  workbook.reviews[0].licenseEvidenceRefs = []
  workbook.reviews[0].approvedStorageLevel = 'full_text'
  const validation = validateSourceApprovalWorkbook(workbook, catalog, approvalContract, { requireFinal: true })
  assert.equal(validation.ok, false)
  assert.ok(validation.errors.some((error) => error.includes('licenseEvidenceRefs invalid')))
  assert.ok(validation.errors.some((error) => error.includes('approvedStorageLevel exceeds candidate')))
  assert.ok(validation.errors.some((error) => error.includes('full_text requires a separate change proposal')))
})

test('P003 review template covers all candidates without activation', async () => {
  const { catalog, reviewContract } = await loadP003ReviewContext()
  const workbook = createP003ReviewWorkbook(catalog)
  const validation = validateP003ReviewWorkbook(workbook, catalog, reviewContract)
  assert.equal(validation.ok, true)
  assert.equal(validation.reviewCount, 36)
  assert.equal(validation.approvalProposalCount, 0)
  assert.ok(workbook.reviews.every((review) => review.activationStatus === 'inactive'))
  assert.match(p003ReviewWorkbookCsv(workbook), /^\uFEFF"candidateKey"/)
  assert.equal(validateP003ReviewWorkbook(workbook, catalog, reviewContract, { requireFinal: true }).ok, false)
})

test('P003 assignment inspection counts pending principals and role gaps without identity data', async () => {
  const { catalog } = await loadP003ReviewContext()
  const workbook = createP003ReviewWorkbook(catalog)
  for (const review of workbook.reviews) {
    review.namedIndividualDri = { ...principal(review.proposedDriRoles[0]), decision: 'pending' }
    review.reviewParticipants = review.proposedDriRoles.map((role, index) => ({
      ...principal(role, index + 1),
      decision: 'pending',
    }))
  }
  workbook.reviews[0].reviewParticipants = workbook.reviews[0].reviewParticipants.filter((participant) => participant.role !== workbook.reviews[0].proposedDriRoles.at(-1))
  const inspection = inspectP003ReviewAssignments(workbook)
  assert.equal(inspection.assignmentReady, false)
  assert.equal(inspection.individualDriAssignedCount, 36)
  assert.equal(inspection.missingRoleAssignmentCount, 1)
  assert.equal(inspection.reviewsMissingRequiredRoles, 1)
  assert.ok(inspection.categoryCoverage.some((category) => category.missingRoles.length === 1))
  const output = JSON.stringify(inspection)
  assert.doesNotMatch(output, /company-directory:/)
  assert.doesNotMatch(output, /reviewer-/)
})

test('P003 assignment inspection rejects string principals and reports category gaps', async () => {
  const { catalog } = await loadP003ReviewContext()
  const workbook = createP003ReviewWorkbook(catalog)
  workbook.reviews[0].namedIndividualDri = 'named reviewer'
  workbook.reviews[0].reviewParticipants = ['named reviewer']
  const inspection = inspectP003ReviewAssignments(workbook)
  assert.equal(inspection.assignmentReady, false)
  assert.equal(inspection.invalidIndividualDriCount, 1)
  assert.equal(inspection.invalidParticipantCount, 1)
  assert.ok(inspection.categoryCoverage.some((category) => category.reviewsMissingRequiredRoles > 0))
  assert.doesNotMatch(JSON.stringify(inspection), /named reviewer/)
})

test('P003 progress inspection reports category completion without identity or review text leakage', async () => {
  const { catalog, reviewContract } = await loadP003ReviewContext()
  const pending = createP003ReviewWorkbook(catalog)
  pending.reviews[0].namedIndividualDri = { ...principal('product'), decision: 'pending' }
  pending.reviews[0].reviewParticipants = [{ ...principal('product'), decision: 'pending' }]
  pending.reviews[0].semanticRewrite = 'private review text that must not appear in progress output'
  const pendingProgress = inspectP003ReviewProgress(pending, catalog, reviewContract)
  assert.equal(pendingProgress.reviewReady, false)
  assert.equal(pendingProgress.pendingCount, 36)
  assert.equal(pendingProgress.semanticRewriteRecordedCount, 1)
  assert.equal(pendingProgress.finalValidationOk, false)
  const pendingOutput = JSON.stringify(pendingProgress)
  assert.doesNotMatch(pendingOutput, /company-directory:/)
  assert.doesNotMatch(pendingOutput, /reviewer-/)
  assert.doesNotMatch(pendingOutput, /private review text/)

  const completed = finalizeP003Workbook(createP003ReviewWorkbook(catalog))
  const completedProgress = inspectP003ReviewProgress(completed, catalog, reviewContract)
  assert.equal(completedProgress.reviewReady, true)
  assert.equal(completedProgress.pendingCount, 0)
  assert.equal(completedProgress.finalDecisionCount, 36)
  assert.equal(completedProgress.decisionCounts.keep_inactive, 36)
  assert.equal(completedProgress.finalValidationErrorCount, 0)
})

test('P003 review CSV round trip preserves typed reviews without activation', async () => {
  const { catalog, reviewContract } = await loadP003ReviewContext()
  const original = finalizeP003Workbook(createP003ReviewWorkbook(catalog))
  approveP003(original.reviews[0])
  const csv = p003ReviewWorkbookCsv(original)
  assert.match(csv, /"reviewChecklist"/)
  const imported = p003ReviewWorkbookFromCsv(csv, catalog, { generatedAt: original.generatedAt })
  assert.deepEqual(imported.reviews, original.reviews)
  const compiled = compileP003HumanReviewResults(imported, catalog, reviewContract)
  assert.equal(compiled.validation.ok, true)
  assert.equal(compiled.validation.approvalProposalCount, 1)
  assert.ok(compiled.results.results.every((result) => result.activationStatus === 'inactive'))
})

test('P003 review CSV import normalizes Feishu SingleSelect cells', async () => {
  const { catalog, reviewContract } = await loadP003ReviewContext()
  const workbook = createP003ReviewWorkbook(catalog)
  const { headers, rows } = parseCsv(p003ReviewWorkbookCsv(workbook))
  rows[0].categoryKey = JSON.stringify([rows[0].categoryKey])
  const imported = p003ReviewWorkbookFromCsv(rowsToCsv(headers, rows), catalog)
  assert.equal(imported.reviews[0].categoryKey, workbook.reviews[0].categoryKey)
  assert.equal(validateP003ReviewWorkbook(imported, catalog, reviewContract).ok, true)

  rows[0].categoryKey = JSON.stringify([workbook.reviews[0].categoryKey, workbook.reviews[1].categoryKey])
  assert.throws(
    () => p003ReviewWorkbookFromCsv(rowsToCsv(headers, rows), catalog),
    /categoryKey must contain exactly one selected option/,
  )
})

test('P003 review CSV import rejects immutable candidate tampering and malformed JSON', async () => {
  const { catalog, reviewContract } = await loadP003ReviewContext()
  const workbook = createP003ReviewWorkbook(catalog)
  workbook.reviews[0].sourceRowHash = '0'.repeat(64)
  const imported = p003ReviewWorkbookFromCsv(p003ReviewWorkbookCsv(workbook), catalog)
  const validation = validateP003ReviewWorkbook(imported, catalog, reviewContract)
  assert.equal(validation.ok, false)
  assert.ok(validation.errors.some((error) => error.includes('sourceRowHash mismatch')))

  const malformed = p003ReviewWorkbookCsv(createP003ReviewWorkbook(catalog)).replace('"[]"', '"not-json"')
  assert.throws(() => p003ReviewWorkbookFromCsv(malformed, catalog), /must contain valid JSON/)
})

test('P003 review compilation produces proposals but never activates relations', async () => {
  const { catalog, reviewContract } = await loadP003ReviewContext()
  const workbook = finalizeP003Workbook(createP003ReviewWorkbook(catalog))
  approveP003(workbook.reviews[0])
  const compiled = compileP003HumanReviewResults(workbook, catalog, reviewContract)
  assert.equal(compiled.validation.ok, true)
  assert.equal(compiled.validation.approvalProposalCount, 1)
  assert.equal(compiled.results.productionActivationAllowed, false)
  assert.equal(compiled.results.formalP2Allowed, false)
  assert.equal(compiled.results.employeeDeliveryAllowed, false)
  assert.ok(compiled.results.results.every((result) => result.activationStatus === 'inactive'))
  assert.equal(compiled.results.results[0].eligibleForActivationProposal, true)
  assert.deepEqual(compiled.results.results[0].externalFactor, {
    primaryDimension: workbook.reviews[0].primaryDimension,
    secondaryDimension: workbook.reviews[0].secondaryDimension,
  })
  assert.equal(compiled.results.results[0].targetGoalFacet.label, workbook.reviews[0].targetGoalFacetLabel)
  assert.deepEqual(compiled.results.results[0].activationConditions, workbook.reviews[0].activationConditions)
  assert.deepEqual(compiled.results.results[0].pauseConditions, workbook.reviews[0].pauseConditions)
  assert.deepEqual(compiled.results.results[0].invalidationConditions, workbook.reviews[0].invalidationConditions)
})

test('P003 review rejects generic rewrites, missing counterevidence and source drift', async () => {
  const { catalog, reviewContract } = await loadP003ReviewContext()
  const workbook = finalizeP003Workbook(createP003ReviewWorkbook(catalog))
  approveP003(workbook.reviews[0])
  workbook.reviews[0].semanticRewrite = workbook.reviews[0].generatedLogic
  workbook.reviews[0].challengeEvidence = []
  workbook.reviews[0].activationConditions = []
  workbook.reviews[0].invalidationConditions = []
  workbook.reviews[0].sourceRowHash = '0'.repeat(64)
  const validation = validateP003ReviewWorkbook(workbook, catalog, reviewContract, { requireFinal: true })
  assert.equal(validation.ok, false)
  assert.ok(validation.errors.some((error) => error.includes('sourceRowHash mismatch')))
  assert.ok(validation.errors.some((error) => error.includes('semanticRewrite remains generic')))
  assert.ok(validation.errors.some((error) => error.includes('challengeEvidence invalid')))
  assert.ok(validation.errors.some((error) => error.includes('activationConditions missing')))
  assert.ok(validation.errors.some((error) => error.includes('invalidationConditions missing')))
})
