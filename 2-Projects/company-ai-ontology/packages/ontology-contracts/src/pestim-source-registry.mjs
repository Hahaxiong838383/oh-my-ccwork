import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { contentHash } from './canonical.mjs'
import { compareDefinitions } from './compatibility.mjs'
import { compileDefinition } from './compiler.mjs'
import { compilePestimStrategicIntelligenceProposal } from './pestim-strategic-intelligence.mjs'

const CONTRACT_URL = new URL('../contracts/pestim-source-registry-v1.json', import.meta.url)
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ELEMENT_GROUPS = ['namespaces', 'objectTypes', 'linkTypes', 'functionTypes', 'actionTypes', 'policyTypes', 'constraintTypes']
const SOURCE_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const REQUIRED_ENTRY_PATHS = [
  'sourceKey',
  'name',
  'sourceType',
  'sourceCategory',
  'ownerRole',
  'pestimLayers',
  'endpointRefs',
  'license.status',
  'license.basis',
  'license.evidenceRef',
  'license.reviewedAt',
  'license.fullTextRetentionAllowed',
  'internalUseScopes',
  'collection.mode',
  'collection.fetchIntervalMinutes',
  'collection.rateLimitPerHour',
  'collection.timeoutSeconds',
  'collection.requiresLogin',
  'collection.antiAutomationBypass',
  'collection.credentialMode',
  'trust.tier',
  'trust.historicalAccuracyStatus',
  'retention.dataClassification',
  'retention.retentionDays',
  'retention.deletionPolicy',
  'retention.storageLevel',
  'governance.complianceOwnerRole',
  'governance.incidentContactRole',
  'governance.approvalStatus',
  'lifecycleStatus',
]

function namedKey(group, value) {
  return group === 'namespaces' ? value?.name : value?.qualifiedName
}

