import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { contentHash } from './canonical.mjs'
import { loadP003ImpactReviewCatalog, p003ReviewHash } from './p003-impact-review.mjs'
import {
  assertCsvHeaders,
  nullableString,
  parseCsv,
  parseJsonCell,
  parseNullableInteger,
  parseNullableNumber,
  rowsToCsv,
} from './review-csv.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REVIEW_CONTRACT_FILE = path.join(PACKAGE_ROOT, 'contracts/p003-impact-review-submission-v1.json')
const REVIEW_WORKBOOK_FILE = path.join(PACKAGE_ROOT, 'templates/reviews/p003-impact-review-template-v1.json')
const GENERIC_LOGIC_RE = /目标直接影响企业长期战略目标|O1目的|灵魂优先原则/
const P003_REVIEW_CSV_HEADERS = [
  'candidateKey',
  'sourceRowHash',
  'categoryKey',
  'categoryName',
  'primaryDimension',
  'secondaryDimension',
  'targetGoalFacetLabel',
  'generatedLogic',
  'sourcePreview',
  'proposedDriRoles',
  'candidateValidationMetrics',
  'decision',
  'semanticRewrite',
  'direction',
  'strength',
  'expectedLagValue',
  'expectedLagUnit',
  'applicabilityConditions',
  'activationConditions',
  'pauseConditions',
  'invalidationConditions',
  'supportEvidence',
  'challengeEvidence',
  'validationMetrics',
  'namedIndividualDri',
  'reviewParticipants',
  'reviewedAt',
  'decisionReason',
  'activationStatus',
  'reviewChecklist',
]

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function namedPrincipal(value) {
  return Boolean(
    value
    && typeof value.displayName === 'string'
    && value.displayName.trim().length >= 2
    && typeof value.principalRef === 'string'
    && /^company-directory:[A-Za-z0-9._-]+$/.test(value.principalRef),
  )
}

function evidenceRefs(values) {
  return Array.isArray(values)
    && values.length > 0
    && values.every((value) => value && typeof value.evidenceRef === 'string' && /^(https:\/\/|feishu:|ontology:|git:)[^\s]+$/.test(value.evidenceRef))
}

function participantRoles(review) {
  return new Set((review.reviewParticipants || []).filter((participant) => participant.decision === 'approve').map((participant) => participant.role))
}

export async function loadP003ReviewSubmissionContract(file = REVIEW_CONTRACT_FILE) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

export async function loadP003ReviewWorkbook(file = REVIEW_WORKBOOK_FILE) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

export function createP003ReviewWorkbook(catalog, generatedAt = '2026-08-10T00:00:00Z') {
  return {
    workbookVersion: '1.0.0-template.1',
    reviewType: 'p003-impact-dri-review',
    productLineKey: catalog.productLineKey,
    candidateCatalogHash: p003ReviewHash(catalog),
    sourceSnapshotHash: catalog.source.snapshotHash,
    status: 'pending_human_review',
    generatedAt,
    productionActivationAllowed: false,
    formalP2Allowed: false,
    employeeDeliveryAllowed: false,
    reviews: catalog.candidates.map((candidate) => ({
      candidateKey: candidate.candidateKey,
      sourceRowHash: candidate.source.rowHash,
      categoryKey: candidate.categoryKey,
      categoryName: candidate.categoryName,
      primaryDimension: candidate.source.primaryDimension,
      secondaryDimension: candidate.source.secondaryDimension,
      targetGoalFacetLabel: candidate.source.targetGoalFacetLabel,
      generatedLogic: candidate.source.generatedLogic,
      sourcePreview: candidate.goalFacet.sourcePreview,
      proposedDriRoles: [...candidate.proposedReview.driRoles],
      candidateValidationMetrics: [...candidate.validationMetrics],
      decision: 'pending',
      semanticRewrite: null,
      direction: null,
      strength: null,
      expectedLagValue: null,
      expectedLagUnit: null,
      applicabilityConditions: [],
      activationConditions: [],
      pauseConditions: [],
      invalidationConditions: [],
      supportEvidence: [],
      challengeEvidence: [],
      validationMetrics: [],
      namedIndividualDri: null,
      reviewParticipants: [],
      reviewedAt: null,
      decisionReason: null,
      activationStatus: 'inactive',
      reviewChecklist: {
        semanticRewriteAccepted: false,
        applicabilityConditionsAccepted: false,
        directionStrengthLagAccepted: false,
        supportEvidenceAccepted: false,
        challengeEvidenceAccepted: false,
        validationMetricAccepted: false,
        namedDriAccepted: false,
        activationDecisionAccepted: false,
      },
    })),
  }
}

