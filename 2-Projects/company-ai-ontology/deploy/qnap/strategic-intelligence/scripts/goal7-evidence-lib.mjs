import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { validateGoal7DeploymentEvidence } from './goal7-deployment-lib.mjs'
import { validateGoal7WorkerReadbackEvidence } from './goal7-worker-readback-lib.mjs'

const COMMIT = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const VERSION = /^\d{4}-\d{2}-\d{2}\.\d+$/
const REFERENCE = /^(feishu:|git:|ontology:|qnap:|https:\/\/)\S+$/
const MAX_EVIDENCE_BYTES = 512 * 1024
const SENSITIVE_KEYS = new Set(['prompt', 'promptText', 'requestBody', 'responseBody', 'reply', 'employeeMessage', 'employeeQuestion', 'displayName', 'principalRef'])

export const GOAL7_ENGINEERING_EVIDENCE_FILES = Object.freeze({
  runtimeVerification: 'runtime-verification.json',
  workerReadback: 'worker-readback.json',
  authorityCanary: 'authority-canary.json',
  deployment: 'deployment-evidence.json',
})

export const GOAL7_EVIDENCE_FILES = Object.freeze({
  ...GOAL7_ENGINEERING_EVIDENCE_FILES,
  ownerAcceptance: 'owner-acceptance.json',
})

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function exactKeys(value, keys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  requireValue(isDeepStrictEqual(actual, expected), `${label} fields mismatch`)
}

function validTimestamp(value, label) {
  requireValue(typeof value === 'string' && Number.isFinite(Date.parse(value)), `${label} invalid`)
}

function validReference(value, label) {
  requireValue(REFERENCE.test(String(value || '')), `${label} invalid`)
}

function rejectSensitiveKeys(value, label) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    requireValue(!SENSITIVE_KEYS.has(key), `${label} contains forbidden sensitive field`)
    rejectSensitiveKeys(child, label)
  }
}

function validateRuntimeVerification(value) {
  requireValue(value?.evidenceVersion === '1.0.0', 'runtime verification evidenceVersion mismatch')
  requireValue(value?.verificationType === 'P1-SI-F-linux-amd64-runtime', 'runtime verification type mismatch')
  requireValue(COMMIT.test(String(value?.sourceCommit || '')), 'runtime verification sourceCommit invalid')
  requireValue(COMMIT.test(String(value?.hLiteSourceCommit || '')), 'runtime verification hLiteSourceCommit invalid')
  requireValue(VERSION.test(String(value?.agentCoreVersion || '')), 'runtime verification agentCoreVersion invalid')
  requireValue(VERSION.test(String(value?.knowledgeConnectorVersion || '')), 'runtime verification knowledgeConnectorVersion invalid')
  requireValue(VERSION.test(String(value?.hLiteVersion || '')), 'runtime verification hLiteVersion invalid')
  requireValue(HASH.test(String(value?.hLiteSourceArchiveSha256 || '')), 'H-Lite source archive hash missing')
  requireValue(String(value?.workflowRunId || '').length > 0, 'runtime verification workflowRunId missing')
  requireValue(value?.sqlRuntimeVerified === true, 'runtime verification SQL runtime missing')
  requireValue(value?.goal7AuthorityRuntimeFoundation === 'verified', 'Goal 7 foundation was not verified')
  requireValue(HASH.test(String(value?.goal7FoundationEvidenceSha256 || '')), 'Goal 7 foundation evidence hash missing')
  requireValue(HASH.test(String(value?.postgresEvidenceSha256 || '')), 'PostgreSQL evidence hash missing')
  requireValue(value?.routeBState === 'disabled', 'runtime verification Route B must remain disabled')
  requireValue(value?.immutableReleaseCandidateVerified === true, 'immutable release candidate not verified')
  requireValue(value?.companyQnapDeployed === false, 'CI evidence must not claim QNAP deployment')
  requireValue(value?.publish === false, 'runtime verification publish must remain false')
  rejectSensitiveKeys(value, 'runtime verification')
}

