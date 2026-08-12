import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
import { createGoal7AcceptanceBundle, createReviewerRoleAccessBundle } from './fixtures/readiness-fixtures.mjs'

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

test('shadow package validator requires Goal 7 rollback drill schema', async () => {
  const validator = await fs.readFile(path.join(ROOT, 'scripts/validate-shadow-package.mjs'), 'utf8')
  assert.match(validator, /goal7-rollback-drill-evidence[.]schema[.]json/)
})

test('deployment scripts only target strategic intelligence services and keep explicit gates', async () => {
  const names = ['dispatch-next.sh', 'persist-shadow-domain-batch.sh', 'freeze-shadow.sh', 'backup-shadow.sh', 'rollback-shadow.sh', 'prepare-shadow-release.sh', 'apply-shadow-migrations.sh', 'deploy-shadow.sh', 'install-dispatcher-cron.sh']
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
  assert.match(deploy, /inspect-deployment-readiness\.mjs/)
  assert.match(deploy, /validate-goal7-acceptance\.mjs/)
  assert.match(deploy, /validate-release-manifest\.mjs/)
  assert.match(deploy, /SI_APPROVED_P003_REVIEW_FILE/)
  assert.match(deploy, /validate-approved-p003-review\.mjs/)
  assert.match(deploy, /SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE/)
  assert.match(deploy, /validate-reviewer-role-access-acceptance\.mjs/)
  assert.match(deploy, /release_project_root\/deploy\/qnap\/strategic-intelligence\/scripts\/apply-shadow-migrations\.sh/)
  assert.match(deploy, /runtime_uid=\$\(id -u\)/)
  assert.match(deploy, /shadow runtime must use a non-root deployment account/)
  assert.ok(deploy.indexOf('shadow runtime must use a non-root deployment account') < deploy.indexOf('docker_path" load'))
  assert.match(deploy, /SI_COLLECTOR_UID=\$runtime_uid/)
  assert.match(deploy, /SI_ORCHESTRATOR_UID=\$runtime_uid/)
  assert.match(deploy, /NODE_BIN/)
  assert.match(deploy, /node-runtime[.]sh/)
  assert.match(deploy, /SI_NODE_RUNTIME_IMAGE is required/)
  assert.match(deploy, /approval files must be staged inside the strategic intelligence controlled root/)
  assert.match(deploy, /"\$shadow_root"\/approvals\/\*/)
  assert.doesNotMatch(deploy, /"\$shadow_root"\/config\/\*/)
  assert.match(deploy, /SI_NODE_RUNTIME_IMAGE=\$node_runtime_image/)
  assert.match(deploy, /SI_PERSIST_DOMAIN_TO_POSTGRES=YES/)
  assert.match(deploy, /up -d --no-deps intelligence-orchestrator/)
  assert.doesNotMatch(deploy, /up -d[^\n]*(?:agent-core|h-lite|connector|gateway|postgres|redis|qdrant)/)
  const migration = await fs.readFile(path.join(ROOT, 'scripts/apply-shadow-migrations.sh'), 'utf8')
  assert.match(migration, /SI_GOAL7_ACCEPTANCE_FILE/)
  assert.match(migration, /validate-goal7-acceptance\.mjs/)
  assert.match(migration, /SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE/)
  assert.match(migration, /validate-reviewer-role-access-acceptance\.mjs/)
  assert.match(migration, /NODE_BIN/)
})