export function p003ReviewWorkbookCsv(workbook) {
  return rowsToCsv(P003_REVIEW_CSV_HEADERS, workbook.reviews)
}

function jsonArray(value, fieldName) {
  const parsed = parseJsonCell(value, fieldName, { emptyValue: [] })
  if (!Array.isArray(parsed)) throw new Error(`${fieldName} must contain a JSON array`)
  return parsed
}

function jsonObjectOrNull(value, fieldName) {
  const parsed = parseJsonCell(value, fieldName)
  if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new Error(`${fieldName} must contain a JSON object or be blank`)
  }
  return parsed
}

export function p003ReviewWorkbookFromCsv(input, catalog, options = {}) {
  const { headers, rows } = parseCsv(input)
  assertCsvHeaders(headers, P003_REVIEW_CSV_HEADERS)
  const workbook = createP003ReviewWorkbook(catalog, options.generatedAt)
  workbook.status = 'imported_human_review'
  workbook.reviews = rows.map((row, index) => {
    const prefix = `CSV row ${index + 2}`
    return {
      candidateKey: row.candidateKey,
      sourceRowHash: row.sourceRowHash,
      categoryKey: row.categoryKey,
      categoryName: row.categoryName,
      primaryDimension: row.primaryDimension,
      secondaryDimension: row.secondaryDimension,
      targetGoalFacetLabel: row.targetGoalFacetLabel,
      generatedLogic: row.generatedLogic,
      sourcePreview: row.sourcePreview,
      proposedDriRoles: jsonArray(row.proposedDriRoles, `${prefix}.proposedDriRoles`),
      candidateValidationMetrics: jsonArray(row.candidateValidationMetrics, `${prefix}.candidateValidationMetrics`),
      decision: row.decision,
      semanticRewrite: nullableString(row.semanticRewrite),
      direction: nullableString(row.direction),
      strength: nullableString(row.strength),
      expectedLagValue: parseNullableNumber(row.expectedLagValue, `${prefix}.expectedLagValue`),
      expectedLagUnit: nullableString(row.expectedLagUnit),
      applicabilityConditions: jsonArray(row.applicabilityConditions, `${prefix}.applicabilityConditions`),
      activationConditions: jsonArray(row.activationConditions, `${prefix}.activationConditions`),
      pauseConditions: jsonArray(row.pauseConditions, `${prefix}.pauseConditions`),
      invalidationConditions: jsonArray(row.invalidationConditions, `${prefix}.invalidationConditions`),
      supportEvidence: jsonArray(row.supportEvidence, `${prefix}.supportEvidence`),
      challengeEvidence: jsonArray(row.challengeEvidence, `${prefix}.challengeEvidence`),
      validationMetrics: jsonArray(row.validationMetrics, `${prefix}.validationMetrics`),
      namedIndividualDri: jsonObjectOrNull(row.namedIndividualDri, `${prefix}.namedIndividualDri`),
      reviewParticipants: jsonArray(row.reviewParticipants, `${prefix}.reviewParticipants`),
      reviewedAt: nullableString(row.reviewedAt),
      decisionReason: nullableString(row.decisionReason),
      activationStatus: row.activationStatus,
      reviewChecklist: jsonObjectOrNull(row.reviewChecklist, `${prefix}.reviewChecklist`),
    }
  })
  return workbook
}

