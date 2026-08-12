import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  compileSevenDayEngineeringSummary,
  recordOwnerAcceptance,
} from '../scripts/seven-day-shadow-lib.mjs'
import { createReadyInputs as createDeploymentReadyInputs } from './fixtures/readiness-fixtures.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSPECTOR = path.join(ROOT, 'scripts/inspect-goal-completion.mjs')
const EVIDENCE_VALIDATOR = path.join(ROOT, 'scripts/validate-goal-completion-evidence.mjs')
const SNAPSHOT_VALIDATOR = path.join(ROOT, 'scripts/validate-goal-runtime-snapshot.mjs')
const COMPLETION_COMPILER = path.join(ROOT, 'scripts/compile-goal-completion-evidence.mjs')
const EVALUATOR = path.join(ROOT, 'scripts/evaluate-shadow.mjs')
const REGISTRY_VALIDATOR = path.join(ROOT, 'scripts/validate-approved-registry.mjs')
const P003_VALIDATOR = path.join(ROOT, 'scripts/validate-approved-p003-review.mjs')
const ROLE_VALIDATOR = path.join(ROOT, 'scripts/validate-reviewer-role-access-acceptance.mjs')
const GOAL7_VALIDATOR = path.join(ROOT, 'scripts/validate-goal7-acceptance.mjs')
const POLICY_FILE = path.join(ROOT, 'config/shadow-policy.json')
const policy = JSON.parse(await fs.readFile(POLICY_FILE, 'utf8'))
const policyHash = createHash('sha256').update(JSON.stringify(policy)).digest('hex')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function validDay(localDate) {
  return {
    evidenceVersion: '1.0.0',
    requestKey: `daily-collection-shadow-${localDate}`,
    localDate,
    timezone: 'Asia/Shanghai',
    requestedAt: `${localDate}T00:00:00.000Z`,
    recordedAt: `${localDate}T00:02:10.000Z`,
    policyVersion: policy.policyVersion,
    policyHash,
    simulated: false,
    publish: false,
    status: 'succeeded',
    startedAt: `${localDate}T00:01:00.000Z`,
    completedAt: `${localDate}T00:02:00.000Z`,
    durationSeconds: 60,
    exitCode: 0,
    timeoutCount: 0,
    sourceAttemptCount: 8,
    sourceSuccessCount: 8,
    rawSnapshotCount: 8,
    normalizedItemCount: 7,
    duplicateCount: 1,
    freshnessP95Seconds: 1800,
    rawSnapshotBytes: 1024,
    networkBytes: 2048,
    peakCpuPermille: 400,
    peakMemoryBytes: 256 * 1024 * 1024,
    reportCostsUsd: { daily: 0.25, weekly: 0 },
    domainArtifacts: {
      persistenceState: 'postgres_committed',
      rawSnapshotCount: 8,
      observationCount: 7,
      signalCount: 7,
      evidenceCount: 7,
      impactAssessmentCount: 6,
      reportRunCount: 3,
      reportDraftCount: 3,
    },
    security: {
      unredactedSensitiveOutputCount: 0,
      sourceRevocationEffectiveSeconds: 60,
      postRevocationNetworkRequestCount: 0,
      lastGoodPreserved: true,
    },
    sideEffects: {
      formalP2Count: 0,
      employeeDeliveryCount: 0,
      erpWritebackCount: 0,
      socialWritebackCount: 0,
      causalActivationCount: 0,
    },
    runtime: {
      collectorImage: `sha256:${'b'.repeat(64)}`,
      sourceCommit: 'a'.repeat(40),
      containerRestartCount: 0,
      newHostPortCount: 0,
    },
    coverage: {
      collectorMetricsCollected: true,
      resourceMetricsCollected: true,
      sensitiveOutputAuditCompleted: true,
      sourceRevocationAuditCompleted: true,
      businessSideEffectAuditCompleted: true,
      domainCompilationCompleted: true,
      domainPersistenceCompleted: true,
    },
  }
}