function atPath(value, dottedPath) {
  return dottedPath.split('.').reduce((current, key) => current?.[key], value)
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function safePackageRelativeFile(value) {
  const text = String(value || '')
  if (!text || path.isAbsolute(text) || text.includes('..') || !/^[A-Za-z0-9._/-]+\.json$/.test(text)) {
    throw new Error(`invalid package-relative JSON path: ${text}`)
  }
  return path.join(PACKAGE_ROOT, text)
}

function validateUniqueAdditions(additions, errors) {
  for (const group of ELEMENT_GROUPS) {
    if (!Array.isArray(additions?.[group])) {
      errors.push(`additions.${group} must be an array`)
      continue
    }
    const names = new Set()
    for (const item of additions[group]) {
      const name = namedKey(group, item)
      if (!name) errors.push(`additions.${group} contains an unnamed item`)
      else if (names.has(name)) errors.push(`additions.${group} duplicates ${name}`)
      names.add(name)
    }
  }
}

function validateEnum(value, values, pathName, errors) {
  if (!values.includes(value)) errors.push(`${pathName} must be one of ${values.join(', ')}`)
}

function validateSourceEntry(entry, index, contract, errors) {
  const prefix = `entries[${index}]`
  for (const requiredPath of REQUIRED_ENTRY_PATHS) {
    if (atPath(entry, requiredPath) === undefined) errors.push(`${prefix}.${requiredPath} is required`)
  }
  if (!SOURCE_KEY_RE.test(String(entry?.sourceKey || ''))) errors.push(`${prefix}.sourceKey must be lower kebab case`)
  if (!String(entry?.name || '').trim()) errors.push(`${prefix}.name must be non-empty`)
  if (!String(entry?.ownerRole || '').trim()) errors.push(`${prefix}.ownerRole must be non-empty`)
  if (!Array.isArray(entry?.pestimLayers) || entry.pestimLayers.length === 0) errors.push(`${prefix}.pestimLayers must be a non-empty array`)
  if (!Array.isArray(entry?.endpointRefs) || entry.endpointRefs.length === 0) errors.push(`${prefix}.endpointRefs must be a non-empty array`)
  for (const endpoint of entry?.endpointRefs || []) {
    if (!String(endpoint).startsWith('https://')) errors.push(`${prefix}.endpointRefs must use https`)
  }
  if (!Array.isArray(entry?.internalUseScopes) || entry.internalUseScopes.length === 0) errors.push(`${prefix}.internalUseScopes must be a non-empty array`)

  const allowed = contract.allowedValues
  validateEnum(entry?.sourceType, allowed.sourceTypes, `${prefix}.sourceType`, errors)
  validateEnum(entry?.sourceCategory, allowed.sourceCategories, `${prefix}.sourceCategory`, errors)
  validateEnum(entry?.lifecycleStatus, allowed.lifecycleStatuses, `${prefix}.lifecycleStatus`, errors)
  validateEnum(entry?.license?.status, allowed.licenseStatuses, `${prefix}.license.status`, errors)
  validateEnum(entry?.governance?.approvalStatus, allowed.complianceApprovalStatuses, `${prefix}.governance.approvalStatus`, errors)
  validateEnum(entry?.retention?.storageLevel, allowed.storageLevels, `${prefix}.retention.storageLevel`, errors)
  validateEnum(entry?.collection?.credentialMode, allowed.credentialModes, `${prefix}.collection.credentialMode`, errors)
  validateEnum(entry?.trust?.tier, allowed.trustTiers, `${prefix}.trust.tier`, errors)
  validateEnum(entry?.trust?.historicalAccuracyStatus, allowed.accuracyStatuses, `${prefix}.trust.historicalAccuracyStatus`, errors)

  for (const [field, minimum] of [['fetchIntervalMinutes', 1], ['rateLimitPerHour', 1], ['timeoutSeconds', 1]]) {
    if (!Number.isInteger(entry?.collection?.[field]) || entry.collection[field] < minimum) {
      errors.push(`${prefix}.collection.${field} must be an integer >= ${minimum}`)
    }
  }
  if (!Number.isInteger(entry?.retention?.retentionDays) || entry.retention.retentionDays < 1) {
    errors.push(`${prefix}.retention.retentionDays must be an integer >= 1`)
  }
  if (typeof entry?.collection?.requiresLogin !== 'boolean') errors.push(`${prefix}.collection.requiresLogin must be boolean`)
  if (typeof entry?.collection?.antiAutomationBypass !== 'boolean') errors.push(`${prefix}.collection.antiAutomationBypass must be boolean`)
  if (typeof entry?.license?.fullTextRetentionAllowed !== 'boolean') errors.push(`${prefix}.license.fullTextRetentionAllowed must be boolean`)
  if (!validTimestamp(entry?.license?.reviewedAt)) errors.push(`${prefix}.license.reviewedAt must be a timestamp`)
  if (entry?.license?.expiresAt !== null && !validTimestamp(entry?.license?.expiresAt)) errors.push(`${prefix}.license.expiresAt must be null or a timestamp`)
  if (!String(entry?.license?.evidenceRef || '').startsWith('https://')) errors.push(`${prefix}.license.evidenceRef must use https`)
  const accuracyScore = entry?.trust?.historicalAccuracyScore
  if (accuracyScore !== null && accuracyScore !== undefined && (typeof accuracyScore !== 'number' || accuracyScore < 0 || accuracyScore > 1)) {
    errors.push(`${prefix}.trust.historicalAccuracyScore must be null or between 0 and 1`)
  }
  if (entry?.trust?.historicalAccuracyStatus === 'measured' && typeof accuracyScore !== 'number') {
    errors.push(`${prefix}.trust.historicalAccuracyScore is required when status is measured`)
  }
}

export async function loadPestimSourceRegistryContract(file = CONTRACT_URL) {
  const contract = JSON.parse(await fs.readFile(file, 'utf8'))
  const errors = []
  if (!SEMVER_RE.test(String(contract.contractVersion || ''))) errors.push('contractVersion must be semantic version')
  if (!SEMVER_RE.test(String(contract.baseSchemaVersion || ''))) errors.push('baseSchemaVersion must be semantic version')
  if (!SEMVER_RE.test(String(contract.candidateSchemaVersion || ''))) errors.push('candidateSchemaVersion must be semantic version')
  if (contract.status !== 'contract_only') errors.push('status must remain contract_only before production approval')
  if (contract.proposalKey !== 'P1-SI-B') errors.push('proposalKey must be P1-SI-B')
  if (contract.compatibilityExpectation !== 'compatible') errors.push('compatibilityExpectation must be compatible')
  if (contract.deploymentAllowed !== false) errors.push('deploymentAllowed must remain false')
  if (contract.defaultDecision !== 'deny') errors.push('defaultDecision must be deny')
  if (contract.registryStatus !== 'candidate') errors.push('registryStatus must remain candidate before company compliance approval')
  safePackageRelativeFile(contract.initialRegistryFile)
  for (const [name, values] of Object.entries(contract.allowedValues || {})) {
    if (!Array.isArray(values) || values.length === 0) errors.push(`allowedValues.${name} must be a non-empty array`)
  }
  if (!Array.isArray(contract.forbiddenCollectionDefaults) || contract.forbiddenCollectionDefaults.length === 0) {
    errors.push('forbiddenCollectionDefaults must be a non-empty array')
  }
  validateUniqueAdditions(contract.additions, errors)
  if ((contract.additions?.actionTypes || []).length !== 0) errors.push('P1-SI-B must not introduce action types')
  if (errors.length > 0) throw new Error(`invalid PESTIM source registry contract: ${errors.join('; ')}`)
  return contract
}

export function validateSourceRegistryCatalog(catalog, contract) {
  const errors = []
  if (!SEMVER_RE.test(String(catalog?.registryVersion || ''))) errors.push('registryVersion must be semantic version')
  if (catalog?.status !== 'candidate') errors.push('status must remain candidate before approval')
  if (catalog?.defaultDecision !== 'deny') errors.push('defaultDecision must be deny')
  if (!validTimestamp(catalog?.generatedAt)) errors.push('generatedAt must be a timestamp')
  if (!Array.isArray(catalog?.entries) || catalog.entries.length === 0) errors.push('entries must be a non-empty array')
  const sourceKeys = new Set()
  for (const [index, entry] of (catalog?.entries || []).entries()) {
    validateSourceEntry(entry, index, contract, errors)
    if (sourceKeys.has(entry?.sourceKey)) errors.push(`entries[${index}].sourceKey duplicates ${entry.sourceKey}`)
    sourceKeys.add(entry?.sourceKey)
  }
  return {
    ok: errors.length === 0,
    errors,
    entryCount: catalog?.entries?.length || 0,
    contentHash: errors.length === 0 ? contentHash(catalog) : null,
  }
}

export async function loadPestimSourceRegistryCatalog(options = {}) {
  const contract = options.contract || await loadPestimSourceRegistryContract(options.contractFile)
  const catalogFile = options.catalogFile || safePackageRelativeFile(contract.initialRegistryFile)
  const catalog = JSON.parse(await fs.readFile(catalogFile, 'utf8'))
  const validation = validateSourceRegistryCatalog(catalog, contract)
  if (!validation.ok) throw new Error(`invalid PESTIM source registry catalog: ${validation.errors.join('; ')}`)
  return { catalog, validation }
}

export function evaluateSourceCollectionPolicy(catalog, contract, sourceKey, evaluatedAt = new Date()) {
  const validation = validateSourceRegistryCatalog(catalog, contract)
  const timestamp = evaluatedAt instanceof Date ? evaluatedAt : new Date(evaluatedAt)
  const deny = (reasonCode, entry = null) => ({
    allowed: false,
    decision: 'deny',
    reasonCode,
    sourceKey: String(sourceKey || ''),
    evaluatedAt: Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null,
    registryVersion: catalog?.registryVersion || null,
    policyVersion: contract?.contractVersion || null,
    lifecycleStatus: entry?.lifecycleStatus || null,
  })
  if (!validation.ok || !Number.isFinite(timestamp.getTime())) return deny('REGISTRY_INVALID')
  const entry = catalog.entries.find((candidate) => candidate.sourceKey === sourceKey)
  if (!entry) return deny('SOURCE_NOT_REGISTERED')
  if (entry.lifecycleStatus !== 'enabled') return deny(`SOURCE_${entry.lifecycleStatus.toUpperCase()}`, entry)
  if (entry.governance.approvalStatus !== 'approved' || !entry.governance.approvedBy || !validTimestamp(entry.governance.approvedAt)) {
    return deny('COMPLIANCE_NOT_APPROVED', entry)
  }
  if (entry.license.status !== 'approved') return deny('LICENSE_NOT_APPROVED', entry)
  if (entry.license.expiresAt && Date.parse(entry.license.expiresAt) <= timestamp.getTime()) return deny('LICENSE_EXPIRED', entry)
  if (entry.collection.credentialMode === 'personal') return deny('PERSONAL_ACCOUNT_FORBIDDEN', entry)
  if (entry.collection.requiresLogin) return deny('LOGIN_REQUIRED_FORBIDDEN', entry)
  if (entry.collection.antiAutomationBypass) return deny('ANTI_AUTOMATION_BYPASS_FORBIDDEN', entry)
  if (entry.internalUseScopes.length === 0) return deny('INTERNAL_USE_SCOPE_MISSING', entry)
  if (entry.retention.storageLevel === 'full_text' && entry.license.fullTextRetentionAllowed !== true) {
    return deny('FULL_TEXT_RETENTION_NOT_APPROVED', entry)
  }
  return {
    allowed: true,
    decision: 'allow',
    reasonCode: 'SOURCE_APPROVED',
    sourceKey: entry.sourceKey,
    evaluatedAt: timestamp.toISOString(),
    registryVersion: catalog.registryVersion,
    policyVersion: contract.contractVersion,
    lifecycleStatus: entry.lifecycleStatus,
    collection: {
      mode: entry.collection.mode,
      fetchIntervalMinutes: entry.collection.fetchIntervalMinutes,
      rateLimitPerHour: entry.collection.rateLimitPerHour,
      timeoutSeconds: entry.collection.timeoutSeconds,
      credentialMode: entry.collection.credentialMode,
    },
    retention: structuredClone(entry.retention),
    internalUseScopes: [...entry.internalUseScopes],
  }
}

export function applyPestimSourceRegistryContract(baseline, contract) {
  if (baseline.schemaVersion !== contract.baseSchemaVersion) {
    throw new Error(`baseline schema ${baseline.schemaVersion} does not match ${contract.baseSchemaVersion}`)
  }
  const candidate = structuredClone(baseline)
  candidate.schemaVersion = contract.candidateSchemaVersion
  for (const group of ELEMENT_GROUPS) {
    const existing = new Set((candidate[group] || []).map((item) => namedKey(group, item)))
    for (const item of contract.additions[group] || []) {
      const name = namedKey(group, item)
      if (existing.has(name)) throw new Error(`proposal collides with existing ${group} ${name}`)
      candidate[group].push(structuredClone(item))
      existing.add(name)
    }
  }
  return candidate
}

export async function compilePestimSourceRegistryProposal(options = {}) {
  const contract = await loadPestimSourceRegistryContract(options.contractFile)
  const strategicIntelligence = await compilePestimStrategicIntelligenceProposal({
    definitionsDirectory: options.definitionsDirectory,
    contractFile: options.pestimContractFile,
  })
  if (strategicIntelligence.candidate.schemaVersion !== contract.baseSchemaVersion) {
    throw new Error(`P1-SI-A candidate ${strategicIntelligence.candidate.schemaVersion} does not match ${contract.baseSchemaVersion}`)
  }
  const { catalog, validation: registryValidation } = await loadPestimSourceRegistryCatalog({
    contract,
    catalogFile: options.catalogFile,
  })
  const candidate = applyPestimSourceRegistryContract(strategicIntelligence.candidate.definition, contract)
  const candidateCompiled = compileDefinition(candidate)
  if (!candidateCompiled.ok) throw new Error(`source registry candidate failed: ${JSON.stringify(candidateCompiled.errors)}`)
  const compatibility = compareDefinitions(strategicIntelligence.candidate.definition, candidateCompiled.bundle.definition)
  if (compatibility.classification !== contract.compatibilityExpectation) {
    throw new Error(`compatibility ${compatibility.classification} does not match ${contract.compatibilityExpectation}`)
  }
  return {
    contract,
    catalog,
    registryValidation,
    strategicIntelligence,
    baseline: strategicIntelligence.candidate,
    candidate: candidateCompiled.bundle,
    compatibility,
  }
}