test('QNAP production runtime scripts never depend on a host Node binary', async () => {
  const names = [
    'deploy-shadow.sh',
    'apply-shadow-migrations.sh',
    'dispatch-next.sh',
    'persist-shadow-domain-batch.sh',
    'run-source-revocation-audit.sh',
    'capture-shadow-side-effects.sh',
  ]
  for (const name of names) {
    const script = await fs.readFile(path.join(ROOT, 'scripts', name), 'utf8')
    assert.match(script, /NODE_BIN/)
    assert.match(script, /node-runtime[.]sh/)
    assert.doesNotMatch(script, /(^|[;&|][ \t]*|\$\()[ \t]*node(?:[ \t]|$)/m)
  }
  const dispatcher = await fs.readFile(path.join(ROOT, 'scripts/dispatch-next.sh'), 'utf8')
  assert.ok(dispatcher.indexOf('. "$env_file"') < dispatcher.indexOf('validate-request.mjs'))
  const envExample = await fs.readFile(path.join(ROOT, 'config/env.shadow.example'), 'utf8')
  assert.match(envExample, /SI_NODE_RUNTIME_IMAGE=sha256:/)
})

test('strategic intelligence attaches to the Foundation fixed data network', async () => {
  const foundationCompose = await fs.readFile(path.resolve(ROOT, '..', 'docker-compose.yml'), 'utf8')
  const shadowCompose = await fs.readFile(path.join(ROOT, 'docker-compose.shadow.yml'), 'utf8')
  const envExample = await fs.readFile(path.join(ROOT, 'config/env.shadow.example'), 'utf8')
  const internalDeploy = await fs.readFile(path.join(ROOT, 'scripts/deploy-internal-engineering-shadow.sh'), 'utf8')
  const productionDeploy = await fs.readFile(path.join(ROOT, 'scripts/deploy-shadow.sh'), 'utf8')

  assert.match(foundationCompose, /data:\n    name: company_ai_data/)
  assert.match(shadowCompose, /FOUNDATION_DATA_NETWORK:-company_ai_data/)
  assert.match(envExample, /^FOUNDATION_DATA_NETWORK=company_ai_data$/m)
  assert.match(internalDeploy, /^FOUNDATION_DATA_NETWORK=company_ai_data$/m)
  assert.match(productionDeploy, /^FOUNDATION_DATA_NETWORK=company_ai_data$/m)
  for (const source of [shadowCompose, envExample, internalDeploy, productionDeploy]) {
    assert.doesNotMatch(source, /company-ai-foundation_data/)
  }
})

test('internal engineering deployment is separately authorized, migration-free, and starts no container', async () => {
  const deploy = await fs.readFile(path.join(ROOT, 'scripts/deploy-internal-engineering-shadow.sh'), 'utf8')
  const run = await fs.readFile(path.join(ROOT, 'scripts/run-internal-engineering-once.sh'), 'utf8')
  const rollback = await fs.readFile(path.join(ROOT, 'scripts/rollback-internal-engineering-shadow.sh'), 'utf8')
  assert.ok(deploy.indexOf('INTERNAL_ENGINEERING_SHADOW_DEPLOY_APPROVED') < deploy.indexOf('preflight-company-qnap.sh'))
  assert.doesNotMatch(deploy, /apply-shadow-migrations|compose .* up|compose .* restart|docker .* restart/)
  assert.match(deploy, /container_started=0/)
  assert.match(deploy, /database_migration_count=0/)
  assert.match(deploy, /cp -R "\$release_project_root" "\$internal_root\/package\.next"/)
  assert.match(deploy, /package_root=\$internal_root\/package\.next\/deploy\/qnap\/strategic-intelligence/)
  assert.match(deploy, /internal engineering runtime must use a non-root deployment account/)
  assert.ok(deploy.indexOf('internal engineering runtime must use a non-root deployment account') < deploy.indexOf('docker_path" load'))
  assert.match(deploy, /SI_COLLECTOR_UID=\$runtime_uid/)
  assert.match(deploy, /NODE_BIN/)
  assert.match(deploy, /node-runtime[.]sh/)
  assert.match(deploy, /previous-runtime[.]tar[.]gz[.]sha256/)
  assert.match(deploy, /backup missing package/)
  assert.match(deploy, /backup missing config/)
  assert.match(deploy, /backup missing env/)
  assert.ok(run.indexOf('INTERNAL_ENGINEERING_RUN_APPROVED') < run.indexOf('preflight-company-qnap.sh'))
  assert.match(run, /project_root=\$internal_root\/package/)
  assert.match(run, /project package missing contracts/)
  assert.match(run, /--profile worker run/)
  assert.match(run, /counts_toward_production_shadow=0/)
  assert.match(run, /NODE_BIN/)
  assert.ok(rollback.indexOf('INTERNAL_ENGINEERING_ROLLBACK_APPROVED') < rollback.indexOf('preflight-company-qnap.sh'))
  assert.ok(rollback.indexOf('backup archive missing') < rollback.indexOf('retired='))
  assert.match(rollback, /backup checksum mismatch/)
  assert.match(rollback, /rollback restore incomplete/)
  assert.doesNotMatch(rollback, /compose .* stop|compose .* down|apply-shadow-migrations|psql|migrate\.sh/)
})

test('QNAP Node runtime uses native Node locally and fails closed without an immutable fallback image', () => {
  const runtime = path.join(ROOT, 'scripts/node-runtime.sh')
  const native = spawnSync('sh', [runtime, '-e', "process.stdout.write('native-node-ok')"], { encoding: 'utf8' })
  assert.equal(native.status, 0, native.stderr)
  assert.equal(native.stdout, 'native-node-ok')

  const fallback = spawnSync('sh', [runtime, '--version'], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      DOCKER_PATH: '/usr/bin/true',
      SI_NODE_RUNTIME_MOUNT_ROOT: '/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence',
    },
  })
  assert.equal(fallback.status, 2)
  assert.match(fallback.stderr, /QNAP Node runtime mount root missing|immutable QNAP Node runtime image required/)
})

