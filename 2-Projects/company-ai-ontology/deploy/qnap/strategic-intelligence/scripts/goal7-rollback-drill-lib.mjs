import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'

import {
  validateGoal7DeploymentEvidence,
  validateGoal7DeploymentSideEffects,
  validateGoal7DeploymentState,
} from './goal7-deployment-lib.mjs'

export const GOAL7_ROLLBACK_DRILL_RAW_FILES = Object.freeze({
  runtimeIdentity: 'runtime-component-versions.json',
  deployment: 'deployment-evidence.json',
  before: 'rollback-before-state.json',
  previous: 'rollback-previous-state.json',
  restored: 'rollback-restored-state.json',
  sideEffects: 'rollback-side-effects.json',
})

const COMMIT = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const VERSION = /^\d{4}-\d{2}-\d{2}\.\d+$/
const MAX_BYTES = 256 * 1024

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function exactKeys(value, keys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  requireValue(isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()), `${label} fields mismatch`)
}

function timestamp(value, label) {
  const parsed = Date.parse(String(value || ''))
  requireValue(Number.isFinite(parsed), `${label} timestamp invalid`)
  return parsed
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

async function readRaw(root, file) {
  const filePath = path.join(root, file)
  const stat = await fs.lstat(filePath)
  requireValue(stat.isFile() && !stat.isSymbolicLink(), `${file} must be a regular file`)
  requireValue(stat.size > 0 && stat.size <= MAX_BYTES, `${file} size invalid`)
  const bytes = await fs.readFile(filePath)
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) }
}

function runtimeIdentity(value) {
  exactKeys(value, [
    'evidenceVersion', 'evidenceType', 'sourceCommit', 'hLiteSourceCommit',
    'agentCoreVersion', 'knowledgeConnectorVersion', 'hLiteVersion',
  ], 'runtimeIdentity')
  requireValue(value.evidenceVersion === '1.0.0', 'runtimeIdentity evidenceVersion mismatch')
  requireValue(value.evidenceType === 'goal7-runtime-component-versions', 'runtimeIdentity evidenceType mismatch')
  requireValue(COMMIT.test(value.sourceCommit), 'runtimeIdentity sourceCommit invalid')
  requireValue(COMMIT.test(value.hLiteSourceCommit), 'runtimeIdentity H-Lite sourceCommit invalid')
  for (const key of ['agentCoreVersion', 'knowledgeConnectorVersion', 'hLiteVersion']) {
    requireValue(VERSION.test(value[key]), `runtimeIdentity ${key} invalid`)
  }
}

function candidateMatches(state, identity, label) {
  const agent = state.components.agentCore
  const connector = state.components.knowledgeConnector
  const hLite = state.components.hLite
  requireValue(agent.ready && agent.productionReady && agent.version === identity.agentCoreVersion, `${label} Agent Core candidate mismatch`)
  requireValue(connector.ready && connector.productionReady && connector.version === identity.knowledgeConnectorVersion, `${label} Knowledge Connector candidate mismatch`)
  requireValue(hLite.ready && hLite.mode === 'active' && hLite.subscriptionEnabled && hLite.version === identity.hLiteVersion, `${label} H-Lite candidate mismatch`)
  requireValue(agent.sourceCommit === identity.sourceCommit && connector.sourceCommit === identity.sourceCommit, `${label} Ontology sourceCommit mismatch`)
  requireValue(hLite.sourceCommit === identity.hLiteSourceCommit, `${label} H-Lite sourceCommit mismatch`)
}

function healthyFoundation(state, label) {
  requireValue(state.foundation.criticalContainerCount === 13, `${label} Foundation critical container count mismatch`)
  requireValue(state.foundation.unhealthyContainerCount === 0, `${label} Foundation unhealthy containers detected`)
  requireValue(state.foundation.restartCountTotal === 0, `${label} Foundation restart count must remain zero`)
  requireValue(state.routeState.routeAOperational === true, `${label} Route A is not operational`)
  requireValue(state.routeState.routeBEnabled === false, `${label} Route B must remain disabled`)
  requireValue(state.candidateMigration012Applied === true, `${label} migration 012 was not retained`)
}

