import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
import { tick } from '../orchestrator/orchestrator.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ROOT = path.resolve(ROOT, '../../..')

async function json(relative) {
  return JSON.parse(await fs.readFile(path.join(ROOT, relative), 'utf8'))
}

function principal(role) {
  return {
    role,
    displayName: `${role}-reviewer`,
    principalRef: `company-directory:${role}-reviewer`,
    decision: 'approve',
  }
}

function finalizeP003Workbook(workbook) {
  for (const review of workbook.reviews) {
    review.decision = 'keep_inactive'
    review.reviewedAt = '2026-08-10T09:00:00Z'
    review.decisionReason = '真实 DRI 已完成审核，本条关系继续保持 inactive。'
    review.reviewParticipants = [principal(review.proposedDriRoles[0] || 'product')]
  }
  return workbook
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

test('shadow compose isolates services, ports, socket, privileges and side effects', async () => {
  const compose = await json('docker-compose.shadow.yml')
  assert.deepEqual(Object.keys(compose.services).sort(), ['intelligence-collector', 'intelligence-orchestrator'])
  for (const service of Object.values(compose.services)) {
    assert.equal(service.ports, undefined)
    assert.equal(service.expose, undefined)
    assert.notEqual(service.privileged, true)
    assert.equal(service.read_only, true)
    assert.ok(service.cap_drop.includes('ALL'))
    assert.ok(service.security_opt.includes('no-new-privileges:true'))
    assert.ok(service.volumes.every((entry) => !entry.includes('docker.sock')))
    assert.equal(service.environment.PUBLISH, 'false')
    assert.equal(service.environment.FORMAL_P2_ENABLED, 'false')
    assert.equal(service.environment.EMPLOYEE_DELIVERY_ENABLED, 'false')
    assert.equal(service.environment.ERP_WRITEBACK_ENABLED, 'false')
    assert.equal(service.environment.SOCIAL_WRITEBACK_ENABLED, 'false')
    assert.equal(service.environment.CAUSAL_ACTIVATION_ENABLED, 'false')
  }
})

test('collector remains a resource-limited ephemeral worker', async () => {
  const compose = await json('docker-compose.shadow.yml')
  const collector = compose.services['intelligence-collector']
  assert.equal(collector.cpus, 0.5)
  assert.equal(collector.mem_limit, '512m')
  assert.equal(collector.restart, 'no')
  assert.deepEqual(collector.profiles, ['worker'])
  assert.match(collector.image, /sha256/)
  assert.ok(!collector.command.join(' ').includes('publish'))
})

test('orchestrator emits one idempotent publish=false request per Shanghai natural day', async () => {
  const policy = await json('config/shadow-policy.json')
  const queueRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-orchestrator-'))
  const now = new Date('2026-08-10T22:30:00Z')
  const first = await tick({ policy, queueRoot, now })
  const second = await tick({ policy, queueRoot, now })
  assert.equal(first.length, 1)
  assert.equal(second.length, 0)
  assert.equal(first[0].localDate, '2026-08-11')
  assert.equal(first[0].publish, false)
  assert.deepEqual(first[0].forbiddenSideEffects, ['formal_p2', 'employee_delivery', 'erp_writeback', 'social_writeback', 'causal_activation'])
})

test('threshold policy freezes all business side effects at zero', async () => {
  const policy = await json('config/shadow-policy.json')
  assert.equal(policy.requiredConsecutiveNaturalDays, 7)
  assert.equal(policy.resourceLimits.collectorCpuCores, 0.5)
  assert.equal(policy.resourceLimits.collectorMemoryMiB, 512)
  for (const key of ['formalP2CountMax', 'employeeDeliveryCountMax', 'erpWritebackCountMax', 'socialWritebackCountMax', 'causalActivationCountMax']) {
    assert.equal(policy.acceptanceThresholds[key], 0)
  }
  assert.equal(policy.automaticResponse.defaultAction, 'freeze_shadow')
  assert.equal(policy.automaticResponse.rollbackRequiresPreapprovalEnvironment, 'SHADOW_AUTO_ROLLBACK_APPROVED=YES')
})

test('deployment scripts only target strategic intelligence services and keep explicit gates', async () => {
  const names = ['dispatch-next.sh', 'freeze-shadow.sh', 'backup-shadow.sh', 'rollback-shadow.sh', 'prepare-shadow-release.sh', 'apply-shadow-migrations.sh', 'deploy-shadow.sh', 'install-dispatcher-cron.sh']
  const forbiddenServiceCommands = /compose\s+(?:--[^\s]+\s+)*(?:up|restart|stop)\b[^\n]*(?:agent-core|h-lite|domain-connector|knowledge-connector|gateway|postgres|redis|qdrant)/
  for (const name of names) {
    const script = await fs.readFile(path.join(ROOT, 'scripts', name), 'utf8')
    assert.doesNotMatch(script, /git add \.|git add -A/)
    assert.doesNotMatch(script, /docker\.sock/)
    assert.doesNotMatch(script, forbiddenServiceCommands)
  }
  const rollback = await fs.readFile(path.join(ROOT, 'scripts/rollback-shadow.sh'), 'utf8')
  assert.match(rollback, /SHADOW_ROLLBACK_APPROVED/)
  const prepare = await fs.readFile(path.join(ROOT, 'scripts/prepare-shadow-release.sh'), 'utf8')
  assert.match(prepare, /HEAD must equal the pushed upstream commit/)
  assert.match(prepare, /release requires a clean project subtree/)
  assert.match(prepare, /source_commit}:2-Projects\/company-ai-ontology/)
  assert.match(prepare, /validate-release-manifest\.mjs/)
  const deploy = await fs.readFile(path.join(ROOT, 'scripts/deploy-shadow.sh'), 'utf8')
  assert.match(deploy, /SHADOW_DEPLOY_APPROVED/)
  assert.match(deploy, /GOAL7_STATUS/)
  assert.match(deploy, /SI_GOAL7_ACCEPTANCE_FILE/)
  assert.match(deploy, /validate-goal7-acceptance\.mjs/)
  assert.match(deploy, /validate-release-manifest\.mjs/)
  assert.match(deploy, /SI_APPROVED_P003_REVIEW_FILE/)
  assert.match(deploy, /validate-approved-p003-review\.mjs/)
  assert.match(deploy, /release_project_root\/deploy\/qnap\/strategic-intelligence\/scripts\/apply-shadow-migrations\.sh/)
  assert.match(deploy, /up -d --no-deps intelligence-orchestrator/)
  assert.doesNotMatch(deploy, /up -d[^\n]*(?:agent-core|h-lite|connector|gateway|postgres|redis|qdrant)/)
  const migration = await fs.readFile(path.join(ROOT, 'scripts/apply-shadow-migrations.sh'), 'utf8')
  assert.match(migration, /SI_GOAL7_ACCEPTANCE_FILE/)
  assert.match(migration, /validate-goal7-acceptance\.mjs/)
})

