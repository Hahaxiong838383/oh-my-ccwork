#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const evidenceFile = process.argv[2]
if (!evidenceFile) throw new Error('internal engineering run evidence file is required')
const evidence = JSON.parse(await fs.readFile(path.resolve(evidenceFile), 'utf8'))
const errors = []
const HASH = /^[0-9a-f]{64}$/

function requireValue(condition, message) {
  if (!condition) errors.push(message)
}

function exactKeys(value, keys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  requireValue(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} contains unexpected or missing fields`)
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function validHashOrNull(value) {
  return value === null || HASH.test(String(value || ''))
}

exactKeys(evidence, ['evidenceVersion', 'evidenceType', 'goalKey', 'operationMode', 'status', 'generatedAt', 'runId', 'startedAt', 'completedAt', 'publish', 'countsTowardProductionShadow', 'collector', 'sourceVerification', 'retentionVerification', 'runtimeVerification', 'sideEffects', 'artifactHashes', 'acceptance', 'failureCodes'], 'evidence')
requireValue(evidence.evidenceVersion === '1.0.0', 'evidenceVersion mismatch')
requireValue(evidence.evidenceType === 'internal_engineering_run', 'evidenceType mismatch')
requireValue(evidence.goalKey === 'P1-STRATEGIC-INTELLIGENCE', 'goalKey mismatch')
requireValue(evidence.operationMode === 'internal_engineering_shadow', 'operationMode mismatch')
requireValue(['succeeded', 'failed'].includes(evidence.status), 'status invalid')
requireValue(validTimestamp(evidence.generatedAt), 'generatedAt invalid')
requireValue(evidence.runId === null || (typeof evidence.runId === 'string' && evidence.runId.length > 0), 'runId invalid')
requireValue(validTimestamp(evidence.startedAt), 'startedAt invalid')
requireValue(validTimestamp(evidence.completedAt), 'completedAt invalid')
requireValue(validTimestamp(evidence.startedAt) && validTimestamp(evidence.completedAt) && Date.parse(evidence.completedAt) >= Date.parse(evidence.startedAt), 'completedAt predates startedAt')
requireValue(validTimestamp(evidence.generatedAt) && validTimestamp(evidence.completedAt) && Date.parse(evidence.generatedAt) >= Date.parse(evidence.completedAt), 'generatedAt predates completedAt')
requireValue(evidence.publish === false, 'publish must remain false')
requireValue(evidence.countsTowardProductionShadow === false, 'countsTowardProductionShadow must remain false')

exactKeys(evidence.collector, ['exitCode', 'summaryPresent', 'status', 'sourceCount', 'rawSnapshotCount', 'itemCount', 'duplicateCount', 'errorCode', 'candidateReportVerified'], 'collector')
requireValue(nonNegativeInteger(evidence.collector?.exitCode), 'collector exitCode invalid')
requireValue(typeof evidence.collector?.summaryPresent === 'boolean', 'collector summaryPresent invalid')
requireValue(['succeeded', 'failed', 'unknown'].includes(evidence.collector?.status), 'collector status invalid')
for (const key of ['sourceCount', 'rawSnapshotCount', 'itemCount', 'duplicateCount']) requireValue(nonNegativeInteger(evidence.collector?.[key]), `collector ${key} invalid`)
requireValue(evidence.collector?.errorCode === null || typeof evidence.collector?.errorCode === 'string', 'collector errorCode invalid')
requireValue(typeof evidence.collector?.candidateReportVerified === 'boolean', 'candidateReportVerified invalid')

exactKeys(evidence.sourceVerification, ['expectedSourceCount', 'successfulSourceCount', 'allDecisionsAllowed', 'allSelectedSourcesCovered', 'maxItemsPerSource', 'maximumObservedItemsPerSource', 'itemLimitSatisfied', 'sources'], 'sourceVerification')
requireValue(evidence.sourceVerification?.expectedSourceCount === 3, 'expectedSourceCount must equal 3')
requireValue(nonNegativeInteger(evidence.sourceVerification?.successfulSourceCount) && evidence.sourceVerification.successfulSourceCount <= 3, 'successfulSourceCount invalid')
requireValue(evidence.sourceVerification?.maxItemsPerSource === 20, 'maxItemsPerSource must equal 20')
requireValue(nonNegativeInteger(evidence.sourceVerification?.maximumObservedItemsPerSource), 'maximumObservedItemsPerSource invalid')
for (const key of ['allDecisionsAllowed', 'allSelectedSourcesCovered', 'itemLimitSatisfied']) requireValue(typeof evidence.sourceVerification?.[key] === 'boolean', `${key} invalid`)
requireValue(Array.isArray(evidence.sourceVerification?.sources) && evidence.sourceVerification.sources.length === 3, 'sources must contain exactly 3 entries')
const sourceKeys = []
for (const source of evidence.sourceVerification?.sources || []) {
  exactKeys(source, ['sourceKey', 'decisionAllowed', 'snapshotPresent', 'itemCount', 'succeeded'], 'source verification entry')
  requireValue(typeof source.sourceKey === 'string' && source.sourceKey.length > 0, 'sourceKey invalid')
  sourceKeys.push(source.sourceKey)
  requireValue(typeof source.decisionAllowed === 'boolean', 'decisionAllowed invalid')
  requireValue(typeof source.snapshotPresent === 'boolean', 'snapshotPresent invalid')
  requireValue(nonNegativeInteger(source.itemCount), 'source itemCount invalid')
  requireValue(typeof source.succeeded === 'boolean', 'source succeeded invalid')
  requireValue(source.succeeded === (source.decisionAllowed && source.snapshotPresent && source.itemCount > 0), 'source succeeded derivation mismatch')
}
requireValue(new Set(sourceKeys).size === sourceKeys.length, 'source keys must be unique')
requireValue(evidence.sourceVerification?.successfulSourceCount === (evidence.sourceVerification?.sources || []).filter((source) => source.succeeded).length, 'successfulSourceCount derivation mismatch')
requireValue(evidence.sourceVerification?.itemLimitSatisfied === (evidence.sourceVerification?.maximumObservedItemsPerSource <= 20), 'itemLimitSatisfied derivation mismatch')

exactKeys(evidence.retentionVerification, ['snapshotCount', 'allPayloadHashOnly', 'retainedBodyCount', 'invalidSnapshotCount'], 'retentionVerification')
for (const key of ['snapshotCount', 'retainedBodyCount', 'invalidSnapshotCount']) requireValue(nonNegativeInteger(evidence.retentionVerification?.[key]), `${key} invalid`)
requireValue(typeof evidence.retentionVerification?.allPayloadHashOnly === 'boolean', 'allPayloadHashOnly invalid')
requireValue(evidence.retentionVerification?.allPayloadHashOnly === (evidence.retentionVerification?.snapshotCount === 3 && evidence.retentionVerification?.retainedBodyCount === 0 && evidence.retentionVerification?.invalidSnapshotCount === 0), 'retention derivation mismatch')

exactKeys(evidence.runtimeVerification, ['expectedFoundationContainerCount', 'foundationBefore', 'foundationAfter', 'foundationStable', 'strategicIntelligenceBefore', 'strategicIntelligenceAfter', 'temporaryResourcesClean', 'newNetworkCount', 'newPublishedPortCount'], 'runtimeVerification')
requireValue(evidence.runtimeVerification?.expectedFoundationContainerCount === 13, 'expectedFoundationContainerCount must equal 13')
for (const [key, state] of [['foundationBefore', evidence.runtimeVerification?.foundationBefore], ['foundationAfter', evidence.runtimeVerification?.foundationAfter]]) {
  if (state === null) continue
  exactKeys(state, ['containerCount', 'runningContainerCount', 'unhealthyContainerCount', 'restartCountTotal', 'fingerprint'], key)
  for (const field of ['containerCount', 'runningContainerCount', 'unhealthyContainerCount', 'restartCountTotal']) requireValue(nonNegativeInteger(state?.[field]), `${key} ${field} invalid`)
  requireValue(HASH.test(String(state?.fingerprint || '')), `${key} fingerprint invalid`)
}
for (const [key, state] of [['strategicIntelligenceBefore', evidence.runtimeVerification?.strategicIntelligenceBefore], ['strategicIntelligenceAfter', evidence.runtimeVerification?.strategicIntelligenceAfter]]) {
  if (state === null) continue
  exactKeys(state, ['containerCount', 'runningContainerCount', 'networkCount', 'publishedPortCount', 'fingerprint'], key)
  for (const field of ['containerCount', 'runningContainerCount', 'networkCount', 'publishedPortCount']) requireValue(nonNegativeInteger(state?.[field]), `${key} ${field} invalid`)
  requireValue(HASH.test(String(state?.fingerprint || '')), `${key} fingerprint invalid`)
}
for (const key of ['foundationStable', 'temporaryResourcesClean']) requireValue(typeof evidence.runtimeVerification?.[key] === 'boolean', `${key} invalid`)
for (const key of ['newNetworkCount', 'newPublishedPortCount']) requireValue(nonNegativeInteger(evidence.runtimeVerification?.[key]), `${key} invalid`)

exactKeys(evidence.sideEffects, ['auditCompleted', 'formalP2Count', 'employeeDeliveryCount', 'erpWritebackCount', 'socialWritebackCount', 'causalActivationCount', 'allZero'], 'sideEffects')
requireValue(typeof evidence.sideEffects?.auditCompleted === 'boolean', 'auditCompleted invalid')
for (const key of ['formalP2Count', 'employeeDeliveryCount', 'erpWritebackCount', 'socialWritebackCount', 'causalActivationCount']) requireValue(nonNegativeInteger(evidence.sideEffects?.[key]), `${key} invalid`)
const derivedAllZero = evidence.sideEffects?.auditCompleted === true && ['formalP2Count', 'employeeDeliveryCount', 'erpWritebackCount', 'socialWritebackCount', 'causalActivationCount'].every((key) => evidence.sideEffects?.[key] === 0)
requireValue(evidence.sideEffects?.allZero === derivedAllZero, 'side effect allZero derivation mismatch')

exactKeys(evidence.artifactHashes, ['collectorStdout', 'collectorStderr', 'runSummary', 'sourceDecisions', 'items', 'rawSnapshots', 'candidateReport', 'runtimeBefore', 'runtimeAfter', 'sideEffectAudit'], 'artifactHashes')
for (const [key, value] of Object.entries(evidence.artifactHashes || {})) requireValue(validHashOrNull(value), `${key} hash invalid`)

exactKeys(evidence.acceptance, ['evidenceComplete', 'collectorSucceeded', 'sourceCoverageVerified', 'itemLimitVerified', 'retentionVerified', 'foundationStable', 'temporaryResourcesClean', 'businessSideEffectsZero', 'acceptedForInternalEngineering', 'eligibleForProductionShadow'], 'acceptance')
for (const key of ['evidenceComplete', 'collectorSucceeded', 'sourceCoverageVerified', 'itemLimitVerified', 'retentionVerified', 'foundationStable', 'temporaryResourcesClean', 'businessSideEffectsZero', 'acceptedForInternalEngineering', 'eligibleForProductionShadow']) requireValue(typeof evidence.acceptance?.[key] === 'boolean', `${key} invalid`)
requireValue(evidence.acceptance?.eligibleForProductionShadow === false, 'internal evidence can never be production-shadow eligible')
requireValue(evidence.acceptance?.itemLimitVerified === evidence.sourceVerification?.itemLimitSatisfied, 'item limit acceptance mismatch')
requireValue(evidence.acceptance?.retentionVerified === (evidence.retentionVerification?.allPayloadHashOnly && evidence.retentionVerification?.invalidSnapshotCount === 0), 'retention acceptance mismatch')
requireValue(evidence.acceptance?.foundationStable === evidence.runtimeVerification?.foundationStable, 'foundation acceptance mismatch')
requireValue(evidence.acceptance?.temporaryResourcesClean === evidence.runtimeVerification?.temporaryResourcesClean, 'temporary resource acceptance mismatch')
requireValue(evidence.acceptance?.businessSideEffectsZero === evidence.sideEffects?.allZero, 'side effect acceptance mismatch')
requireValue(Array.isArray(evidence.failureCodes) && new Set(evidence.failureCodes).size === evidence.failureCodes.length, 'failureCodes invalid')
requireValue((evidence.failureCodes || []).every((code) => /^[A-Z0-9_]+$/.test(code)), 'failure code format invalid')
const acceptanceInputs = ['evidenceComplete', 'collectorSucceeded', 'sourceCoverageVerified', 'itemLimitVerified', 'retentionVerified', 'foundationStable', 'temporaryResourcesClean', 'businessSideEffectsZero']
const derivedAccepted = acceptanceInputs.every((key) => evidence.acceptance?.[key] === true) && evidence.failureCodes.length === 0
requireValue(evidence.acceptance?.acceptedForInternalEngineering === derivedAccepted, 'acceptedForInternalEngineering derivation mismatch')
requireValue(evidence.status === (derivedAccepted ? 'succeeded' : 'failed'), 'status derivation mismatch')
if (evidence.status === 'succeeded') {
  requireValue(evidence.runId !== null, 'successful evidence requires a runId')
  requireValue(evidence.collector?.exitCode === 0, 'successful evidence requires collector exit 0')
  requireValue(evidence.collector?.status === 'succeeded', 'successful evidence requires collector succeeded')
  requireValue(evidence.collector?.sourceCount === 3, 'successful evidence requires 3 sources')
  requireValue(evidence.collector?.rawSnapshotCount === 3, 'successful evidence requires 3 raw snapshots')
  requireValue(evidence.sourceVerification?.successfulSourceCount === 3, 'successful evidence requires 3 successful sources')
}

if (errors.length > 0) throw new Error(`internal engineering run evidence denied: ${errors.join('; ')}`)
const evidenceHash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
process.stdout.write(`${JSON.stringify({
  ok: true,
  status: evidence.status,
  runId: evidence.runId,
  acceptedForInternalEngineering: evidence.acceptance.acceptedForInternalEngineering,
  eligibleForProductionShadow: false,
  evidenceHash,
}, null, 2)}\n`)
