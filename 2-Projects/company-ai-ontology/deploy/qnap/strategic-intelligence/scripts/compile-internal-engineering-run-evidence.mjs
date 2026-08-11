#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const files = {
  collectorStdout: argument('--collector-stdout'),
  collectorStderr: argument('--collector-stderr'),
  plan: argument('--plan'),
  config: argument('--config'),
  stateRoot: argument('--state-root'),
  reportRoot: argument('--report-root'),
  runtimeBefore: argument('--runtime-before'),
  runtimeAfter: argument('--runtime-after'),
  sideEffectAudit: argument('--side-effect-audit'),
  output: argument('--output'),
}
const startedAtInput = argument('--started-at')
const completedAtInput = argument('--completed-at')
const exitCode = Number(argument('--exit-code', '1'))
for (const [key, value] of Object.entries(files)) {
  if (!value) throw new Error(`${key} is required`)
}
if (!Number.isInteger(exitCode) || exitCode < 0) throw new Error('exit code must be a non-negative integer')
if (!Number.isFinite(Date.parse(startedAtInput)) || !Number.isFinite(Date.parse(completedAtInput))) throw new Error('run timestamps are invalid')

const HASH = /^[0-9a-f]{64}$/
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

async function readBytes(file) {
  try {
    return await fs.readFile(path.resolve(file))
  } catch {
    return null
  }
}

async function readJson(file) {
  const bytes = await readBytes(file)
  if (!bytes) return { value: null, bytes: null, hash: null }
  try {
    return { value: JSON.parse(bytes.toString('utf8')), bytes, hash: sha256(bytes) }
  } catch {
    return { value: null, bytes, hash: sha256(bytes) }
  }
}

function safeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function parseJsonOutput(bytes) {
  if (!bytes) return null
  const text = bytes.toString('utf8').trim()
  try {
    return JSON.parse(text)
  } catch {
    for (const line of text.split('\n').reverse()) {
      try {
        return JSON.parse(line)
      } catch {
        continue
      }
    }
    return null
  }
}

function runtimeFoundation(snapshot, expectedPhase) {
  if (snapshot?.snapshotVersion !== '1.0.0' || snapshot?.phase !== expectedPhase) return null
  const state = snapshot?.foundation
  if (!state || typeof state !== 'object') return null
  return {
    containerCount: safeInteger(state.containerCount),
    runningContainerCount: safeInteger(state.runningContainerCount),
    unhealthyContainerCount: safeInteger(state.unhealthyContainerCount),
    restartCountTotal: safeInteger(state.restartCountTotal),
    fingerprint: HASH.test(String(state.fingerprint || '')) ? state.fingerprint : sha256('invalid-foundation-state'),
  }
}

function runtimeStrategic(snapshot, expectedPhase) {
  if (snapshot?.snapshotVersion !== '1.0.0' || snapshot?.phase !== expectedPhase) return null
  const state = snapshot?.strategicIntelligence
  if (!state || typeof state !== 'object') return null
  return {
    containerCount: safeInteger(state.containerCount),
    runningContainerCount: safeInteger(state.runningContainerCount),
    networkCount: safeInteger(state.networkCount),
    publishedPortCount: safeInteger(state.publishedPortCount),
    fingerprint: HASH.test(String(state.fingerprint || '')) ? state.fingerprint : sha256('invalid-strategic-state'),
  }
}