export function validateP003ReviewWorkbook(workbook, catalog, reviewContract, options = {}) {
  const errors = []
  const requireFinal = options.requireFinal === true
  if (workbook?.reviewType !== reviewContract.reviewType) errors.push('reviewType mismatch')
  if (workbook?.productLineKey !== catalog.productLineKey) errors.push('productLineKey mismatch')
  if (workbook?.candidateCatalogHash !== p003ReviewHash(catalog)) errors.push('candidateCatalogHash mismatch')
  if (workbook?.sourceSnapshotHash !== catalog.source.snapshotHash) errors.push('sourceSnapshotHash mismatch')
  if (workbook?.productionActivationAllowed !== false) errors.push('productionActivationAllowed must remain false')
  if (workbook?.formalP2Allowed !== false) errors.push('formalP2Allowed must remain false')
  if (workbook?.employeeDeliveryAllowed !== false) errors.push('employeeDeliveryAllowed must remain false')
  const reviews = Array.isArray(workbook?.reviews) ? workbook.reviews : []
  const expectedKeys = new Set(catalog.candidates.map((candidate) => candidate.candidateKey))
  const seenKeys = new Set()
  for (const [index, review] of reviews.entries()) {
    const prefix = `reviews[${index}]`
    const candidate = catalog.candidates.find((entry) => entry.candidateKey === review.candidateKey)
    if (!candidate) errors.push(`${prefix}.candidateKey unknown`)
    if (seenKeys.has(review.candidateKey)) errors.push(`${prefix}.candidateKey duplicate`)
    seenKeys.add(review.candidateKey)
    if (!reviewContract.allowedDecisions.includes(review.decision)) errors.push(`${prefix}.decision invalid`)
    if (requireFinal && !reviewContract.finalDecisions.includes(review.decision)) errors.push(`${prefix}.decision must be final`)
    if (!candidate) continue
    if (review.sourceRowHash !== candidate.source.rowHash) errors.push(`${prefix}.sourceRowHash mismatch`)
    if (review.categoryKey !== candidate.categoryKey) errors.push(`${prefix}.categoryKey mismatch`)
    if (review.categoryName !== candidate.categoryName) errors.push(`${prefix}.categoryName mismatch`)
    if (review.primaryDimension !== candidate.source.primaryDimension) errors.push(`${prefix}.primaryDimension mismatch`)
    if (review.secondaryDimension !== candidate.source.secondaryDimension) errors.push(`${prefix}.secondaryDimension mismatch`)
    if (review.targetGoalFacetLabel !== candidate.source.targetGoalFacetLabel) errors.push(`${prefix}.targetGoalFacetLabel mismatch`)
    if (review.generatedLogic !== candidate.source.generatedLogic) errors.push(`${prefix}.generatedLogic mismatch`)
    if (review.sourcePreview !== candidate.goalFacet.sourcePreview) errors.push(`${prefix}.sourcePreview mismatch`)
    if (contentHash(review.proposedDriRoles) !== contentHash(candidate.proposedReview.driRoles)) errors.push(`${prefix}.proposedDriRoles mismatch`)
    if (contentHash(review.candidateValidationMetrics) !== contentHash(candidate.validationMetrics)) errors.push(`${prefix}.candidateValidationMetrics mismatch`)
    if (review.activationStatus !== 'inactive') errors.push(`${prefix}.activationStatus must remain inactive`)
    if (review.decision === 'approve_for_activation_proposal') {
      const rewrite = String(review.semanticRewrite || '').trim()
      if (rewrite.length < reviewContract.approvalRequirements.semanticRewriteMinimumCharacters) errors.push(`${prefix}.semanticRewrite too short`)
      if (rewrite === candidate.source.generatedLogic || GENERIC_LOGIC_RE.test(rewrite)) errors.push(`${prefix}.semanticRewrite remains generic`)
      if (!reviewContract.allowedAssessmentValues.directions.includes(review.direction)) errors.push(`${prefix}.direction invalid`)
      if (!reviewContract.allowedAssessmentValues.strengths.includes(review.strength)) errors.push(`${prefix}.strength invalid`)
      if (!Number.isFinite(review.expectedLagValue) || review.expectedLagValue <= 0) errors.push(`${prefix}.expectedLagValue invalid`)
      if (!reviewContract.allowedAssessmentValues.lagUnits.includes(review.expectedLagUnit)) errors.push(`${prefix}.expectedLagUnit invalid`)
      if (!Array.isArray(review.applicabilityConditions) || review.applicabilityConditions.filter((value) => String(value).trim()).length < 1) errors.push(`${prefix}.applicabilityConditions missing`)
      if (!Array.isArray(review.activationConditions) || review.activationConditions.filter((value) => String(value).trim()).length < reviewContract.approvalRequirements.activationConditionMinimum) errors.push(`${prefix}.activationConditions missing`)
      if (!Array.isArray(review.pauseConditions) || review.pauseConditions.filter((value) => String(value).trim()).length < reviewContract.approvalRequirements.pauseConditionMinimum) errors.push(`${prefix}.pauseConditions missing`)
      if (!Array.isArray(review.invalidationConditions) || review.invalidationConditions.filter((value) => String(value).trim()).length < reviewContract.approvalRequirements.invalidationConditionMinimum) errors.push(`${prefix}.invalidationConditions missing`)
      if (!evidenceRefs(review.supportEvidence)) errors.push(`${prefix}.supportEvidence invalid`)
      if (!evidenceRefs(review.challengeEvidence)) errors.push(`${prefix}.challengeEvidence invalid`)
      if (!namedPrincipal(review.namedIndividualDri)) errors.push(`${prefix}.namedIndividualDri invalid`)
      if (!validTimestamp(review.reviewedAt)) errors.push(`${prefix}.reviewedAt invalid`)
      const metrics = Array.isArray(review.validationMetrics) ? review.validationMetrics : []
      if (metrics.length < 1) errors.push(`${prefix}.validationMetrics missing`)
      for (const metric of metrics) {
        if (!candidate.validationMetrics.includes(metric.metricKey)) errors.push(`${prefix}.validationMetrics contains unknown metric`)
        if (metric.baseline === null || metric.baseline === undefined || metric.threshold === null || metric.threshold === undefined) errors.push(`${prefix}.validationMetric baseline and threshold required`)
        if (!Number.isInteger(metric.observationWindowDays) || metric.observationWindowDays <= 0) errors.push(`${prefix}.validationMetric observationWindowDays invalid`)
      }
      const roles = participantRoles(review)
      for (const role of candidate.proposedReview.driRoles) if (!roles.has(role)) errors.push(`${prefix}.reviewParticipants missing role ${role}`)
      if (candidate.categoryKey === 'privacy_safety_compliance' && !roles.has('compliance')) errors.push(`${prefix}.reviewParticipants missing role compliance`)
      for (const participant of review.reviewParticipants || []) if (!namedPrincipal(participant)) errors.push(`${prefix}.reviewParticipants contains invalid principal`)
      if (!review.reviewChecklist || Object.values(review.reviewChecklist).some((value) => value !== true)) errors.push(`${prefix}.reviewChecklist incomplete`)
    } else if (review.decision !== 'pending') {
      if (!validTimestamp(review.reviewedAt)) errors.push(`${prefix}.reviewedAt invalid`)
      if (!String(review.decisionReason || '').trim()) errors.push(`${prefix}.decisionReason required`)
      if (!Array.isArray(review.reviewParticipants) || review.reviewParticipants.length === 0) errors.push(`${prefix}.reviewParticipants required`)
      for (const participant of review.reviewParticipants || []) if (!namedPrincipal(participant)) errors.push(`${prefix}.reviewParticipants contains invalid principal`)
    }
  }
  for (const candidateKey of expectedKeys) if (!seenKeys.has(candidateKey)) errors.push(`review missing: ${candidateKey}`)
  return {
    ok: errors.length === 0,
    errors,
    reviewCount: reviews.length,
    approvalProposalCount: reviews.filter((review) => review.decision === 'approve_for_activation_proposal').length,
    finalDecisionCount: reviews.filter((review) => reviewContract.finalDecisions.includes(review.decision)).length,
    workbookHash: contentHash(workbook),
  }
}