function validateWorkerReadback(value) {
  exactKeys(value, [
    'evidenceVersion', 'evidenceType', 'sourceCommit', 'hLiteSourceCommit', 'capturedAt', 'evidenceRef',
    'requestIdHash', 'provider', 'model', 'credentialModeTag', 'productionReady',
    'usage', 'governance', 'rawEvidenceFiles', 'publicOutputContainsSensitiveData',
  ], 'workerReadback')
  requireValue(value.evidenceVersion === '2.0.0', 'workerReadback evidenceVersion mismatch')
  requireValue(value.evidenceType === 'goal7-h-worker-readback', 'workerReadback evidenceType mismatch')
  requireValue(COMMIT.test(value.sourceCommit), 'workerReadback sourceCommit invalid')
  requireValue(COMMIT.test(value.hLiteSourceCommit), 'workerReadback hLiteSourceCommit invalid')
  validTimestamp(value.capturedAt, 'workerReadback.capturedAt')
  requireValue(value.evidenceRef === 'qnap:acceptance/goal7-worker-readback', 'workerReadback evidenceRef mismatch')
  requireValue(HASH.test(value.requestIdHash), 'workerReadback requestIdHash invalid')
  requireValue(typeof value.provider === 'string' && value.provider.length >= 2, 'workerReadback provider missing')
  requireValue(typeof value.model === 'string' && value.model.length >= 2, 'workerReadback model missing')
  requireValue(typeof value.credentialModeTag === 'string' && value.credentialModeTag.length >= 2, 'workerReadback credential mode missing')
  requireValue(value.productionReady === true, 'workerReadback productionReady must be true')
  exactKeys(value.governance, ['routeKey', 'retryCount', 'ledgerRecorded', 'routeBEnabled'], 'workerReadback.governance')
  requireValue(value.governance.routeKey === 'route-a', 'workerReadback must use Route A')
  requireValue(value.governance.ledgerRecorded === true, 'workerReadback ledger missing')
  requireValue(value.governance.routeBEnabled === false, 'workerReadback Route B must remain disabled')
  exactKeys(value.rawEvidenceFiles, ['http', 'ledger'], 'workerReadback.rawEvidenceFiles')
  requireValue(value.publicOutputContainsSensitiveData === false, 'workerReadback exposes sensitive data')
  rejectSensitiveKeys(value, 'workerReadback')
}

function validateAuthorityCanary(value) {
  exactKeys(value, [
    'evidenceVersion', 'evidenceType', 'sourceCommit', 'hLiteSourceCommit', 'capturedAt', 'evidenceRef',
    'runIdHash', 'syntheticResourcesOnly', 'scenarios', 'counts',
    'publicOutputContainsSensitiveData',
  ], 'authorityCanary')
  requireValue(value.evidenceVersion === '1.0.0', 'authorityCanary evidenceVersion mismatch')
  requireValue(value.evidenceType === 'goal7-feishu-authority-canary', 'authorityCanary evidenceType mismatch')
  requireValue(COMMIT.test(value.sourceCommit), 'authorityCanary sourceCommit invalid')
  requireValue(COMMIT.test(value.hLiteSourceCommit), 'authorityCanary hLiteSourceCommit invalid')
  validTimestamp(value.capturedAt, 'authorityCanary.capturedAt')
  validReference(value.evidenceRef, 'authorityCanary.evidenceRef')
  requireValue(HASH.test(value.runIdHash), 'authorityCanary runIdHash invalid')
  requireValue(value.syntheticResourcesOnly === true, 'authorityCanary must use synthetic resources only')
  exactKeys(value.scenarios, [
    'privateSenderOnly', 'activeChatMembershipAllowed', 'staleChatMembershipFailClosed',
    'revokedChatMembershipFailClosed', 'multiMentionNoExpansion', 'purposeNarrowing',
    'aclFailureBeforeBody', 'revocationConvergenceSeconds',
  ], 'authorityCanary.scenarios')
  for (const key of [
    'privateSenderOnly', 'activeChatMembershipAllowed', 'staleChatMembershipFailClosed',
    'revokedChatMembershipFailClosed', 'multiMentionNoExpansion', 'purposeNarrowing',
    'aclFailureBeforeBody',
  ]) requireValue(value.scenarios[key] === true, `authorityCanary.scenarios.${key} must be true`)
  requireValue(Number.isFinite(value.scenarios.revocationConvergenceSeconds)
    && value.scenarios.revocationConvergenceSeconds >= 0
    && value.scenarios.revocationConvergenceSeconds <= 60, 'authorityCanary revocation convergence exceeds 60 seconds')
  exactKeys(value.counts, ['scenarioCount', 'passedCount', 'bodyReadOnDeniedCount', 'unauthorizedEvidenceCount'], 'authorityCanary.counts')
  requireValue(value.counts.scenarioCount === 7, 'authorityCanary scenarioCount must be 7')
  requireValue(value.counts.passedCount === 7, 'authorityCanary passedCount must be 7')
  requireValue(value.counts.bodyReadOnDeniedCount === 0, 'authorityCanary denied paths read body')
  requireValue(value.counts.unauthorizedEvidenceCount === 0, 'authorityCanary returned unauthorized evidence')
  requireValue(value.publicOutputContainsSensitiveData === false, 'authorityCanary exposes sensitive data')
}

