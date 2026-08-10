import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { contentHash } from './canonical.mjs'
import { compareDefinitions } from './compatibility.mjs'
import { compileDefinition } from './compiler.mjs'
import { compilePestimDataFoundationProposal } from './pestim-data-foundation.mjs'

const CONTRACT_URL = new URL('../contracts/pestim-reporting-v1.json', import.meta.url)
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ROOT = path.resolve(PACKAGE_ROOT, '../..')
const ELEMENT_GROUPS = ['namespaces', 'objectTypes', 'linkTypes', 'functionTypes', 'actionTypes', 'policyTypes', 'constraintTypes']
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const HASH_RE = /^[a-f0-9]{64}$/
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

function namedKey(group, value) {
  return group === 'namespaces' ? value?.name : value?.qualifiedName
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function safeFile(root, value, extension) {
  const text = String(value || '')
  if (!text || path.isAbsolute(text) || text.includes('..') || !new RegExp(`^[A-Za-z0-9._/-]+\\.${extension}$`).test(text)) {
    throw new Error(`invalid relative ${extension} path: ${text}`)
  }
  return path.join(root, text)
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

function localDateParts(date) {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    isoWeekday: shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay(),
  }
}

function shanghaiMidnight(year, month, day) {
  return new Date(Date.UTC(year, month, day) - SHANGHAI_OFFSET_MS)
}

function explicitWindow(reportType, explicitPeriod) {
  const start = new Date(explicitPeriod?.periodStart)
  const end = new Date(explicitPeriod?.periodEnd)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new Error(`${reportType} requires a valid explicit periodStart and periodEnd`)
  }
  return { periodStart: start, periodEnd: end }
}

export async function loadPestimReportingContract(file = CONTRACT_URL) {
  const contract = JSON.parse(await fs.readFile(file, 'utf8'))
  const errors = []
  if (!SEMVER_RE.test(String(contract.contractVersion || ''))) errors.push('contractVersion must be semantic version')
  if (!SEMVER_RE.test(String(contract.baseSchemaVersion || ''))) errors.push('baseSchemaVersion must be semantic version')
  if (!SEMVER_RE.test(String(contract.candidateSchemaVersion || ''))) errors.push('candidateSchemaVersion must be semantic version')
  if (contract.status !== 'contract_only') errors.push('status must remain contract_only before production approval')
  if (contract.proposalKey !== 'P1-SI-E') errors.push('proposalKey must be P1-SI-E')
  if (contract.compatibilityExpectation !== 'compatible') errors.push('compatibilityExpectation must be compatible')
  if (contract.deploymentAllowed !== false) errors.push('deploymentAllowed must remain false')
  if (contract.timezone !== 'Asia/Shanghai') errors.push('timezone must be Asia/Shanghai')
  for (const field of ['reportTypes', 'structuredInputTypes', 'forbiddenInputTypes', 'projectionChannels']) {
    if (!Array.isArray(contract[field]) || contract[field].length === 0) errors.push(`${field} must be a non-empty array`)
  }
  for (const template of Object.values(contract.templateFiles || {})) safeFile(PACKAGE_ROOT, template, 'json')
  safeFile(PROJECT_ROOT, contract.candidateMigration, 'sql')
  validateUniqueAdditions(contract.additions, errors)
  if ((contract.additions?.actionTypes || []).length !== 0) errors.push('P1-SI-E must not introduce action types')
  if (errors.length > 0) throw new Error(`invalid PESTIM reporting contract: ${errors.join('; ')}`)
  return contract
}