test('internal engineering deployment, run, and rollback refuse before QNAP preflight without explicit approval', async () => {
  for (const script of [
    'deploy-internal-engineering-shadow.sh',
    'run-internal-engineering-once.sh',
    'rollback-internal-engineering-shadow.sh',
  ]) {
    const result = spawnSync('sh', [path.join(ROOT, 'scripts', script)], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /explicit internal engineering/)
    assert.doesNotMatch(result.stderr, /QNAP|Container Station|company ontology root/)
  }
})

test('rollback refuses execution before QNAP preflight when explicit approval is absent', () => {
  const result = spawnSync('sh', [path.join(ROOT, 'scripts/rollback-shadow.sh')], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SHADOW_ROLLBACK_APPROVED: 'NO',
    },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /explicit shadow rollback approval missing/)
  assert.doesNotMatch(result.stderr, /QNAP|backup|docker|manifest/i)
})

test('release manifest validator binds immutable archives and keeps deployment disabled', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-release-manifest-'))
  const sourceArchive = path.join(outputRoot, 'source.tar.gz')
  const hLiteSourceArchive = path.join(outputRoot, 'h-lite-source.tar.gz')
  const imageArchive = path.join(outputRoot, 'collector-image.tar.gz')
  const componentVersionsFile = path.join(outputRoot, 'runtime-component-versions.json')
  const manifestFile = path.join(outputRoot, 'release-manifest.json')
  const sourceBytes = Buffer.from('immutable source archive')
  const hLiteSourceBytes = Buffer.from('immutable h-lite source archive')
  const imageBytes = Buffer.from('immutable collector image archive')
  const componentVersionsBytes = Buffer.from(`${JSON.stringify({
    evidenceVersion: '1.0.0',
    evidenceType: 'goal7-runtime-component-versions',
    sourceCommit: 'a'.repeat(40),
    hLiteSourceCommit: 'f'.repeat(40),
    agentCoreVersion: '2026-08-12.3',
    knowledgeConnectorVersion: '2026-08-11.1',
    hLiteVersion: '2026-08-12.1',
  })}\n`)
  await fs.writeFile(sourceArchive, sourceBytes)
  await fs.writeFile(hLiteSourceArchive, hLiteSourceBytes)
  await fs.writeFile(imageArchive, imageBytes)
  await fs.writeFile(componentVersionsFile, componentVersionsBytes)
  const manifest = {
    manifestVersion: '1.6.0',
    releaseType: 'P1-SI-F-shadow-candidate-gated',
    createdAt: '2026-08-10T09:00:00Z',
    sourceCommit: 'a'.repeat(40),
    hLiteSourceCommit: 'f'.repeat(40),
    collectorImageId: `sha256:${'b'.repeat(64)}`,
    sourceArchiveSha256: sha256(sourceBytes),
    hLiteSourceArchiveSha256: sha256(hLiteSourceBytes),
    collectorImageArchiveSha256: sha256(imageBytes),
    runtimeComponentVersionsSha256: sha256(componentVersionsBytes),
    agentCoreVersion: '2026-08-12.3',
    knowledgeConnectorVersion: '2026-08-11.1',
    hLiteVersion: '2026-08-12.1',
    candidateOntologySchema: '3.7.0',
    candidateOntologyHash: 'c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860',
    sourceRegistryCandidateHash: '0ce4022adcfc177ced670a8d7fd2e4b4e119c2fc1bc5c19cabefb3223c010eae',
    publish: false,
    productionDeploymentAuthorized: false,
    requiredGate: 'WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH',
    p003ReviewGateRequired: true,
    reviewerRoleAccessGateRequired: true,
    goal7AcceptanceGateRequired: true,
    goal7Migration012Mode: 'pre_existing_reconciliation_only',
    goal7Migration012SqlReplayAllowed: false,
  }
  await fs.writeFile(manifestFile, JSON.stringify(manifest))
  const { spawnSync } = await import('node:child_process')
  const validator = path.join(ROOT, 'scripts/validate-release-manifest.mjs')
  const accepted = spawnSync(process.execPath, [validator, manifestFile, sourceArchive, hLiteSourceArchive, imageArchive, componentVersionsFile], { encoding: 'utf8' })
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal(JSON.parse(accepted.stdout).productionDeploymentAuthorized, false)

  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, publish: true }))
  const unsafe = spawnSync(process.execPath, [validator, manifestFile, sourceArchive, hLiteSourceArchive, imageArchive, componentVersionsFile], { encoding: 'utf8' })
  assert.notEqual(unsafe.status, 0)
  assert.match(unsafe.stderr, /publish must remain false/)

  await fs.writeFile(manifestFile, JSON.stringify(manifest))
  await fs.writeFile(sourceArchive, 'tampered source archive')
  const tampered = spawnSync(process.execPath, [validator, manifestFile, sourceArchive, hLiteSourceArchive, imageArchive, componentVersionsFile], { encoding: 'utf8' })
  assert.notEqual(tampered.status, 0)
  assert.match(tampered.stderr, /source archive hash mismatch/)

  await fs.writeFile(sourceArchive, sourceBytes)
  await fs.writeFile(manifestFile, JSON.stringify({
    ...manifest,
    manifestVersion: '1.3.0',
  }))
  const legacy = spawnSync(process.execPath, [validator, manifestFile, sourceArchive, hLiteSourceArchive, imageArchive, componentVersionsFile], { encoding: 'utf8' })
  assert.notEqual(legacy.status, 0)
  assert.match(legacy.stderr, /manifestVersion mismatch/)
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

