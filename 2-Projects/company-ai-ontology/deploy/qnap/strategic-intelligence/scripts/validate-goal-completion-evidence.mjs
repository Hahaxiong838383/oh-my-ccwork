#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const evidenceFile = process.argv[2]
if (!evidenceFile) throw new Error('goal completion evidence file is required')

const evidence = JSON.parse(await fs.readFile(path.resolve(evidenceFile), 'utf8'))
const errors = []
const HASH = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const IMAGE = /(^sha256:[a-f0-9]{64}$)|(@sha256:[a-f0-9]{64}$)/

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

const rootKeys = [
  'evidenceVersion', 'goalKey', 'status', 'deploymentMode', 'companyQnap', 'deployedAt', 'verifiedAt', 'publish',
  'releaseIdentity', 'policyIdentity', 'preDeployment', 'postDeployment', 'database', 'approvalEvidenceHashes',
  'sideEffects', 'backup', 'sevenDay', 'verifiedByPrincipalRef',
]
exactKeys(evidence, rootKeys, 'goal completion evidence')
requireValue(evidence.evidenceVersion === '1.0.0', 'evidenceVersion mismatch')
requireValue(evidence.goalKey === 'P1-STRATEGIC-INTELLIGENCE', 'goalKey mismatch')
requireValue(evidence.status === 'complete', 'status must be complete')
requireValue(evidence.deploymentMode === 'production_shadow', 'deploymentMode must be production_shadow')
requireValue(validTimestamp(evidence.deployedAt), 'deployedAt invalid')
requireValue(validTimestamp(evidence.verifiedAt), 'verifiedAt invalid')
requireValue(validTimestamp(evidence.deployedAt) && validTimestamp(evidence.verifiedAt) && Date.parse(evidence.verifiedAt) >= Date.parse(evidence.deployedAt), 'verifiedAt must not predate deployment')
requireValue(evidence.publish === false, 'publish must remain false')

exactKeys(evidence.companyQnap, ['purpose', 'host', 'model', 'ip', 'foundationRoot', 'shadowRoot'], 'companyQnap')
requireValue(evidence.companyQnap?.purpose === 'company_ai_ontology_production', 'company QNAP purpose mismatch')
requireValue(evidence.companyQnap?.host === 'PRNas', 'company QNAP host mismatch')
requireValue(evidence.companyQnap?.model === 'TS-X65', 'company QNAP model mismatch')
requireValue(evidence.companyQnap?.ip === '192.168.61.18', 'company QNAP address mismatch')
requireValue(evidence.companyQnap?.foundationRoot === '/share/CACHEDEV1_DATA/ai-ontology/foundation', 'company foundation root mismatch')
requireValue(evidence.companyQnap?.shadowRoot === '/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence', 'strategic intelligence root mismatch')

exactKeys(evidence.releaseIdentity, ['sourceCommit', 'collectorImage', 'candidateOntologySchema', 'candidateOntologyHash', 'releaseManifestHash'], 'releaseIdentity')
requireValue(COMMIT.test(String(evidence.releaseIdentity?.sourceCommit || '')), 'sourceCommit invalid')
requireValue(IMAGE.test(String(evidence.releaseIdentity?.collectorImage || '')), 'collectorImage invalid')
requireValue(evidence.releaseIdentity?.candidateOntologySchema === '3.7.0', 'candidate ontology schema mismatch')
requireValue(evidence.releaseIdentity?.candidateOntologyHash === 'c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860', 'candidate ontology hash mismatch')
requireValue(HASH.test(String(evidence.releaseIdentity?.releaseManifestHash || '')), 'releaseManifestHash invalid')

exactKeys(evidence.policyIdentity, ['policyVersion', 'policyHash'], 'policyIdentity')
requireValue(typeof evidence.policyIdentity?.policyVersion === 'string' && evidence.policyIdentity.policyVersion.length > 0, 'policyVersion missing')
requireValue(HASH.test(String(evidence.policyIdentity?.policyHash || '')), 'policyHash invalid')

