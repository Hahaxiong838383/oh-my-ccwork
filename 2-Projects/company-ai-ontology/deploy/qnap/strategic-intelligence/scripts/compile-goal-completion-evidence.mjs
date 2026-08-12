#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const preSnapshotFile = process.env.SI_PRE_DEPLOYMENT_SNAPSHOT_FILE
const postSnapshotFile = process.env.SI_POST_SEVEN_DAY_SNAPSHOT_FILE
const releaseRoot = process.env.SI_RELEASE_ROOT
const summaryFile = process.env.SI_SEVEN_DAY_ACCEPTED_SUMMARY_FILE
const evidenceRoot = process.env.SI_SEVEN_DAY_EVIDENCE_ROOT
const outputFile = process.env.SI_GOAL_COMPLETION_EVIDENCE_FILE
const deployedAt = process.env.SI_GOAL_COMPLETION_DEPLOYED_AT
const verifiedByPrincipalRef = process.env.SI_GOAL_COMPLETION_VERIFIED_BY_PRINCIPAL_REF

for (const [key, value] of Object.entries({
  SI_PRE_DEPLOYMENT_SNAPSHOT_FILE: preSnapshotFile,
  SI_POST_SEVEN_DAY_SNAPSHOT_FILE: postSnapshotFile,
  SI_RELEASE_ROOT: releaseRoot,
  SI_SEVEN_DAY_ACCEPTED_SUMMARY_FILE: summaryFile,
  SI_SEVEN_DAY_EVIDENCE_ROOT: evidenceRoot,
  SI_GOAL_COMPLETION_EVIDENCE_FILE: outputFile,
  SI_GOAL_COMPLETION_DEPLOYED_AT: deployedAt,
  SI_GOAL_COMPLETION_VERIFIED_BY_PRINCIPAL_REF: verifiedByPrincipalRef,
  SI_APPROVED_SOURCE_REGISTRY_FILE: process.env.SI_APPROVED_SOURCE_REGISTRY_FILE,
  SI_APPROVED_COLLECTOR_CONFIG_FILE: process.env.SI_APPROVED_COLLECTOR_CONFIG_FILE,
  SI_APPROVED_P003_REVIEW_FILE: process.env.SI_APPROVED_P003_REVIEW_FILE,
  SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE: process.env.SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE,
  SI_GOAL7_ACCEPTANCE_FILE: process.env.SI_GOAL7_ACCEPTANCE_FILE,
})) {
  if (!value) throw new Error(`${key} is required`)
}