export function computeReportWindow(reportType, anchorAt, explicitPeriod = null) {
  const anchor = new Date(anchorAt)
  if (!Number.isFinite(anchor.getTime())) throw new Error('anchorAt must be a timestamp')
  const parts = localDateParts(anchor)
  let periodStart
  let periodEnd
  if (reportType === 'daily') {
    periodEnd = shanghaiMidnight(parts.year, parts.month, parts.day)
    periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000)
  } else if (reportType === 'weekly') {
    const currentWeekStart = shanghaiMidnight(parts.year, parts.month, parts.day - (parts.isoWeekday - 1))
    periodEnd = currentWeekStart
    periodStart = new Date(currentWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000)
  } else if (reportType === 'monthly') {
    periodEnd = shanghaiMidnight(parts.year, parts.month, 1)
    periodStart = shanghaiMidnight(parts.year, parts.month - 1, 1)
  } else if (reportType === 'quarterly') {
    const currentQuarterMonth = Math.floor(parts.month / 3) * 3
    periodEnd = shanghaiMidnight(parts.year, currentQuarterMonth, 1)
    periodStart = shanghaiMidnight(parts.year, currentQuarterMonth - 3, 1)
  } else if (reportType === 'semiannual') {
    const currentHalfMonth = parts.month < 6 ? 0 : 6
    periodEnd = shanghaiMidnight(parts.year, currentHalfMonth, 1)
    periodStart = shanghaiMidnight(parts.year, currentHalfMonth - 6, 1)
  } else if (reportType === 'annual') {
    periodEnd = shanghaiMidnight(parts.year, 0, 1)
    periodStart = shanghaiMidnight(parts.year - 1, 0, 1)
  } else if (['alert', 'company', 'p003'].includes(reportType)) {
    ;({ periodStart, periodEnd } = explicitWindow(reportType, explicitPeriod))
  } else {
    throw new Error(`unsupported reportType ${reportType}`)
  }
  return {
    reportType,
    timezone: 'Asia/Shanghai',
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  }
}

