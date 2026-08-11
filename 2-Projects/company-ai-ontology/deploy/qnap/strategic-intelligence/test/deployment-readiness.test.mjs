import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  compileShadowSourceRegistry,
  createP003ReviewWorkbook,
  createSourceApprovalWorkbook,
  loadP003ReviewContext,
  loadSourceApprovalContext,
} from '../../../../packages/ontology-contracts/src/index.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSPECTOR = path.join(ROOT, 'scripts/inspect-deployment-readiness.mjs')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function principal(role) {
  return {
    role,
    displayName: `${role}-reviewer`,
    principalRef: `company-directory:${role}-reviewer`,
    decision: 'approve',
  }
}

async function createReadyInputs() {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-readiness-'))
  const releaseRoot = path.join(outputRoot, 'release')
  await fs.mkdir(releaseRoot)
  const sourceBytes = Buffer.from('source archive')
  const imageBytes = Buffer.from('collector image archive')
  await fs.writeFile(path.join(releaseRoot, 'source.tar.gz'), sourceBytes)
  await fs.writeFile(path.join(releaseRoot, 'collector-image.tar.gz'), imageBytes)
  await fs.writeFile(path.join(releaseRoot, 'release-manifest.json'), JSON.stringify({
    manifestVersion: '1.1.0',
    releaseType: 'P1-SI-F-shadow-candidate-gated',
    createdAt: '2026-08-11T00:00:00Z',
    sourceCommit: 'a'.repeat(40),
    collectorImageId: `sha256:${'b'.repeat(64)}`,
    sourceArchiveSha256: sha256(sourceBytes),
    collectorImageArchiveSha256: sha256(imageBytes),
    candidateOntologySchema: '3.7.0',
    candidateOntologyHash: 'c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860',
    sourceRegistryCandidateHash: '0ce4022adcfc177ced670a8d7fd2e4b4e119c2fc1bc5c19cabefb3223c010eae',
    publish: false,
    productionDeploymentAuthorized: false,
    requiredGate: 'WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH',
    p003ReviewGateRequired: true,
    goal7AcceptanceGateRequired: true,
  }))

  const { sourceContract, catalog, approvalContract } = await loadSourceApprovalContext()
  const sourceWorkbook = createSourceApprovalWorkbook(catalog)
  for (const review of sourceWorkbook.reviews) {
    review.decision = 'keep_paused'
    review.approvedAt = '2026-08-11T00:00:00Z'
    review.decisionReason = '来源继续暂停。'
    review.namedComplianceDri = principal('compliance')
  }
  const approvedSource = sourceWorkbook.reviews[0]
  approvedSource.decision = 'approve_for_shadow'
  approvedSource.licenseDecision = 'approved'
  approvedSource.complianceDecision = 'approved'
  approvedSource.approvedStorageLevel = approvedSource.candidateStorageLevel
  approvedSource.approvedRetentionDays = approvedSource.candidateRetentionDays
  approvedSource.licenseEvidenceRefs = [approvedSource.candidateLicenseEvidenceRef]
  approvedSource.complianceEvidenceRefs = ['feishu:doc/company-source-approval']
  approvedSource.namedLicenseReviewer = principal('license')
  approvedSource.decisionReason = '批准仅用于 PUBLISH=false Shadow。'
  const compiled = compileShadowSourceRegistry(sourceWorkbook, catalog, sourceContract, approvalContract)
  const registryFile = path.join(outputRoot, 'approved-source-registry.json')
  const collectorConfigFile = path.join(outputRoot, 'approved-collector-config.json')
  await fs.writeFile(registryFile, JSON.stringify(compiled.registry))
  await fs.writeFile(collectorConfigFile, JSON.stringify({ sourceKeys: [approvedSource.sourceKey] }))

  const { catalog: p003Catalog } = await loadP003ReviewContext()
  const p003Workbook = createP003ReviewWorkbook(p003Catalog)
  for (const review of p003Workbook.reviews) {
    review.decision = 'keep_inactive'
    review.reviewedAt = '2026-08-11T00:00:00Z'
    review.decisionReason = '真实 DRI 已完成审核，本条关系继续保持 inactive。'
    review.reviewParticipants = [principal(review.proposedDriRoles[0] || 'product')]
  }
  const p003ReviewFile = path.join(outputRoot, 'approved-p003-review.json')
  await fs.writeFile(p003ReviewFile, JSON.stringify(p003Workbook))

  const goal7File = path.join(outputRoot, 'goal7-acceptance.json')
  await fs.writeFile(goal7File, JSON.stringify({
    evidenceVersion: '1.0.0',
    goalKey: 'P1-PROD-READINESS',
    status: 'complete',
    engineeringVerified: true,
    ownerAccepted: true,
    acceptedAt: '2026-08-11T00:00:00Z',
    sourceCommit: 'c'.repeat(40),
    ownerAcceptanceRef: 'feishu:doc/goal7-owner-acceptance',
    evidenceRefs: ['git:commit/goal7-accepted', 'qnap:acceptance/goal7'],
    authorityEvidence: {
      principalModelVerified: true,
      senderPrincipalIsolationVerified: true,
      purposeNarrowingVerified: true,
      revocationFailClosedVerified: true,
      readBeforeBodyAclVerified: true,
    },
    runtimeEvidence: {
      circuitBreakerVerified: true,
      retryBudgetVerified: true,
      costBudgetVerified: true,
      realModelReadbackVerified: true,
    },
    routeState: { routeAOperational: true, routeBEnabled: false },
    closedCapabilities: {
      productResearchBulkImport: false,
      realEmployeeCanary: false,
      employeePrivateBotMigration: false,
      erpWriteback: false,
      socialWriteback: false,
    },
  }))

  return { releaseRoot, registryFile, collectorConfigFile, p003ReviewFile, goal7File }
}