const [planInput, configInput, stdoutInput, stderrBytes, runtimeBeforeInput, runtimeAfterInput, sideEffectInput] = await Promise.all([
  readJson(files.plan),
  readJson(files.config),
  readJson(files.collectorStdout),
  readBytes(files.collectorStderr),
  readJson(files.runtimeBefore),
  readJson(files.runtimeAfter),
  readJson(files.sideEffectAudit),
])
const plan = planInput.value
const config = configInput.value
const stderrJson = parseJsonOutput(stderrBytes)
const stdoutSummary = stdoutInput.value
const runId = typeof stdoutSummary?.runId === 'string' ? stdoutSummary.runId : (typeof stderrJson?.runId === 'string' ? stderrJson.runId : null)
const runDir = runId ? path.join(path.resolve(files.stateRoot), 'runs', runId) : null
const runInput = runDir ? await readJson(path.join(runDir, 'run.json')) : { value: null, hash: null }
const decisionsInput = runDir ? await readJson(path.join(runDir, 'source-decisions.json')) : { value: null, hash: null }
const itemsInput = runDir ? await readJson(path.join(runDir, 'items.json')) : { value: null, hash: null }
const candidateInput = runId ? await readJson(path.join(path.resolve(files.reportRoot), `candidate-${runId}.json`)) : { value: null, hash: null }
const selectedSources = Array.isArray(plan?.selectedSources) ? plan.selectedSources : []
const expectedKeys = selectedSources.map((source) => source?.sourceKey).filter(Boolean)
const decisions = Array.isArray(decisionsInput.value) ? decisionsInput.value : []
const items = Array.isArray(itemsInput.value) ? itemsInput.value : []
const rawSnapshots = []
if (runDir) {
  for (const source of selectedSources) {
    rawSnapshots.push({
      sourceKey: source.sourceKey,
      ...(await readJson(path.join(runDir, 'raw', `${source.sourceKey}.snapshot.json`))),
    })
  }
}
const rawSnapshotHash = rawSnapshots.every((snapshot) => snapshot.bytes)
  ? sha256(Buffer.concat(rawSnapshots.flatMap((snapshot) => [Buffer.from(`${snapshot.sourceKey}\n`), snapshot.bytes])))
  : null

const sourceRows = selectedSources.map((source) => {
  const decision = decisions.find((candidate) => candidate?.sourceKey === source.sourceKey)
  const snapshot = rawSnapshots.find((candidate) => candidate.sourceKey === source.sourceKey)?.value
  const itemCount = items.filter((item) => item?.sourceKey === source.sourceKey).length
  const decisionAllowed = decision?.allowed === true
  const snapshotPresent = Boolean(snapshot)
  return {
    sourceKey: source.sourceKey,
    decisionAllowed,
    snapshotPresent,
    itemCount,
    succeeded: decisionAllowed && snapshotPresent && itemCount > 0,
  }
})
const decisionKeys = decisions.map((decision) => decision?.sourceKey).filter(Boolean).sort()
const expectedKeysSorted = [...expectedKeys].sort()
const itemKeysCovered = [...new Set(items.map((item) => item?.sourceKey).filter(Boolean))].sort()
const allSelectedSourcesCovered = expectedKeys.length === 3
  && JSON.stringify(decisionKeys) === JSON.stringify(expectedKeysSorted)
  && JSON.stringify(itemKeysCovered) === JSON.stringify(expectedKeysSorted)
  && rawSnapshots.every((snapshot) => Boolean(snapshot.value))
const allDecisionsAllowed = decisions.length === 3 && decisions.every((decision) => decision?.allowed === true)
const maxItemsPerSource = Number.isInteger(config?.maxItemsPerSource) ? config.maxItemsPerSource : 0
const maximumObservedItemsPerSource = Math.max(0, ...sourceRows.map((source) => source.itemCount))
const itemLimitSatisfied = maxItemsPerSource === 20 && maximumObservedItemsPerSource <= 20
const invalidSnapshots = rawSnapshots.filter((snapshot) => {
  const value = snapshot.value
  const planned = selectedSources.find((source) => source.sourceKey === snapshot.sourceKey)
  return !value
    || value.sourceKey !== snapshot.sourceKey
    || value.payloadRetention !== 'hash_only'
    || value.bodyBase64 !== null
    || !HASH.test(String(value.contentHash || ''))
    || !['reference_only', 'metadata_only'].includes(value.retentionStorageLevel)
    || value.retentionStorageLevel !== planned?.storageLevel
}).length
const retainedBodyCount = rawSnapshots.filter((snapshot) => snapshot.value?.bodyBase64 !== null && snapshot.value?.bodyBase64 !== undefined).length
const allPayloadHashOnly = rawSnapshots.length === 3 && invalidSnapshots === 0 && retainedBodyCount === 0

const runSummary = runInput.value || stdoutSummary
const candidateReportVerified = Boolean(candidateInput.value)
  && candidateInput.value.runId === runId
  && candidateInput.value.status === 'succeeded'
  && Array.isArray(candidateInput.value.items)
  && candidateInput.value.items.length === items.length
  && JSON.stringify(candidateInput.value.items) === JSON.stringify(items)
const stdoutMatchesRun = Boolean(stdoutSummary && runInput.value)
  && stdoutSummary.runId === runInput.value.runId
  && stdoutSummary.status === runInput.value.status
  && stdoutSummary.operationMode === runInput.value.operationMode
  && stdoutSummary.publish === runInput.value.publish
  && stdoutSummary.countsTowardProductionShadow === runInput.value.countsTowardProductionShadow
  && stdoutSummary.sourceCount === runInput.value.sourceCount
  && stdoutSummary.rawSnapshotCount === runInput.value.rawSnapshotCount
  && stdoutSummary.itemCount === runInput.value.itemCount
