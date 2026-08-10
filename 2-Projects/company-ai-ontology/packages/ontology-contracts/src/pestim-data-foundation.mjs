import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareDefinitions } from './compatibility.mjs'
import { compileDefinition } from './compiler.mjs'
import { compilePestimSourceRegistryProposal } from './pestim-source-registry.mjs'

const CONTRACT_URL = new URL('../contracts/pestim-data-foundation-v1.json', import.meta.url)
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ROOT = path.resolve(PACKAGE_ROOT, '../..')
const ELEMENT_GROUPS = ['namespaces', 'objectTypes', 'linkTypes', 'functionTypes', 'actionTypes', 'policyTypes', 'constraintTypes']
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const HASH_RE = /^[a-f0-9]{64}$/

function namedKey(group, value) {
  return group === 'namespaces' ? value?.name : value?.qualifiedName
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function safeProjectRelativeFile(value) {
  const text = String(value || '')
  if (!text || path.isAbsolute(text) || text.includes('..') || !/^[A-Za-z0-9._/-]+\.sql$/.test(text)) {
    throw new Error(`invalid project-relative SQL path: ${text}`)
  }
  return path.join(PROJECT_ROOT, text)
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

function dualTimeErrors(record, errors) {
  if (!validTimestamp(record?.validFrom)) errors.push('validFrom must be a timestamp')
  if (record?.validTo !== null && record?.validTo !== undefined && !validTimestamp(record.validTo)) errors.push('validTo must be null or a timestamp')
  if (!validTimestamp(record?.recordedAt)) errors.push('recordedAt must be a timestamp')
  if (validTimestamp(record?.validFrom) && validTimestamp(record?.validTo) && Date.parse(record.validTo) <= Date.parse(record.validFrom)) {
    errors.push('validTo must be after validFrom')
  }
}

export async function loadPestimDataFoundationContract(file = CONTRACT_URL) {
  const contract = JSON.parse(await fs.readFile(file, 'utf8'))
  const errors = []
  if (!SEMVER_RE.test(String(contract.contractVersion || ''))) errors.push('contractVersion must be semantic version')
  if (!SEMVER_RE.test(String(contract.baseSchemaVersion || ''))) errors.push('baseSchemaVersion must be semantic version')
  if (!SEMVER_RE.test(String(contract.candidateSchemaVersion || ''))) errors.push('candidateSchemaVersion must be semantic version')
  if (contract.status !== 'contract_only') errors.push('status must remain contract_only before production approval')
  if (contract.proposalKey !== 'P1-SI-D') errors.push('proposalKey must be P1-SI-D')
  if (contract.compatibilityExpectation !== 'compatible') errors.push('compatibilityExpectation must be compatible')
  if (contract.deploymentAllowed !== false) errors.push('deploymentAllowed must remain false')
  if (contract.structuredTruthStore !== 'postgres') errors.push('structuredTruthStore must be postgres')
  if (contract.vectorStoreRole !== 'rebuildable_retrieval_derivative') errors.push('vectorStoreRole must remain rebuildable_retrieval_derivative')
  if (contract.rawEvidenceMode !== 'append_only') errors.push('rawEvidenceMode must be append_only')
  if (contract.externalContentTrust !== 'untrusted') errors.push('externalContentTrust must be untrusted')
  if (!Array.isArray(contract.requiredLineage) || contract.requiredLineage.length === 0) errors.push('requiredLineage must be a non-empty array')
  safeProjectRelativeFile(contract.candidateMigration)
  validateUniqueAdditions(contract.additions, errors)
  if ((contract.additions?.actionTypes || []).length !== 0) errors.push('P1-SI-D must not introduce action types')
  if (errors.length > 0) throw new Error(`invalid PESTIM data foundation contract: ${errors.join('; ')}`)
  return contract
}

export function deriveRawSnapshotIdentity({ tenantKey, sourceKey, contentHash, runKey }) {
  for (const [field, value] of Object.entries({ tenantKey, sourceKey, runKey })) {
    if (!String(value || '').trim()) throw new Error(`${field} is required`)
  }
  if (!HASH_RE.test(String(contentHash || ''))) throw new Error('contentHash must be a lowercase SHA-256 hash')
  return {
    snapshotKey: sha256(`${tenantKey}\n${sourceKey}\n${contentHash}`),
    dedupKey: sha256(`${tenantKey}\n${sourceKey}\n${contentHash}`),
    idempotencyKey: sha256(`${tenantKey}\n${runKey}\n${sourceKey}\n${contentHash}`),
  }
}

export function validateDualTimeRecord(recordType, record) {
  const errors = []
  dualTimeErrors(record, errors)
  if (recordType === 'raw_snapshot') {
    for (const field of ['snapshotKey', 'sourceKey', 'sourceReference', 'contentHash', 'dedupKey', 'contentType', 'sourceRegistryVersion', 'collectorVersion']) {
      if (!String(record?.[field] || '').trim()) errors.push(`${field} is required`)
    }
    for (const field of ['snapshotKey', 'contentHash', 'dedupKey']) if (!HASH_RE.test(String(record?.[field] || ''))) errors.push(`${field} must be a lowercase SHA-256 hash`)
    if (!validTimestamp(record?.fetchedAt)) errors.push('fetchedAt must be a timestamp')
    if (!validTimestamp(record?.retentionExpiresAt)) errors.push('retentionExpiresAt must be a timestamp')
    if (!Number.isInteger(record?.byteLength) || record.byteLength < 0) errors.push('byteLength must be an integer >= 0')
    if (validTimestamp(record?.recordedAt) && validTimestamp(record?.fetchedAt) && Date.parse(record.recordedAt) < Date.parse(record.fetchedAt)) {
      errors.push('recordedAt must not precede fetchedAt')
    }
  } else if (recordType === 'external_observation') {
    for (const field of ['observationKey', 'parserVersion', 'payloadHash', 'dataQualityStatus', 'freshnessStatus', 'conflictStatus', 'purpose']) {
      if (!String(record?.[field] || '').trim()) errors.push(`${field} is required`)
    }
    if (!validTimestamp(record?.observedAt)) errors.push('observedAt must be a timestamp')
    if (!HASH_RE.test(String(record?.payloadHash || ''))) errors.push('payloadHash must be a lowercase SHA-256 hash')
    if (validTimestamp(record?.validFrom) && validTimestamp(record?.observedAt) && Date.parse(record.validFrom) > Date.parse(record.observedAt)) {
      errors.push('validFrom must not follow observedAt')
    }
  } else if (recordType === 'strategic_signal') {
    for (const field of ['signalKey', 'signalType', 'title', 'signalStatus', 'dataQualityStatus', 'freshnessStatus', 'conflictStatus', 'ontologyVersion', 'causalGraphVersion']) {
      if (!String(record?.[field] || '').trim()) errors.push(`${field} is required`)
    }
    for (const field of ['firstSeenAt', 'lastSeenAt']) if (!validTimestamp(record?.[field])) errors.push(`${field} must be a timestamp`)
    for (const field of ['strength', 'confidence']) if (typeof record?.[field] !== 'number' || record[field] < 0 || record[field] > 1) errors.push(`${field} must be between 0 and 1`)
    if (validTimestamp(record?.firstSeenAt) && validTimestamp(record?.lastSeenAt) && Date.parse(record.lastSeenAt) < Date.parse(record.firstSeenAt)) {
      errors.push('lastSeenAt must not precede firstSeenAt')
    }
  } else {
    errors.push(`unsupported recordType ${recordType}`)
  }
  return { ok: errors.length === 0, errors }
}

export function validateReplayLineage(originalRun, replayRun) {
  const errors = []
  if (!String(originalRun?.runKey || '').trim()) errors.push('originalRun.runKey is required')
  if (!String(replayRun?.runKey || '').trim()) errors.push('replayRun.runKey is required')
  if (replayRun?.replayOfRunKey !== originalRun?.runKey) errors.push('replayOfRunKey must reference the original run')
  if (replayRun?.sourceRegistryVersion !== originalRun?.sourceRegistryVersion) errors.push('sourceRegistryVersion must remain explicit and equal for deterministic replay')
  if (replayRun?.sourceSnapshotHash !== originalRun?.sourceSnapshotHash) errors.push('sourceSnapshotHash must remain unchanged')
  if (replayRun?.inputHash !== originalRun?.inputHash) errors.push('inputHash must remain unchanged')
  if (!String(replayRun?.parserVersion || '').trim()) errors.push('replayRun.parserVersion is required')
  return { ok: errors.length === 0, errors }
}

export function applyPestimDataFoundationContract(baseline, contract) {
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

export async function compilePestimDataFoundationProposal(options = {}) {
  const contract = await loadPestimDataFoundationContract(options.contractFile)
  const sourceRegistry = await compilePestimSourceRegistryProposal({
    definitionsDirectory: options.definitionsDirectory,
    pestimContractFile: options.pestimContractFile,
    contractFile: options.sourceRegistryContractFile,
    catalogFile: options.sourceRegistryCatalogFile,
  })
  if (sourceRegistry.candidate.schemaVersion !== contract.baseSchemaVersion) {
    throw new Error(`P1-SI-B candidate ${sourceRegistry.candidate.schemaVersion} does not match ${contract.baseSchemaVersion}`)
  }
  const candidate = applyPestimDataFoundationContract(sourceRegistry.candidate.definition, contract)
  const candidateCompiled = compileDefinition(candidate)
  if (!candidateCompiled.ok) throw new Error(`data foundation candidate failed: ${JSON.stringify(candidateCompiled.errors)}`)
  const compatibility = compareDefinitions(sourceRegistry.candidate.definition, candidateCompiled.bundle.definition)
  if (compatibility.classification !== contract.compatibilityExpectation) {
    throw new Error(`compatibility ${compatibility.classification} does not match ${contract.compatibilityExpectation}`)
  }
  return {
    contract,
    sourceRegistry,
    baseline: sourceRegistry.candidate,
    candidate: candidateCompiled.bundle,
    compatibility,
    candidateMigrationFile: safeProjectRelativeFile(contract.candidateMigration),
  }
}
