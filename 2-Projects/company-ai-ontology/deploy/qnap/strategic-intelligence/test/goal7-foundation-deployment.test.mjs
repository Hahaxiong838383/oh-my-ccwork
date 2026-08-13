import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateGoal7RuntimeRelease } from '../scripts/goal7-runtime-release-lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEPLOY = path.join(ROOT, 'scripts/deploy-goal7-foundation.sh')
const PREPARE = path.join(ROOT, 'scripts/prepare-goal7-foundation.sh')
const STAGE = path.join(ROOT, 'scripts/stage-goal7-runtime-release.sh')
const MIGRATE = path.join(ROOT, 'scripts/reconcile-goal7-migration-012.sh')
const ROLLBACK = path.join(ROOT, 'scripts/rollback-goal7-foundation.sh')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function writeRuntimeRelease(root) {
  const sourceCommit = 'c'.repeat(40)
  const hLiteSourceCommit = 'f'.repeat(40)
  const componentVersions = {
    evidenceVersion: '1.0.0',
    evidenceType: 'goal7-runtime-component-versions',
    sourceCommit,
    hLiteSourceCommit,
    agentCoreVersion: '2026-08-12.3',
    knowledgeConnectorVersion: '2026-08-11.1',
    hLiteVersion: '2026-08-12.1',
  }
  const bytes = {
    'postgres-validation.txt': Buffer.from('postgres verified\n'),
    'goal7-foundation-validation.txt': Buffer.from('foundation verified\n'),
    'source.tar.gz': Buffer.from('ontology source'),
    'h-lite-source.tar.gz': Buffer.from('h-lite source'),
    'collector-image.tar.gz': Buffer.from('collector image'),
    'runtime-component-versions.json': Buffer.from(`${JSON.stringify(componentVersions)}\n`),
  }
  bytes['image.env'] = Buffer.from(`image_id=sha256:${'a'.repeat(64)}\nplatform=linux/amd64\narchive_sha=${sha256(bytes['collector-image.tar.gz'])}\n`)
  const releaseManifest = {
    manifestVersion: '1.6.0',
    releaseType: 'P1-SI-F-shadow-candidate-gated',
    sourceCommit,
    hLiteSourceCommit,
    sourceArchiveSha256: sha256(bytes['source.tar.gz']),
    hLiteSourceArchiveSha256: sha256(bytes['h-lite-source.tar.gz']),
    collectorImageArchiveSha256: sha256(bytes['collector-image.tar.gz']),
    collectorImageId: `sha256:${'a'.repeat(64)}`,
    collectorPlatform: 'linux/amd64',
    runtimeComponentVersionsSha256: sha256(bytes['runtime-component-versions.json']),
    agentCoreVersion: componentVersions.agentCoreVersion,
    knowledgeConnectorVersion: componentVersions.knowledgeConnectorVersion,
    hLiteVersion: componentVersions.hLiteVersion,
    publish: false,
    productionDeploymentAuthorized: false,
    requiredGate: 'WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH',
    goal7Migration012Mode: 'pre_existing_reconciliation_only',
    goal7Migration012SqlReplayAllowed: false,
  }
  bytes['release-manifest.json'] = Buffer.from(`${JSON.stringify(releaseManifest)}\n`)
  const verification = {
    evidenceVersion: '1.0.0',
    verificationType: 'P1-SI-F-linux-amd64-runtime',
    sourceCommit,
    hLiteSourceCommit,
    agentCoreVersion: componentVersions.agentCoreVersion,
    knowledgeConnectorVersion: componentVersions.knowledgeConnectorVersion,
    hLiteVersion: componentVersions.hLiteVersion,
    collectorImageId: `sha256:${'a'.repeat(64)}`,
    collectorPlatform: 'linux/amd64',
    sourceArchiveSha256: sha256(bytes['source.tar.gz']),
    hLiteSourceArchiveSha256: sha256(bytes['h-lite-source.tar.gz']),
    collectorImageArchiveSha256: sha256(bytes['collector-image.tar.gz']),
    releaseManifestSha256: sha256(bytes['release-manifest.json']),
    runtimeComponentVersionsSha256: sha256(bytes['runtime-component-versions.json']),
    postgresEvidenceSha256: sha256(bytes['postgres-validation.txt']),
    goal7FoundationEvidenceSha256: sha256(bytes['goal7-foundation-validation.txt']),
    immutableReleaseCandidateVerified: true,
    companyQnapDeployed: false,
    publish: false,
    routeBState: 'disabled',
    goal7AuthorityRuntimeFoundation: 'verified',
  }
  bytes['runtime-verification.json'] = Buffer.from(`${JSON.stringify(verification)}\n`)
  for (const [name, value] of Object.entries(bytes)) await fs.writeFile(path.join(root, name), value)
  const sums = Object.entries(bytes).map(([name, value]) => `${sha256(value)}  ${name}`).join('\n')
  await fs.writeFile(path.join(root, 'SHA256SUMS'), `${sums}\n`)
  return { sourceCommit, hLiteSourceCommit, ...componentVersions, verification }
}

async function rewriteChecksums(root) {
  const names = (await fs.readFile(path.join(root, 'SHA256SUMS'), 'utf8')).trim().split('\n').map((line) => line.slice(66))
  const lines = []
  for (const name of names) lines.push(`${sha256(await fs.readFile(path.join(root, name)))}  ${name}`)
  await fs.writeFile(path.join(root, 'SHA256SUMS'), `${lines.join('\n')}\n`)
}

async function writeExecutable(file, body) {
  await fs.writeFile(file, body)
  await fs.chmod(file, 0o700)
}