const collectorSucceeded = exitCode === 0
  && stdoutMatchesRun
  && runSummary?.status === 'succeeded'
  && runSummary?.operationMode === 'internal_engineering_shadow'
  && runSummary?.publish === false
  && runSummary?.countsTowardProductionShadow === false
  && runSummary?.sourceCount === 3
  && runSummary?.rawSnapshotCount === 3
  && runSummary?.sourceDecisionCount === 3
  && runSummary?.itemCount === items.length
  && candidateReportVerified

const foundationBefore = runtimeFoundation(runtimeBeforeInput.value, 'before')
const foundationAfter = runtimeFoundation(runtimeAfterInput.value, 'after')
const strategicBefore = runtimeStrategic(runtimeBeforeInput.value, 'before')
const strategicAfter = runtimeStrategic(runtimeAfterInput.value, 'after')
const foundationStable = Boolean(foundationBefore && foundationAfter)
  && foundationBefore.containerCount === 13
  && foundationAfter.containerCount === 13
  && foundationBefore.runningContainerCount === 13
  && foundationAfter.runningContainerCount === 13
  && foundationBefore.unhealthyContainerCount === 0
  && foundationAfter.unhealthyContainerCount === 0
  && foundationBefore.restartCountTotal === 0
  && foundationAfter.restartCountTotal === 0
  && foundationBefore.fingerprint === foundationAfter.fingerprint
const temporaryResourcesClean = Boolean(strategicBefore && strategicAfter)
  && strategicBefore.containerCount === 0
  && strategicBefore.runningContainerCount === 0
  && strategicBefore.networkCount === 0
  && strategicBefore.publishedPortCount === 0
  && strategicAfter.containerCount === 0
  && strategicAfter.runningContainerCount === 0
  && strategicAfter.networkCount === 0
  && strategicAfter.publishedPortCount === 0
const newNetworkCount = strategicBefore && strategicAfter ? Math.max(0, strategicAfter.networkCount - strategicBefore.networkCount) : 0
const newPublishedPortCount = strategicBefore && strategicAfter ? Math.max(0, strategicAfter.publishedPortCount - strategicBefore.publishedPortCount) : 0

const sideEffectAudit = sideEffectInput.value
const sideEffectCounts = {
  formalP2Count: safeInteger(sideEffectAudit?.formalP2Count),
  employeeDeliveryCount: safeInteger(sideEffectAudit?.employeeDeliveryCount),
  erpWritebackCount: safeInteger(sideEffectAudit?.erpWritebackCount),
  socialWritebackCount: safeInteger(sideEffectAudit?.socialWritebackCount),
  causalActivationCount: safeInteger(sideEffectAudit?.causalActivationCount),
}
const auditCompleted = sideEffectAudit?.auditVersion === '1.0.0'
  && sideEffectAudit?.completed === true
  && Number.isFinite(Date.parse(sideEffectAudit?.windowStart))
  && Number.isFinite(Date.parse(sideEffectAudit?.windowEnd))
  && Date.parse(sideEffectAudit.windowStart) === Date.parse(startedAtInput)
  && Date.parse(sideEffectAudit.windowEnd) === Date.parse(completedAtInput)
const businessSideEffectsZero = auditCompleted && Object.values(sideEffectCounts).every((value) => value === 0)
const sourceCoverageVerified = sourceRows.length === 3
  && sourceRows.every((source) => source.succeeded)
  && allDecisionsAllowed
  && allSelectedSourcesCovered
const retentionVerified = allPayloadHashOnly && invalidSnapshots === 0
const evidenceComplete = Boolean(
  planInput.value
  && configInput.value
  && stdoutInput.hash
  && runInput.hash
  && decisionsInput.hash
  && itemsInput.hash
  && rawSnapshotHash
  && candidateInput.hash
  && runtimeBeforeInput.hash
  && runtimeAfterInput.hash
  && sideEffectInput.hash,
)

