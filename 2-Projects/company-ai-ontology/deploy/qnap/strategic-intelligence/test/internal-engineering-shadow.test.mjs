import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ROOT = path.resolve(ROOT, '../../..')
const PLAN_FILE = path.join(ROOT, 'config/internal-engineering-shadow-plan.json')
const VALIDATOR = path.join(ROOT, 'scripts/validate-internal-engineering-shadow-plan.mjs')
const INTERNAL_READINESS = path.join(ROOT, 'scripts/inspect-internal-engineering-readiness.mjs')
const PRODUCTION_READINESS = path.join(ROOT, 'scripts/inspect-deployment-readiness.mjs')
const COMPILE_RUNTIME = path.join(ROOT, 'scripts/compile-internal-engineering-runtime.mjs')
const VALIDATE_RUNTIME = path.join(ROOT, 'scripts/validate-internal-engineering-runtime.mjs')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function copyProjectWithoutDependencies(source, target) {
  await fs.cp(source, target, {
    recursive: true,
    filter(candidate) {
      const relative = path.relative(source, candidate)
      return !relative.split(path.sep).includes('node_modules')
    },
  })
}

async function mutatePlan(mutator) {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-internal-plan-'))
  const plan = JSON.parse(await fs.readFile(PLAN_FILE, 'utf8'))
  mutator(plan)
  const file = path.join(outputRoot, 'plan.json')
  await fs.writeFile(file, JSON.stringify(plan))
  return file
}

test('internal engineering plan is bounded, non-publishing, and non-production', () => {
  const result = spawnSync(process.execPath, [VALIDATOR, PLAN_FILE], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.mode, 'internal_engineering_shadow')
  assert.equal(output.selectedSourceCount, 3)
  assert.equal(output.p003SampleCount, 6)
  assert.equal(output.countsTowardProductionShadow, false)
  assert.equal(output.businessSideEffectsEnabled, 0)
  assert.equal(output.deploymentAuthorized, false)
})

test('internal engineering plan rejects source expansion and unsafe retention', async () => {
  const expanded = await mutatePlan((plan) => {
    plan.selectedSources.push({ ...plan.selectedSources[0], sourceKey: 'arxiv-official-rss-api' })
  })
  const expandedResult = spawnSync(process.execPath, [VALIDATOR, expanded], { encoding: 'utf8' })
  assert.notEqual(expandedResult.status, 0)
  assert.match(expandedResult.stderr, /between 2 and 3 sources/)

  const unsafeRetention = await mutatePlan((plan) => {
    plan.selectedSources[0].storageLevel = 'full_text'
  })
  const unsafeRetentionResult = spawnSync(process.execPath, [VALIDATOR, unsafeRetention], { encoding: 'utf8' })
  assert.notEqual(unsafeRetentionResult.status, 0)
  assert.match(unsafeRetentionResult.stderr, /storageLevel is not allowed/)

  const unapprovedEndpoint = await mutatePlan((plan) => {
    plan.selectedSources[2].endpointRef = 'https://api.github.com/repos/unapproved/example/releases?per_page=20'
  })
  const unapprovedEndpointResult = spawnSync(process.execPath, [VALIDATOR, unapprovedEndpoint], { encoding: 'utf8' })
  assert.notEqual(unapprovedEndpointResult.status, 0)
  assert.match(unapprovedEndpointResult.stderr, /endpointRef is not an approved bounded endpoint/)
})

test('internal engineering plan rejects P003 activation and missing category samples', async () => {
  const activated = await mutatePlan((plan) => {
    plan.p003Samples[0].activationStatus = 'active'
  })
  const activatedResult = spawnSync(process.execPath, [VALIDATOR, activated], { encoding: 'utf8' })
  assert.notEqual(activatedResult.status, 0)
  assert.match(activatedResult.stderr, /activationStatus must remain inactive/)

  const missingCategory = await mutatePlan((plan) => {
    plan.p003Samples.pop()
  })
  const missingCategoryResult = spawnSync(process.execPath, [VALIDATOR, missingCategory], { encoding: 'utf8' })
  assert.notEqual(missingCategoryResult.status, 0)
  assert.match(missingCategoryResult.stderr, /must contain exactly 6 samples/)
  assert.match(missingCategoryResult.stderr, /missing category privacy_safety_compliance/)
})