async function createPrepareSandbox({ existingEvidence = false, existingEvidenceValid = false, freshPreparationSuccess = false, precreateLock = false } = {}) {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-prepare-'))
  const scripts = path.join(sandbox, 'scripts')
  const shadowRoot = path.join(sandbox, 'shadow')
  const foundationRoot = path.join(sandbox, 'foundation')
  const runtimeEvidenceRoot = path.join(shadowRoot, 'release', 'goal7-123')
  const evidenceRoot = path.join(shadowRoot, 'approvals', 'run-123')
  const backupBase = path.join(sandbox, 'backup', 'goal7')
  const dockerLog = path.join(sandbox, 'docker.log')
  const sourceCommit = 'c'.repeat(40)
  const hLiteSourceCommit = 'f'.repeat(40)
  const runId = 'run-123'
  await fs.mkdir(scripts, { recursive: true })
  await fs.mkdir(runtimeEvidenceRoot, { recursive: true })
  await fs.mkdir(evidenceRoot, { recursive: true })
  await fs.mkdir(foundationRoot, { recursive: true })
  const backupRoot = path.join(backupBase, runId)
  const previousImageId = `sha256:${'1'.repeat(64)}`
  const candidateImageId = `sha256:${'2'.repeat(64)}`
  let backupEnvSha = ''
  let backupComposeSha = ''
  if (existingEvidence) {
    await fs.writeFile(path.join(evidenceRoot, 'preparation-evidence.json'), '{"existing":true}\n')
    await fs.writeFile(path.join(evidenceRoot, 'preparation-baseline-state.json'), '{"existing":true}\n')
  }
  if (existingEvidenceValid) {
    await fs.mkdir(backupRoot, { recursive: true })
    const backupEnv = Buffer.from('FOUNDATION_ENV=preserved\n')
    const backupCompose = Buffer.from('services: {}\n')
    await fs.writeFile(path.join(backupRoot, '.env'), backupEnv)
    await fs.writeFile(path.join(backupRoot, 'docker-compose.yml'), backupCompose)
    backupEnvSha = sha256(backupEnv)
    backupComposeSha = sha256(backupCompose)
  }
  if (freshPreparationSuccess) {
    const ontologyArchiveRoot = path.join(sandbox, 'ontology-archive', 'company-ai-ontology')
    const hLiteArchiveRoot = path.join(sandbox, 'h-lite-archive', 'feishu-grok-bridge')
    await fs.mkdir(path.join(ontologyArchiveRoot, 'deploy/qnap/candidate-migrations'), { recursive: true })
    await fs.mkdir(path.join(hLiteArchiveRoot, 'deploy/company-qnap-lite'), { recursive: true })
    await fs.writeFile(path.join(ontologyArchiveRoot, 'deploy/qnap/docker-compose.yml'), 'services: {}\n')
    await fs.writeFile(path.join(ontologyArchiveRoot, 'deploy/qnap/candidate-migrations/012-goal7-authority-runtime.sql'), '-- candidate\n')
    await fs.writeFile(path.join(hLiteArchiveRoot, 'deploy/company-qnap-lite/Dockerfile'), 'FROM scratch\n')
    assert.equal(spawnSync('tar', ['-czf', path.join(runtimeEvidenceRoot, 'source.tar.gz'), '-C', path.join(sandbox, 'ontology-archive'), '.']).status, 0)
    assert.equal(spawnSync('tar', ['-czf', path.join(runtimeEvidenceRoot, 'h-lite-source.tar.gz'), '-C', hLiteArchiveRoot, '.']).status, 0)
    await fs.writeFile(path.join(runtimeEvidenceRoot, 'SHA256SUMS'), 'signed release\n')
    await fs.writeFile(path.join(runtimeEvidenceRoot, 'runtime-component-versions.json'), '{}\n')
    await fs.writeFile(path.join(foundationRoot, '.env'), 'FOUNDATION_ENV=active\n')
    await fs.writeFile(path.join(foundationRoot, 'docker-compose.yml'), 'services: {}\n')
  }
  const prepare = (await fs.readFile(PREPARE, 'utf8'))
    .replace('/share/CACHEDEV2_DATA/ai-ontology-backup/goal7', backupBase)
  await fs.writeFile(path.join(scripts, 'prepare-goal7-foundation.sh'), prepare)
  await fs.writeFile(path.join(scripts, 'preflight-company-qnap.sh'), [
    `shadow_root=${JSON.stringify(shadowRoot)}`,
    `foundation_root=${JSON.stringify(foundationRoot)}`,
    `docker_path=${JSON.stringify(path.join(scripts, 'docker'))}`,
    '',
  ].join('\n'))
  await writeExecutable(path.join(scripts, 'node-runtime.sh'), `#!/bin/sh
case "$1" in
  */validate-goal7-runtime-release.mjs)
    printf '%s\n' 'source_commit=${sourceCommit}' 'h_lite_source_commit=${hLiteSourceCommit}' 'agent_core_version=2026-08-12.3' 'knowledge_connector_version=2026-08-11.1' 'h_lite_version=2026-08-12.1'
    ;;
  */validate-goal7-preparation.mjs)
    ${existingEvidenceValid ? `printf '%s\\n' 'run_id=${runId}' 'backup_root=${backupRoot}' 'backup_env_sha256=${backupEnvSha}' 'backup_compose_sha256=${backupComposeSha}' 'previous_agent_core_image_id=${previousImageId}' 'candidate_agent_core_image_id=${candidateImageId}' 'previous_knowledge_connector_image_id=${previousImageId}' 'candidate_knowledge_connector_image_id=${candidateImageId}' 'previous_h_lite_image_id=${previousImageId}' 'candidate_h_lite_image_id=${candidateImageId}'` : freshPreparationSuccess ? 'exit 0' : 'exit 7'}
    ;;
  */hash-goal7-runtime-tree.mjs)
    printf '%s\n' 'runtime-tree-sha'
    ;;
  */write-goal7-preparation-evidence.mjs)
    cp "$2" "$3"
    ;;
  *) exit 8 ;;
esac
`)
  if (freshPreparationSuccess) {
    await writeExecutable(path.join(scripts, 'capture-goal7-deployment-state.sh'), `#!/bin/sh
printf '%s\n' '{"captured":true}' > "$2"
`)
  }
  await writeExecutable(path.join(scripts, 'docker'), `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(dockerLog)}
case "$*" in
  "image inspect --format {{.Id}} "*":goal7-pre-${runId}") printf '%s\n' '${previousImageId}' ;;
  "image inspect --format {{.Id}} "*":goal7-candidate-${runId}") printf '%s\n' '${candidateImageId}' ;;
  "image inspect "*":goal7-pre-${runId}"|"image inspect "*":goal7-candidate-${runId}") exit 1 ;;
  "compose config") exit 0 ;;
  "compose ps -q agent-core") printf '%s\n' 'cid-agent-core' ;;
  "compose ps -q knowledge-connector") printf '%s\n' 'cid-knowledge-connector' ;;
  "compose ps -q h-lite") printf '%s\n' 'cid-h-lite' ;;
  "inspect --format {{.Image}} cid-agent-core") printf '%s\n' 'sha256:${'a'.repeat(64)}' ;;
  "inspect --format {{.Image}} cid-knowledge-connector") printf '%s\n' 'sha256:${'b'.repeat(64)}' ;;
  "inspect --format {{.Image}} cid-h-lite") printf '%s\n' 'sha256:${'c'.repeat(64)}' ;;
  "image inspect sha256:"*|"image tag "*|"build "*|"run "*) exit 0 ;;
  *) exit 99 ;;
esac
`)
  if (precreateLock) await fs.mkdir(path.join(shadowRoot, '.goal7-foundation-preparation.lock'))
  return {
    sandbox,
    scripts,
    shadowRoot,
    foundationRoot,
    runtimeEvidenceRoot,
    evidenceRoot,
    backupBase,
    dockerLog,
    sourceCommit,
    hLiteSourceCommit,
    runId,
  }
}