export function compileP003HumanReviewResults(workbook, catalog, reviewContract) {
  const validation = validateP003ReviewWorkbook(workbook, catalog, reviewContract, { requireFinal: true })
  if (!validation.ok) throw new Error(`invalid P003 review workbook: ${validation.errors.join('; ')}`)
  const output = {
    resultVersion: '1.0.0-human-reviewed.1',
    status: reviewContract.output.status,
    productLineKey: catalog.productLineKey,
    candidateCatalogHash: p003ReviewHash(catalog),
    sourceSnapshotHash: catalog.source.snapshotHash,
    productionActivationAllowed: false,
    formalP2Allowed: false,
    employeeDeliveryAllowed: false,
    reviewedAt: new Date(Math.max(...workbook.reviews.map((review) => Date.parse(review.reviewedAt)))).toISOString(),
    results: workbook.reviews.map((review) => ({
      candidateKey: review.candidateKey,
      sourceRowHash: review.sourceRowHash,
      categoryKey: review.categoryKey,
      externalFactor: {
        primaryDimension: review.primaryDimension,
        secondaryDimension: review.secondaryDimension,
      },
      targetGoalFacet: {
        label: review.targetGoalFacetLabel,
      },
      decision: review.decision,
      eligibleForActivationProposal: review.decision === 'approve_for_activation_proposal',
      activationStatus: 'inactive',
      semanticRewrite: review.semanticRewrite,
      direction: review.direction,
      strength: review.strength,
      expectedLagValue: review.expectedLagValue,
      expectedLagUnit: review.expectedLagUnit,
      applicabilityConditions: review.applicabilityConditions,
      activationConditions: review.activationConditions,
      pauseConditions: review.pauseConditions,
      invalidationConditions: review.invalidationConditions,
      supportEvidence: review.supportEvidence,
      challengeEvidence: review.challengeEvidence,
      validationMetrics: review.validationMetrics,
      namedIndividualDri: review.namedIndividualDri,
      reviewParticipants: review.reviewParticipants,
      reviewedAt: review.reviewedAt,
      decisionReason: review.decisionReason,
    })),
  }
  return { results: output, validation, resultsHash: contentHash(output) }
}

export async function loadP003ReviewContext(options = {}) {
  const catalog = await loadP003ImpactReviewCatalog(options.catalogFile)
  const reviewContract = await loadP003ReviewSubmissionContract(options.reviewContractFile)
  return { catalog, reviewContract }
}