test('reviewer role access gate requires four real member sessions and explicit security owner acceptance', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-role-access-gate-'))
  const validator = path.join(ROOT, 'scripts/validate-reviewer-role-access-acceptance.mjs')
  const { spawnSync } = await import('node:child_process')
  const { acceptanceFile } = await createReviewerRoleAccessBundle(outputRoot)

  const accepted = spawnSync(process.execPath, [validator, acceptanceFile], { encoding: 'utf8' })
  assert.equal(accepted.status, 0, accepted.stderr)
  const result = JSON.parse(accepted.stdout)
  assert.equal(result.scopedRoleCount, 4)
  assert.equal(result.memberExperienceVerified, true)
  assert.equal(result.legacyBroadRoleMemberCount, 0)
  assert.equal(result.rawEvidenceFileCount, 5)
  assert.doesNotMatch(accepted.stdout, /company-directory:/)
  assert.doesNotMatch(accepted.stdout, /displayName/)

  const productSessionFile = path.join(outputRoot, 'reviewer-role-session-product-user.json')
  const productSession = JSON.parse(await fs.readFile(productSessionFile, 'utf8'))
  productSession.results.unassignedCategoryEditDenied = false
  await fs.writeFile(productSessionFile, JSON.stringify(productSession))
  const unsafeEdit = spawnSync(process.execPath, [validator, acceptanceFile], { encoding: 'utf8' })
  assert.notEqual(unsafeEdit.status, 0)
  assert.match(unsafeEdit.stderr, /unassignedCategoryEditDenied must be true/)

  const template = path.join(ROOT, 'config/reviewer-role-access-acceptance.template.json')
  const pendingTemplate = spawnSync(process.execPath, [validator, template], { encoding: 'utf8' })
  assert.notEqual(pendingTemplate.status, 0)
  assert.match(pendingTemplate.stderr, /raw evidence missing|compiler-derived/)
})