function prepareEnv(fixture) {
  return {
    ...process.env,
    GOAL7_DEPLOY_APPROVED: 'YES',
    GOAL7_RUNTIME_EVIDENCE_ROOT: fixture.runtimeEvidenceRoot,
    GOAL7_DEPLOYMENT_EVIDENCE_ROOT: fixture.evidenceRoot,
    GOAL7_APPROVED_SOURCE_COMMIT: fixture.sourceCommit,
    GOAL7_APPROVED_H_LITE_SOURCE_COMMIT: fixture.hLiteSourceCommit,
    GOAL7_DEPLOY_RUN_ID: fixture.runId,
  }
}

async function createMigrationSandbox({ existingEvidence = false, precreateLock = false, failFinalValidation = false } = {}) {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-migration-'))
  const scripts = path.join(sandbox, 'scripts')
  const shadowRoot = path.join(sandbox, 'shadow')
  const foundationRoot = path.join(sandbox, 'foundation')
  const evidenceRoot = path.join(shadowRoot, 'approvals', 'goal7-current')
  const runtimeRoot = path.join(shadowRoot, 'foundation-releases', 'current')
  const historicalReleaseRoot = path.join(shadowRoot, 'release', 'goal7-31555822727')
  const historicalEvidenceRoot = path.join(shadowRoot, 'approvals', 'goal7-31555822727')
  const sourceCommit = 'c'.repeat(40)
  const hLiteSourceCommit = 'f'.repeat(40)
  const migrationBytes = Buffer.from('-- goal7 migration fixture\n')
  const historicalPreState = Buffer.from('{"phase":"before"}\n')
  const migrationSha = sha256(migrationBytes)
  const historicalPreStateSha = sha256(historicalPreState)
  const nodeLog = path.join(sandbox, 'node.log')
  const liveLog = path.join(sandbox, 'live.log')
  await fs.mkdir(scripts, { recursive: true })
  await fs.mkdir(evidenceRoot, { recursive: true })
  await fs.mkdir(path.join(runtimeRoot, 'company-ai-ontology/deploy/qnap/candidate-migrations'), { recursive: true })
  await fs.mkdir(historicalReleaseRoot, { recursive: true })
  await fs.mkdir(historicalEvidenceRoot, { recursive: true })
  await fs.mkdir(foundationRoot, { recursive: true })
  await fs.writeFile(path.join(runtimeRoot, 'company-ai-ontology/deploy/qnap/candidate-migrations/012-goal7-authority-runtime.sql'), migrationBytes)
  await fs.writeFile(path.join(historicalEvidenceRoot, 'pre-deployment-state.json'), historicalPreState)
  const archiveRoot = path.join(sandbox, 'historical-archive')
  await fs.mkdir(path.join(archiveRoot, 'company-ai-ontology/deploy/qnap/candidate-migrations'), { recursive: true })
  await fs.writeFile(path.join(archiveRoot, 'company-ai-ontology/deploy/qnap/candidate-migrations/012-goal7-authority-runtime.sql'), migrationBytes)
  assert.equal(spawnSync('tar', [
    '-czf',
    path.join(historicalReleaseRoot, 'source.tar.gz'),
    '-C',
    archiveRoot,
    'company-ai-ontology/deploy/qnap/candidate-migrations/012-goal7-authority-runtime.sql',
  ]).status, 0)
  await fs.writeFile(path.join(evidenceRoot, 'preparation-evidence.json'), '{"prepared":true}\n')
  if (existingEvidence) await fs.writeFile(path.join(evidenceRoot, 'migration-012-evidence.json'), '{"existing":true}\n')
  const migrate = (await fs.readFile(MIGRATE, 'utf8'))
    .replaceAll('8ea8648effbd7ab6d3ef81283678afc2fb16250f526e73c6a421abcb4d723a74', migrationSha)
    .replaceAll('5c6c10e8aeb9ebd8db0e87ad30b5f8ce8ed5a5ac94be53068baca75a04b0b723', historicalPreStateSha)
  await writeExecutable(path.join(scripts, 'reconcile-goal7-migration-012.sh'), migrate)
  await fs.writeFile(path.join(scripts, 'preflight-company-qnap.sh'), [
    `shadow_root=${JSON.stringify(shadowRoot)}`,
    `foundation_root=${JSON.stringify(foundationRoot)}`,
    `docker_path=${JSON.stringify(path.join(scripts, 'docker'))}`,
    '',
  ].join('\n'))
  await writeExecutable(path.join(scripts, 'node-runtime.sh'), `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(nodeLog)}
case "$1" in
  */validate-goal7-preparation.mjs)
    printf '%s\n' 'run_id=goal7-current' 'runtime_root=${runtimeRoot}' 'preparation_evidence_sha256=${'a'.repeat(64)}'
    ;;
  */write-goal7-migration-evidence.mjs)
    cp "$2" "$3"
    ;;
  */validate-goal7-migration.mjs)
    ${failFinalValidation ? 'exit 7' : `printf '%s\n' 'migration_status=verified' 'migration_evidence_sha256=${'b'.repeat(64)}'`}
    ;;
  *) exit 8 ;;
esac
`)
  await writeExecutable(path.join(scripts, 'verify-goal7-migration-012-live.sh'), `#!/bin/sh
printf '%s\n' verified >> ${JSON.stringify(liveLog)}
cat <<'EOF'
table_count=4
forced_rls_count=4
tenant_policy_count=4
app_privilege_count=10
delete_privilege_count=0
banned_column_count=0
app_role_read_verified=true
principal_membership_row_count=0
authority_snapshot_row_count=0
route_state_row_count=1
usage_event_row_count=0
EOF
`)
  await fs.writeFile(path.join(scripts, 'write-goal7-migration-evidence.mjs'), '')
  await fs.writeFile(path.join(scripts, 'validate-goal7-migration.mjs'), '')
  await fs.writeFile(path.join(scripts, 'validate-goal7-preparation.mjs'), '')
  if (precreateLock) await fs.mkdir(path.join(shadowRoot, '.goal7-migration-012-reconciliation.lock'))
  return { scripts, shadowRoot, evidenceRoot, sourceCommit, hLiteSourceCommit, nodeLog, liveLog }
}