function validateDeployment(value) {
  exactKeys(value, [
    'evidenceVersion', 'evidenceType', 'sourceCommit', 'hLiteSourceCommit', 'capturedAt', 'evidenceRef',
    'companyQnapIdentity', 'activeOntologySchema', 'registryStatus',
    'candidateMigration012Applied', 'agentCoreVersion', 'knowledgeConnectorVersion', 'hLiteVersion',
    'foundationCriticalContainerCount', 'foundationUnhealthyContainerCount',
    'foundationRestartCountTotal', 'newHostPortCount', 'routeAOperational',
    'routeBEnabled', 'sideEffects', 'closedCapabilities', 'rawEvidenceFiles',
  ], 'deployment')
  requireValue(value.evidenceVersion === '1.0.0', 'deployment evidenceVersion mismatch')
  requireValue(value.evidenceType === 'goal7-company-qnap-deployment', 'deployment evidenceType mismatch')
  requireValue(COMMIT.test(value.sourceCommit), 'deployment sourceCommit invalid')
  requireValue(COMMIT.test(value.hLiteSourceCommit), 'deployment hLiteSourceCommit invalid')
  validTimestamp(value.capturedAt, 'deployment.capturedAt')
  validReference(value.evidenceRef, 'deployment.evidenceRef')
  requireValue(value.companyQnapIdentity === 'qnap:company/prnas/TS-X65', 'company QNAP identity mismatch')
  requireValue(value.activeOntologySchema === '3.3.0', 'active Ontology Schema changed')
  requireValue(value.registryStatus === 'in_sync', 'Registry must remain in_sync')
  requireValue(value.candidateMigration012Applied === true, 'candidate migration 012 missing')
  requireValue(VERSION.test(value.agentCoreVersion), 'Agent Core candidate version invalid')
  requireValue(VERSION.test(value.knowledgeConnectorVersion), 'Knowledge Connector candidate version invalid')
  requireValue(VERSION.test(value.hLiteVersion), 'H-Lite candidate version invalid')
  requireValue(value.foundationCriticalContainerCount === 13, 'Foundation critical container count mismatch')
  requireValue(value.foundationUnhealthyContainerCount === 0, 'Foundation unhealthy containers detected')
  requireValue(value.foundationRestartCountTotal === 0, 'Foundation restart count must remain zero')
  requireValue(value.newHostPortCount === 0, 'Goal 7 opened new host ports')
  requireValue(value.routeAOperational === true, 'Route A is not operational')
  requireValue(value.routeBEnabled === false, 'Route B must remain disabled')
  exactKeys(value.sideEffects, ['formalP2Count', 'employeeDeliveryCount', 'erpWritebackCount', 'socialWritebackCount'], 'deployment.sideEffects')
  for (const key of Object.keys(value.sideEffects)) requireValue(value.sideEffects[key] === 0, `deployment.sideEffects.${key} must be zero`)
  exactKeys(value.closedCapabilities, [
    'productResearchBulkImport', 'realEmployeeCanary', 'employeePrivateBotMigration',
    'erpWriteback', 'socialWriteback',
  ], 'deployment.closedCapabilities')
  for (const key of Object.keys(value.closedCapabilities)) requireValue(value.closedCapabilities[key] === false, `deployment.closedCapabilities.${key} must remain false`)
  exactKeys(value.rawEvidenceFiles, ['runtimeIdentity', 'preparation', 'migration', 'before', 'after', 'sideEffects'], 'deployment.rawEvidenceFiles')
  for (const [key, file] of Object.entries(value.rawEvidenceFiles)) {
    exactKeys(file, ['file', 'sha256'], `deployment.rawEvidenceFiles.${key}`)
    requireValue(/^[a-z0-9-]+\.json$/.test(file.file), `deployment.rawEvidenceFiles.${key}.file invalid`)
    requireValue(HASH.test(file.sha256), `deployment.rawEvidenceFiles.${key}.sha256 invalid`)
  }
}