async function createReadyInputs() {
  const deploymentInputs = await createDeploymentReadyInputs()
  const { outputRoot, releaseRoot } = deploymentInputs
  const evidenceRoot = path.join(outputRoot, 'evidence')
  await fs.mkdir(evidenceRoot)
  const manifestFile = path.join(releaseRoot, 'release-manifest.json')

  for (let index = 0; index < 7; index += 1) {
    const localDate = new Date(Date.parse('2026-08-01T00:00:00Z') + index * 86400000).toISOString().slice(0, 10)
    const evidence = validDay(localDate)
    const evidenceFile = path.join(evidenceRoot, `${evidence.requestKey}.json`)
    await fs.writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
    const evaluation = spawnSync(process.execPath, [EVALUATOR, POLICY_FILE, evidenceFile], { encoding: 'utf8' })
    assert.equal(evaluation.status, 0, evaluation.stderr)
    await fs.writeFile(`${evidenceFile}.evaluation.json`, evaluation.stdout, { mode: 0o600 })
  }

  const engineeringSummary = await compileSevenDayEngineeringSummary(evidenceRoot)
  const acceptedSummary = recordOwnerAcceptance(engineeringSummary, {
    acceptedAt: '2026-08-08T00:00:00.000Z',
    acceptedByPrincipalRef: 'company-directory:owner',
    acceptanceRef: 'feishu:doc/p1-si-shadow-owner-acceptance',
  })
  const acceptedSummaryFile = path.join(outputRoot, 'seven-day-shadow-summary.accepted.json')
  await fs.writeFile(acceptedSummaryFile, `${JSON.stringify(acceptedSummary, null, 2)}\n`, { mode: 0o600 })

  const manifestBytes = await fs.readFile(manifestFile)
  const summaryBytes = await fs.readFile(acceptedSummaryFile)
  const registryValidation = spawnSync(process.execPath, [REGISTRY_VALIDATOR, deploymentInputs.registryFile, deploymentInputs.collectorConfigFile], { encoding: 'utf8' })
  const p003Validation = spawnSync(process.execPath, [P003_VALIDATOR, deploymentInputs.p003ReviewFile], { encoding: 'utf8' })
  const roleValidation = spawnSync(process.execPath, [ROLE_VALIDATOR, deploymentInputs.reviewerRoleAccessFile], { encoding: 'utf8' })
  const goal7Validation = spawnSync(process.execPath, [GOAL7_VALIDATOR, deploymentInputs.goal7File], { encoding: 'utf8' })
  for (const validation of [registryValidation, p003Validation, roleValidation, goal7Validation]) assert.equal(validation.status, 0, validation.stderr)
  const approvalHashes = {
    sourceRegistry: JSON.parse(registryValidation.stdout).registryHash,
    p003Review: JSON.parse(p003Validation.stdout).workbookHash,
    reviewerRoleAccess: JSON.parse(roleValidation.stdout).evidenceHash,
    goal7: JSON.parse(goal7Validation.stdout).evidenceHash,
  }
  const completionFile = path.join(outputRoot, 'goal-completion-evidence.json')
  const activeOntologyHash = '1'.repeat(64)
  const snapshot = {
    activeOntologySchema: '3.3.0',
    activeOntologyHash,
    registryStatus: 'in_sync',
    foundationCriticalContainerCount: 13,
    foundationUnhealthyContainerCount: 0,
    foundationRestartCountTotal: 0,
    strategicIntelligenceContainerCount: 0,
  }
  const completion = {
    evidenceVersion: '1.0.0',
    goalKey: 'P1-STRATEGIC-INTELLIGENCE',
    status: 'complete',
    deploymentMode: 'production_shadow',
    companyQnap: {
      purpose: 'company_ai_ontology_production',
      host: 'PRNas',
      model: 'TS-X65',
      ip: '192.168.61.18',
      foundationRoot: '/share/CACHEDEV1_DATA/ai-ontology/foundation',
      shadowRoot: '/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence',
    },
    deployedAt: '2026-08-01T00:00:00.000Z',
    verifiedAt: '2026-08-08T00:10:00.000Z',
    publish: false,
    releaseIdentity: {
      sourceCommit: 'a'.repeat(40),
      collectorImage: `sha256:${'b'.repeat(64)}`,
      candidateOntologySchema: '3.7.0',
      candidateOntologyHash: 'c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860',
      releaseManifestHash: sha256(manifestBytes),
    },
    policyIdentity: {
      policyVersion: policy.policyVersion,
      policyHash,
    },
    preDeployment: snapshot,
    postDeployment: {
      ...snapshot,
      strategicIntelligenceContainerCount: 1,
      strategicIntelligenceOrchestratorHealth: 'healthy',
      strategicIntelligenceOrchestratorRestartCount: 0,
      activeCollectorContainerCount: 0,
      newHostPortCount: 0,
      publicPortCount: 0,
    },
    database: {
      appliedCandidateMigrations: ['010', '011', '012'],
      foundationRestartCount: 0,
    },
    approvalEvidenceHashes: approvalHashes,
    sideEffects: {
      formalP2Count: 0,
      employeeDeliveryCount: 0,
      erpWritebackCount: 0,
      socialWritebackCount: 0,
      causalActivationCount: 0,
    },
    backup: {
      configurationBackupVerified: true,
      rollbackPackageVerified: true,
      backupRef: 'qnap:strategic-intelligence/pre-shadow-a',
    },
    sevenDay: {
      completedNaturalDays: 7,
      summaryHash: sha256(summaryBytes),
      ownerAccepted: true,
      ownerAcceptanceRef: acceptedSummary.ownerAcceptance.acceptanceRef,
    },
    verifiedByPrincipalRef: 'company-directory:security-owner',
  }
  await fs.writeFile(completionFile, `${JSON.stringify(completion, null, 2)}\n`, { mode: 0o600 })
  return { ...deploymentInputs, evidenceRoot, acceptedSummaryFile, completionFile, completion }
}