function migrationEnv(fixture) {
  return {
    ...process.env,
    GOAL7_MIGRATION_012_RECONCILIATION_APPROVED: 'YES',
    GOAL7_DEPLOYMENT_EVIDENCE_ROOT: fixture.evidenceRoot,
    GOAL7_APPROVED_SOURCE_COMMIT: fixture.sourceCommit,
    GOAL7_APPROVED_H_LITE_SOURCE_COMMIT: fixture.hLiteSourceCommit,
  }
}

test('Goal 7 部署和回滚在公司 QNAP 预检前要求独立显式授权', () => {
  const deploy = spawnSync('sh', [DEPLOY], { encoding: 'utf8' })
  assert.equal(deploy.status, 2)
  assert.match(deploy.stderr, /explicit GOAL7_SERVICE_RECREATION_APPROVED=YES/)
  assert.doesNotMatch(deploy.stderr, /QNAP|docker|runtime evidence/i)

  const rollback = spawnSync('sh', [ROLLBACK], { encoding: 'utf8' })
  assert.equal(rollback.status, 2)
  assert.match(rollback.stderr, /explicit GOAL7_ROLLBACK_APPROVED=YES/)
  assert.doesNotMatch(rollback.stderr, /QNAP|docker|backup/i)
})

test('Goal 7 Runtime 包绑定全部 Hash 与获批双 Commit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-runtime-release-'))
  const fixture = await writeRuntimeRelease(root)
  const verified = await validateGoal7RuntimeRelease(root, fixture)
  assert.equal(verified.sourceCommit, fixture.sourceCommit)
  assert.equal(verified.hLiteSourceCommit, fixture.hLiteSourceCommit)
  assert.equal(verified.agentCoreVersion, '2026-08-12.3')
  assert.equal(verified.checksumEntryCount, 9)

  await assert.rejects(
    validateGoal7RuntimeRelease(root, { ...fixture, sourceCommit: 'a'.repeat(40) }),
    /approved Ontology sourceCommit drift/,
  )
  await assert.rejects(
    validateGoal7RuntimeRelease(root, { ...fixture, hLiteSourceCommit: 'b'.repeat(40) }),
    /approved H-Lite sourceCommit drift/,
  )
})

test('Goal 7 Runtime Release 拒绝未校验和文件、image.env 漂移和额外根条目', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-runtime-release-strict-'))
  const expected = await writeRuntimeRelease(root)
  await fs.writeFile(path.join(root, 'unexpected.txt'), 'not checksummed')
  await assert.rejects(() => validateGoal7RuntimeRelease(root, expected), /unexpected root entries/)
  await fs.rm(path.join(root, 'unexpected.txt'))

  await fs.writeFile(path.join(root, 'image.env'), `image_id=sha256:${'b'.repeat(64)}\nplatform=linux/amd64\narchive_sha=${expected.verification.collectorImageArchiveSha256}\n`)
  await rewriteChecksums(root)
  await assert.rejects(() => validateGoal7RuntimeRelease(root, expected), /image_id drift/)
})

test('Goal 7 Artifact staging 在 QNAP 预检前要求 A 阶段显式授权', () => {
  const result = spawnSync('sh', [STAGE], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /explicit GOAL7_DEPLOY_APPROVED=YES/)
  assert.doesNotMatch(result.stderr, /QNAP|docker|artifact id/i)
})

test('Goal 7 Artifact staging 只接受 uploading 到 release 的原子晋级', async () => {
  const stage = await fs.readFile(STAGE, 'utf8')
  assert.match(stage, /incoming=\$incoming_root\/goal7-\$artifact_id\.uploading/)
  assert.match(stage, /target=\$release_root\/goal7-\$artifact_id/)
  assert.match(stage, /validate-goal7-runtime-release\.mjs/)
  assert.match(stage, /checksum_count.*= 9/)
  assert.match(stage, /mv "\$temporary_target" "\$target"/)
  assert.match(stage, /\.goal7-\$artifact_id\.lock/)
  assert.ok(stage.indexOf('trap cleanup_stage EXIT') < stage.indexOf('validation=$('))
  assert.match(stage, /rmdir "\$lock" 2>\/dev\/null \|\| true/)
  assert.match(stage, /rm -rf "\$incoming"/)
  assert.doesNotMatch(stage, /compose up|compose build|psql|Collector|Shadow/)
})