test('readiness inspector reports every missing gate without exposing paths', () => {
  const result = spawnSync(process.execPath, [INSPECTOR], { encoding: 'utf8', env: {} })
  assert.equal(result.status, 2)
  const output = JSON.parse(result.stdout)
  assert.equal(output.deploymentEligible, false)
  assert.equal(output.blockedGateCount, 6)
  assert.equal(output.requiredGate, 'WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH')
  assert.ok(output.gates.every((gate) => gate.status === 'blocked'))
  assert.deepEqual(output.gates.find((gate) => gate.key === 'immutable_release'), {
    key: 'immutable_release',
    status: 'blocked',
    reasonCode: 'missing_input',
  })
  assert.doesNotMatch(result.stdout, /\/Users\//)
  assert.doesNotMatch(result.stdout, /\/share\//)
})

test('readiness inspector accepts only fully validated deployment inputs', async () => {
  const inputs = await createReadyInputs()
  const result = spawnSync(process.execPath, [INSPECTOR], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SHADOW_DEPLOY_APPROVED: 'YES',
      GOAL7_STATUS: 'complete',
      SI_RELEASE_ROOT: inputs.releaseRoot,
      SI_APPROVED_SOURCE_REGISTRY_FILE: inputs.registryFile,
      SI_APPROVED_COLLECTOR_CONFIG_FILE: inputs.collectorConfigFile,
      SI_APPROVED_P003_REVIEW_FILE: inputs.p003ReviewFile,
      SI_GOAL7_ACCEPTANCE_FILE: inputs.goal7File,
    },
  })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.deploymentEligible, true)
  assert.equal(output.passedGateCount, 6)
  assert.equal(output.blockedGateCount, 0)
  assert.equal(output.requiredGate, 'READY_FOR_EXPLICIT_DEPLOYMENT')
})

test('readiness inspector fails closed when a present approval file is invalid', async () => {
  const inputs = await createReadyInputs()
  await fs.writeFile(inputs.goal7File, JSON.stringify({ status: 'pending' }))
  const result = spawnSync(process.execPath, [INSPECTOR], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SHADOW_DEPLOY_APPROVED: 'YES',
      GOAL7_STATUS: 'complete',
      SI_RELEASE_ROOT: inputs.releaseRoot,
      SI_APPROVED_SOURCE_REGISTRY_FILE: inputs.registryFile,
      SI_APPROVED_COLLECTOR_CONFIG_FILE: inputs.collectorConfigFile,
      SI_APPROVED_P003_REVIEW_FILE: inputs.p003ReviewFile,
      SI_GOAL7_ACCEPTANCE_FILE: inputs.goal7File,
    },
  })
  assert.equal(result.status, 2)
  const output = JSON.parse(result.stdout)
  const goal7Gate = output.gates.find((gate) => gate.key === 'goal7_owner_acceptance')
  assert.deepEqual(goal7Gate, { key: 'goal7_owner_acceptance', status: 'blocked', reasonCode: 'validation_failed' })
  assert.doesNotMatch(result.stdout, /ownerAccepted/)
})