test('internal engineering plan rejects business side effects and production-shadow credit', async () => {
  const sideEffect = await mutatePlan((plan) => {
    plan.forbiddenSideEffects.employeeDelivery = true
  })
  const sideEffectResult = spawnSync(process.execPath, [VALIDATOR, sideEffect], { encoding: 'utf8' })
  assert.notEqual(sideEffectResult.status, 0)
  assert.match(sideEffectResult.stderr, /employeeDelivery must remain false/)

  const productionCredit = await mutatePlan((plan) => {
    plan.countsTowardProductionShadow = true
  })
  const productionCreditResult = spawnSync(process.execPath, [VALIDATOR, productionCredit], { encoding: 'utf8' })
  assert.notEqual(productionCreditResult.status, 0)
  assert.match(productionCreditResult.stderr, /countsTowardProductionShadow must equal false/)
})

test('internal readiness remains blocked without separate deploy authorization and release', () => {
  const result = spawnSync(process.execPath, [INTERNAL_READINESS], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INTERNAL_ENGINEERING_SHADOW_DEPLOY_APPROVED: 'NO',
      COMPANY_QNAP_PREFLIGHT_VERIFIED: 'NO',
    },
  })
  assert.equal(result.status, 2)
  const output = JSON.parse(result.stdout)
  assert.equal(output.productionDeploymentEligible, false)
  assert.equal(output.internalDeploymentEligible, false)
  assert.equal(output.gates.find((gate) => gate.key === 'internal_engineering_plan').status, 'pass')
  assert.equal(output.gates.find((gate) => gate.key === 'internal_deployment_authorization').status, 'blocked')
})

test('internal mode evidence cannot satisfy production readiness', () => {
  const result = spawnSync(process.execPath, [PRODUCTION_READINESS], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INTERNAL_ENGINEERING_SHADOW_DEPLOY_APPROVED: 'YES',
      COMPANY_QNAP_PREFLIGHT_VERIFIED: 'YES',
      SI_INTERNAL_ENGINEERING_PLAN_FILE: PLAN_FILE,
    },
  })
  assert.equal(result.status, 2)
  const output = JSON.parse(result.stdout)
  assert.equal(output.deploymentEligible, false)
  assert.equal(output.gates.find((gate) => gate.key === 'goal7_status').status, 'blocked')
  assert.equal(output.gates.find((gate) => gate.key === 'approved_source_registry').status, 'blocked')
  assert.equal(output.gates.find((gate) => gate.key === 'approved_p003_review').status, 'blocked')
  assert.equal(output.gates.find((gate) => gate.key === 'reviewer_role_access_acceptance').status, 'blocked')
})

test('internal runtime compiler keeps candidate approvals paused and produces a reproducible bounded config', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-internal-runtime-'))
  const runtimeRoot = path.join(outputRoot, 'runtime')
  const compiled = spawnSync(process.execPath, [COMPILE_RUNTIME, PLAN_FILE, runtimeRoot], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  const compiledOutput = JSON.parse(compiled.stdout)
  assert.equal(compiledOutput.selectedSourceCount, 3)
  assert.equal(compiledOutput.p003SampleCount, 6)
  assert.equal(compiledOutput.countsTowardProductionShadow, false)
  assert.equal(compiledOutput.deploymentAuthorized, false)

  const validated = spawnSync(process.execPath, [VALIDATE_RUNTIME, runtimeRoot], { encoding: 'utf8' })
  assert.equal(validated.status, 0, validated.stderr)
  const validationOutput = JSON.parse(validated.stdout)
  assert.equal(validationOutput.registrySourcesRemainingPaused, 8)
  assert.equal(validationOutput.productionApprovalSatisfied, false)

  const registry = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'source-registry.json'), 'utf8'))
  assert.ok(registry.entries.every((entry) => entry.lifecycleStatus === 'paused'))
  assert.ok(registry.entries.every((entry) => entry.license.status === 'pending'))
  assert.ok(registry.entries.every((entry) => entry.governance.approvalStatus === 'pending'))
  const config = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'collector.json'), 'utf8'))
  assert.equal(config.operationMode, 'internal_engineering_shadow')
  assert.equal(config.sourceKeys.length, 3)
})