test('Goal 7 Artifact staging 校验失败后清理锁和临时目录', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-stage-cleanup-'))
  const scripts = path.join(sandbox, 'scripts')
  const shadowRoot = path.join(sandbox, 'shadow')
  const artifactId = '1234567890'
  const incoming = path.join(shadowRoot, 'incoming', `goal7-${artifactId}.uploading`)
  const releaseRoot = path.join(shadowRoot, 'release')
  await fs.mkdir(scripts, { recursive: true })
  await fs.mkdir(incoming, { recursive: true })
  await fs.copyFile(STAGE, path.join(scripts, 'stage-goal7-runtime-release.sh'))
  await fs.copyFile(path.join(ROOT, 'scripts/validate-goal7-runtime-release.mjs'), path.join(scripts, 'validate-goal7-runtime-release.mjs'))
  await fs.copyFile(path.join(ROOT, 'scripts/goal7-runtime-release-lib.mjs'), path.join(scripts, 'goal7-runtime-release-lib.mjs'))
  await fs.writeFile(path.join(scripts, 'preflight-company-qnap.sh'), `shadow_root=${JSON.stringify(shadowRoot)}\n`)
  await fs.writeFile(path.join(scripts, 'node-runtime.sh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`)
  await fs.chmod(path.join(scripts, 'node-runtime.sh'), 0o700)
  await fs.writeFile(path.join(incoming, 'SHA256SUMS'), 'invalid\n')

  const result = spawnSync('sh', [path.join(scripts, 'stage-goal7-runtime-release.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GOAL7_DEPLOY_APPROVED: 'YES',
      GOAL7_APPROVED_ARTIFACT_ID: artifactId,
      GOAL7_APPROVED_SOURCE_COMMIT: 'c'.repeat(40),
      GOAL7_APPROVED_H_LITE_SOURCE_COMMIT: 'f'.repeat(40),
    },
  })
  assert.notEqual(result.status, 0)
  await assert.rejects(fs.lstat(path.join(releaseRoot, `.goal7-${artifactId}.lock`)), { code: 'ENOENT' })
  assert.deepEqual((await fs.readdir(releaseRoot)).filter((name) => name.includes('.partial-')), [])
})

test('Goal 7 Artifact staging 晋级后复验失败不留下目标目录', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-stage-promote-cleanup-'))
  const scripts = path.join(sandbox, 'scripts')
  const shadowRoot = path.join(sandbox, 'shadow')
  const artifactId = '1234567891'
  const incoming = path.join(shadowRoot, 'incoming', `goal7-${artifactId}.uploading`)
  const releaseRoot = path.join(shadowRoot, 'release')
  const sourceCommit = 'c'.repeat(40)
  const hLiteSourceCommit = 'f'.repeat(40)
  await fs.mkdir(scripts, { recursive: true })
  await fs.mkdir(incoming, { recursive: true })
  await writeRuntimeRelease(incoming)
  await fs.copyFile(STAGE, path.join(scripts, 'stage-goal7-runtime-release.sh'))
  await fs.copyFile(path.join(ROOT, 'scripts/validate-goal7-runtime-release.mjs'), path.join(scripts, 'validate-goal7-runtime-release.mjs'))
  await fs.copyFile(path.join(ROOT, 'scripts/goal7-runtime-release-lib.mjs'), path.join(scripts, 'goal7-runtime-release-lib.mjs'))
  await fs.writeFile(path.join(scripts, 'preflight-company-qnap.sh'), `shadow_root=${JSON.stringify(shadowRoot)}\n`)
  await fs.writeFile(path.join(scripts, 'node-runtime.sh'), `#!/bin/sh\ncount_file=${JSON.stringify(path.join(sandbox, 'validator-count'))}\ncount=0\n[ ! -f "$count_file" ] || count=$(cat "$count_file")\ncount=$((count + 1))\nprintf '%s' "$count" > "$count_file"\n[ "$count" -lt 3 ] || exit 9\nexec ${JSON.stringify(process.execPath)} "$@"\n`)
  await fs.chmod(path.join(scripts, 'node-runtime.sh'), 0o700)

  const result = spawnSync('sh', [path.join(scripts, 'stage-goal7-runtime-release.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GOAL7_DEPLOY_APPROVED: 'YES',
      GOAL7_APPROVED_ARTIFACT_ID: artifactId,
      GOAL7_APPROVED_SOURCE_COMMIT: sourceCommit,
      GOAL7_APPROVED_H_LITE_SOURCE_COMMIT: hLiteSourceCommit,
    },
  })
  assert.equal(result.status, 9)
  await assert.rejects(fs.lstat(path.join(releaseRoot, `goal7-${artifactId}`)), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(path.join(releaseRoot, `.goal7-${artifactId}.lock`)), { code: 'ENOENT' })
  assert.deepEqual((await fs.readdir(releaseRoot)).filter((name) => name.includes('.partial-')), [])
  assert.equal((await fs.lstat(incoming)).isDirectory(), true)
})

test('Goal 7 Runtime 包拒绝 SHA 清单篡改和重新签名后的内部 Hash 漂移', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-runtime-tamper-'))
  const fixture = await writeRuntimeRelease(root)
  await fs.appendFile(path.join(root, 'h-lite-source.tar.gz'), 'tampered')
  await assert.rejects(validateGoal7RuntimeRelease(root, fixture), /checksum mismatch: h-lite-source\.tar\.gz/)

  await rewriteChecksums(root)
  await assert.rejects(validateGoal7RuntimeRelease(root, fixture), /hLiteSourceArchiveSha256 drift/)

  await writeRuntimeRelease(root)
  const versionsFile = path.join(root, 'runtime-component-versions.json')
  const versions = JSON.parse(await fs.readFile(versionsFile, 'utf8'))
  await fs.writeFile(versionsFile, JSON.stringify({ ...versions, agentCoreVersion: '2026-08-11.1' }))
  await rewriteChecksums(root)
  await assert.rejects(validateGoal7RuntimeRelease(root, fixture), /runtimeComponentVersionsSha256 drift/)

  await writeRuntimeRelease(root)
  const verificationFile = path.join(root, 'runtime-verification.json')
  await fs.writeFile(verificationFile, JSON.stringify({ ...fixture.verification, sourceCommit: 'invalid' }))
  await rewriteChecksums(root)
  await assert.rejects(validateGoal7RuntimeRelease(root, fixture), /sourceCommit invalid/)
})

