#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateInternalEngineeringEndpoint } from '../../../../packages/ontology-contracts/src/index.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = path.resolve(root, '../../..')
const planFile = path.resolve(process.argv[2] || path.join(root, 'config/internal-engineering-shadow-plan.json'))
const sourceCatalogFile = path.join(projectRoot, 'packages/ontology-contracts/catalogs/pestim-source-registry-candidate-v1.json')
const p003CatalogFile = path.join(projectRoot, 'packages/ontology-contracts/catalogs/p003-impact-review-candidate-v1.json')

const [plan, sourceCatalog, p003Catalog] = await Promise.all([
  fs.readFile(planFile, 'utf8').then(JSON.parse),
  fs.readFile(sourceCatalogFile, 'utf8').then(JSON.parse),
  fs.readFile(p003CatalogFile, 'utf8').then(JSON.parse),
])

const errors = []
const requiredDeferredGates = new Set([
  'all_source_license_and_compliance_approvals',
  'all_p003_final_reviews',
  'reviewer_role_member_uat',
  'goal7_owner_acceptance',
  'final_immutable_release',
  'production_seven_day_shadow',
  'production_owner_acceptance',
])
const allowedStorageLevels = new Set(['reference_only', 'metadata_only'])
const sourceEntries = new Map((sourceCatalog.entries || []).map((entry) => [entry.sourceKey, entry]))
const p003Candidates = new Map((p003Catalog.candidates || []).map((candidate) => [candidate.candidateKey, candidate]))
const expectedCategories = new Set((p003Catalog.candidates || []).map((candidate) => candidate.categoryKey))

function requireEqual(actual, expected, label) {
  if (actual !== expected) errors.push(`${label} must equal ${JSON.stringify(expected)}`)
}

requireEqual(plan.planVersion, '1.0.0', 'planVersion')
requireEqual(plan.mode, 'internal_engineering_shadow', 'mode')
requireEqual(plan.status, 'provisional_internal_test', 'status')
requireEqual(plan.ownerDecisionRecorded, true, 'ownerDecisionRecorded')
requireEqual(plan.deploymentAuthorized, false, 'deploymentAuthorized')
requireEqual(plan.countsTowardProductionShadow, false, 'countsTowardProductionShadow')
requireEqual(plan.publish, false, 'publish')
requireEqual(plan.runWindowNaturalDays?.minimum, 1, 'runWindowNaturalDays.minimum')
requireEqual(plan.runWindowNaturalDays?.maximum, 3, 'runWindowNaturalDays.maximum')

const configuredStorageLevels = new Set(plan.allowedStorageLevels || [])
if (configuredStorageLevels.size !== allowedStorageLevels.size || [...allowedStorageLevels].some((level) => !configuredStorageLevels.has(level))) {
  errors.push('allowedStorageLevels must contain only reference_only and metadata_only')
}

const selectedSources = Array.isArray(plan.selectedSources) ? plan.selectedSources : []
if (selectedSources.length < 2 || selectedSources.length > 3) errors.push('selectedSources must contain between 2 and 3 sources')
if (new Set(selectedSources.map((source) => source.sourceKey)).size !== selectedSources.length) errors.push('selectedSources must be unique')
for (const source of selectedSources) {
  const catalogEntry = sourceEntries.get(source.sourceKey)
  if (!catalogEntry) {
    errors.push(`unknown internal source ${source.sourceKey}`)
    continue
  }
  if (!allowedStorageLevels.has(source.storageLevel)) errors.push(`${source.sourceKey} storageLevel is not allowed for internal validation`)
  if (!Number.isInteger(source.retentionDays) || source.retentionDays < 1 || source.retentionDays > 3) errors.push(`${source.sourceKey} retentionDays must be between 1 and 3`)
  if (source.approvalState !== 'provisional_internal_test') errors.push(`${source.sourceKey} approvalState must remain provisional_internal_test`)
  if (source.licenseDecision !== 'deferred_before_production') errors.push(`${source.sourceKey} licenseDecision must remain deferred_before_production`)
  if (source.complianceDecision !== 'deferred_before_production') errors.push(`${source.sourceKey} complianceDecision must remain deferred_before_production`)
  if (catalogEntry.collection?.requiresLogin !== false) errors.push(`${source.sourceKey} must not require login`)
  if (catalogEntry.collection?.antiAutomationBypass !== false) errors.push(`${source.sourceKey} must not use anti-automation bypass`)
  if (catalogEntry.collection?.credentialMode !== 'none') errors.push(`${source.sourceKey} must not require credentials`)
  const endpointValidation = validateInternalEngineeringEndpoint(catalogEntry, source.endpointRef)
  if (!endpointValidation.ok) errors.push(`${source.sourceKey} endpointRef is not an approved bounded endpoint`)
}

const p003Samples = Array.isArray(plan.p003Samples) ? plan.p003Samples : []
if (p003Samples.length !== expectedCategories.size) errors.push(`p003Samples must contain exactly ${expectedCategories.size} samples`)
if (new Set(p003Samples.map((sample) => sample.candidateKey)).size !== p003Samples.length) errors.push('p003Samples candidateKey values must be unique')
const selectedCategories = new Set(p003Samples.map((sample) => sample.categoryKey))
for (const category of expectedCategories) {
  if (!selectedCategories.has(category)) errors.push(`p003Samples missing category ${category}`)
}
for (const sample of p003Samples) {
  const candidate = p003Candidates.get(sample.candidateKey)
  if (!candidate) {
    errors.push(`unknown P003 sample ${sample.candidateKey}`)
    continue
  }
  if (candidate.categoryKey !== sample.categoryKey) errors.push(`${sample.candidateKey} categoryKey does not match candidate catalog`)
  if (sample.decision !== 'sample_reviewed_keep_inactive') errors.push(`${sample.candidateKey} decision must remain sample_reviewed_keep_inactive`)
  if (sample.activationStatus !== 'inactive') errors.push(`${sample.candidateKey} activationStatus must remain inactive`)
  if (sample.formalReviewState !== 'deferred_before_production') errors.push(`${sample.candidateKey} formalReviewState must remain deferred_before_production`)
}

const deferredGates = new Set(plan.deferredProductionGates || [])
for (const gate of requiredDeferredGates) {
  if (!deferredGates.has(gate)) errors.push(`deferredProductionGates missing ${gate}`)
}

for (const [key, value] of Object.entries(plan.forbiddenSideEffects || {})) {
  if (value !== false) errors.push(`forbiddenSideEffects.${key} must remain false`)
}
for (const key of ['formalP2', 'employeeDelivery', 'erpWriteback', 'socialWriteback', 'causalActivation']) {
  if (!Object.hasOwn(plan.forbiddenSideEffects || {}, key)) errors.push(`forbiddenSideEffects missing ${key}`)
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: plan.mode,
    status: plan.status,
    selectedSourceCount: selectedSources.length,
    p003SampleCount: p003Samples.length,
    deferredProductionGateCount: requiredDeferredGates.size,
    countsTowardProductionShadow: false,
    publish: false,
    businessSideEffectsEnabled: 0,
    deploymentAuthorized: false,
  }, null, 2)}\n`)
}