test('release manifest validator binds immutable archives and keeps deployment disabled', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-release-manifest-'))
  const sourceArchive = path.join(outputRoot, 'source.tar.gz')
  const imageArchive = path.join(outputRoot, 'collector-image.tar.gz')
  const manifestFile = path.join(outputRoot, 'release-manifest.json')
  const sourceBytes = Buffer.from('immutable source archive')
  const imageBytes = Buffer.from('immutable collector image archive')
  await fs.writeFile(sourceArchive, sourceBytes)
  await fs.writeFile(imageArchive, imageBytes)
  const manifest = {
    manifestVersion: '1.1.0',
    releaseType: 'P1-SI-F-shadow-candidate-gated',
    createdAt: '2026-08-10T09:00:00Z',
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
  }
  await fs.writeFile(manifestFile, JSON.stringify(manifest))
  const { spawnSync } = await import('node:child_process')
  const validator = path.join(ROOT, 'scripts/validate-release-manifest.mjs')
  const accepted = spawnSync(process.execPath, [validator, manifestFile, sourceArchive, imageArchive], { encoding: 'utf8' })
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal(JSON.parse(accepted.stdout).productionDeploymentAuthorized, false)

  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, publish: true }))
  const unsafe = spawnSync(process.execPath, [validator, manifestFile, sourceArchive, imageArchive], { encoding: 'utf8' })
  assert.notEqual(unsafe.status, 0)
  assert.match(unsafe.stderr, /publish must remain false/)

  await fs.writeFile(manifestFile, JSON.stringify(manifest))
  await fs.writeFile(sourceArchive, 'tampered source archive')
  const tampered = spawnSync(process.execPath, [validator, manifestFile, sourceArchive, imageArchive], { encoding: 'utf8' })
  assert.notEqual(tampered.status, 0)
  assert.match(tampered.stderr, /source archive hash mismatch/)

  await fs.writeFile(sourceArchive, sourceBytes)
  await fs.writeFile(manifestFile, JSON.stringify({
    ...manifest,
    manifestVersion: '1.0.0',
    releaseType: 'P1-SI-F-shadow-candidate',
  }))
  const legacy = spawnSync(process.execPath, [validator, manifestFile, sourceArchive, imageArchive], { encoding: 'utf8' })
  assert.notEqual(legacy.status, 0)
  assert.match(legacy.stderr, /manifestVersion mismatch/)
  assert.match(legacy.stderr, /releaseType mismatch/)
})