test('Goal 7 Foundation 脚本只切换三个服务并保留可回滚链', async () => {
  const prepare = await fs.readFile(PREPARE, 'utf8')
  const migrate = await fs.readFile(MIGRATE, 'utf8')
  const deploy = await fs.readFile(DEPLOY, 'utf8')
  const rollback = await fs.readFile(ROLLBACK, 'utf8')
  for (const marker of [
    'GOAL7_APPROVED_SOURCE_COMMIT',
    'GOAL7_APPROVED_H_LITE_SOURCE_COMMIT',
    'agent_core_version=',
    'knowledge_connector_version=',
    'h_lite_version=',
    'validate-goal7-migration.mjs',
    'capture-goal7-deployment-state.sh" before',
    'capture-goal7-deployment-state.sh" after',
    'capture-shadow-side-effects.sh',
    'process.stdout.write(x.capturedAt)',
    'compile-goal7-deployment-evidence.mjs',
    'goal7-pre-$run_id',
    'rollback_on_error',
    'migration012_retained_on_rollback=true',
  ]) assert.ok(deploy.includes(marker), `deployment marker missing: ${marker}`)

  assert.match(prepare, /validate-goal7-runtime-release\.mjs/)
  assert.match(prepare, /\.goal7-foundation-preparation\.lock/)
  assert.match(prepare, /Goal 7 foundation preparation is already in progress/)
  assert.match(prepare, /Goal 7 preparation previous image tag already exists/)
  assert.match(prepare, /Goal 7 preparation candidate image tag already exists/)
  assert.match(prepare, /trap 'exit 130' HUP INT TERM/)
  assert.match(prepare, /release_lock/)
  assert.match(prepare, /baseline_created=0/)
  assert.match(prepare, /preparation_created=0/)
  assert.match(prepare, /capture-goal7-deployment-state\.sh" preparation/)
  assert.match(prepare, /\[ "\$baseline_created" -eq 0 \] \|\| rm -f "\$baseline_file"/)
  assert.match(prepare, /\[ "\$preparation_created" -eq 0 \] \|\| rm -f "\$preparation_file"/)
  assert.ok(prepare.indexOf('created_image_tags="$created_image_tags $candidate"') < prepare.indexOf('"$docker_path" build --build-arg ONTOLOGY_SOURCE_COMMIT'))
  assert.match(prepare, /goal7-candidate-\$run_id/)
  assert.match(prepare, /verify_image_readable company-ai-foundation-agent-core:goal7-candidate-\$run_id \/app\/src\/server\.mjs/)
  assert.match(prepare, /verify_image_readable company-ai-foundation-knowledge-connector:goal7-candidate-\$run_id \/app\/src\/server\.mjs/)
  assert.match(prepare, /verify_image_readable company-ai-foundation-h-lite:goal7-candidate-\$run_id \/app\/company-qnap-lite\.mjs/)
  assert.match(migrate, /012-goal7-authority-runtime\.sql/)
  assert.match(migrate, /\.goal7-migration-012-reconciliation\.lock/)
  assert.match(migrate, /Goal 7 migration 012 reconciliation is already in progress/)
  assert.match(migrate, /release_lock/)
  assert.match(migrate, /migration-012-evidence\.json/)
  assert.match(migrate, /originalEvidenceStatus/)
  assert.match(migrate, /database_sql_executed=0/)
  assert.doesNotMatch(migrate, /compose exec -T postgres psql --set=ON_ERROR_STOP=1/)
  assert.doesNotMatch(migrate, /compose up|compose build/)
  assert.doesNotMatch(deploy, /compose build|psql[\s\S]*012-goal7-authority-runtime\.sql/)
  assert.match(deploy, /wait_foundation_stable/)
  assert.match(deploy, /stable_samples.*-ge 2/)
  assert.match(deploy, /count.*-eq 13/)
  const mainPath = deploy.slice(deploy.indexOf('wait_legacy_h_lite_quiet ||'))
  for (const service of ['agent-core', 'knowledge-connector', 'h-lite']) {
    assert.equal((mainPath.match(new RegExp(`compose up -d --no-deps --no-build ${service}`, 'g')) || []).length, 1)
  }
  assert.match(deploy, /compose up -d --no-deps --no-build "\$service"/)
  assert.match(deploy, /wait_legacy_h_lite_quiet/)
  assert.match(deploy, /h_lite_admin drain 0/)
  assert.match(deploy, /drain_agent_core/)
  assert.match(deploy, /h_lite_admin resume 0/)
  assert.match(deploy, /pendingDeliveries===0/)
  assert.match(deploy, /agent_core_switched=0/)
  assert.match(deploy, /knowledge_connector_switched=0/)
  assert.match(deploy, /agent_core_draining=0/)
  assert.match(deploy, /agent_core_admin_available\(\)/)
  assert.match(deploy, /typeof p\.activeRequests==='number'&&typeof p\.draining==='boolean'/)
  assert.match(deploy, /if agent_core_admin_available; then\s+agent_core_draining=1\s+else\s+agent_core_draining=0/s)
  assert.match(deploy, /service_uses_image\(\)/)
  assert.match(deploy, /previous_h_lite=company-ai-foundation-h-lite:goal7-pre-\$run_id/)
  assert.match(deploy, /preserve_agent_core=1\s+preserve_recovery_h_lite=1/s)
  assert.match(deploy, /p\.serviceVersion===process\.argv\[1\]&&p\.sourceCommit===process\.argv\[2\]/)
  assert.match(deploy, /service_uses_image h-lite "\$previous_h_lite"/)
  assert.match(deploy, /service_uses_image agent-core "\$previous_agent_core"/)
  assert.match(deploy, /if \[ "\$agent_core_draining" -eq 1 \]; then\s+if resume_agent_core/s)
  assert.match(deploy, /elif ! drain_agent_core; then\s+preserve_agent_core=1\s+preserve_recovery_h_lite=1/s)
  assert.match(deploy, /service_uses_image knowledge-connector "\$previous_knowledge_connector"/)
  assert.match(deploy, /agent_core_resume_failed=1\s+preserve_recovery_h_lite=1/s)
  assert.match(deploy, /agent_core_intake_ready=1/)
  assert.match(deploy, /if \[ "\$agent_core_intake_ready" -eq 1 \]; then\s+h_lite_admin resume 0/s)
  assert.match(deploy, /recovery H-Lite remains drained and no new Feishu work is admitted/)
  assert.ok(mainPath.indexOf('h_lite_switched=1') < mainPath.indexOf('compose up -d --no-deps --no-build h-lite'))
  assert.ok(mainPath.indexOf('agent_core_switched=1') < mainPath.indexOf('compose up -d --no-deps --no-build agent-core'))
  assert.ok(mainPath.indexOf('knowledge_connector_switched=1') < mainPath.indexOf('compose up -d --no-deps --no-build knowledge-connector'))
  assert.match(deploy, /\[ "\$agent_core_switched" -eq 1 \].*restore_services/s)
  assert.match(deploy, /\[ "\$knowledge_connector_switched" -eq 1 \].*restore_services/s)
  assert.match(deploy, /preserve_recovery_h_lite.*h_lite_admin resume 0/s)
  assert.doesNotMatch(deploy, /compose (restart|down|stop)|Collector|FORMAL_P2_ENABLED=1|ERP_WRITEBACK_ENABLED=1|SOCIAL_WRITEBACK_ENABLED=1/)
  assert.match(deploy, /KNOWLEDGE_SYNC_ON_START 0/)

  assert.match(rollback, /agent-core knowledge-connector h-lite/)
  assert.match(rollback, /h_lite_admin drain 1/)
  assert.match(rollback, /pendingDeliveries===0/)
  assert.match(rollback, /agent-core\/v1\/admin\/drain|127\.0\.0\.1:8080\/v1\/admin\/drain/)
  assert.match(rollback, /wait_legacy_release_quiet/)
  assert.match(rollback, /switch_candidate_from_legacy/)
  assert.match(rollback, /wait_candidate_h_lite_recovery/)
  assert.match(rollback, /wait_agent_core_idle/)
  assert.match(rollback, /h_lite_admin drain 0/)
  for (const service of ['agent-core', 'knowledge-connector', 'h-lite']) {
    assert.match(rollback, new RegExp(`compose up -d --no-deps --no-build ${service}`))
  }
  const previousReleasePath = rollback.slice(
    rollback.indexOf('switch_release "$backup_root/.env"'),
    rollback.indexOf('"$script_root/capture-goal7-deployment-state.sh" rollback_previous'),
  )
  assert.doesNotMatch(previousReleasePath, /h_lite_admin resume/)
  const legacyRestorePath = rollback.slice(rollback.indexOf('switch_candidate_from_legacy()'))
  assert.ok(legacyRestorePath.indexOf('compose up -d --no-deps --no-build h-lite') < legacyRestorePath.indexOf('h_lite_admin drain 0'))
  assert.ok(legacyRestorePath.indexOf('h_lite_admin drain 0') < legacyRestorePath.indexOf('compose up -d --no-deps --no-build agent-core'))
  assert.ok(legacyRestorePath.indexOf('compose up -d --no-deps --no-build agent-core') < legacyRestorePath.indexOf('compose up -d --no-deps --no-build knowledge-connector'))
  assert.match(rollback, /goal7-candidate-\$run_id/)
  assert.match(rollback, /rollback_previous/)
  assert.match(rollback, /rollback_restored/)
  assert.match(rollback, /compile-goal7-rollback-drill\.mjs/)
  assert.match(rollback, /validate-goal7-rollback-drill\.mjs/)
  assert.match(rollback, /migration012_retained=true/)
  assert.doesNotMatch(rollback, /DROP TABLE|DROP SCHEMA|012-goal7-authority-runtime\.sql|compose (restart|down|stop)/)
})

test('Goal 7 Foundation 准备拒绝危险 run id 且不触碰 QNAP', () => {
  for (const runId of ['.', '..', '-unsafe', '_unsafe', 'a'.repeat(65)]) {
    const result = spawnSync('sh', [PREPARE], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GOAL7_DEPLOY_APPROVED: 'YES',
        GOAL7_RUNTIME_EVIDENCE_ROOT: '/not-used',
        GOAL7_DEPLOYMENT_EVIDENCE_ROOT: '/not-used',
        GOAL7_APPROVED_SOURCE_COMMIT: 'c'.repeat(40),
        GOAL7_APPROVED_H_LITE_SOURCE_COMMIT: 'f'.repeat(40),
        GOAL7_DEPLOY_RUN_ID: runId,
      },
    })
    assert.equal(result.status, 2, runId)
    assert.match(result.stderr, /run id is (unsafe|too long)/, runId)
    assert.doesNotMatch(result.stderr, /QNAP|docker|runtime evidence/i, runId)
  }
})