test('Goal 7 deployment gate requires engineering evidence and explicit owner acceptance', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-goal7-gate-'))
  const { bundleRoot, goal7File: evidenceFile } = await createGoal7AcceptanceBundle(outputRoot)
  const validator = path.join(ROOT, 'scripts/validate-goal7-acceptance.mjs')
  const { spawnSync } = await import('node:child_process')
  const accepted = spawnSync(process.execPath, [validator, evidenceFile], { encoding: 'utf8' })
  assert.equal(accepted.status, 0, accepted.stderr)
  const result = JSON.parse(accepted.stdout)
  assert.equal(result.ownerAccepted, true)
  assert.equal(result.routeBEnabled, false)
  assert.equal(result.evidenceFileCount, 6)
  assert.match(result.evidenceHash, /^[a-f0-9]{64}$/)

  const acceptedEvidence = JSON.parse(await fs.readFile(evidenceFile, 'utf8'))
  await fs.writeFile(evidenceFile, JSON.stringify({ ...acceptedEvidence, ownerAccepted: false }))
  const ownerMissing = spawnSync(process.execPath, [validator, evidenceFile], { encoding: 'utf8' })
  assert.notEqual(ownerMissing.status, 0)
  assert.match(ownerMissing.stderr, /ownerAccepted must be true/)

  await fs.writeFile(evidenceFile, JSON.stringify(acceptedEvidence))
  const deploymentFile = path.join(bundleRoot, 'deployment-evidence.json')
  const deploymentEvidence = JSON.parse(await fs.readFile(deploymentFile, 'utf8'))
  await fs.writeFile(deploymentFile, JSON.stringify({ ...deploymentEvidence, routeBEnabled: true }))
  const unsafeRoute = spawnSync(process.execPath, [validator, evidenceFile], { encoding: 'utf8' })
  assert.notEqual(unsafeRoute.status, 0)
  assert.match(unsafeRoute.stderr, /Route B must remain disabled/)

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
  assert.match(validator, /NODE_BIN/)
  assert.match(validator, /volume create/)
  assert.match(validator, /volume rm -f/)
  assert.match(validator, /PostgreSQL init process complete; ready for start up[.]/)
  assert.match(validator, /to_regclass\('workflow[.]tasks'\)/)
  assert.doesNotMatch(validator, /-Atc 'SELECT 1'/)
  assert.match(validator, /baseline\.dump/)
  assert.match(validator, /ontology_restore/)
  assert.match(validator, /write-shadow-domain-runtime-fixture[.]mjs/)
  assert.match(validator, /compile-shadow-domain-sql[.]mjs/)
  assert.match(validator, /domain_persistence_idempotent=verified/)
  assert.match(validator, /acl_fail_closed=verified/)
})

test('isolated migration validation rejects a missing Node runtime before creating Docker state', () => {
  const validator = path.join(ROOT, 'scripts/validate-candidate-migrations-isolated.sh')
  const result = spawnSync('sh', [validator], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROJECT_ROOT,
      DOCKER_PATH: '/usr/bin/true',
      NODE_BIN: path.join(os.tmpdir(), 'p1-si-node-runtime-does-not-exist'),
      VALIDATION_RUN_ID: 'node-runtime-negative-test',
    },
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /node runtime unavailable/)
})