export function buildReportInputSet(request, inputs, contract) {
  const errors = []
  if (!contract.reportTypes.includes(request?.reportType)) errors.push('unsupported reportType')
  for (const field of ['periodStart', 'periodEnd', 'evidenceCutoffAt', 'createdAt']) if (!validTimestamp(request?.[field])) errors.push(`${field} must be a timestamp`)
  if (validTimestamp(request?.periodStart) && validTimestamp(request?.periodEnd) && Date.parse(request.periodStart) >= Date.parse(request.periodEnd)) errors.push('periodStart must precede periodEnd')
  if (validTimestamp(request?.periodEnd) && validTimestamp(request?.evidenceCutoffAt) && Date.parse(request.evidenceCutoffAt) < Date.parse(request.periodEnd)) errors.push('evidenceCutoffAt must not precede periodEnd')
  for (const field of ['sourceRegistryVersion', 'ontologyVersion', 'causalGraphVersion']) if (!String(request?.[field] || '').trim()) errors.push(`${field} is required`)
  if (!Array.isArray(inputs)) errors.push('inputs must be an array')
  const normalizedInputs = []
  for (const [index, input] of (inputs || []).entries()) {
    if (contract.forbiddenInputTypes.includes(input?.type)) errors.push(`inputs[${index}].type is forbidden`)
    else if (!contract.structuredInputTypes.includes(input?.type)) errors.push(`inputs[${index}].type is unsupported`)
    if (!String(input?.id || '').trim()) errors.push(`inputs[${index}].id is required`)
    if (!HASH_RE.test(String(input?.hash || ''))) errors.push(`inputs[${index}].hash must be SHA-256`)
    if (Array.isArray(input?.sourceSnapshotIds) && input.sourceSnapshotIds.some((id) => !String(id || '').trim())) errors.push(`inputs[${index}].sourceSnapshotIds contains an empty id`)
    normalizedInputs.push({
      type: input?.type,
      id: String(input?.id || ''),
      hash: String(input?.hash || ''),
      sourceSnapshotIds: [...(input?.sourceSnapshotIds || [])].map(String).sort(),
    })
  }
  if (errors.length > 0) throw new Error(`invalid report input set: ${errors.join('; ')}`)
  normalizedInputs.sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`, 'en'))
  const sourceSnapshotIds = [...new Set(normalizedInputs.flatMap((input) => input.type === 'raw_snapshot' ? [input.id, ...input.sourceSnapshotIds] : input.sourceSnapshotIds))].sort()
  const manifestBody = {
    reportType: request.reportType,
    periodStart: new Date(request.periodStart).toISOString(),
    periodEnd: new Date(request.periodEnd).toISOString(),
    evidenceCutoffAt: new Date(request.evidenceCutoffAt).toISOString(),
    sourceRegistryVersion: request.sourceRegistryVersion,
    ontologyVersion: request.ontologyVersion,
    causalGraphVersion: request.causalGraphVersion,
    inputs: normalizedInputs,
  }
  const inputHash = contentHash(manifestBody)
  return {
    inputSetKey: inputHash,
    ...manifestBody,
    inputHash,
    sourceSnapshotIds,
    createdAt: new Date(request.createdAt).toISOString(),
  }
}

export function validateReportRun(reportRun, contract) {
  const errors = []
  if (!contract.reportTypes.includes(reportRun?.reportType)) errors.push('unsupported reportType')
  for (const field of ['periodStart', 'periodEnd', 'evidenceCutoffAt']) if (!validTimestamp(reportRun?.[field])) errors.push(`${field} must be a timestamp`)
  if (validTimestamp(reportRun?.periodStart) && validTimestamp(reportRun?.periodEnd) && Date.parse(reportRun.periodStart) >= Date.parse(reportRun.periodEnd)) errors.push('periodStart must precede periodEnd')
  if (validTimestamp(reportRun?.periodEnd) && validTimestamp(reportRun?.evidenceCutoffAt) && Date.parse(reportRun.evidenceCutoffAt) < Date.parse(reportRun.periodEnd)) errors.push('evidenceCutoffAt must not precede periodEnd')
  if (!HASH_RE.test(String(reportRun?.inputHash || ''))) errors.push('inputHash must be SHA-256')
  if (!Array.isArray(reportRun?.sourceSnapshotIds)) errors.push('sourceSnapshotIds must be an array')
  for (const field of ['sourceRegistryVersion', 'ontologyVersion', 'causalGraphVersion', 'modelProvider', 'modelId', 'promptVersion', 'status']) {
    if (!String(reportRun?.[field] || '').trim()) errors.push(`${field} is required`)
  }
  for (const field of ['inputTokens', 'outputTokens', 'costMicrounits', 'retryCount']) {
    if (!Number.isInteger(reportRun?.[field]) || reportRun[field] < 0) errors.push(`${field} must be an integer >= 0`)
  }
  if (reportRun?.durationMs !== null && reportRun?.durationMs !== undefined && (!Number.isInteger(reportRun.durationMs) || reportRun.durationMs < 0)) errors.push('durationMs must be null or an integer >= 0')
  if (!['pending', 'running', 'succeeded', 'failed', 'cancelled'].includes(reportRun?.status)) errors.push('status is unsupported')
  return { ok: errors.length === 0, errors }
}

export async function loadPestimReportingTemplates(contract) {
  const templates = {}
  for (const [name, relative] of Object.entries(contract.templateFiles)) {
    templates[name] = JSON.parse(await fs.readFile(safeFile(PACKAGE_ROOT, relative, 'json'), 'utf8'))
  }
  return templates
}

export function applyPestimReportingContract(baseline, contract) {
  if (baseline.schemaVersion !== contract.baseSchemaVersion) throw new Error(`baseline schema ${baseline.schemaVersion} does not match ${contract.baseSchemaVersion}`)
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

export async function compilePestimReportingProposal(options = {}) {
  const contract = await loadPestimReportingContract(options.contractFile)
  const dataFoundation = await compilePestimDataFoundationProposal(options)
  if (dataFoundation.candidate.schemaVersion !== contract.baseSchemaVersion) throw new Error(`P1-SI-D candidate ${dataFoundation.candidate.schemaVersion} does not match ${contract.baseSchemaVersion}`)
  const candidate = applyPestimReportingContract(dataFoundation.candidate.definition, contract)
  const candidateCompiled = compileDefinition(candidate)
  if (!candidateCompiled.ok) throw new Error(`reporting candidate failed: ${JSON.stringify(candidateCompiled.errors)}`)
  const compatibility = compareDefinitions(dataFoundation.candidate.definition, candidateCompiled.bundle.definition)
  if (compatibility.classification !== contract.compatibilityExpectation) throw new Error(`compatibility ${compatibility.classification} does not match ${contract.compatibilityExpectation}`)
  const templates = await loadPestimReportingTemplates(contract)
  return {
    contract,
    dataFoundation,
    templates,
    baseline: dataFoundation.candidate,
    candidate: candidateCompiled.bundle,
    compatibility,
    candidateMigrationFile: safeFile(PROJECT_ROOT, contract.candidateMigration, 'sql'),
  }
}