function completionEnv(inputs) {
  return {
    ...process.env,
    SI_RELEASE_ROOT: inputs.releaseRoot,
    SI_GOAL_COMPLETION_EVIDENCE_FILE: inputs.completionFile,
    SI_SEVEN_DAY_ACCEPTED_SUMMARY_FILE: inputs.acceptedSummaryFile,
    SI_SEVEN_DAY_EVIDENCE_ROOT: inputs.evidenceRoot,
    SI_APPROVED_SOURCE_REGISTRY_FILE: inputs.registryFile,
    SI_APPROVED_COLLECTOR_CONFIG_FILE: inputs.collectorConfigFile,
    SI_APPROVED_P003_REVIEW_FILE: inputs.p003ReviewFile,
    SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE: inputs.reviewerRoleAccessFile,
    SI_GOAL7_ACCEPTANCE_FILE: inputs.goal7File,
  }
}

async function writeRuntimeSnapshots(inputs) {
  const preSnapshotFile = path.join(inputs.outputRoot, 'pre-deployment-snapshot.json')
  const postSnapshotFile = path.join(inputs.outputRoot, 'post-seven-day-snapshot.json')
  const shared = {
    snapshotVersion: '1.0.0',
    companyQnap: inputs.completion.companyQnap,
    activeOntology: {
      schemaVersion: inputs.completion.preDeployment.activeOntologySchema,
      contentHash: inputs.completion.preDeployment.activeOntologyHash,
      registryStatus: inputs.completion.preDeployment.registryStatus,
    },
    foundation: {
      criticalContainerCount: inputs.completion.preDeployment.foundationCriticalContainerCount,
      unhealthyContainerCount: 0,
      restartCountTotal: 0,
    },
    sideEffects: inputs.completion.sideEffects,
  }
  const pre = {
    ...shared,
    phase: 'pre_deployment',
    capturedAt: '2026-08-01T00:00:00.000Z',
    strategicIntelligence: {
      containerCount: 0,
      orchestratorHealth: 'absent',
      orchestratorRestartCount: 0,
      activeCollectorContainerCount: 0,
      newHostPortCount: 0,
      publicPortCount: 0,
    },
    database: {
      appliedCandidateMigrations: ['012'],
      foundationRestartCount: 0,
    },
    backup: null,
  }
  const post = {
    ...shared,
    phase: 'post_seven_day',
    capturedAt: inputs.completion.verifiedAt,
    strategicIntelligence: {
      containerCount: 1,
      orchestratorHealth: 'healthy',
      orchestratorRestartCount: 0,
      activeCollectorContainerCount: 0,
      newHostPortCount: 0,
      publicPortCount: 0,
    },
    database: inputs.completion.database,
    backup: inputs.completion.backup,
  }
  await fs.writeFile(preSnapshotFile, `${JSON.stringify(pre, null, 2)}\n`, { mode: 0o600 })
  await fs.writeFile(postSnapshotFile, `${JSON.stringify(post, null, 2)}\n`, { mode: 0o600 })
  return { preSnapshotFile, postSnapshotFile, pre, post }
}