test('runtime workflow stays aligned with the gated release and domain persistence proof', async () => {
  const workflow = await fs.readFile(path.resolve(PROJECT_ROOT, '../../.github/workflows/p1-si-runtime-verify.yml'), 'utf8')
  assert.match(workflow, /manifestVersion: '1[.]6[.]0'/)
  assert.match(workflow, /runtime-component-versions\.json/)
  assert.match(workflow, /releaseType: 'P1-SI-F-shadow-candidate-gated'/)
  assert.match(workflow, /goal7Migration012Mode: 'pre_existing_reconciliation_only'/)
  assert.match(workflow, /goal7Migration012SqlReplayAllowed: false/)
  assert.match(workflow, /grep -qx 'domain_persistence=verified'/)
  assert.match(workflow, /grep -qx 'domain_persistence_idempotent=verified'/)
  assert.match(workflow, /grep -qx 'acl_fail_closed=verified'/)
  assert.match(workflow, /reviewerRoleAccessGateRequired: true/)
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

test('runtime audit compiler derives real coverage without trusting manual flags', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-run-audit-'))
  const stateRoot = path.join(root, 'state')
  const reportRoot = path.join(root, 'reports')
  const runId = '2026-08-11T01-00-00-000Z-audit-run'
  const runDir = path.join(stateRoot, 'runs', runId)
  await fs.mkdir(path.join(runDir, 'raw'), { recursive: true })
  await fs.mkdir(reportRoot, { recursive: true })
  const summary = { runId, status: 'succeeded' }
  await fs.writeFile(path.join(root, 'stdout.json'), JSON.stringify({ ok: true, ...summary }))
  await fs.writeFile(path.join(root, 'stderr.log'), '')
  await fs.writeFile(path.join(root, 'domain-stderr.log'), '')
  await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(summary))
  await fs.writeFile(path.join(runDir, 'items.json'), JSON.stringify([{ title: 'Public item', summary: 'No secret', contentHash: 'a'.repeat(64) }]))
  await fs.writeFile(path.join(runDir, 'source-decisions.json'), JSON.stringify([{ allowed: true }]))
  await fs.writeFile(path.join(runDir, 'raw', 'source.snapshot.json'), JSON.stringify({ bodyBase64: null, contentHash: 'b'.repeat(64) }))
  await fs.writeFile(path.join(reportRoot, `candidate-${runId}.json`), JSON.stringify({ ...summary, items: [] }))
  await fs.writeFile(path.join(stateRoot, 'last-good.json'), JSON.stringify({ ...summary, items: [] }))
  await fs.writeFile(path.join(root, 'pre-last-good.json'), JSON.stringify({ snapshotVersion: '1.0.0', present: false, sha256: null, runId: null }))
  await fs.writeFile(path.join(root, 'revocation.json'), JSON.stringify({ auditVersion: '1.0.0', completed: true, reasonCode: 'SOURCE_POLICY_DENIED', networkMode: 'none', effectiveSeconds: 1, postRevocationNetworkRequestCount: 0 }))
  await fs.writeFile(path.join(root, 'side-effects.json'), JSON.stringify({ auditVersion: '1.0.0', completed: true, formalP2Count: 0, employeeDeliveryCount: 0, erpWritebackCount: 0, socialWritebackCount: 0, causalActivationCount: 0 }))
  await fs.writeFile(path.join(root, 'domain-batch.json'), JSON.stringify({ batchVersion: '1.0.0', publish: false, persistenceState: 'json_candidate_pending_postgres' }))
  const output = path.join(root, 'audit.json')
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/compile-shadow-run-audit.mjs'),
    '--collector-stdout', path.join(root, 'stdout.json'),
    '--collector-stderr', path.join(root, 'stderr.log'),
    '--state-root', stateRoot,
    '--report-root', reportRoot,
    '--pre-last-good', path.join(root, 'pre-last-good.json'),
    '--revocation-evidence', path.join(root, 'revocation.json'),
    '--side-effect-evidence', path.join(root, 'side-effects.json'),
    '--domain-batch', path.join(root, 'domain-batch.json'),
    '--domain-stderr', path.join(root, 'domain-stderr.log'),
    '--output', output,
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const audit = JSON.parse(await fs.readFile(output, 'utf8'))
  assert.equal(audit.auditCompleted, true)
  assert.equal(audit.unredactedSensitiveOutputCount, 0)
  assert.equal(audit.sensitiveOutputAuditCompleted, true)
  assert.equal(audit.sourceRevocationAuditCompleted, true)
  assert.equal(audit.businessSideEffectAuditCompleted, true)
  assert.equal(audit.lastGoodPreserved, true)
  assert.deepEqual(audit.sideEffects, { formalP2Count: 0, employeeDeliveryCount: 0, erpWritebackCount: 0, socialWritebackCount: 0, causalActivationCount: 0 })
})

