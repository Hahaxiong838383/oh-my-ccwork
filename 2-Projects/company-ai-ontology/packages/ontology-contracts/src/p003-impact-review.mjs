import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACT_FILE = path.join(PACKAGE_ROOT, 'contracts/p003-impact-review-v1.json')
const CATALOG_FILE = path.join(PACKAGE_ROOT, 'catalogs/p003-impact-review-candidate-v1.json')

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

export function p003ReviewHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

export async function loadP003ImpactReviewContract(file = CONTRACT_FILE) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

export async function loadP003ImpactReviewCatalog(file = CATALOG_FILE) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

export function validateP003ImpactReviewCatalog(catalog, contract) {
  const errors = []
  const candidates = Array.isArray(catalog?.candidates) ? catalog.candidates : []
  if (catalog?.catalogVersion !== '1.0.0-candidate.1') errors.push('catalogVersion must be 1.0.0-candidate.1')
  if (catalog?.productLineKey !== contract.productLineKey) errors.push('productLineKey mismatch')
  if (catalog?.source?.recordCount !== contract.source.expectedMatrixRecordCount) errors.push('source record count mismatch')
  if (!/^[0-9a-f]{64}$/.test(String(catalog?.source?.snapshotHash || ''))) errors.push('source snapshot hash invalid')
  if (candidates.length < contract.candidateCount.minimum || candidates.length > contract.candidateCount.maximum) errors.push('candidate count outside contract')
  const candidateKeys = new Set()
  const recordIds = new Set()
  const matrixNumbers = new Set()
  const categories = new Map()
  const driRoles = new Set()
  for (const [index, candidate] of candidates.entries()) {
    const prefix = `candidates[${index}]`
    if (candidateKeys.has(candidate.candidateKey)) errors.push(`${prefix}.candidateKey duplicate`)
    candidateKeys.add(candidate.candidateKey)
    if (recordIds.has(candidate.source.recordId)) errors.push(`${prefix}.source.recordId duplicate`)
    recordIds.add(candidate.source.recordId)
    if (matrixNumbers.has(candidate.source.matrixNumber)) errors.push(`${prefix}.source.matrixNumber duplicate`)
    matrixNumbers.add(candidate.source.matrixNumber)
    categories.set(candidate.categoryKey, (categories.get(candidate.categoryKey) || 0) + 1)
    for (const role of candidate.proposedReview.driRoles || []) driRoles.add(role)
    if (candidate.productLineKey !== contract.productLineKey) errors.push(`${prefix}.productLineKey mismatch`)
    for (const [key, value] of Object.entries(contract.requiredCandidateState)) {
      if (candidate.state?.[key] !== value) errors.push(`${prefix}.state.${key} must be ${value}`)
    }
    if (candidate.sourceSemanticQuality !== 'generated_generic_requires_rewrite') errors.push(`${prefix}.sourceSemanticQuality must require rewrite`)
    if (candidate.proposedAssessment?.direction !== 'context_dependent') errors.push(`${prefix}.direction must remain context_dependent`)
    if (candidate.proposedAssessment?.strength !== 'pending_dri_review') errors.push(`${prefix}.strength must remain pending`)
    if (candidate.proposedAssessment?.expectedLag !== 'pending_dri_review') errors.push(`${prefix}.expectedLag must remain pending`)
    if ((candidate.evidence?.support || []).length !== 0 || (candidate.evidence?.challenge || []).length !== 0) errors.push(`${prefix}.evidence must be empty before review`)
    if (candidate.proposedReview?.namedIndividualDri !== null) errors.push(`${prefix}.namedIndividualDri must be null`)
    if (candidate.reviewChecklist && Object.values(candidate.reviewChecklist).some((value) => value !== false)) errors.push(`${prefix}.review checklist must remain false`)
    if (!Array.isArray(candidate.validationMetrics) || candidate.validationMetrics.length === 0) errors.push(`${prefix}.validationMetrics missing`)
  }
  for (const category of contract.requiredCategories) {
    if (!categories.has(category)) errors.push(`required category missing: ${category}`)
  }
  for (const role of contract.requiredDriRolesAcrossPack) {
    if (!driRoles.has(role)) errors.push(`required DRI role missing: ${role}`)
  }
  return {
    ok: errors.length === 0,
    errors,
    candidateCount: candidates.length,
    categoryCounts: Object.fromEntries(categories),
    driRoles: [...driRoles].sort(),
    contentHash: p003ReviewHash(catalog),
  }
}

export async function compileP003ImpactReviewCandidate(options = {}) {
  const contract = await loadP003ImpactReviewContract(options.contractFile)
  const catalog = await loadP003ImpactReviewCatalog(options.catalogFile)
  const validation = validateP003ImpactReviewCatalog(catalog, contract)
  if (!validation.ok) throw new Error(`invalid P003 impact review catalog: ${validation.errors.join('; ')}`)
  return { contract, catalog, validation }
}
