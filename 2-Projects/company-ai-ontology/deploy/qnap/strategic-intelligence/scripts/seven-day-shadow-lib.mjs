import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const REQUIRED_NATURAL_DAYS = 7
export const SHADOW_TIMEZONE = 'Asia/Shanghai'

const COVERAGE_KEYS = [
  'collectorMetricsCollected',
  'resourceMetricsCollected',
  'sensitiveOutputAuditCompleted',
  'sourceRevocationAuditCompleted',
  'businessSideEffectAuditCompleted',
]

const SIDE_EFFECT_KEYS = [
  'formalP2Count',
  'employeeDeliveryCount',
  'erpWritebackCount',
  'socialWritebackCount',
  'causalActivationCount',
]

const ENGINEERING_KEYS = [
  'summaryVersion',
  'shadowStartDate',
  'shadowEndDate',
  'timezone',
  'requiredNaturalDays',
  'completedNaturalDays',
  'simulated',
  'publish',
  'runtimeIdentity',
  'dayEvidence',
  'totals',
  'invariants',
  'engineeringVerified',
  'engineeringEvidenceHash',
]

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}

function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hashJson(value) {
  return hashBytes(JSON.stringify(canonicalize(value)))
}

async function readJsonWithHash(file) {
  const bytes = await fs.readFile(file)
  return {
    value: JSON.parse(bytes.toString('utf8')),
    hash: hashBytes(bytes),
  }
}

function parseNaturalDate(value) {
  requireValue(/^\d{4}-\d{2}-\d{2}$/.test(value || ''), `invalid natural date ${value}`)
  const [year, month, day] = value.split('-').map(Number)
  const timestamp = Date.UTC(year, month - 1, day)
  const parsed = new Date(timestamp)
  requireValue(
    parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day,
    `invalid natural date ${value}`,
  )
  return timestamp
}

