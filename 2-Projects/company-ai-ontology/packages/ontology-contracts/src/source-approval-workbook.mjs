import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { contentHash } from './canonical.mjs'
import {
  evaluateSourceCollectionPolicy,
  loadPestimSourceRegistryCatalog,
  loadPestimSourceRegistryContract,
  validateSourceRegistryCatalog,
} from './pestim-source-registry.mjs'
import {
  assertCsvHeaders,
  nullableString,
  parseCsv,
  parseJsonCell,
  parseNullableInteger,
  rowsToCsv,
} from './review-csv.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APPROVAL_CONTRACT_FILE = path.join(PACKAGE_ROOT, 'contracts/pestim-source-approval-v1.json')
const REVIEW_WORKBOOK_FILE = path.join(PACKAGE_ROOT, 'templates/reviews/source-registry-review-template-v1.json')
const SOURCE_APPROVAL_CSV_HEADERS = [
  'sourceKey',
  'sourceName',
  'sourceType',
  'sourceCategory',
  'endpointRefs',
  'candidateStorageLevel',
  'candidateRetentionDays',
  'candidateInternalUseScopes',
  'candidateLicenseEvidenceRef',
  'decision',
  'licenseDecision',
  'complianceDecision',
  'approvedStorageLevel',
  'approvedRetentionDays',
  'licenseExpiresAt',
  'licenseEvidenceRefs',
  'complianceEvidenceRefs',
  'namedLicenseReviewer',
  'namedComplianceDri',
  'approvedAt',
  'decisionReason',
]

const STORAGE_DOWNGRADE = {
  reference_only: new Set(['reference_only']),
  metadata_only: new Set(['reference_only', 'metadata_only']),
  summary_metadata: new Set(['reference_only', 'metadata_only', 'summary_metadata']),
  structured_data: new Set(['reference_only', 'metadata_only', 'structured_data']),
  full_text: new Set(['reference_only', 'metadata_only', 'summary_metadata', 'structured_data', 'full_text']),
}

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

function assignedPrincipal(value) {
  return namedPrincipal(value)
    && typeof value.role === 'string'
    && value.role.trim().length > 0
    && ['pending', 'approve', 'reject'].includes(value.decision)
}

function validEvidenceRefs(values) {
  return Array.isArray(values)
    && values.length > 0
    && values.every((value) => typeof value === 'string' && /^(https:\/\/|feishu:|ontology:|git:)[^\s]+$/.test(value))
}

export async function loadPestimSourceApprovalContract(file = APPROVAL_CONTRACT_FILE) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

export async function loadSourceApprovalWorkbook(file = REVIEW_WORKBOOK_FILE) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

export function createSourceApprovalWorkbook(catalog, generatedAt = '2026-08-10T00:00:00Z') {
  return {
    workbookVersion: '1.0.0-template.1',
    reviewType: 'pestim-source-compliance',
    sourceRegistryVersion: catalog.registryVersion,
    sourceCatalogHash: contentHash(catalog),
    status: 'pending_human_review',
    generatedAt,
    productionCollectionAllowed: false,
    publishAllowed: false,
    reviews: catalog.entries.map((entry) => ({
      sourceKey: entry.sourceKey,
      sourceName: entry.name,
      sourceType: entry.sourceType,
      sourceCategory: entry.sourceCategory,
      endpointRefs: [...entry.endpointRefs],
      candidateStorageLevel: entry.retention.storageLevel,
      candidateRetentionDays: entry.retention.retentionDays,
      candidateInternalUseScopes: [...entry.internalUseScopes],
      candidateLicenseEvidenceRef: entry.license.evidenceRef,
      decision: 'pending',
      licenseDecision: 'pending',
      complianceDecision: 'pending',
      approvedStorageLevel: null,
      approvedRetentionDays: null,
      licenseExpiresAt: null,
      licenseEvidenceRefs: [],
      complianceEvidenceRefs: [],
      namedLicenseReviewer: null,
      namedComplianceDri: null,
      approvedAt: null,
      decisionReason: null,
    })),
  }
}