test('internal runtime validator rejects source expansion after compilation', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-internal-runtime-tamper-'))
  const runtimeRoot = path.join(outputRoot, 'runtime')
  const compiled = spawnSync(process.execPath, [COMPILE_RUNTIME, PLAN_FILE, runtimeRoot], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  const configFile = path.join(runtimeRoot, 'collector.json')
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'))
  config.sourceKeys.push('world-bank-indicators-api')
  await fs.writeFile(configFile, JSON.stringify(config))
  const validation = spawnSync(process.execPath, [VALIDATE_RUNTIME, runtimeRoot], { encoding: 'utf8' })
  assert.notEqual(validation.status, 0)
  assert.match(validation.stderr, /collector sourceKeys must match/)
})

test('internal deployed package layout preserves runtime validator dependencies', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-internal-package-layout-'))
  const runtimeRoot = path.join(outputRoot, 'runtime')
  const packageRoot = path.join(outputRoot, 'package')
  const compiled = spawnSync(process.execPath, [COMPILE_RUNTIME, PLAN_FILE, runtimeRoot], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  await fs.cp(PROJECT_ROOT, packageRoot, { recursive: true })
  const deployedValidator = path.join(packageRoot, 'deploy/qnap/strategic-intelligence/scripts/validate-internal-engineering-runtime.mjs')
  const validation = spawnSync(process.execPath, [deployedValidator, runtimeRoot], { encoding: 'utf8' })
  assert.equal(validation.status, 0, validation.stderr)
  assert.equal(JSON.parse(validation.stdout).productionApprovalSatisfied, false)
})

test('internal deployment prepares a complete runtime without starting containers or migrating data', async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-internal-deploy-'))
  t.after(() => fs.rm(outputRoot, { recursive: true, force: true }))

  const controlProjectRoot = path.join(outputRoot, 'control', 'company-ai-ontology')
  const releaseSourceRoot = path.join(outputRoot, 'release-source', 'company-ai-ontology')
  const releaseBase = path.join(outputRoot, 'qnap', 'strategic-intelligence', 'release')
  const releaseRoot = path.join(releaseBase, 'candidate')
  const runtimeBase = path.join(outputRoot, 'qnap', 'strategic-intelligence', 'internal-runtime')
  const runtimeRoot = path.join(runtimeBase, 'session')
  const shadowRoot = path.join(outputRoot, 'qnap', 'strategic-intelligence')
  const backupBase = path.join(outputRoot, 'qnap-backup', 'strategic-intelligence', 'internal-engineering')
  const fakeDocker = path.join(outputRoot, 'fake-docker.sh')
  const dockerLog = path.join(outputRoot, 'docker.log')

  await Promise.all([
    copyProjectWithoutDependencies(PROJECT_ROOT, controlProjectRoot),
    copyProjectWithoutDependencies(PROJECT_ROOT, releaseSourceRoot),
    fs.mkdir(releaseRoot, { recursive: true }),
    fs.mkdir(runtimeRoot, { recursive: true }),
  ])

  const compiled = spawnSync(process.execPath, [
    path.join(controlProjectRoot, 'deploy/qnap/strategic-intelligence/scripts/compile-internal-engineering-runtime.mjs'),
    path.join(controlProjectRoot, 'deploy/qnap/strategic-intelligence/config/internal-engineering-shadow-plan.json'),
    runtimeRoot,
  ], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)

  const sourceArchive = path.join(releaseRoot, 'source.tar.gz')
  const imageArchive = path.join(releaseRoot, 'collector-image.tar.gz')
  const archiveResult = spawnSync('tar', [
    '-C', path.dirname(releaseSourceRoot),
    '-czf', sourceArchive,
    path.basename(releaseSourceRoot),
  ], { encoding: 'utf8' })
  assert.equal(archiveResult.status, 0, archiveResult.stderr)
  await fs.writeFile(imageArchive, gzipSync(Buffer.from('bounded fake collector image archive')))

  const sourceCommit = 'a'.repeat(40)
  const collectorImageId = `sha256:${'b'.repeat(64)}`
  const [sourceBytes, imageBytes] = await Promise.all([
    fs.readFile(sourceArchive),
    fs.readFile(imageArchive),
  ])
  await fs.writeFile(path.join(releaseRoot, 'release-manifest.json'), JSON.stringify({
    manifestVersion: '1.2.0',
    releaseType: 'P1-SI-F-shadow-candidate-gated',
    createdAt: '2026-08-11T00:00:00Z',
    sourceCommit,
    collectorImageId,
    sourceArchiveSha256: sha256(sourceBytes),
    collectorImageArchiveSha256: sha256(imageBytes),
    candidateOntologySchema: '3.7.0',
    candidateOntologyHash: 'c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860',
    sourceRegistryCandidateHash: '0ce4022adcfc177ced670a8d7fd2e4b4e119c2fc1bc5c19cabefb3223c010eae',
    publish: false,
    productionDeploymentAuthorized: false,
    requiredGate: 'WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH',
    p003ReviewGateRequired: true,
    reviewerRoleAccessGateRequired: true,
    goal7AcceptanceGateRequired: true,
  }))

  await fs.writeFile(fakeDocker, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  load)
    cat >/dev/null
    ;;
  image)
    [ "\${2:-}" = inspect ]
    ;;
  compose)
    case "$*" in
      *" config")
        [ "\${FAKE_DOCKER_FAIL_COMPOSE:-NO}" != YES ] || exit 88
        ;;
      *) exit 87 ;;
    esac
    ;;
  *)
    exit 86
    ;;