function validateOwnerAcceptance(value, engineering) {
  exactKeys(value, [
    'evidenceVersion', 'evidenceType', 'goalKey', 'accepted', 'acceptedAt',
    'sourceCommit', 'hLiteSourceCommit', 'ownerPrincipalHash', 'acceptanceRef',
    'engineeringEvidenceFiles', 'publicOutputContainsSensitiveData',
  ], 'ownerAcceptance')
  requireValue(value.evidenceVersion === '2.0.0', 'ownerAcceptance evidenceVersion mismatch')
  requireValue(value.evidenceType === 'goal7-owner-acceptance', 'ownerAcceptance evidenceType mismatch')
  requireValue(value.goalKey === 'P1-PROD-READINESS', 'ownerAcceptance goalKey mismatch')
  requireValue(value.accepted === true, 'Goal 7 owner acceptance missing')
  validTimestamp(value.acceptedAt, 'ownerAcceptance.acceptedAt')
  requireValue(value.sourceCommit === engineering.sourceCommit, 'ownerAcceptance sourceCommit drift')
  requireValue(value.hLiteSourceCommit === engineering.hLiteSourceCommit, 'ownerAcceptance H-Lite sourceCommit drift')
  requireValue(HASH.test(String(value.ownerPrincipalHash || '')), 'ownerAcceptance ownerPrincipalHash invalid')
  validReference(value.acceptanceRef, 'ownerAcceptance.acceptanceRef')
  exactKeys(value.engineeringEvidenceFiles, Object.keys(GOAL7_ENGINEERING_EVIDENCE_FILES), 'ownerAcceptance.engineeringEvidenceFiles')
  for (const [key, file] of Object.entries(GOAL7_ENGINEERING_EVIDENCE_FILES)) {
    exactKeys(value.engineeringEvidenceFiles[key], ['file', 'sha256'], `ownerAcceptance.engineeringEvidenceFiles.${key}`)
    requireValue(value.engineeringEvidenceFiles[key].file === file, `ownerAcceptance engineering file drift in ${key}`)
    requireValue(value.engineeringEvidenceFiles[key].sha256 === engineering.entries[key].sha256, `ownerAcceptance engineering hash drift in ${key}`)
  }
  requireValue(Date.parse(value.acceptedAt) >= engineering.latestEngineeringAt, 'Goal 7 owner acceptance predates engineering evidence')
  requireValue(value.publicOutputContainsSensitiveData === false, 'ownerAcceptance exposes sensitive data')
  rejectSensitiveKeys(value, 'ownerAcceptance')
}

async function readEvidenceFile(bundleRoot, fileName) {
  requireValue(path.basename(fileName) === fileName, 'Goal 7 evidence filename is unsafe')
  const filePath = path.join(bundleRoot, fileName)
  const stat = await fs.lstat(filePath)
  requireValue(stat.isFile() && !stat.isSymbolicLink(), `${fileName} must be a regular file`)
  requireValue(stat.size > 0 && stat.size <= MAX_EVIDENCE_BYTES, `${fileName} size invalid`)
  const bytes = await fs.readFile(filePath)
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) }
}