function runValidator(script, args) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${script} failed`)
  return JSON.parse(result.stdout)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

const releaseFiles = [
  path.join(releaseRoot, 'release-manifest.json'),
  path.join(releaseRoot, 'source.tar.gz'),
  path.join(releaseRoot, 'h-lite-source.tar.gz'),
  path.join(releaseRoot, 'collector-image.tar.gz'),
  path.join(releaseRoot, 'runtime-component-versions.json'),
]
const preValidation = runValidator('validate-goal-runtime-snapshot.mjs', [preSnapshotFile, 'pre_deployment'])
const postValidation = runValidator('validate-goal-runtime-snapshot.mjs', [postSnapshotFile, 'post_seven_day'])
runValidator('validate-release-manifest.mjs', releaseFiles)
const sourceRegistryValidation = runValidator('validate-approved-registry.mjs', [
  process.env.SI_APPROVED_SOURCE_REGISTRY_FILE,
  process.env.SI_APPROVED_COLLECTOR_CONFIG_FILE,
])
const p003Validation = runValidator('validate-approved-p003-review.mjs', [process.env.SI_APPROVED_P003_REVIEW_FILE])
const roleValidation = runValidator('validate-reviewer-role-access-acceptance.mjs', [process.env.SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE])
const goal7Validation = runValidator('validate-goal7-acceptance.mjs', [process.env.SI_GOAL7_ACCEPTANCE_FILE])
runValidator('validate-seven-day-shadow-summary.mjs', [summaryFile, evidenceRoot])

const [pre, post, manifestBytes, summaryBytes] = await Promise.all([
  fs.readFile(path.resolve(preSnapshotFile), 'utf8').then(JSON.parse),
  fs.readFile(path.resolve(postSnapshotFile), 'utf8').then(JSON.parse),
  fs.readFile(releaseFiles[0]),
  fs.readFile(path.resolve(summaryFile)),
])
const manifest = JSON.parse(manifestBytes.toString('utf8'))
const summary = JSON.parse(summaryBytes.toString('utf8'))

if (pre.companyQnap.host !== post.companyQnap.host) throw new Error('QNAP identity drift detected')
if (pre.activeOntology.contentHash !== post.activeOntology.contentHash) throw new Error('active ontology hash changed during production Shadow')
if (pre.foundation.criticalContainerCount !== post.foundation.criticalContainerCount) throw new Error('foundation critical container count changed')
if (summary.runtimeIdentity.sourceCommit !== manifest.sourceCommit) throw new Error('seven-day source commit does not match release')
if (summary.runtimeIdentity.collectorImage !== manifest.collectorImageId) throw new Error('seven-day collector image does not match release')
if (!Number.isFinite(Date.parse(deployedAt))) throw new Error('SI_GOAL_COMPLETION_DEPLOYED_AT invalid')
if (Date.parse(post.capturedAt) < Date.parse(summary.ownerAcceptance.acceptedAt)) throw new Error('post snapshot predates owner acceptance')

const evidence = {
  evidenceVersion: '1.0.0',
  goalKey: 'P1-STRATEGIC-INTELLIGENCE',
  status: 'complete',
  deploymentMode: 'production_shadow',
  companyQnap: post.companyQnap,
  deployedAt: new Date(deployedAt).toISOString(),
  verifiedAt: new Date(post.capturedAt).toISOString(),
  publish: false,
  releaseIdentity: {
    sourceCommit: manifest.sourceCommit,
    collectorImage: manifest.collectorImageId,
    candidateOntologySchema: manifest.candidateOntologySchema,
    candidateOntologyHash: manifest.candidateOntologyHash,
    releaseManifestHash: sha256(manifestBytes),
  },
  policyIdentity: {
    policyVersion: summary.runtimeIdentity.policyVersion,
    policyHash: summary.runtimeIdentity.policyHash,
  },
  preDeployment: {
    activeOntologySchema: pre.activeOntology.schemaVersion,
    activeOntologyHash: pre.activeOntology.contentHash,
    registryStatus: pre.activeOntology.registryStatus,
    foundationCriticalContainerCount: pre.foundation.criticalContainerCount,
    foundationUnhealthyContainerCount: pre.foundation.unhealthyContainerCount,
    foundationRestartCountTotal: pre.foundation.restartCountTotal,
    strategicIntelligenceContainerCount: pre.strategicIntelligence.containerCount,
  },
  postDeployment: {
    activeOntologySchema: post.activeOntology.schemaVersion,
    activeOntologyHash: post.activeOntology.contentHash,
    registryStatus: post.activeOntology.registryStatus,
    foundationCriticalContainerCount: post.foundation.criticalContainerCount,
    foundationUnhealthyContainerCount: post.foundation.unhealthyContainerCount,
    foundationRestartCountTotal: post.foundation.restartCountTotal,
    strategicIntelligenceContainerCount: post.strategicIntelligence.containerCount,
    strategicIntelligenceOrchestratorHealth: post.strategicIntelligence.orchestratorHealth,
    strategicIntelligenceOrchestratorRestartCount: post.strategicIntelligence.orchestratorRestartCount,
    activeCollectorContainerCount: post.strategicIntelligence.activeCollectorContainerCount,
    newHostPortCount: post.strategicIntelligence.newHostPortCount,
    publicPortCount: post.strategicIntelligence.publicPortCount,
  },
  database: post.database,
  approvalEvidenceHashes: {
    sourceRegistry: sourceRegistryValidation.registryHash,
    p003Review: p003Validation.workbookHash,
    reviewerRoleAccess: roleValidation.evidenceHash,
    goal7: goal7Validation.evidenceHash,
  },
  sideEffects: post.sideEffects,
  backup: post.backup,
  sevenDay: {
    completedNaturalDays: summary.completedNaturalDays,
    summaryHash: sha256(summaryBytes),
    ownerAccepted: summary.ownerAcceptance.ownerAccepted,
    ownerAcceptanceRef: summary.ownerAcceptance.acceptanceRef,
  },
  verifiedByPrincipalRef,
}

await fs.mkdir(path.dirname(path.resolve(outputFile)), { recursive: true, mode: 0o750 })
await fs.writeFile(path.resolve(outputFile), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
runValidator('validate-goal-completion-evidence.mjs', [outputFile])
process.stdout.write(`${JSON.stringify({
  ok: true,
  outputCreated: true,
  preSnapshotHash: preValidation.snapshotHash,
  postSnapshotHash: postValidation.snapshotHash,
  sourceCommit: manifest.sourceCommit,
  completedNaturalDays: summary.completedNaturalDays,
  ownerAccepted: true,
}, null, 2)}\n`)