test('runtime audit exposes sensitive output and business side effects instead of hiding them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-run-audit-negative-'))
  const stateRoot = path.join(root, 'state')
  const reportRoot = path.join(root, 'reports')
  const runId = '2026-08-11T02-00-00-000Z-audit-run'
  const runDir = path.join(stateRoot, 'runs', runId)
  await fs.mkdir(path.join(runDir, 'raw'), { recursive: true })
  await fs.mkdir(reportRoot, { recursive: true })
  await fs.writeFile(path.join(root, 'stdout.json'), JSON.stringify({ ok: true, runId }))
  await fs.writeFile(path.join(root, 'stderr.log'), '')
  await fs.writeFile(path.join(root, 'domain-stderr.log'), '')
  await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify({ runId, status: 'succeeded' }))
  await fs.writeFile(path.join(runDir, 'items.json'), JSON.stringify([{ title: 'unsafe', access_token: 'not-redacted-token-value' }]))
  await fs.writeFile(path.join(runDir, 'source-decisions.json'), '[]')
  await fs.writeFile(path.join(runDir, 'raw', 'source.snapshot.json'), JSON.stringify({ bodyBase64: null }))
  await fs.writeFile(path.join(reportRoot, `candidate-${runId}.json`), JSON.stringify({ runId, items: [] }))
  await fs.writeFile(path.join(stateRoot, 'last-good.json'), JSON.stringify({ runId, items: [] }))
  await fs.writeFile(path.join(root, 'pre-last-good.json'), JSON.stringify({ snapshotVersion: '1.0.0', present: false, sha256: null, runId: null }))
  await fs.writeFile(path.join(root, 'revocation.json'), JSON.stringify({ auditVersion: '1.0.0', completed: true, reasonCode: 'SOURCE_POLICY_DENIED', networkMode: 'none', effectiveSeconds: 1, postRevocationNetworkRequestCount: 0 }))
  await fs.writeFile(path.join(root, 'side-effects.json'), JSON.stringify({ auditVersion: '1.0.0', completed: true, formalP2Count: 1, employeeDeliveryCount: 0, erpWritebackCount: 0, socialWritebackCount: 0, causalActivationCount: 0 }))
  await fs.writeFile(path.join(root, 'domain-batch.json'), JSON.stringify({ batchVersion: '1.0.0', publish: false, persistenceState: 'json_candidate_pending_postgres' }))
  const output = path.join(root, 'audit.json')
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/compile-shadow-run-audit.mjs'),
    '--collector-stdout', path.join(root, 'stdout.json'), '--collector-stderr', path.join(root, 'stderr.log'),
    '--state-root', stateRoot, '--report-root', reportRoot,
    '--pre-last-good', path.join(root, 'pre-last-good.json'),
    '--revocation-evidence', path.join(root, 'revocation.json'),
    '--side-effect-evidence', path.join(root, 'side-effects.json'),
    '--domain-batch', path.join(root, 'domain-batch.json'),
    '--domain-stderr', path.join(root, 'domain-stderr.log'), '--output', output,
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const audit = JSON.parse(await fs.readFile(output, 'utf8'))
  assert.equal(audit.unredactedSensitiveOutputCount, 1)
  assert.equal(audit.sideEffects.formalP2Count, 1)
})

test('dispatcher performs fail-closed revocation, sensitive-output and side-effect audits', async () => {
  const dispatcher = await fs.readFile(path.join(ROOT, 'scripts/dispatch-next.sh'), 'utf8')
  const revocationAudit = await fs.readFile(path.join(ROOT, 'scripts/run-source-revocation-audit.sh'), 'utf8')
  assert.match(dispatcher, /snapshot-last-good[.]mjs/)
  assert.match(dispatcher, /run-source-revocation-audit[.]sh/)
  assert.match(dispatcher, /capture-shadow-side-effects[.]sh/)
  assert.match(dispatcher, /compile-shadow-run-audit[.]mjs/)
  assert.match(dispatcher, /persist-shadow-domain-batch[.]sh/)
  assert.match(dispatcher, /domain_exit/)
  assert.match(dispatcher, /domain-stderr/)
  assert.match(dispatcher, /--audit-metrics-file/)
  assert.match(revocationAudit, /--network none/)
  assert.match(revocationAudit, /SOURCE_POLICY_DENIED/)
})