esac
`)
  await fs.chmod(fakeDocker, 0o700)

  const controlDeployRoot = path.join(controlProjectRoot, 'deploy/qnap/strategic-intelligence')
  await fs.writeFile(path.join(controlDeployRoot, 'scripts/preflight-company-qnap.sh'), `#!/bin/sh
docker_path=${JSON.stringify(fakeDocker)}
foundation_root=${JSON.stringify(path.join(outputRoot, 'qnap', 'foundation'))}
shadow_root=${JSON.stringify(shadowRoot)}
printf 'company_qnap_identity=verified\\nfoundation_root=%s\\nshadow_root=%s\\n' "$foundation_root" "$shadow_root"
`)

  const deployScript = path.join(controlDeployRoot, 'scripts/deploy-internal-engineering-shadow.sh')
  const originalDeploy = await fs.readFile(deployScript, 'utf8')
  const testDeploy = originalDeploy
    .replace('/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence/release/*', `${releaseBase}/*`)
    .replace('/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence/internal-runtime/*', `${runtimeBase}/*`)
    .replace('/share/CACHEDEV2_DATA/ai-ontology-backup/strategic-intelligence/internal-engineering/$backup_id', `${backupBase}/$backup_id`)
  assert.notEqual(testDeploy, originalDeploy)
  await fs.writeFile(deployScript, testDeploy)

  const deployed = spawnSync('sh', [deployScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${process.env.PATH}:/sbin`,
      INTERNAL_ENGINEERING_SHADOW_DEPLOY_APPROVED: 'YES',
      SI_NODE_RUNTIME_IMAGE: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      SI_RELEASE_ROOT: releaseRoot,
      SI_INTERNAL_RUNTIME_ROOT: runtimeRoot,
      SI_INTERNAL_ENGINEERING_PLAN_FILE: path.join(runtimeRoot, 'internal-engineering-plan.json'),
      FAKE_DOCKER_LOG: dockerLog,
    },
  })
  assert.equal(deployed.status, 0, deployed.stderr)
  assert.match(deployed.stdout, /internal_engineering_runtime=prepared/)
  assert.match(deployed.stdout, /container_started=0/)
  assert.match(deployed.stdout, /database_migration_count=0/)
  assert.match(deployed.stdout, /existing_service_restart_count=0/)

  const internalRoot = path.join(shadowRoot, 'internal-engineering')
  const installedProject = path.join(internalRoot, 'package')
  const installedValidator = path.join(installedProject, 'deploy/qnap/strategic-intelligence/scripts/validate-internal-engineering-runtime.mjs')
  for (const requiredPath of [
    installedValidator,
    path.join(installedProject, 'packages/ontology-contracts/src/index.mjs'),
    path.join(installedProject, 'services/intelligence-collector/src/config.mjs'),
  ]) {
    assert.equal((await fs.stat(requiredPath)).isFile(), true, `missing installed dependency ${requiredPath}`)
  }
  const installedValidation = spawnSync(process.execPath, [installedValidator, path.join(internalRoot, 'config')], { encoding: 'utf8' })
  assert.equal(installedValidation.status, 0, installedValidation.stderr)

  const envFile = path.join(internalRoot, '.env.internal')
  const envContents = await fs.readFile(envFile, 'utf8')
  assert.match(envContents, new RegExp(`SI_ORCHESTRATOR_UID=${process.getuid()}`))
  assert.match(envContents, new RegExp(`SI_ORCHESTRATOR_GID=${process.getgid()}`))
  assert.match(envContents, new RegExp(`SI_COLLECTOR_UID=${process.getuid()}`))
  assert.match(envContents, new RegExp(`SI_COLLECTOR_GID=${process.getgid()}`))
  assert.match(envContents, /PUBLISH=false/)
  assert.match(envContents, /SI_NODE_RUNTIME_IMAGE=sha256:a{64}/)
  assert.equal((await fs.stat(envFile)).mode & 0o777, 0o600)
  for (const name of ['internal-engineering-plan.json', 'source-registry.json', 'collector.json', 'runtime-manifest.json']) {
    assert.equal((await fs.stat(path.join(internalRoot, 'config', name))).mode & 0o777, 0o600)
  }

  const dockerCalls = (await fs.readFile(dockerLog, 'utf8')).trim().split('\n')
  assert.deepEqual(dockerCalls, [
    `compose --env-file ${envFile}.next -f docker-compose.shadow.yml config`,
    'load',
    `image inspect ${collectorImageId}`,
  ])
  assert.ok(dockerCalls.every((call) => !/compose .*\b(up|run|restart|down)\b/.test(call)))
  assert.ok(dockerCalls.every((call) => !/migrat|dispatcher|cron/i.test(call)))

  const installedManifestFile = path.join(internalRoot, 'config', 'runtime-manifest.json')
  const installedEnvBeforeFailedUpdate = await fs.readFile(envFile, 'utf8')
  const installedManifestBeforeFailedUpdate = await fs.readFile(installedManifestFile, 'utf8')
  const releaseManifestFile = path.join(releaseRoot, 'release-manifest.json')
  const releaseManifest = JSON.parse(await fs.readFile(releaseManifestFile, 'utf8'))
  releaseManifest.sourceCommit = 'c'.repeat(40)
  await fs.writeFile(releaseManifestFile, JSON.stringify(releaseManifest))
  const runtimeManifestFile = path.join(runtimeRoot, 'runtime-manifest.json')
  const runtimeManifest = JSON.parse(await fs.readFile(runtimeManifestFile, 'utf8'))
  runtimeManifest.generatedAt = '2026-08-11T00:05:00Z'
  await fs.writeFile(runtimeManifestFile, JSON.stringify(runtimeManifest))
  const failedUpdate = spawnSync('sh', [deployScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${process.env.PATH}:/sbin`,
      INTERNAL_ENGINEERING_SHADOW_DEPLOY_APPROVED: 'YES',
      SI_NODE_RUNTIME_IMAGE: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      SI_RELEASE_ROOT: releaseRoot,
      SI_INTERNAL_RUNTIME_ROOT: runtimeRoot,
      SI_INTERNAL_ENGINEERING_PLAN_FILE: path.join(runtimeRoot, 'internal-engineering-plan.json'),
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_DOCKER_FAIL_COMPOSE: 'YES',
    },
  })
  assert.notEqual(failedUpdate.status, 0)
  assert.equal(await fs.readFile(envFile, 'utf8'), installedEnvBeforeFailedUpdate)
  assert.equal(await fs.readFile(installedManifestFile, 'utf8'), installedManifestBeforeFailedUpdate)
  assert.equal((await fs.stat(installedProject)).isDirectory(), true)
  const validationAfterFailedUpdate = spawnSync(process.execPath, [installedValidator, path.join(internalRoot, 'config')], { encoding: 'utf8' })
  assert.equal(validationAfterFailedUpdate.status, 0, validationAfterFailedUpdate.stderr)

  const fakeBin = path.join(outputRoot, 'fake-bin')
  const fakeMv = path.join(fakeBin, 'mv')
  const realMv = spawnSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).stdout.trim()
  await fs.mkdir(fakeBin, { recursive: true })
  await fs.writeFile(fakeMv, `#!/bin/sh
set -eu
if [ "\${FAKE_MV_FAIL_ENV_SWITCH:-NO}" = YES ] && [ "\${1:-}" = "\${FAKE_MV_FAIL_SOURCE:-}" ]; then exit 89; fi
exec ${JSON.stringify(realMv)} "$@"
`)
  await fs.chmod(fakeMv, 0o700)
  const failedSwitch = spawnSync('sh', [deployScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}:/sbin`,
      INTERNAL_ENGINEERING_SHADOW_DEPLOY_APPROVED: 'YES',
      SI_NODE_RUNTIME_IMAGE: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      SI_RELEASE_ROOT: releaseRoot,
      SI_INTERNAL_RUNTIME_ROOT: runtimeRoot,
      SI_INTERNAL_ENGINEERING_PLAN_FILE: path.join(runtimeRoot, 'internal-engineering-plan.json'),
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_MV_FAIL_ENV_SWITCH: 'YES',
      FAKE_MV_FAIL_SOURCE: `${internalRoot}/.env.internal.next`,
    },
  })
  assert.notEqual(failedSwitch.status, 0)
  assert.equal(await fs.readFile(envFile, 'utf8'), installedEnvBeforeFailedUpdate)
  assert.equal(await fs.readFile(installedManifestFile, 'utf8'), installedManifestBeforeFailedUpdate)
  const validationAfterFailedSwitch = spawnSync(process.execPath, [installedValidator, path.join(internalRoot, 'config')], { encoding: 'utf8' })
  assert.equal(validationAfterFailedSwitch.status, 0, validationAfterFailedSwitch.stderr)

  const rollbackScript = path.join(controlDeployRoot, 'scripts/rollback-internal-engineering-shadow.sh')
  const originalRollback = await fs.readFile(rollbackScript, 'utf8')
  const testRollback = originalRollback.replace('/share/CACHEDEV2_DATA/ai-ontology-backup/strategic-intelligence/internal-engineering/*', `${backupBase}/*`)
  assert.notEqual(testRollback, originalRollback)
  await fs.writeFile(rollbackScript, testRollback)
  const refusedRollback = spawnSync('sh', [rollbackScript], {
    encoding: 'utf8',
    env: { ...process.env, INTERNAL_ENGINEERING_ROLLBACK_APPROVED: 'YES' },
  })
  assert.notEqual(refusedRollback.status, 0)
  assert.match(refusedRollback.stderr, /backup archive missing/)
  assert.equal((await fs.stat(installedProject)).isDirectory(), true)

  const redeployed = spawnSync('sh', [deployScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${process.env.PATH}:/sbin`,
      INTERNAL_ENGINEERING_SHADOW_DEPLOY_APPROVED: 'YES',
      SI_NODE_RUNTIME_IMAGE: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      SI_RELEASE_ROOT: releaseRoot,
      SI_INTERNAL_RUNTIME_ROOT: runtimeRoot,
      SI_INTERNAL_ENGINEERING_PLAN_FILE: path.join(runtimeRoot, 'internal-engineering-plan.json'),
      FAKE_DOCKER_LOG: dockerLog,
    },
  })
  assert.equal(redeployed.status, 0, redeployed.stderr)
  const secondBackupRoot = (await fs.readFile(path.join(internalRoot, '.previous-backup'), 'utf8')).trim()
  const backupArchive = path.join(secondBackupRoot, 'previous-runtime.tar.gz')
  const backupChecksum = path.join(secondBackupRoot, 'previous-runtime.tar.gz.sha256')
  assert.equal((await fs.stat(backupArchive)).isFile(), true)
  assert.equal((await fs.stat(backupChecksum)).isFile(), true)
  const archiveListing = spawnSync('tar', ['-tzf', backupArchive], { encoding: 'utf8' })
  assert.equal(archiveListing.status, 0, archiveListing.stderr)
  assert.match(archiveListing.stdout, /^package\//m)
  assert.match(archiveListing.stdout, /^config\//m)
  assert.match(archiveListing.stdout, /^\.env\.internal$/m)

  const restored = spawnSync('sh', [rollbackScript], {
    encoding: 'utf8',
    env: { ...process.env, INTERNAL_ENGINEERING_ROLLBACK_APPROVED: 'YES' },
  })
  assert.equal(restored.status, 0, restored.stderr)
  assert.match(restored.stdout, /internal_engineering_rollback=completed/)
  assert.equal((await fs.stat(path.join(internalRoot, 'package'))).isDirectory(), true)
  assert.equal((await fs.stat(path.join(internalRoot, 'config'))).isDirectory(), true)
  assert.equal((await fs.stat(path.join(internalRoot, '.env.internal'))).isFile(), true)
})