export async function buildGoal7RollbackDrillEvidence(bundleRoot) {
  const root = path.resolve(bundleRoot)
  const entries = Object.fromEntries(await Promise.all(Object.entries(GOAL7_ROLLBACK_DRILL_RAW_FILES)
    .map(async ([key, file]) => [key, await readRaw(root, file)])))
  runtimeIdentity(entries.runtimeIdentity.value)
  await validateGoal7DeploymentEvidence(root, entries.deployment.value)
  validateGoal7DeploymentState(entries.before.value, 'rollback_before')
  validateGoal7DeploymentState(entries.previous.value, 'rollback_previous')
  validateGoal7DeploymentState(entries.restored.value, 'rollback_restored')
  validateGoal7DeploymentSideEffects(entries.sideEffects.value)

  const identity = entries.runtimeIdentity.value
  const deployment = entries.deployment.value
  const before = entries.before.value
  const previous = entries.previous.value
  const restored = entries.restored.value
  const audit = entries.sideEffects.value
  requireValue(deployment.sourceCommit === identity.sourceCommit && deployment.hLiteSourceCommit === identity.hLiteSourceCommit, 'rollback deployment identity drift')
  requireValue(timestamp(before.capturedAt, 'rollback.before') <= timestamp(previous.capturedAt, 'rollback.previous'), 'rollback previous state order invalid')
  requireValue(timestamp(previous.capturedAt, 'rollback.previous') <= timestamp(restored.capturedAt, 'rollback.restored'), 'rollback restored state order invalid')
  requireValue(timestamp(audit.windowStart, 'rollback.audit.start') <= timestamp(before.capturedAt, 'rollback.before'), 'rollback side-effect window starts late')
  requireValue(timestamp(audit.windowEnd, 'rollback.audit.end') >= timestamp(restored.capturedAt, 'rollback.restored'), 'rollback side-effect window ends early')
  for (const [label, state] of [['before', before], ['previous', previous], ['restored', restored]]) healthyFoundation(state, label)
  candidateMatches(before, identity, 'rollback before')
  candidateMatches(restored, identity, 'rollback restored')
  const previousDiffers = previous.components.agentCore.version !== identity.agentCoreVersion
    || previous.components.agentCore.sourceCommit !== identity.sourceCommit
    || previous.components.knowledgeConnector.version !== identity.knowledgeConnectorVersion
    || previous.components.knowledgeConnector.sourceCommit !== identity.sourceCommit
    || previous.components.hLite.version !== identity.hLiteVersion
    || previous.components.hLite.sourceCommit !== identity.hLiteSourceCommit
  requireValue(previousDiffers, 'rollback previous state did not prove the old release')
  requireValue(previous.foundation.publishedPortCount === before.foundation.publishedPortCount, 'rollback previous state changed host ports')
  requireValue(restored.foundation.publishedPortCount === before.foundation.publishedPortCount, 'rollback restored state changed host ports')

  return {
    evidenceVersion: '1.0.0',
    evidenceType: 'goal7-foundation-rollback-restore-drill',
    sourceCommit: identity.sourceCommit,
    hLiteSourceCommit: identity.hLiteSourceCommit,
    capturedAt: new Date(restored.capturedAt).toISOString(),
    evidenceRef: 'qnap:acceptance/goal7-rollback-drill',
    companyQnapIdentity: restored.companyQnapIdentity,
    activeOntologySchema: restored.activeOntologySchema,
    registryStatus: restored.registryStatus,
    migration012Retained: true,
    previousReleaseVerified: true,
    candidateReleaseRestored: true,
    candidateVersions: {
      agentCore: identity.agentCoreVersion,
      knowledgeConnector: identity.knowledgeConnectorVersion,
      hLite: identity.hLiteVersion,
    },
    previousVersions: {
      agentCore: previous.components.agentCore.version,
      knowledgeConnector: previous.components.knowledgeConnector.version,
      hLite: previous.components.hLite.version,
    },
    foundationCriticalContainerCount: restored.foundation.criticalContainerCount,
    foundationUnhealthyContainerCount: restored.foundation.unhealthyContainerCount,
    foundationRestartCountTotal: restored.foundation.restartCountTotal,
    newHostPortCount: 0,
    sideEffects: {
      formalP2Count: audit.formalP2Count,
      employeeDeliveryCount: audit.employeeDeliveryCount,
      erpWritebackCount: audit.erpWritebackCount,
      socialWritebackCount: audit.socialWritebackCount,
      causalActivationCount: audit.causalActivationCount,
    },
    rawEvidenceFiles: Object.fromEntries(Object.entries(GOAL7_ROLLBACK_DRILL_RAW_FILES)
      .map(([key, file]) => [key, { file, sha256: entries[key].sha256 }])),
    publicOutputContainsSensitiveData: false,
  }
}

export async function writeGoal7RollbackDrillEvidence(bundleRoot, outputFile = path.join(bundleRoot, 'rollback-drill-evidence.json')) {
  const evidence = await buildGoal7RollbackDrillEvidence(bundleRoot)
  await fs.writeFile(path.resolve(outputFile), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  return evidence
}

export async function validateGoal7RollbackDrillEvidence(bundleRoot, evidence) {
  const expected = await buildGoal7RollbackDrillEvidence(bundleRoot)
  requireValue(isDeepStrictEqual(evidence, expected), 'Goal 7 rollback drill evidence is not compiler-derived from bound runtime state')
  return expected
}