const failureCodes = []
if (!evidenceComplete) failureCodes.push('EVIDENCE_INPUT_INCOMPLETE')
if (!collectorSucceeded) failureCodes.push(exitCode === 0 ? 'COLLECTOR_SUMMARY_INVALID' : 'COLLECTOR_EXIT_NONZERO')
if (!sourceCoverageVerified) failureCodes.push('SOURCE_COVERAGE_INVALID')
if (!itemLimitSatisfied) failureCodes.push('ITEM_LIMIT_EXCEEDED')
if (!retentionVerified) failureCodes.push('RAW_RETENTION_UNSAFE')
if (!foundationStable) failureCodes.push('FOUNDATION_RUNTIME_DRIFT')
if (!temporaryResourcesClean) failureCodes.push('TEMPORARY_RESOURCE_LEAK')
if (!businessSideEffectsZero) failureCodes.push(auditCompleted ? 'BUSINESS_SIDE_EFFECT_DETECTED' : 'SIDE_EFFECT_AUDIT_INCOMPLETE')
const acceptedForInternalEngineering = failureCodes.length === 0

const evidence = {
  evidenceVersion: '1.0.0',
  evidenceType: 'internal_engineering_run',
  goalKey: 'P1-STRATEGIC-INTELLIGENCE',
  operationMode: 'internal_engineering_shadow',
  status: acceptedForInternalEngineering ? 'succeeded' : 'failed',
  generatedAt: new Date().toISOString(),
  runId,
  startedAt: new Date(startedAtInput).toISOString(),
  completedAt: new Date(completedAtInput).toISOString(),
  publish: false,
  countsTowardProductionShadow: false,
  collector: {
    exitCode,
    summaryPresent: Boolean(runSummary),
    status: ['succeeded', 'failed'].includes(runSummary?.status) ? runSummary.status : 'unknown',
    sourceCount: safeInteger(runSummary?.sourceCount),
    rawSnapshotCount: safeInteger(runSummary?.rawSnapshotCount),
    itemCount: safeInteger(runSummary?.itemCount),
    duplicateCount: safeInteger(runSummary?.duplicateCount),
    errorCode: typeof runSummary?.errorCode === 'string' ? runSummary.errorCode : (typeof stderrJson?.errorCode === 'string' ? stderrJson.errorCode : null),
    candidateReportVerified,
  },
  sourceVerification: {
    expectedSourceCount: 3,
    successfulSourceCount: sourceRows.filter((source) => source.succeeded).length,
    allDecisionsAllowed,
    allSelectedSourcesCovered,
    maxItemsPerSource: 20,
    maximumObservedItemsPerSource,
    itemLimitSatisfied,
    sources: sourceRows,
  },
  retentionVerification: {
    snapshotCount: rawSnapshots.filter((snapshot) => snapshot.value).length,
    allPayloadHashOnly,
    retainedBodyCount,
    invalidSnapshotCount: invalidSnapshots,
  },
  runtimeVerification: {
    expectedFoundationContainerCount: 13,
    foundationBefore,
    foundationAfter,
    foundationStable,
    strategicIntelligenceBefore: strategicBefore,
    strategicIntelligenceAfter: strategicAfter,
    temporaryResourcesClean,
    newNetworkCount,
    newPublishedPortCount,
  },
  sideEffects: {
    auditCompleted,
    ...sideEffectCounts,
    allZero: businessSideEffectsZero,
  },
  artifactHashes: {
    collectorStdout: stdoutInput.hash,
    collectorStderr: stderrBytes ? sha256(stderrBytes) : null,
    runSummary: runInput.hash,
    sourceDecisions: decisionsInput.hash,
    items: itemsInput.hash,
    rawSnapshots: rawSnapshotHash,
    candidateReport: candidateInput.hash,
    runtimeBefore: runtimeBeforeInput.hash,
    runtimeAfter: runtimeAfterInput.hash,
    sideEffectAudit: sideEffectInput.hash,
  },
  acceptance: {
    evidenceComplete,
    collectorSucceeded,
    sourceCoverageVerified,
    itemLimitVerified: itemLimitSatisfied,
    retentionVerified,
    foundationStable,
    temporaryResourcesClean,
    businessSideEffectsZero,
    acceptedForInternalEngineering,
    eligibleForProductionShadow: false,
  },
  failureCodes,
}

await fs.mkdir(path.dirname(path.resolve(files.output)), { recursive: true, mode: 0o750 })
await fs.writeFile(path.resolve(files.output), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({
  ok: true,
  evidenceCreated: true,
  status: evidence.status,
  runId: evidence.runId,
  acceptedForInternalEngineering,
  countsTowardProductionShadow: false,
  failureCodes,
}, null, 2)}\n`)