export async function buildGoal7EngineeringEvidenceContext(bundleRoot) {
  const root = path.resolve(bundleRoot)
  const entries = Object.fromEntries(await Promise.all(Object.entries(GOAL7_ENGINEERING_EVIDENCE_FILES).map(async ([key, fileName]) => [key, await readEvidenceFile(root, fileName)])))
  validateRuntimeVerification(entries.runtimeVerification.value)
  validateWorkerReadback(entries.workerReadback.value)
  await validateGoal7WorkerReadbackEvidence(root, entries.workerReadback.value)
  validateAuthorityCanary(entries.authorityCanary.value)
  validateDeployment(entries.deployment.value)
  await validateGoal7DeploymentEvidence(root, entries.deployment.value)

  const sourceCommit = entries.runtimeVerification.value.sourceCommit
  for (const key of ['workerReadback', 'authorityCanary', 'deployment']) {
    requireValue(entries[key].value.sourceCommit === sourceCommit, `Goal 7 sourceCommit drift in ${key}`)
  }
  const hLiteSourceCommit = entries.runtimeVerification.value.hLiteSourceCommit
  for (const key of ['workerReadback', 'authorityCanary', 'deployment']) {
    requireValue(entries[key].value.hLiteSourceCommit === hLiteSourceCommit, `Goal 7 H-Lite sourceCommit drift in ${key}`)
  }
  const deployment = entries.deployment.value
  for (const key of ['agentCoreVersion', 'knowledgeConnectorVersion', 'hLiteVersion']) {
    requireValue(deployment[key] === entries.runtimeVerification.value[key], `Goal 7 ${key} drift in deployment`)
  }
  const latestEngineeringAt = Math.max(...['workerReadback', 'authorityCanary', 'deployment'].map((key) => Date.parse(entries[key].value.capturedAt)))
  return { root, entries, sourceCommit, hLiteSourceCommit, latestEngineeringAt }
}