function compilerEnv(inputs, snapshots, outputFile) {
  return {
    ...completionEnv(inputs),
    SI_PRE_DEPLOYMENT_SNAPSHOT_FILE: snapshots.preSnapshotFile,
    SI_POST_SEVEN_DAY_SNAPSHOT_FILE: snapshots.postSnapshotFile,
    SI_GOAL_COMPLETION_EVIDENCE_FILE: outputFile,
    SI_GOAL_COMPLETION_DEPLOYED_AT: inputs.completion.deployedAt,
    SI_GOAL_COMPLETION_VERIFIED_BY_PRINCIPAL_REF: inputs.completion.verifiedByPrincipalRef,
  }
}

test('goal completion inspector reports every missing final gate without exposing paths', () => {
  const result = spawnSync(process.execPath, [INSPECTOR], { encoding: 'utf8', env: {} })
  assert.equal(result.status, 2)
  const output = JSON.parse(result.stdout)
  assert.equal(output.goalCompletionEligible, false)
  assert.equal(output.blockedGateCount, 8)
  assert.ok(output.gates.every((gate) => gate.status === 'blocked'))
  assert.doesNotMatch(result.stdout, /\/Users\//)
  assert.doesNotMatch(result.stdout, /\/share\//)
})

test('goal completion requires one immutable identity across release, deployment and seven real days', async () => {
  const inputs = await createReadyInputs()
  const evidenceValidation = spawnSync(process.execPath, [EVIDENCE_VALIDATOR, inputs.completionFile], { encoding: 'utf8' })
  assert.equal(evidenceValidation.status, 0, evidenceValidation.stderr)

  const result = spawnSync(process.execPath, [INSPECTOR], { encoding: 'utf8', env: completionEnv(inputs) })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.goalCompletionEligible, true)
  assert.equal(output.productionShadowCompleted, true)
  assert.equal(output.businessSideEffectsZero, true)
  assert.equal(output.passedGateCount, 8)
  assert.equal(output.requiredGate, 'GOAL_COMPLETE')
})

test('goal completion rejects unhealthy deployment evidence and immutable identity drift', async () => {
  const inputs = await createReadyInputs()
  const unsafe = structuredClone(inputs.completion)
  unsafe.postDeployment.strategicIntelligenceOrchestratorRestartCount = 1
  await fs.writeFile(inputs.completionFile, JSON.stringify(unsafe))
  const unhealthy = spawnSync(process.execPath, [INSPECTOR], { encoding: 'utf8', env: completionEnv(inputs) })
  assert.equal(unhealthy.status, 2)
  assert.equal(JSON.parse(unhealthy.stdout).gates.find((gate) => gate.key === 'deployment_completion_evidence').status, 'blocked')

  const drift = structuredClone(inputs.completion)
  drift.releaseIdentity.sourceCommit = 'b'.repeat(40)
  await fs.writeFile(inputs.completionFile, JSON.stringify(drift))
  const mismatch = spawnSync(process.execPath, [INSPECTOR], { encoding: 'utf8', env: completionEnv(inputs) })
  assert.equal(mismatch.status, 2)
  assert.equal(JSON.parse(mismatch.stdout).gates.find((gate) => gate.key === 'release_deployment_shadow_identity').status, 'blocked')
})

test('goal completion rejects seven-day evidence without owner acceptance', async () => {
  const inputs = await createReadyInputs()
  const summary = JSON.parse(await fs.readFile(inputs.acceptedSummaryFile, 'utf8'))
  summary.ownerAcceptance = {
    ownerAccepted: false,
    acceptedAt: null,
    acceptedByPrincipalRef: null,
    acceptanceRef: null,
    ownerAcceptanceHash: null,
  }
  await fs.writeFile(inputs.acceptedSummaryFile, JSON.stringify(summary))
  const result = spawnSync(process.execPath, [INSPECTOR], { encoding: 'utf8', env: completionEnv(inputs) })
  assert.equal(result.status, 2)
  const output = JSON.parse(result.stdout)
  assert.equal(output.gates.find((gate) => gate.key === 'seven_day_owner_acceptance').status, 'blocked')
  assert.equal(output.requiredGate, 'WAIT_PRODUCTION_SHADOW_AND_OWNER_ACCEPTANCE')
})

test('goal completion evidence compiler derives hashes and state from validated raw inputs', async () => {
  const inputs = await createReadyInputs()
  const snapshots = await writeRuntimeSnapshots(inputs)
  const compiledFile = path.join(inputs.outputRoot, 'compiled-goal-completion-evidence.json')
  for (const [file, phase] of [[snapshots.preSnapshotFile, 'pre_deployment'], [snapshots.postSnapshotFile, 'post_seven_day']]) {
    const validation = spawnSync(process.execPath, [SNAPSHOT_VALIDATOR, file, phase], { encoding: 'utf8' })
    assert.equal(validation.status, 0, validation.stderr)
  }

  const compiled = spawnSync(process.execPath, [COMPLETION_COMPILER], {
    encoding: 'utf8',
    env: compilerEnv(inputs, snapshots, compiledFile),
  })
  assert.equal(compiled.status, 0, compiled.stderr)
  assert.equal((await fs.stat(compiledFile)).mode & 0o777, 0o600)
  const compiledEvidence = JSON.parse(await fs.readFile(compiledFile, 'utf8'))
  assert.equal(compiledEvidence.releaseIdentity.sourceCommit, inputs.completion.releaseIdentity.sourceCommit)
  assert.deepEqual(compiledEvidence.approvalEvidenceHashes, inputs.completion.approvalEvidenceHashes)
  assert.equal(compiledEvidence.sevenDay.ownerAccepted, true)

  const completion = spawnSync(process.execPath, [INSPECTOR], {
    encoding: 'utf8',
    env: { ...completionEnv(inputs), SI_GOAL_COMPLETION_EVIDENCE_FILE: compiledFile },
  })
  assert.equal(completion.status, 0, completion.stderr)
  assert.equal(JSON.parse(completion.stdout).goalCompletionEligible, true)
})

test('goal completion evidence compiler rejects runtime drift and incomplete post state', async () => {
  const inputs = await createReadyInputs()
  const snapshots = await writeRuntimeSnapshots(inputs)
  const unsafePost = structuredClone(snapshots.post)
  unsafePost.activeOntology.contentHash = '9'.repeat(64)
  await fs.writeFile(snapshots.postSnapshotFile, JSON.stringify(unsafePost))
  const drift = spawnSync(process.execPath, [COMPLETION_COMPILER], {
    encoding: 'utf8',
    env: compilerEnv(inputs, snapshots, path.join(inputs.outputRoot, 'drift.json')),
  })
  assert.notEqual(drift.status, 0)
  assert.match(drift.stderr, /active ontology hash changed/)

  const incompletePost = structuredClone(snapshots.post)
  incompletePost.database.appliedCandidateMigrations = ['010', '011']
  await fs.writeFile(snapshots.postSnapshotFile, JSON.stringify(incompletePost))
  const incomplete = spawnSync(process.execPath, [COMPLETION_COMPILER], {
    encoding: 'utf8',
    env: compilerEnv(inputs, snapshots, path.join(inputs.outputRoot, 'incomplete.json')),
  })
  assert.notEqual(incomplete.status, 0)
  assert.match(incomplete.stderr, /validate-goal-runtime-snapshot\.mjs failed/)
})