test('approved registry validator accepts only enabled sources from a shadow-reviewed registry', async () => {
  const { sourceContract, catalog, approvalContract } = await loadSourceApprovalContext()
  const workbook = createSourceApprovalWorkbook(catalog)
  for (const review of workbook.reviews) {
    review.decision = 'keep_paused'
    review.approvedAt = '2026-08-10T09:00:00Z'
    review.decisionReason = '来源继续暂停。'
    review.namedComplianceDri = principal('compliance')
  }
  const approved = workbook.reviews[0]
  approved.decision = 'approve_for_shadow'
  approved.licenseDecision = 'approved'
  approved.complianceDecision = 'approved'
  approved.approvedStorageLevel = approved.candidateStorageLevel
  approved.approvedRetentionDays = approved.candidateRetentionDays
  approved.licenseEvidenceRefs = [approved.candidateLicenseEvidenceRef]
  approved.complianceEvidenceRefs = ['feishu:doc/company-source-approval']
  approved.namedLicenseReviewer = principal('license')
  approved.decisionReason = '批准仅用于 PUBLISH=false Shadow。'
  const compiled = compileShadowSourceRegistry(workbook, catalog, sourceContract, approvalContract)

  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-approved-registry-'))
  const registryFile = path.join(outputRoot, 'registry.json')
  const configFile = path.join(outputRoot, 'config.json')
  await fs.writeFile(registryFile, JSON.stringify(compiled.registry))
  await fs.writeFile(configFile, JSON.stringify({ sourceKeys: [approved.sourceKey] }))
  const { spawnSync } = await import('node:child_process')
  const validator = path.join(ROOT, 'scripts/validate-approved-registry.mjs')
  const accepted = spawnSync(process.execPath, [validator, registryFile, configFile], { encoding: 'utf8' })
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal(JSON.parse(accepted.stdout).approvedSourceCount, 1)

  await fs.writeFile(configFile, JSON.stringify({ sourceKeys: [workbook.reviews[1].sourceKey] }))
  const denied = spawnSync(process.execPath, [validator, registryFile, configFile], { encoding: 'utf8' })
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /source approval gate denied/)
})

test('P003 deployment gate requires all real-review decisions and keeps every relation inactive', async () => {
  const { catalog } = await loadP003ReviewContext()
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-p003-review-gate-'))
  const reviewFile = path.join(outputRoot, 'p003-review.json')
  const validator = path.join(ROOT, 'scripts/validate-approved-p003-review.mjs')
  const { spawnSync } = await import('node:child_process')

  const reviewed = finalizeP003Workbook(createP003ReviewWorkbook(catalog))
  await fs.writeFile(reviewFile, JSON.stringify(reviewed))
  const accepted = spawnSync(process.execPath, [validator, reviewFile], { encoding: 'utf8' })
  assert.equal(accepted.status, 0, accepted.stderr)
  const result = JSON.parse(accepted.stdout)
  assert.equal(result.reviewCount, 36)
  assert.equal(result.finalDecisionCount, 36)
  assert.equal(result.productionActivationAllowed, false)

  const pending = createP003ReviewWorkbook(catalog)
  await fs.writeFile(reviewFile, JSON.stringify(pending))
  const incomplete = spawnSync(process.execPath, [validator, reviewFile], { encoding: 'utf8' })
  assert.notEqual(incomplete.status, 0)
  assert.match(incomplete.stderr, /P003 review gate denied/)

  reviewed.reviews[0].activationStatus = 'active'
  await fs.writeFile(reviewFile, JSON.stringify(reviewed))
  const activated = spawnSync(process.execPath, [validator, reviewFile], { encoding: 'utf8' })
  assert.notEqual(activated.status, 0)
  assert.match(activated.stderr, /activationStatus must remain inactive/)
})