export async function writeGoal7OwnerAcceptanceEvidence(bundleRoot, {
  ownerPrincipalRef,
  acceptanceRef,
  acceptedAt = new Date(),
  outputFile = path.join(bundleRoot, GOAL7_EVIDENCE_FILES.ownerAcceptance),
} = {}) {
  const engineering = await buildGoal7EngineeringEvidenceContext(bundleRoot)
  requireValue(typeof ownerPrincipalRef === 'string' && ownerPrincipalRef.trim().length >= 8, 'Goal 7 owner principal reference is required')
  validReference(acceptanceRef, 'ownerAcceptance.acceptanceRef')
  const acceptedAtMs = new Date(acceptedAt).getTime()
  requireValue(Number.isFinite(acceptedAtMs), 'ownerAcceptance.acceptedAt invalid')
  requireValue(acceptedAtMs >= engineering.latestEngineeringAt, 'Goal 7 owner acceptance predates engineering evidence')
  const evidence = {
    evidenceVersion: '2.0.0',
    evidenceType: 'goal7-owner-acceptance',
    goalKey: 'P1-PROD-READINESS',
    accepted: true,
    acceptedAt: new Date(acceptedAtMs).toISOString(),
    sourceCommit: engineering.sourceCommit,
    hLiteSourceCommit: engineering.hLiteSourceCommit,
    ownerPrincipalHash: sha256(Buffer.from(ownerPrincipalRef.trim())),
    acceptanceRef,
    engineeringEvidenceFiles: Object.fromEntries(Object.entries(GOAL7_ENGINEERING_EVIDENCE_FILES).map(([key, file]) => [key, { file, sha256: engineering.entries[key].sha256 }])),
    publicOutputContainsSensitiveData: false,
  }
  await fs.writeFile(path.resolve(outputFile), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  return evidence
}

export async function buildGoal7AcceptanceEvidence(bundleRoot) {
  const engineering = await buildGoal7EngineeringEvidenceContext(bundleRoot)
  const ownerAcceptance = await readEvidenceFile(engineering.root, GOAL7_EVIDENCE_FILES.ownerAcceptance)
  validateOwnerAcceptance(ownerAcceptance.value, engineering)
  const entries = { ...engineering.entries, ownerAcceptance }
  const { sourceCommit, hLiteSourceCommit } = engineering

  const authority = entries.authorityCanary.value
  const worker = entries.workerReadback.value
  const deployment = entries.deployment.value
  const evidenceRefs = [
    worker.evidenceRef,
    authority.evidenceRef,
    deployment.evidenceRef,
    entries.ownerAcceptance.value.acceptanceRef,
    `git:workflow/${entries.runtimeVerification.value.workflowRunId}`,
    `git:feishu-grok-bridge/${hLiteSourceCommit}`,
  ]
  requireValue(new Set(evidenceRefs).size === evidenceRefs.length, 'Goal 7 evidence references must be unique')
  return {
    evidenceVersion: '2.0.0',
    goalKey: 'P1-PROD-READINESS',
    status: 'complete',
    engineeringVerified: true,
    ownerAccepted: true,
    acceptedAt: new Date(entries.ownerAcceptance.value.acceptedAt).toISOString(),
    sourceCommit,
    hLiteSourceCommit,
    ownerAcceptanceRef: entries.ownerAcceptance.value.acceptanceRef,
    evidenceRefs,
    evidenceFiles: Object.fromEntries(Object.entries(GOAL7_EVIDENCE_FILES).map(([key, file]) => [key, { file, sha256: entries[key].sha256 }])),
    authorityEvidence: {
      principalModelVerified: true,
      senderPrincipalIsolationVerified: authority.scenarios.privateSenderOnly && authority.scenarios.multiMentionNoExpansion,
      purposeNarrowingVerified: authority.scenarios.purposeNarrowing,
      revocationFailClosedVerified: authority.scenarios.revokedChatMembershipFailClosed && authority.scenarios.revocationConvergenceSeconds <= 60,
      readBeforeBodyAclVerified: authority.scenarios.aclFailureBeforeBody && authority.counts.bodyReadOnDeniedCount === 0,
    },
    runtimeEvidence: {
      circuitBreakerVerified: true,
      retryBudgetVerified: true,
      costBudgetVerified: true,
      realModelReadbackVerified: worker.productionReady
        && worker.governance.routeKey === 'route-a'
        && worker.governance.ledgerRecorded === true
        && worker.governance.routeBEnabled === false
        && worker.usage.totalTokens === worker.usage.promptTokens + worker.usage.completionTokens,
    },
    routeState: {
      routeAOperational: deployment.routeAOperational,
      routeBEnabled: deployment.routeBEnabled,
    },
    closedCapabilities: deployment.closedCapabilities,
  }
}

export async function writeGoal7AcceptanceEvidence(bundleRoot, outputFile = path.join(bundleRoot, 'goal7-acceptance.json')) {
  const evidence = await buildGoal7AcceptanceEvidence(bundleRoot)
  await fs.writeFile(path.resolve(outputFile), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  return evidence
}

export async function validateGoal7AcceptanceEvidence(evidenceFile) {
  const resolved = path.resolve(evidenceFile)
  const bytes = await fs.readFile(resolved)
  requireValue(bytes.length > 0 && bytes.length <= MAX_EVIDENCE_BYTES, 'Goal 7 acceptance file size invalid')
  const evidence = JSON.parse(bytes.toString('utf8'))
  requireValue(evidence?.evidenceVersion === '2.0.0', 'Goal 7 acceptance evidenceVersion mismatch')
  requireValue(evidence?.goalKey === 'P1-PROD-READINESS', 'Goal 7 acceptance goalKey mismatch')
  requireValue(evidence?.status === 'complete', 'Goal 7 status must be complete')
  requireValue(evidence?.engineeringVerified === true, 'Goal 7 engineeringVerified must be true')
  requireValue(evidence?.ownerAccepted === true, 'Goal 7 ownerAccepted must be true')
  const expected = await buildGoal7AcceptanceEvidence(path.dirname(resolved))
  requireValue(isDeepStrictEqual(evidence, expected), 'Goal 7 acceptance is not compiler-derived from the bound evidence files')
  return { evidence, evidenceHash: sha256(bytes) }
}
