import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'

import { validateGoal7MigrationEvidence, validateGoal7PreparationEvidence } from './goal7-phase-evidence-lib.mjs'

export const GOAL7_DEPLOYMENT_RAW_FILES = Object.freeze({
  runtimeIdentity: 'runtime-component-versions.json',
  preparation: 'preparation-evidence.json',
  migration: 'migration-012-evidence.json',
  before: 'pre-deployment-state.json',
  after: 'post-deployment-state.json',
  sideEffects: 'deployment-side-effects.json',
})

const COMMIT = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
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

function component(value, label, { hLite = false } = {}) {
  const keys = hLite
    ? ['version', 'sourceCommit', 'ready', 'mode', 'subscriptionEnabled']
    : ['version', 'sourceCommit', 'ready', 'productionReady']
  exactKeys(value, keys, label)
  requireValue(value.sourceCommit === null || COMMIT.test(value.sourceCommit), `${label}.sourceCommit invalid`)
  requireValue(typeof value.version === 'string' && value.version.length > 0, `${label}.version missing`)
  requireValue(typeof value.ready === 'boolean', `${label}.ready invalid`)
  if (hLite) {
    requireValue(['shadow', 'standby', 'active'].includes(value.mode), `${label}.mode invalid`)
    requireValue(typeof value.subscriptionEnabled === 'boolean', `${label}.subscriptionEnabled invalid`)
  } else {
    requireValue(typeof value.productionReady === 'boolean', `${label}.productionReady invalid`)
  }
}

function state(value, phase) {
  exactKeys(value, [
    'snapshotVersion', 'evidenceType', 'phase', 'capturedAt', 'companyQnapIdentity',
    'activeOntologySchema', 'registryStatus', 'candidateMigration012Applied',
    'components', 'foundation', 'routeState',
  ], `${phase}State`)
  requireValue(value.snapshotVersion === '1.0.0', `${phase}State snapshotVersion mismatch`)
  requireValue(value.evidenceType === 'goal7-deployment-state', `${phase}State evidenceType mismatch`)
  requireValue(value.phase === phase, `${phase}State phase mismatch`)
  timestamp(value.capturedAt, `${phase}State.capturedAt`)
  requireValue(value.companyQnapIdentity === 'qnap:company/prnas/TS-X65', `${phase}State QNAP identity mismatch`)
  requireValue(value.activeOntologySchema === '3.3.0', `${phase}State active schema changed`)
  requireValue(value.registryStatus === 'in_sync', `${phase}State registry not in_sync`)
  requireValue(typeof value.candidateMigration012Applied === 'boolean', `${phase}State migration status invalid`)
  exactKeys(value.components, ['agentCore', 'knowledgeConnector', 'hLite'], `${phase}State.components`)
  component(value.components.agentCore, `${phase}State.agentCore`)
  component(value.components.knowledgeConnector, `${phase}State.knowledgeConnector`)
  component(value.components.hLite, `${phase}State.hLite`, { hLite: true })
  exactKeys(value.foundation, [
    'criticalContainerCount', 'unhealthyContainerCount', 'restartCountTotal',
    'publishedPortCount', 'fingerprint',
  ], `${phase}State.foundation`)
  for (const key of ['criticalContainerCount', 'unhealthyContainerCount', 'restartCountTotal', 'publishedPortCount']) {
    requireValue(Number.isInteger(value.foundation[key]) && value.foundation[key] >= 0, `${phase}State.foundation.${key} invalid`)
  }
  requireValue(HASH.test(value.foundation.fingerprint), `${phase}State.foundation.fingerprint invalid`)
  exactKeys(value.routeState, ['routeAOperational', 'routeBEnabled'], `${phase}State.routeState`)
  requireValue(typeof value.routeState.routeAOperational === 'boolean', `${phase}State route A invalid`)
  requireValue(typeof value.routeState.routeBEnabled === 'boolean', `${phase}State route B invalid`)
}

function sideEffects(value) {
  exactKeys(value, [
    'auditVersion', 'completed', 'windowStart', 'windowEnd', 'formalP2Count',
    'employeeDeliveryCount', 'erpWritebackCount', 'socialWritebackCount', 'causalActivationCount',
  ], 'deploymentSideEffects')
  requireValue(value.auditVersion === '1.0.0' && value.completed === true, 'deployment side-effect audit incomplete')
  const start = timestamp(value.windowStart, 'deploymentSideEffects.windowStart')
  const end = timestamp(value.windowEnd, 'deploymentSideEffects.windowEnd')
  requireValue(end >= start, 'deployment side-effect window invalid')
  for (const key of ['formalP2Count', 'employeeDeliveryCount', 'erpWritebackCount', 'socialWritebackCount', 'causalActivationCount']) {
    requireValue(value[key] === 0, `deployment side effect ${key} must be zero`)
  }
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
    requireValue(/^\d{4}-\d{2}-\d{2}\.\d+$/.test(value[key]), `runtimeIdentity ${key} invalid`)
  }
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