const snapshotKeys = [
  'activeOntologySchema', 'activeOntologyHash', 'registryStatus', 'foundationCriticalContainerCount',
  'foundationUnhealthyContainerCount', 'foundationRestartCountTotal', 'strategicIntelligenceContainerCount',
]
for (const [label, snapshot] of [['preDeployment', evidence.preDeployment], ['postDeployment', evidence.postDeployment]]) {
  const keys = label === 'postDeployment'
    ? [...snapshotKeys, 'strategicIntelligenceOrchestratorHealth', 'strategicIntelligenceOrchestratorRestartCount', 'activeCollectorContainerCount', 'newHostPortCount', 'publicPortCount']
    : snapshotKeys
  exactKeys(snapshot, keys, label)
  requireValue(snapshot?.activeOntologySchema === '3.3.0', `${label}.activeOntologySchema must remain 3.3.0`)
  requireValue(HASH.test(String(snapshot?.activeOntologyHash || '')), `${label}.activeOntologyHash invalid`)
  requireValue(snapshot?.registryStatus === 'in_sync', `${label}.registryStatus must be in_sync`)
  requireValue(Number.isInteger(snapshot?.foundationCriticalContainerCount) && snapshot.foundationCriticalContainerCount > 0, `${label}.foundationCriticalContainerCount invalid`)
  requireValue(snapshot?.foundationUnhealthyContainerCount === 0, `${label}.foundationUnhealthyContainerCount must be zero`)
  requireValue(snapshot?.foundationRestartCountTotal === 0, `${label}.foundationRestartCountTotal must be zero`)
  requireValue(Number.isInteger(snapshot?.strategicIntelligenceContainerCount) && snapshot.strategicIntelligenceContainerCount >= 0, `${label}.strategicIntelligenceContainerCount invalid`)
}
requireValue(evidence.preDeployment?.activeOntologyHash === evidence.postDeployment?.activeOntologyHash, 'active ontology hash changed during Shadow deployment')
requireValue(evidence.preDeployment?.foundationCriticalContainerCount === evidence.postDeployment?.foundationCriticalContainerCount, 'foundation critical container count changed')
requireValue(evidence.preDeployment?.strategicIntelligenceContainerCount === 0, 'strategic intelligence containers existed before deployment')
requireValue(evidence.postDeployment?.strategicIntelligenceContainerCount === 1, 'post deployment must contain only the orchestrator')
requireValue(evidence.postDeployment?.strategicIntelligenceOrchestratorHealth === 'healthy', 'orchestrator must be healthy')
requireValue(evidence.postDeployment?.strategicIntelligenceOrchestratorRestartCount === 0, 'orchestrator restart count must be zero')
requireValue(evidence.postDeployment?.activeCollectorContainerCount === 0, 'collector must not remain active')
requireValue(evidence.postDeployment?.newHostPortCount === 0, 'new host port count must be zero')
requireValue(evidence.postDeployment?.publicPortCount === 0, 'public port count must be zero')

exactKeys(evidence.database, ['appliedCandidateMigrations', 'foundationRestartCount'], 'database')
requireValue(JSON.stringify(evidence.database?.appliedCandidateMigrations) === JSON.stringify(['010', '011']), 'candidate migrations must be exactly 010 and 011')
requireValue(evidence.database?.foundationRestartCount === 0, 'database foundation restart count must be zero')

exactKeys(evidence.approvalEvidenceHashes, ['sourceRegistry', 'p003Review', 'reviewerRoleAccess', 'goal7'], 'approvalEvidenceHashes')
for (const key of ['sourceRegistry', 'p003Review', 'reviewerRoleAccess', 'goal7']) {
  requireValue(HASH.test(String(evidence.approvalEvidenceHashes?.[key] || '')), `approvalEvidenceHashes.${key} invalid`)
}

exactKeys(evidence.sideEffects, ['formalP2Count', 'employeeDeliveryCount', 'erpWritebackCount', 'socialWritebackCount', 'causalActivationCount'], 'sideEffects')
for (const key of ['formalP2Count', 'employeeDeliveryCount', 'erpWritebackCount', 'socialWritebackCount', 'causalActivationCount']) {
  requireValue(evidence.sideEffects?.[key] === 0, `${key} must remain zero`)
}

exactKeys(evidence.backup, ['configurationBackupVerified', 'rollbackPackageVerified', 'backupRef'], 'backup')
requireValue(evidence.backup?.configurationBackupVerified === true, 'configuration backup must be verified')
requireValue(evidence.backup?.rollbackPackageVerified === true, 'rollback package must be verified')
requireValue(/^qnap:\S+$/.test(String(evidence.backup?.backupRef || '')), 'backupRef invalid')

exactKeys(evidence.sevenDay, ['completedNaturalDays', 'summaryHash', 'ownerAccepted', 'ownerAcceptanceRef'], 'sevenDay')
requireValue(evidence.sevenDay?.completedNaturalDays === 7, 'seven completed natural days required')
requireValue(HASH.test(String(evidence.sevenDay?.summaryHash || '')), 'seven-day summaryHash invalid')
requireValue(evidence.sevenDay?.ownerAccepted === true, 'seven-day owner acceptance required')
requireValue(typeof evidence.sevenDay?.ownerAcceptanceRef === 'string' && evidence.sevenDay.ownerAcceptanceRef.length >= 8, 'ownerAcceptanceRef missing')
requireValue(/^company-directory:[A-Za-z0-9._-]+$/.test(String(evidence.verifiedByPrincipalRef || '')), 'verifiedByPrincipalRef invalid')

if (errors.length > 0) throw new Error(`goal completion evidence denied: ${errors.join('; ')}`)
const evidenceHash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
process.stdout.write(`${JSON.stringify({
  ok: true,
  goalKey: evidence.goalKey,
  status: evidence.status,
  sourceCommit: evidence.releaseIdentity.sourceCommit,
  collectorImage: evidence.releaseIdentity.collectorImage,
  completedNaturalDays: 7,
  ownerAccepted: true,
  evidenceHash,
}, null, 2)}\n`)
