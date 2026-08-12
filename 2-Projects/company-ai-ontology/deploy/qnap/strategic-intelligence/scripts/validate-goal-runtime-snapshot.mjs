#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const snapshotFile = process.argv[2]
const expectedPhase = process.argv[3]
if (!snapshotFile || !expectedPhase) throw new Error('runtime snapshot file and expected phase are required')
if (!['pre_deployment', 'post_seven_day'].includes(expectedPhase)) throw new Error('expected phase invalid')

const snapshot = JSON.parse(await fs.readFile(path.resolve(snapshotFile), 'utf8'))
const errors = []
const HASH = /^[a-f0-9]{64}$/

function requireValue(condition, message) {
  if (!condition) errors.push(message)
}

function exactKeys(value, keys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  requireValue(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} contains unexpected or missing fields`)
}

exactKeys(snapshot, ['snapshotVersion', 'phase', 'capturedAt', 'companyQnap', 'activeOntology', 'foundation', 'strategicIntelligence', 'database', 'sideEffects', 'backup'], 'runtime snapshot')
requireValue(snapshot.snapshotVersion === '1.0.0', 'snapshotVersion mismatch')
requireValue(snapshot.phase === expectedPhase, 'snapshot phase mismatch')
requireValue(typeof snapshot.capturedAt === 'string' && Number.isFinite(Date.parse(snapshot.capturedAt)), 'capturedAt invalid')

exactKeys(snapshot.companyQnap, ['purpose', 'host', 'model', 'ip', 'foundationRoot', 'shadowRoot'], 'companyQnap')
requireValue(snapshot.companyQnap?.purpose === 'company_ai_ontology_production', 'company QNAP purpose mismatch')
requireValue(snapshot.companyQnap?.host === 'PRNas', 'company QNAP host mismatch')
requireValue(snapshot.companyQnap?.model === 'TS-X65', 'company QNAP model mismatch')
requireValue(snapshot.companyQnap?.ip === '192.168.61.18', 'company QNAP address mismatch')
requireValue(snapshot.companyQnap?.foundationRoot === '/share/CACHEDEV1_DATA/ai-ontology/foundation', 'foundation root mismatch')
requireValue(snapshot.companyQnap?.shadowRoot === '/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence', 'shadow root mismatch')

exactKeys(snapshot.activeOntology, ['schemaVersion', 'contentHash', 'registryStatus'], 'activeOntology')
requireValue(snapshot.activeOntology?.schemaVersion === '3.3.0', 'active ontology schema must remain 3.3.0')
requireValue(HASH.test(String(snapshot.activeOntology?.contentHash || '')), 'active ontology contentHash invalid')
requireValue(snapshot.activeOntology?.registryStatus === 'in_sync', 'registry must remain in_sync')

exactKeys(snapshot.foundation, ['criticalContainerCount', 'unhealthyContainerCount', 'restartCountTotal'], 'foundation')
requireValue(Number.isInteger(snapshot.foundation?.criticalContainerCount) && snapshot.foundation.criticalContainerCount > 0, 'foundation criticalContainerCount invalid')
requireValue(snapshot.foundation?.unhealthyContainerCount === 0, 'foundation unhealthyContainerCount must be zero')
requireValue(snapshot.foundation?.restartCountTotal === 0, 'foundation restartCountTotal must be zero')

exactKeys(snapshot.strategicIntelligence, ['containerCount', 'orchestratorHealth', 'orchestratorRestartCount', 'activeCollectorContainerCount', 'newHostPortCount', 'publicPortCount'], 'strategicIntelligence')
requireValue(Number.isInteger(snapshot.strategicIntelligence?.containerCount) && snapshot.strategicIntelligence.containerCount >= 0, 'strategic intelligence containerCount invalid')
requireValue(snapshot.strategicIntelligence?.orchestratorRestartCount === 0, 'orchestrator restart count must be zero')
requireValue(snapshot.strategicIntelligence?.activeCollectorContainerCount === 0, 'collector must not remain active')
requireValue(snapshot.strategicIntelligence?.newHostPortCount === 0, 'new host port count must be zero')
requireValue(snapshot.strategicIntelligence?.publicPortCount === 0, 'public port count must be zero')

exactKeys(snapshot.database, ['appliedCandidateMigrations', 'foundationRestartCount'], 'database')
requireValue(Array.isArray(snapshot.database?.appliedCandidateMigrations), 'appliedCandidateMigrations must be an array')
requireValue(snapshot.database?.foundationRestartCount === 0, 'database foundation restart count must be zero')

exactKeys(snapshot.sideEffects, ['formalP2Count', 'employeeDeliveryCount', 'erpWritebackCount', 'socialWritebackCount', 'causalActivationCount'], 'sideEffects')
for (const key of ['formalP2Count', 'employeeDeliveryCount', 'erpWritebackCount', 'socialWritebackCount', 'causalActivationCount']) {
  requireValue(snapshot.sideEffects?.[key] === 0, `${key} must remain zero`)
}

if (expectedPhase === 'pre_deployment') {
  requireValue(snapshot.strategicIntelligence?.containerCount === 0, 'pre-deployment strategic intelligence container count must be zero')
  requireValue(snapshot.strategicIntelligence?.orchestratorHealth === 'absent', 'pre-deployment orchestrator must be absent')
  requireValue(JSON.stringify(snapshot.database?.appliedCandidateMigrations) === JSON.stringify(['012']), 'pre-deployment must contain only Goal 7 migration 012')
  requireValue(snapshot.backup === null, 'pre-deployment backup must be null')
} else {
  requireValue(snapshot.strategicIntelligence?.containerCount === 1, 'post-seven-day strategic intelligence container count must equal one')
  requireValue(snapshot.strategicIntelligence?.orchestratorHealth === 'healthy', 'post-seven-day orchestrator must be healthy')
  requireValue(JSON.stringify(snapshot.database?.appliedCandidateMigrations) === JSON.stringify(['010', '011', '012']), 'post-seven-day candidate migrations must be exactly 010, 011 and 012')
  exactKeys(snapshot.backup, ['configurationBackupVerified', 'rollbackPackageVerified', 'backupRef'], 'backup')
  requireValue(snapshot.backup?.configurationBackupVerified === true, 'configuration backup must be verified')
  requireValue(snapshot.backup?.rollbackPackageVerified === true, 'rollback package must be verified')
  requireValue(/^qnap:\S+$/.test(String(snapshot.backup?.backupRef || '')), 'backupRef invalid')
}

if (errors.length > 0) throw new Error(`runtime snapshot denied: ${errors.join('; ')}`)
const snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
process.stdout.write(`${JSON.stringify({
  ok: true,
  phase: snapshot.phase,
  capturedAt: snapshot.capturedAt,
  activeOntologySchema: snapshot.activeOntology.schemaVersion,
  strategicIntelligenceContainerCount: snapshot.strategicIntelligence.containerCount,
  snapshotHash,
}, null, 2)}\n`)