export async function buildGoal7DeploymentEvidence(bundleRoot) {
  const root = path.resolve(bundleRoot)
  const entries = Object.fromEntries(await Promise.all(Object.entries(GOAL7_DEPLOYMENT_RAW_FILES).map(async ([key, file]) => [key, await readRaw(root, file)])))
  state(entries.before.value, 'before')
  state(entries.after.value, 'after')
  sideEffects(entries.sideEffects.value)
  runtimeIdentity(entries.runtimeIdentity.value)
  validateGoal7PreparationEvidence(entries.preparation.value)
  validateGoal7MigrationEvidence(entries.migration.value, {
    sourceCommit: entries.preparation.value.sourceCommit,
    hLiteSourceCommit: entries.preparation.value.hLiteSourceCommit,
    preparationEvidenceSha256: entries.preparation.sha256,
  })
  const identity = entries.runtimeIdentity.value
  const preparation = entries.preparation.value
  const migration = entries.migration.value
  const before = entries.before.value
  const after = entries.after.value
  const audit = entries.sideEffects.value
  requireValue(timestamp(before.capturedAt, 'before.capturedAt') <= timestamp(after.capturedAt, 'after.capturedAt'), 'deployment state order invalid')
  requireValue(timestamp(audit.windowStart, 'audit.windowStart') <= timestamp(before.capturedAt, 'before.capturedAt'), 'side-effect window starts after deployment')
  requireValue(timestamp(audit.windowEnd, 'audit.windowEnd') >= timestamp(after.capturedAt, 'after.capturedAt'), 'side-effect window ends before deployment verification')
  requireValue(after.candidateMigration012Applied === true, 'candidate migration 012 missing after deployment')
  requireValue(preparation.sourceCommit === identity.sourceCommit && migration.sourceCommit === identity.sourceCommit, 'Goal 7 phase Ontology sourceCommit drift')
  requireValue(preparation.hLiteSourceCommit === identity.hLiteSourceCommit && migration.hLiteSourceCommit === identity.hLiteSourceCommit, 'Goal 7 phase H-Lite sourceCommit drift')
  requireValue(preparation.agentCoreVersion === identity.agentCoreVersion, 'Goal 7 preparation Agent Core version drift')
  requireValue(preparation.knowledgeConnectorVersion === identity.knowledgeConnectorVersion, 'Goal 7 preparation Knowledge Connector version drift')
  requireValue(preparation.hLiteVersion === identity.hLiteVersion, 'Goal 7 preparation H-Lite version drift')
  requireValue(after.foundation.criticalContainerCount === 13, 'Foundation critical container count mismatch')
  requireValue(before.foundation.criticalContainerCount === after.foundation.criticalContainerCount, 'Foundation critical container count changed')
  requireValue(after.foundation.unhealthyContainerCount === 0, 'Foundation unhealthy containers detected')
  requireValue(after.foundation.restartCountTotal === 0, 'Foundation restart count must remain zero')
  const newHostPortCount = Math.max(0, after.foundation.publishedPortCount - before.foundation.publishedPortCount)
  requireValue(newHostPortCount === 0, 'Goal 7 opened new host ports')
  requireValue(after.routeState.routeAOperational === true, 'Route A is not operational')
  requireValue(after.routeState.routeBEnabled === false, 'Route B must remain disabled')
  const agent = after.components.agentCore
  const connector = after.components.knowledgeConnector
  const hLite = after.components.hLite
  requireValue(agent.ready && agent.productionReady && agent.version === identity.agentCoreVersion, 'Agent Core deployment state invalid')
  requireValue(connector.ready && connector.productionReady && connector.version === identity.knowledgeConnectorVersion, 'Knowledge Connector deployment state invalid')
  requireValue(hLite.ready && hLite.mode === 'active' && hLite.subscriptionEnabled && hLite.version === identity.hLiteVersion, 'H-Lite deployment state invalid')
  requireValue(agent.sourceCommit === identity.sourceCommit && connector.sourceCommit === identity.sourceCommit, 'Ontology component sourceCommit drift')
  requireValue(hLite.sourceCommit === identity.hLiteSourceCommit, 'H-Lite sourceCommit drift')
  return {
    evidenceVersion: '1.0.0',
    evidenceType: 'goal7-company-qnap-deployment',
    sourceCommit: agent.sourceCommit,
    hLiteSourceCommit: hLite.sourceCommit,
    capturedAt: new Date(after.capturedAt).toISOString(),
    evidenceRef: 'qnap:acceptance/goal7-deployment',
    companyQnapIdentity: after.companyQnapIdentity,
    activeOntologySchema: after.activeOntologySchema,
    registryStatus: after.registryStatus,
    candidateMigration012Applied: true,
    agentCoreVersion: agent.version,
    knowledgeConnectorVersion: connector.version,
    hLiteVersion: hLite.version,
    foundationCriticalContainerCount: after.foundation.criticalContainerCount,
    foundationUnhealthyContainerCount: after.foundation.unhealthyContainerCount,
    foundationRestartCountTotal: after.foundation.restartCountTotal,
    newHostPortCount,
    routeAOperational: true,
    routeBEnabled: false,
    sideEffects: {
      formalP2Count: audit.formalP2Count,
      employeeDeliveryCount: audit.employeeDeliveryCount,
      erpWritebackCount: audit.erpWritebackCount,
      socialWritebackCount: audit.socialWritebackCount,
    },
    closedCapabilities: {
      productResearchBulkImport: false,
      realEmployeeCanary: false,
      employeePrivateBotMigration: false,
      erpWriteback: false,
      socialWriteback: false,
    },
    rawEvidenceFiles: Object.fromEntries(Object.entries(GOAL7_DEPLOYMENT_RAW_FILES).map(([key, file]) => [key, { file, sha256: entries[key].sha256 }])),
  }
}

export async function writeGoal7DeploymentEvidence(bundleRoot, outputFile = path.join(bundleRoot, 'deployment-evidence.json')) {
  const evidence = await buildGoal7DeploymentEvidence(bundleRoot)
  await fs.writeFile(path.resolve(outputFile), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  return evidence
}

export async function validateGoal7DeploymentEvidence(bundleRoot, evidence) {
  const expected = await buildGoal7DeploymentEvidence(bundleRoot)
  requireValue(isDeepStrictEqual(evidence, expected), 'Goal 7 deployment evidence is not compiler-derived from bound runtime state')
  return expected
}