export function sourceApprovalWorkbookCsv(workbook) {
  return rowsToCsv(SOURCE_APPROVAL_CSV_HEADERS, workbook.reviews)
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

export function sourceApprovalWorkbookFromCsv(input, catalog, options = {}) {
  const { headers, rows } = parseCsv(input)
  assertCsvHeaders(headers, SOURCE_APPROVAL_CSV_HEADERS)
  const workbook = createSourceApprovalWorkbook(catalog, options.generatedAt)
  workbook.status = 'imported_human_review'
  workbook.reviews = rows.map((row, index) => {
    const prefix = `CSV row ${index + 2}`
    return {
      sourceKey: row.sourceKey,
      sourceName: row.sourceName,
      sourceType: row.sourceType,
      sourceCategory: row.sourceCategory,
      endpointRefs: jsonArray(row.endpointRefs, `${prefix}.endpointRefs`),
      candidateStorageLevel: row.candidateStorageLevel,
      candidateRetentionDays: parseNullableInteger(row.candidateRetentionDays, `${prefix}.candidateRetentionDays`),
      candidateInternalUseScopes: jsonArray(row.candidateInternalUseScopes, `${prefix}.candidateInternalUseScopes`),
      candidateLicenseEvidenceRef: nullableString(row.candidateLicenseEvidenceRef),
      decision: row.decision,
      licenseDecision: row.licenseDecision,
      complianceDecision: row.complianceDecision,
      approvedStorageLevel: nullableString(row.approvedStorageLevel),
      approvedRetentionDays: parseNullableInteger(row.approvedRetentionDays, `${prefix}.approvedRetentionDays`),
      licenseExpiresAt: nullableString(row.licenseExpiresAt),
      licenseEvidenceRefs: jsonArray(row.licenseEvidenceRefs, `${prefix}.licenseEvidenceRefs`),
      complianceEvidenceRefs: jsonArray(row.complianceEvidenceRefs, `${prefix}.complianceEvidenceRefs`),
      namedLicenseReviewer: jsonObjectOrNull(row.namedLicenseReviewer, `${prefix}.namedLicenseReviewer`),
      namedComplianceDri: jsonObjectOrNull(row.namedComplianceDri, `${prefix}.namedComplianceDri`),
      approvedAt: nullableString(row.approvedAt),
      decisionReason: nullableString(row.decisionReason),
    }
  })
  return workbook
}

export function validateSourceApprovalWorkbook(workbook, catalog, approvalContract, options = {}) {
  const errors = []
  const requireFinal = options.requireFinal === true
  if (workbook?.reviewType !== approvalContract.reviewType) errors.push('reviewType mismatch')
  if (workbook?.sourceRegistryVersion !== catalog.registryVersion) errors.push('sourceRegistryVersion mismatch')
  if (workbook?.sourceCatalogHash !== contentHash(catalog)) errors.push('sourceCatalogHash mismatch')
  if (workbook?.productionCollectionAllowed !== false) errors.push('productionCollectionAllowed must remain false')
  if (workbook?.publishAllowed !== false) errors.push('publishAllowed must remain false')
  const reviews = Array.isArray(workbook?.reviews) ? workbook.reviews : []
  const expectedKeys = new Set(catalog.entries.map((entry) => entry.sourceKey))
  const seenKeys = new Set()
  for (const [index, review] of reviews.entries()) {
    const prefix = `reviews[${index}]`
    if (!expectedKeys.has(review.sourceKey)) errors.push(`${prefix}.sourceKey unknown`)
    if (seenKeys.has(review.sourceKey)) errors.push(`${prefix}.sourceKey duplicate`)
    seenKeys.add(review.sourceKey)
    if (!approvalContract.allowedDecisions.includes(review.decision)) errors.push(`${prefix}.decision invalid`)
    if (requireFinal && !approvalContract.finalDecisions.includes(review.decision)) errors.push(`${prefix}.decision must be final`)
    const entry = catalog.entries.find((candidate) => candidate.sourceKey === review.sourceKey)
    if (!entry) continue
    if (review.sourceName !== entry.name) errors.push(`${prefix}.sourceName mismatch`)
    if (review.sourceType !== entry.sourceType) errors.push(`${prefix}.sourceType mismatch`)
    if (review.sourceCategory !== entry.sourceCategory) errors.push(`${prefix}.sourceCategory mismatch`)
    if (contentHash(review.endpointRefs) !== contentHash(entry.endpointRefs)) errors.push(`${prefix}.endpointRefs mismatch`)
    if (review.candidateStorageLevel !== entry.retention.storageLevel) errors.push(`${prefix}.candidateStorageLevel mismatch`)
    if (review.candidateRetentionDays !== entry.retention.retentionDays) errors.push(`${prefix}.candidateRetentionDays mismatch`)
    if (contentHash(review.candidateInternalUseScopes) !== contentHash(entry.internalUseScopes)) errors.push(`${prefix}.candidateInternalUseScopes mismatch`)
    if (review.candidateLicenseEvidenceRef !== entry.license.evidenceRef) errors.push(`${prefix}.candidateLicenseEvidenceRef mismatch`)
    if (review.decision === 'approve_for_shadow') {
      if (review.licenseDecision !== 'approved') errors.push(`${prefix}.licenseDecision must be approved`)
      if (review.complianceDecision !== 'approved') errors.push(`${prefix}.complianceDecision must be approved`)
      if (!namedPrincipal(review.namedLicenseReviewer)) errors.push(`${prefix}.namedLicenseReviewer invalid`)
      if (!namedPrincipal(review.namedComplianceDri)) errors.push(`${prefix}.namedComplianceDri invalid`)
      if (!validTimestamp(review.approvedAt)) errors.push(`${prefix}.approvedAt invalid`)
      if (review.licenseExpiresAt !== null && !validTimestamp(review.licenseExpiresAt)) errors.push(`${prefix}.licenseExpiresAt invalid`)
      if (!validEvidenceRefs(review.licenseEvidenceRefs)) errors.push(`${prefix}.licenseEvidenceRefs invalid`)
      if (!validEvidenceRefs(review.complianceEvidenceRefs)) errors.push(`${prefix}.complianceEvidenceRefs invalid`)
      const allowedStorage = STORAGE_DOWNGRADE[entry.retention.storageLevel] || new Set()
      if (!allowedStorage.has(review.approvedStorageLevel)) errors.push(`${prefix}.approvedStorageLevel exceeds candidate`)
      if (review.approvedStorageLevel === 'full_text') errors.push(`${prefix}.full_text requires a separate change proposal`)
      if (!Number.isInteger(review.approvedRetentionDays) || review.approvedRetentionDays <= 0 || review.approvedRetentionDays > entry.retention.retentionDays) {
        errors.push(`${prefix}.approvedRetentionDays invalid`)
      }
      if (entry.collection.credentialMode === 'personal') errors.push(`${prefix}.personal credential forbidden`)
      if (entry.collection.requiresLogin) errors.push(`${prefix}.login-required collection forbidden`)
      if (entry.collection.antiAutomationBypass) errors.push(`${prefix}.anti-automation bypass forbidden`)
    } else if (review.decision !== 'pending') {
      if (!validTimestamp(review.approvedAt)) errors.push(`${prefix}.approvedAt invalid`)
      if (!String(review.decisionReason || '').trim()) errors.push(`${prefix}.decisionReason required`)
      if (!namedPrincipal(review.namedComplianceDri)) errors.push(`${prefix}.namedComplianceDri invalid`)
    }
  }
  for (const sourceKey of expectedKeys) if (!seenKeys.has(sourceKey)) errors.push(`review missing: ${sourceKey}`)
  return {
    ok: errors.length === 0,
    errors,
    reviewCount: reviews.length,
    finalDecisionCount: reviews.filter((review) => approvalContract.finalDecisions.includes(review.decision)).length,
    workbookHash: contentHash(workbook),
  }
}

export function inspectSourceReviewAssignments(workbook) {
  const reviews = Array.isArray(workbook?.reviews) ? workbook.reviews : []
  const licenseReviewerAssignedCount = reviews.filter((review) => assignedPrincipal(review.namedLicenseReviewer)).length
  const complianceDriAssignedCount = reviews.filter((review) => assignedPrincipal(review.namedComplianceDri)).length
  const fullyAssignedReviewCount = reviews.filter((review) => (
    assignedPrincipal(review.namedLicenseReviewer)
    && assignedPrincipal(review.namedComplianceDri)
  )).length
  const invalidLicenseReviewerCount = reviews.filter((review) => (
    review.namedLicenseReviewer !== null
    && review.namedLicenseReviewer !== undefined
    && !assignedPrincipal(review.namedLicenseReviewer)
  )).length
  const invalidComplianceDriCount = reviews.filter((review) => (
    review.namedComplianceDri !== null
    && review.namedComplianceDri !== undefined
    && !assignedPrincipal(review.namedComplianceDri)
  )).length

  return {
    assignmentReady: reviews.length > 0 && fullyAssignedReviewCount === reviews.length,
    reviewCount: reviews.length,
    fullyAssignedReviewCount,
    licenseReviewerAssignedCount,
    complianceDriAssignedCount,
    missingLicenseReviewerCount: reviews.length - licenseReviewerAssignedCount - invalidLicenseReviewerCount,
    missingComplianceDriCount: reviews.length - complianceDriAssignedCount - invalidComplianceDriCount,
    invalidLicenseReviewerCount,
    invalidComplianceDriCount,
  }
}

export function inspectSourceReviewProgress(workbook, catalog, approvalContract) {
  const reviews = Array.isArray(workbook?.reviews) ? workbook.reviews : []
  const finalValidation = validateSourceApprovalWorkbook(workbook, catalog, approvalContract, { requireFinal: true })
  const decisionCounts = Object.fromEntries(approvalContract.allowedDecisions.map((decision) => [decision, 0]))
  const categoryMap = new Map()
  for (const review of reviews) {
    if (Object.hasOwn(decisionCounts, review.decision)) decisionCounts[review.decision] += 1
    const categoryKey = typeof review.sourceCategory === 'string' && review.sourceCategory.length > 0
      ? review.sourceCategory
      : 'unknown'
    if (!categoryMap.has(categoryKey)) {
      categoryMap.set(categoryKey, {
        sourceCategory: categoryKey,
        reviewCount: 0,
        finalDecisionCount: 0,
        approveForShadowCount: 0,
        keepPausedCount: 0,
        revokeCount: 0,
      })
    }
    const category = categoryMap.get(categoryKey)
    category.reviewCount += 1
    if (approvalContract.finalDecisions.includes(review.decision)) category.finalDecisionCount += 1
    if (review.decision === 'approve_for_shadow') category.approveForShadowCount += 1
    if (review.decision === 'keep_paused') category.keepPausedCount += 1
    if (review.decision === 'revoke') category.revokeCount += 1
  }
  const finalDecisionCount = reviews.filter((review) => approvalContract.finalDecisions.includes(review.decision)).length
  return {
    reviewReady: reviews.length > 0 && finalDecisionCount === reviews.length && finalValidation.ok,
    reviewCount: reviews.length,
    pendingCount: decisionCounts.pending || 0,
    finalDecisionCount,
    decisionCounts,
    licenseDecisionRecordedCount: reviews.filter((review) => review.licenseDecision !== 'pending').length,
    complianceDecisionRecordedCount: reviews.filter((review) => review.complianceDecision !== 'pending').length,
    approvedStorageLevelRecordedCount: reviews.filter((review) => String(review.approvedStorageLevel || '').length > 0).length,
    approvedRetentionRecordedCount: reviews.filter((review) => Number.isInteger(review.approvedRetentionDays) && review.approvedRetentionDays > 0).length,
    licenseEvidenceRecordedCount: reviews.filter((review) => Array.isArray(review.licenseEvidenceRefs) && review.licenseEvidenceRefs.length > 0).length,
    complianceEvidenceRecordedCount: reviews.filter((review) => Array.isArray(review.complianceEvidenceRefs) && review.complianceEvidenceRefs.length > 0).length,
    approvedAtRecordedCount: reviews.filter((review) => validTimestamp(review.approvedAt)).length,
    decisionReasonRecordedCount: reviews.filter((review) => String(review.decisionReason || '').trim().length > 0).length,
    finalValidationOk: finalValidation.ok,
    finalValidationErrorCount: finalValidation.errors.length,
    categoryProgress: [...categoryMap.values()].sort((left, right) => left.sourceCategory.localeCompare(right.sourceCategory)),
  }
}

export function compileShadowSourceRegistry(workbook, catalog, sourceContract, approvalContract) {
  const validation = validateSourceApprovalWorkbook(workbook, catalog, approvalContract, { requireFinal: true })
  if (!validation.ok) throw new Error(`invalid source approval workbook: ${validation.errors.join('; ')}`)
  const reviewsByKey = new Map(workbook.reviews.map((review) => [review.sourceKey, review]))
  const output = structuredClone(catalog)
  output.registryVersion = '1.0.0-shadow-reviewed.1'
  output.status = approvalContract.output.registryStatus
  output.generatedAt = new Date(Math.max(...workbook.reviews.map((review) => Date.parse(review.approvedAt)))).toISOString()
  output.approvalNote = 'Human-reviewed registry for publish=false Shadow only. Production collection and report publication remain disabled.'
  for (const entry of output.entries) {
    const review = reviewsByKey.get(entry.sourceKey)
    if (review.decision === 'approve_for_shadow') {
      entry.license.status = 'approved'
      entry.license.reviewedAt = review.approvedAt
      entry.license.expiresAt = review.licenseExpiresAt
      entry.license.fullTextRetentionAllowed = false
      entry.retention.storageLevel = review.approvedStorageLevel
      entry.retention.retentionDays = review.approvedRetentionDays
      entry.governance.approvalStatus = 'approved'
      entry.governance.approvedBy = review.namedComplianceDri.principalRef
      entry.governance.approvedAt = review.approvedAt
      entry.lifecycleStatus = 'enabled'
    } else if (review.decision === 'revoke') {
      entry.lifecycleStatus = 'revoked'
    } else {
      entry.lifecycleStatus = 'paused'
    }
  }
  const catalogValidation = validateSourceRegistryCatalog(output, sourceContract, { allowedStatuses: [approvalContract.output.registryStatus] })
  if (!catalogValidation.ok) throw new Error(`compiled source registry invalid: ${catalogValidation.errors.join('; ')}`)
  const policyDecisions = output.entries.map((entry) => evaluateSourceCollectionPolicy(output, sourceContract, entry.sourceKey, new Date(output.generatedAt)))
  return {
    registry: output,
    workbookValidation: validation,
    registryValidation: catalogValidation,
    policyDecisions,
    registryHash: contentHash(output),
  }
}

export async function loadSourceApprovalContext(options = {}) {
  const sourceContract = await loadPestimSourceRegistryContract(options.sourceContractFile)
  const { catalog } = await loadPestimSourceRegistryCatalog({ contract: sourceContract, catalogFile: options.catalogFile })
  const approvalContract = await loadPestimSourceApprovalContract(options.approvalContractFile)
  return { sourceContract, catalog, approvalContract }
}