test('Goal 7 deployment gate requires engineering evidence and explicit owner acceptance', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-goal7-gate-'))
  const evidenceFile = path.join(outputRoot, 'goal7-acceptance.json')
  const validator = path.join(ROOT, 'scripts/validate-goal7-acceptance.mjs')
  const { spawnSync } = await import('node:child_process')
  const acceptedEvidence = {
    evidenceVersion: '1.0.0',
    goalKey: 'P1-PROD-READINESS',
    status: 'complete',
    engineeringVerified: true,
    ownerAccepted: true,
    acceptedAt: '2026-08-10T09:00:00Z',
    sourceCommit: 'a'.repeat(40),
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
    routeState: {
      routeAOperational: true,
      routeBEnabled: false,
    },
    closedCapabilities: {
      productResearchBulkImport: false,
      realEmployeeCanary: false,
      employeePrivateBotMigration: false,
      erpWriteback: false,
      socialWriteback: false,
    },
  }

  await fs.writeFile(evidenceFile, JSON.stringify(acceptedEvidence))
  const accepted = spawnSync(process.execPath, [validator, evidenceFile], { encoding: 'utf8' })
  assert.equal(accepted.status, 0, accepted.stderr)
  const result = JSON.parse(accepted.stdout)
  assert.equal(result.ownerAccepted, true)
  assert.equal(result.routeBEnabled, false)
  assert.match(result.evidenceHash, /^[a-f0-9]{64}$/)

  await fs.writeFile(evidenceFile, JSON.stringify({ ...acceptedEvidence, ownerAccepted: false }))
  const ownerMissing = spawnSync(process.execPath, [validator, evidenceFile], { encoding: 'utf8' })
  assert.notEqual(ownerMissing.status, 0)
  assert.match(ownerMissing.stderr, /ownerAccepted must be true/)

  await fs.writeFile(evidenceFile, JSON.stringify({
    ...acceptedEvidence,
    routeState: { ...acceptedEvidence.routeState, routeBEnabled: true },
  }))
  const unsafeRoute = spawnSync(process.execPath, [validator, evidenceFile], { encoding: 'utf8' })
  assert.notEqual(unsafeRoute.status, 0)
  assert.match(unsafeRoute.stderr, /routeBEnabled must remain false/)

  const template = path.join(ROOT, 'config/goal7-acceptance.template.json')
  const pendingTemplate = spawnSync(process.execPath, [validator, template], { encoding: 'utf8' })
  assert.notEqual(pendingTemplate.status, 0)
  assert.match(pendingTemplate.stderr, /Goal 7 status must be complete/)
})

test('candidate migrations remain outside production migrations and isolated validation restores baseline', async () => {
  const productionMigrations = await fs.readdir(path.join(PROJECT_ROOT, 'deploy/qnap/migrations'))
  assert.ok(!productionMigrations.some((name) => /^01[01]-pestim/.test(name)))
  for (const name of ['010-pestim-strategic-intelligence.sql', '011-pestim-reporting.sql']) {
    await fs.access(path.join(PROJECT_ROOT, 'deploy/qnap/candidate-migrations', name))
  }
  const validator = await fs.readFile(path.join(ROOT, 'scripts/validate-candidate-migrations-isolated.sh'), 'utf8')
  assert.match(validator, /--network none/)
  assert.match(validator, /project_root_input/)
  assert.match(validator, /cd -- "\$project_root_input"/)
  assert.match(validator, /VALIDATION_POSTGRES_IMAGE/)
  assert.match(validator, /volume create/)
  assert.match(validator, /volume rm -f/)
  assert.match(validator, /baseline\.dump/)
  assert.match(validator, /ontology_restore/)
})

test('seven-day pack generator creates exactly seven pending real-run evidence files', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-seven-day-'))
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/generate-seven-day-pack.mjs'), outputRoot, '2026-08-11'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const files = (await fs.readdir(outputRoot)).sort()
  assert.equal(files.length, 7)
  const first = JSON.parse(await fs.readFile(path.join(outputRoot, files[0]), 'utf8'))
  const last = JSON.parse(await fs.readFile(path.join(outputRoot, files[6]), 'utf8'))
  assert.equal(first.status, 'pending_real_run')
  assert.equal(first.simulated, false)
  assert.equal(last.dayNumber, 7)
})

test('runtime metrics parser records CPU, memory and network without exposing payloads', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-stats-'))
  const statsFile = path.join(outputRoot, 'stats.jsonl')
  await fs.writeFile(statsFile, [
    JSON.stringify({ cpu: '12.50%', mem: '128MiB / 512MiB', net: '1.5MB / 500kB' }),
    JSON.stringify({ cpu: '48.25%', mem: '300MiB / 512MiB', net: '3MB / 1MB' }),
  ].join('\n'))
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/summarize-docker-stats.mjs'), statsFile], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const metrics = JSON.parse(result.stdout)
  assert.equal(metrics.collected, true)
  assert.equal(metrics.peakCpuPermille, 483)
  assert.equal(metrics.peakMemoryBytes, 300 * 1024 * 1024)
  assert.equal(metrics.networkBytes, 4_000_000)
})