test('Postgres persistence refuses execution unless deployment explicitly enables it', async () => {
  const script = path.join(ROOT, 'scripts/persist-shadow-domain-batch.sh')
  const result = spawnSync('sh', [script, '/nonexistent/domain.json', '/nonexistent/metrics.json'], {
    encoding: 'utf8',
    env: { ...process.env, SI_PERSIST_DOMAIN_TO_POSTGRES: 'NO' },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Postgres domain persistence is not enabled/)
  assert.doesNotMatch(result.stderr, /192[.]168[.]61[.]18/)
})

test('daily evidence is populated from compiled runtime audits rather than manual coverage flags', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-record-audit-'))
  const requestFile = path.join(root, 'request.json')
  const collectorMetricsFile = path.join(root, 'collector.json')
  const runtimeMetricsFile = path.join(root, 'runtime.json')
  const auditMetricsFile = path.join(root, 'audit.json')
  const domainMetricsFile = path.join(root, 'domain.json')
  const outputFile = path.join(root, 'evidence.json')
  await fs.writeFile(requestFile, JSON.stringify({
    requestKey: 'daily-collection-shadow-2026-08-11',
    localDate: '2026-08-11',
    timezone: 'Asia/Shanghai',
    requestedAt: '2026-08-10T22:30:00Z',
    policyVersion: '1.0.0-candidate.1',
    policyHash: 'a'.repeat(64),
  }))
  await fs.writeFile(collectorMetricsFile, JSON.stringify({ collected: true, sourceAttemptCount: 3, sourceSuccessCount: 3, rawSnapshotCount: 3, normalizedItemCount: 30, duplicateCount: 2, freshnessP95Seconds: 300, rawSnapshotBytes: 2048 }))
  await fs.writeFile(runtimeMetricsFile, JSON.stringify({ collected: true, networkBytes: 4096, peakCpuPermille: 200, peakMemoryBytes: 64 * 1024 * 1024 }))
  await fs.writeFile(auditMetricsFile, JSON.stringify({
    unredactedSensitiveOutputCount: 0,
    sourceRevocationEffectiveSeconds: 1,
    postRevocationNetworkRequestCount: 0,
    lastGoodPreserved: true,
    sensitiveOutputAuditCompleted: true,
    sourceRevocationAuditCompleted: true,
    businessSideEffectAuditCompleted: true,
    sideEffects: { formalP2Count: 0, employeeDeliveryCount: 0, erpWritebackCount: 0, socialWritebackCount: 0, causalActivationCount: 0 },
  }))
  await fs.writeFile(domainMetricsFile, JSON.stringify({
    compiled: true,
    persisted: true,
    persistenceState: 'postgres_committed',
    rawSnapshotCount: 3,
    observationCount: 30,
    signalCount: 30,
    evidenceCount: 30,
    impactAssessmentCount: 6,
    reportRunCount: 3,
    reportDraftCount: 3,
  }))
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/record-shadow-run.mjs'),
    '--request', requestFile, '--output', outputFile, '--status', 'succeeded',
    '--started-at', '2026-08-10T22:30:00Z', '--completed-at', '2026-08-10T22:31:00Z',
    '--duration-seconds', '60', '--exit-code', '0',
    '--collector-image', `sha256:${'b'.repeat(64)}`, '--source-commit', 'c'.repeat(40),
    '--collector-metrics-file', collectorMetricsFile, '--runtime-metrics-file', runtimeMetricsFile,
    '--audit-metrics-file', auditMetricsFile, '--domain-metrics-file', domainMetricsFile,
    '--container-restart-count', '0', '--new-host-port-count', '0',
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(await fs.readFile(outputFile, 'utf8'))
  assert.equal(evidence.coverage.sensitiveOutputAuditCompleted, true)
  assert.equal(evidence.coverage.sourceRevocationAuditCompleted, true)
  assert.equal(evidence.coverage.businessSideEffectAuditCompleted, true)
  assert.equal(evidence.coverage.domainCompilationCompleted, true)
  assert.equal(evidence.coverage.domainPersistenceCompleted, true)
  assert.deepEqual(evidence.domainArtifacts, {
    persistenceState: 'postgres_committed',
    rawSnapshotCount: 3,
    observationCount: 30,
    signalCount: 30,
    evidenceCount: 30,
    impactAssessmentCount: 6,
    reportRunCount: 3,
    reportDraftCount: 3,
  })
  assert.equal(evidence.security.lastGoodPreserved, true)
  assert.deepEqual(evidence.sideEffects, { formalP2Count: 0, employeeDeliveryCount: 0, erpWritebackCount: 0, socialWritebackCount: 0, causalActivationCount: 0 })
})