function shanghaiDate(timestamp) {
  const date = new Date(timestamp)
  requireValue(!Number.isNaN(date.getTime()), `invalid timestamp ${timestamp}`)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SHADOW_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function requireNonNegativeInteger(value, label) {
  requireValue(Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative integer`)
}

function requireFiniteNumber(value, label) {
  requireValue(Number.isFinite(value) && value >= 0, `${label} must be a non-negative finite number`)
}

function engineeringProjection(summary) {
  return Object.fromEntries(ENGINEERING_KEYS.map((key) => [key, summary[key]]))
}

function requireExactKeys(value, expectedKeys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  requireValue(JSON.stringify(actual) === JSON.stringify(expected), `${label} contains unexpected or missing fields`)
}

function requireRuntimeIdentity(value, label) {
  requireValue(/^[0-9a-f]{40}$/.test(value.sourceCommit || ''), `${label} sourceCommit must be a full Git SHA`)
  requireValue(
    /^sha256:[0-9a-f]{64}$/.test(value.collectorImage || '') || /@sha256:[0-9a-f]{64}$/.test(value.collectorImage || ''),
    `${label} collectorImage must be immutable`,
  )
  requireValue(typeof value.policyVersion === 'string' && value.policyVersion.length > 0, `${label} policyVersion missing`)
  requireValue(/^[0-9a-f]{64}$/.test(value.policyHash || ''), `${label} policyHash invalid`)
}

function validateRunTimestamps(evidence) {
  for (const key of ['requestedAt', 'startedAt', 'completedAt', 'recordedAt']) {
    requireValue(shanghaiDate(evidence[key]) === evidence.localDate, `${evidence.requestKey} ${key} is outside localDate`)
  }
  const requestedAt = new Date(evidence.requestedAt).getTime()
  const startedAt = new Date(evidence.startedAt).getTime()
  const completedAt = new Date(evidence.completedAt).getTime()
  const recordedAt = new Date(evidence.recordedAt).getTime()
  requireValue(requestedAt <= startedAt, `${evidence.requestKey} started before request`)
  requireValue(startedAt <= completedAt, `${evidence.requestKey} completed before start`)
  requireValue(completedAt <= recordedAt, `${evidence.requestKey} recorded before completion`)
  requireValue(recordedAt - completedAt <= 10 * 60 * 1000, `${evidence.requestKey} evidence was not recorded promptly`)
  requireValue(Math.abs((completedAt - startedAt) / 1000 - evidence.durationSeconds) <= 5, `${evidence.requestKey} duration mismatch`)
}

function validateDayEvidence(evidence, expectedDate) {
  const requestKey = `daily-collection-shadow-${expectedDate}`
  requireValue(evidence.evidenceVersion === '1.0.0', `${requestKey} evidenceVersion invalid`)
  requireValue(evidence.requestKey === requestKey, `${requestKey} requestKey mismatch`)
  requireValue(evidence.localDate === expectedDate, `${requestKey} localDate mismatch`)
  requireValue(evidence.timezone === SHADOW_TIMEZONE, `${requestKey} timezone mismatch`)
  requireValue(evidence.simulated === false, `${requestKey} simulated evidence is forbidden`)
  requireValue(evidence.publish === false, `${requestKey} publish must remain false`)
  requireValue(evidence.status === 'succeeded', `${requestKey} status must be succeeded`)
  requireNonNegativeInteger(evidence.durationSeconds, `${requestKey} durationSeconds`)
  requireValue(evidence.exitCode === 0, `${requestKey} exitCode must be zero`)
  requireValue(evidence.timeoutCount === 0, `${requestKey} timeoutCount must be zero`)
  requireNonNegativeInteger(evidence.sourceAttemptCount, `${requestKey} sourceAttemptCount`)
  requireNonNegativeInteger(evidence.sourceSuccessCount, `${requestKey} sourceSuccessCount`)
  requireValue(evidence.sourceAttemptCount > 0, `${requestKey} sourceAttemptCount must be greater than zero`)
  requireValue(evidence.sourceSuccessCount > 0, `${requestKey} sourceSuccessCount must be greater than zero`)
  requireValue(evidence.sourceSuccessCount <= evidence.sourceAttemptCount, `${requestKey} sourceSuccessCount exceeds attempts`)
  for (const key of ['rawSnapshotCount', 'normalizedItemCount', 'duplicateCount', 'freshnessP95Seconds', 'rawSnapshotBytes', 'networkBytes', 'peakCpuPermille', 'peakMemoryBytes']) {
    requireNonNegativeInteger(evidence[key], `${requestKey} ${key}`)
  }
  requireFiniteNumber(evidence.reportCostsUsd?.daily, `${requestKey} reportCostsUsd.daily`)
  requireFiniteNumber(evidence.reportCostsUsd?.weekly, `${requestKey} reportCostsUsd.weekly`)
  for (const key of ['unredactedSensitiveOutputCount', 'sourceRevocationEffectiveSeconds', 'postRevocationNetworkRequestCount']) {
    requireNonNegativeInteger(evidence.security?.[key], `${requestKey} security.${key}`)
  }
  requireValue(evidence.security?.lastGoodPreserved === true, `${requestKey} lastGoodPreserved must be true`)
  for (const key of COVERAGE_KEYS) requireValue(evidence.coverage?.[key] === true, `${requestKey} coverage ${key} missing`)
  for (const key of SIDE_EFFECT_KEYS) {
    requireNonNegativeInteger(evidence.sideEffects?.[key], `${requestKey} sideEffects.${key}`)
    requireValue(evidence.sideEffects[key] === 0, `${requestKey} sideEffects.${key} must remain zero`)
  }
  requireValue(evidence.runtime?.containerRestartCount === 0, `${requestKey} containerRestartCount must remain zero`)
  requireValue(evidence.runtime?.newHostPortCount === 0, `${requestKey} newHostPortCount must remain zero`)
  requireRuntimeIdentity({
    sourceCommit: evidence.runtime?.sourceCommit,
    collectorImage: evidence.runtime?.collectorImage,
    policyVersion: evidence.policyVersion,
    policyHash: evidence.policyHash,
  }, requestKey)
  validateRunTimestamps(evidence)
}

function validateEvaluation(evaluation, evidence, evidenceHash) {
  requireValue(evaluation.ok === true, `${evidence.requestKey} evaluation did not pass`)
  requireValue(evaluation.critical === false, `${evidence.requestKey} evaluation is critical`)
  requireValue(Array.isArray(evaluation.violations) && evaluation.violations.length === 0, `${evidence.requestKey} evaluation has violations`)
  requireValue(evaluation.requestKey === evidence.requestKey, `${evidence.requestKey} evaluation requestKey mismatch`)
  requireValue(evaluation.localDate === evidence.localDate, `${evidence.requestKey} evaluation localDate mismatch`)
  requireValue(evaluation.policyVersion === evidence.policyVersion, `${evidence.requestKey} evaluation policyVersion mismatch`)
  requireValue(evaluation.policyHash === evidence.policyHash, `${evidence.requestKey} evaluation policyHash mismatch`)
  requireValue(evaluation.evidenceHash === evidenceHash, `${evidence.requestKey} evaluation evidenceHash mismatch`)
}

export async function compileSevenDayEngineeringSummary(evidenceRoot) {
  const entries = await fs.readdir(evidenceRoot, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && /^daily-collection-shadow-\d{4}-\d{2}-\d{2}\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  requireValue(files.length === REQUIRED_NATURAL_DAYS, `expected exactly ${REQUIRED_NATURAL_DAYS} day evidence files, found ${files.length}`)

  const dayEvidence = []
  const totals = {
    sourceAttemptCount: 0,
    sourceSuccessCount: 0,
    rawSnapshotCount: 0,
    normalizedItemCount: 0,
    duplicateCount: 0,
    rawSnapshotBytes: 0,
    networkBytes: 0,
    dailyReportCostUsd: 0,
    weeklyReportCostUsd: 0,
    peakCpuPermilleMax: 0,
    peakMemoryBytesMax: 0,
    sideEffects: Object.fromEntries(SIDE_EFFECT_KEYS.map((key) => [key, 0])),
    containerRestartCount: 0,
    newHostPortCount: 0,
  }
  let runtimeIdentity = null
  let previousTimestamp = null

  for (let index = 0; index < files.length; index += 1) {
    const evidenceFile = files[index]
    const expectedDate = evidenceFile.slice('daily-collection-shadow-'.length, -'.json'.length)
    const naturalTimestamp = parseNaturalDate(expectedDate)
    if (previousTimestamp !== null) requireValue(naturalTimestamp - previousTimestamp === 86400000, `shadow dates are not consecutive at ${expectedDate}`)
    previousTimestamp = naturalTimestamp

    const evidencePath = path.join(evidenceRoot, evidenceFile)
    const evaluationFile = `${evidenceFile}.evaluation.json`
    const evaluationPath = path.join(evidenceRoot, evaluationFile)
    const { value: evidence, hash: evidenceHash } = await readJsonWithHash(evidencePath)
    const { value: evaluation, hash: evaluationHash } = await readJsonWithHash(evaluationPath)
    validateDayEvidence(evidence, expectedDate)
    validateEvaluation(evaluation, evidence, evidenceHash)

    const currentIdentity = {
      sourceCommit: evidence.runtime.sourceCommit,
      collectorImage: evidence.runtime.collectorImage,
      policyVersion: evidence.policyVersion,
      policyHash: evidence.policyHash,
    }
    if (!runtimeIdentity) runtimeIdentity = currentIdentity
    else requireValue(hashJson(currentIdentity) === hashJson(runtimeIdentity), `${evidence.requestKey} runtime identity drift detected`)

    for (const key of ['sourceAttemptCount', 'sourceSuccessCount', 'rawSnapshotCount', 'normalizedItemCount', 'duplicateCount', 'rawSnapshotBytes', 'networkBytes']) {
      requireNonNegativeInteger(evidence[key], `${evidence.requestKey} ${key}`)
      totals[key] += evidence[key]
    }
    totals.dailyReportCostUsd += evidence.reportCostsUsd.daily
    totals.weeklyReportCostUsd += evidence.reportCostsUsd.weekly
    totals.peakCpuPermilleMax = Math.max(totals.peakCpuPermilleMax, evidence.peakCpuPermille)
    totals.peakMemoryBytesMax = Math.max(totals.peakMemoryBytesMax, evidence.peakMemoryBytes)
    for (const key of SIDE_EFFECT_KEYS) totals.sideEffects[key] += evidence.sideEffects[key]
    totals.containerRestartCount += evidence.runtime.containerRestartCount
    totals.newHostPortCount += evidence.runtime.newHostPortCount

    dayEvidence.push({
      dayNumber: index + 1,
      localDate: expectedDate,
      requestKey: evidence.requestKey,
      recordedAt: evidence.recordedAt,
      evidenceFile,
      evidenceHash,
      evaluationFile,
      evaluationHash,
    })
  }

  const engineering = {
    summaryVersion: '1.0.0',
    shadowStartDate: dayEvidence[0].localDate,
    shadowEndDate: dayEvidence.at(-1).localDate,
    timezone: SHADOW_TIMEZONE,
    requiredNaturalDays: REQUIRED_NATURAL_DAYS,
    completedNaturalDays: REQUIRED_NATURAL_DAYS,
    simulated: false,
    publish: false,
    runtimeIdentity,
    dayEvidence,
    totals,
    invariants: {
      consecutiveNaturalDays: true,
      allRunsSucceeded: true,
      allEvaluationsPassed: true,
      coverageComplete: true,
      runtimeIdentityStable: true,
      forbiddenSideEffectsZero: true,
      noNewHostPorts: true,
      containerRestartsZero: true,
    },
    engineeringVerified: true,
  }
  engineering.engineeringEvidenceHash = hashJson(engineering)
  return {
    ...engineering,
    ownerAcceptance: {
      ownerAccepted: false,
      acceptedAt: null,
      acceptedByPrincipalRef: null,
      acceptanceRef: null,
      ownerAcceptanceHash: null,
    },
  }
}

export async function verifyEngineeringSummary(summary, evidenceRoot) {
  requireExactKeys(summary, [...ENGINEERING_KEYS, 'ownerAcceptance'], 'seven-day summary')
  const expected = await compileSevenDayEngineeringSummary(evidenceRoot)
  requireValue(
    hashJson(engineeringProjection(summary)) === hashJson(engineeringProjection(expected)),
    'seven-day engineering summary does not match current daily evidence',
  )
  return expected
}

export function recordOwnerAcceptance(summary, { acceptedAt, acceptedByPrincipalRef, acceptanceRef }) {
  requireValue(summary.engineeringVerified === true, 'engineeringVerified must be true before owner acceptance')
  requireValue(!Number.isNaN(new Date(acceptedAt).getTime()), 'acceptedAt must be an ISO timestamp')
  requireValue(typeof acceptedByPrincipalRef === 'string' && acceptedByPrincipalRef.length >= 8, 'acceptedByPrincipalRef is required')
  requireValue(typeof acceptanceRef === 'string' && acceptanceRef.length >= 8, 'acceptanceRef is required')
  requireValue(new Date(acceptedAt).getTime() >= new Date(summary.dayEvidence.at(-1)?.recordedAt).getTime(), 'owner acceptance must occur after the seventh run')
  const acceptance = {
    ownerAccepted: true,
    acceptedAt: new Date(acceptedAt).toISOString(),
    acceptedByPrincipalRef,
    acceptanceRef,
  }
  return {
    ...summary,
    ownerAcceptance: {
      ...acceptance,
      ownerAcceptanceHash: hashJson({ engineeringEvidenceHash: summary.engineeringEvidenceHash, ...acceptance }),
    },
  }
}

export async function verifyAcceptedSummary(summary, evidenceRoot) {
  await verifyEngineeringSummary(summary, evidenceRoot)
  const acceptance = summary.ownerAcceptance
  requireExactKeys(acceptance, ['ownerAccepted', 'acceptedAt', 'acceptedByPrincipalRef', 'acceptanceRef', 'ownerAcceptanceHash'], 'ownerAcceptance')
  requireValue(acceptance?.ownerAccepted === true, 'ownerAccepted must be true')
  requireValue(!Number.isNaN(new Date(acceptance.acceptedAt).getTime()), 'owner acceptedAt invalid')
  requireValue(typeof acceptance.acceptedByPrincipalRef === 'string' && acceptance.acceptedByPrincipalRef.length >= 8, 'owner principal missing')
  requireValue(typeof acceptance.acceptanceRef === 'string' && acceptance.acceptanceRef.length >= 8, 'owner acceptanceRef missing')
  requireValue(new Date(acceptance.acceptedAt).getTime() >= new Date(summary.dayEvidence.at(-1)?.recordedAt).getTime(), 'owner acceptance predates the seventh run')
  const expectedHash = hashJson({
    engineeringEvidenceHash: summary.engineeringEvidenceHash,
    ownerAccepted: true,
    acceptedAt: new Date(acceptance.acceptedAt).toISOString(),
    acceptedByPrincipalRef: acceptance.acceptedByPrincipalRef,
    acceptanceRef: acceptance.acceptanceRef,
  })
  requireValue(acceptance.ownerAcceptanceHash === expectedHash, 'ownerAcceptanceHash mismatch')
  return summary
}

export async function writeJson600(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o750 })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

export function fileSha256(bytes) {
  return hashBytes(bytes)
}