test('Goal 7 Foundation 准备锁拒绝并发且不调用 Docker', async () => {
  const fixture = await createPrepareSandbox({ precreateLock: true })
  const result = spawnSync('sh', [path.join(fixture.scripts, 'prepare-goal7-foundation.sh')], {
    encoding: 'utf8',
    env: prepareEnv(fixture),
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /preparation is already in progress/)
  await assert.rejects(fs.lstat(fixture.dockerLog), { code: 'ENOENT' })
})

test('Goal 7 Foundation 回放校验失败保留既有证据并释放锁', async () => {
  const fixture = await createPrepareSandbox({ existingEvidence: true })
  const evidenceFile = path.join(fixture.evidenceRoot, 'preparation-evidence.json')
  const baselineFile = path.join(fixture.evidenceRoot, 'preparation-baseline-state.json')
  const evidenceBefore = await fs.readFile(evidenceFile)
  const baselineBefore = await fs.readFile(baselineFile)
  const result = spawnSync('sh', [path.join(fixture.scripts, 'prepare-goal7-foundation.sh')], {
    encoding: 'utf8',
    env: prepareEnv(fixture),
  })
  assert.equal(result.status, 7)
  assert.deepEqual(await fs.readFile(evidenceFile), evidenceBefore)
  assert.deepEqual(await fs.readFile(baselineFile), baselineBefore)
  await assert.rejects(fs.lstat(path.join(fixture.shadowRoot, '.goal7-foundation-preparation.lock')), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(fixture.dockerLog), { code: 'ENOENT' })
})

test('Goal 7 Foundation 成功回放完成后释放锁', async () => {
  const fixture = await createPrepareSandbox({ existingEvidence: true, existingEvidenceValid: true })
  const result = spawnSync('sh', [path.join(fixture.scripts, 'prepare-goal7-foundation.sh')], {
    encoding: 'utf8',
    env: prepareEnv(fixture),
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /preparation_replay=accepted/)
  await assert.rejects(fs.lstat(path.join(fixture.shadowRoot, '.goal7-foundation-preparation.lock')), { code: 'ENOENT' })
  assert.equal((await fs.readFile(fixture.dockerLog, 'utf8')).trim().split('\n').length, 6)
})

test('Goal 7 Foundation 新准备成功完成后释放锁', async () => {
  const fixture = await createPrepareSandbox({ freshPreparationSuccess: true })
  const result = spawnSync('sh', [path.join(fixture.scripts, 'prepare-goal7-foundation.sh')], {
    encoding: 'utf8',
    env: prepareEnv(fixture),
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /goal7_preparation=completed/)
  assert.match(result.stdout, /services_recreated=0/)
  assert.match(result.stdout, /migration012_applied=0/)
  await assert.rejects(fs.lstat(path.join(fixture.shadowRoot, '.goal7-foundation-preparation.lock')), { code: 'ENOENT' })
  assert.equal((await fs.lstat(path.join(fixture.evidenceRoot, 'preparation-evidence.json'))).isFile(), true)
  assert.equal((await fs.lstat(path.join(fixture.backupBase, fixture.runId, 'images/tags.txt'))).isFile(), true)
})

test('Goal 7 迁移对账锁拒绝并发且不运行验证器', async () => {
  const fixture = await createMigrationSandbox({ precreateLock: true })
  const result = spawnSync('sh', [path.join(fixture.scripts, 'reconcile-goal7-migration-012.sh')], {
    encoding: 'utf8',
    env: migrationEnv(fixture),
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /reconciliation is already in progress/)
  await assert.rejects(fs.lstat(fixture.nodeLog), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(fixture.liveLog), { code: 'ENOENT' })
})

test('Goal 7 迁移对账成功回放后释放锁', async () => {
  const fixture = await createMigrationSandbox({ existingEvidence: true })
  const result = spawnSync('sh', [path.join(fixture.scripts, 'reconcile-goal7-migration-012.sh')], {
    encoding: 'utf8',
    env: migrationEnv(fixture),
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /migration_reconciliation_replay=accepted/)
  assert.match(result.stdout, /database_sql_executed=0/)
  await assert.rejects(fs.lstat(path.join(fixture.shadowRoot, '.goal7-migration-012-reconciliation.lock')), { code: 'ENOENT' })
})

test('Goal 7 迁移对账失败回放保留既有证据并释放锁', async () => {
  const fixture = await createMigrationSandbox({ existingEvidence: true, failFinalValidation: true })
  const evidenceFile = path.join(fixture.evidenceRoot, 'migration-012-evidence.json')
  const evidenceBefore = await fs.readFile(evidenceFile)
  const result = spawnSync('sh', [path.join(fixture.scripts, 'reconcile-goal7-migration-012.sh')], {
    encoding: 'utf8',
    env: migrationEnv(fixture),
  })
  assert.equal(result.status, 7)
  assert.deepEqual(await fs.readFile(evidenceFile), evidenceBefore)
  await assert.rejects(fs.lstat(path.join(fixture.shadowRoot, '.goal7-migration-012-reconciliation.lock')), { code: 'ENOENT' })
})

test('Goal 7 迁移新对账成功后释放锁并保持 SQL 为零', async () => {
  const fixture = await createMigrationSandbox()
  const result = spawnSync('sh', [path.join(fixture.scripts, 'reconcile-goal7-migration-012.sh')], {
    encoding: 'utf8',
    env: migrationEnv(fixture),
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /goal7_migration012=pre_existing_reconciled/)
  assert.match(result.stdout, /database_sql_executed=0/)
  assert.equal((await fs.lstat(path.join(fixture.evidenceRoot, 'migration-012-evidence.json'))).isFile(), true)
  await assert.rejects(fs.lstat(path.join(fixture.shadowRoot, '.goal7-migration-012-reconciliation.lock')), { code: 'ENOENT' })
})

test('Goal 7 迁移新对账最终验证失败时清理新证据并释放锁', async () => {
  const fixture = await createMigrationSandbox({ failFinalValidation: true })
  const result = spawnSync('sh', [path.join(fixture.scripts, 'reconcile-goal7-migration-012.sh')], {
    encoding: 'utf8',
    env: migrationEnv(fixture),
  })
  assert.equal(result.status, 7)
  await assert.rejects(fs.lstat(path.join(fixture.evidenceRoot, 'migration-012-evidence.json')), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(path.join(fixture.shadowRoot, '.goal7-migration-012-reconciliation.lock')), { code: 'ENOENT' })
})

test('Goal 7 Ontology 候选 Foundation 镜像固定 Node 基础镜像 digest', async () => {
  const digest = /node:22\.19\.0-bookworm-slim@sha256:[a-f0-9]{64}/
  const ontologyDockerfiles = [
    path.resolve(ROOT, '../../../services/agent-core/Dockerfile'),
    path.resolve(ROOT, '../../../services/knowledge-connector/Dockerfile'),
  ]
  for (const dockerfile of ontologyDockerfiles) assert.match(await fs.readFile(dockerfile, 'utf8'), digest)
})
