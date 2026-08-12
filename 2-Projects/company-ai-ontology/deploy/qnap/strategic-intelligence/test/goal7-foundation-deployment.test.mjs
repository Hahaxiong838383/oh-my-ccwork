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
const MIGRATE = path.join(ROOT, 'scripts/apply-goal7-migration-012.sh')
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
  const releaseManifest = {
    manifestVersion: '1.3.0',
    releaseType: 'P1-SI-F-shadow-candidate-gated',
    sourceCommit,
    hLiteSourceCommit,
    sourceArchiveSha256: sha256(bytes['source.tar.gz']),
    hLiteSourceArchiveSha256: sha256(bytes['h-lite-source.tar.gz']),
    collectorImageArchiveSha256: sha256(bytes['collector-image.tar.gz']),
    runtimeComponentVersionsSha256: sha256(bytes['runtime-component-versions.json']),
    agentCoreVersion: componentVersions.agentCoreVersion,
    knowledgeConnectorVersion: componentVersions.knowledgeConnectorVersion,
    hLiteVersion: componentVersions.hLiteVersion,
    publish: false,
    productionDeploymentAuthorized: false,
    requiredGate: 'WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH',
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
  assert.equal(verified.checksumEntryCount, 8)

  await assert.rejects(
    validateGoal7RuntimeRelease(root, { ...fixture, sourceCommit: 'a'.repeat(40) }),
    /approved Ontology sourceCommit drift/,
  )
  await assert.rejects(
    validateGoal7RuntimeRelease(root, { ...fixture, hLiteSourceCommit: 'b'.repeat(40) }),
    /approved H-Lite sourceCommit drift/,
  )
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
  assert.match(prepare, /goal7-candidate-\$run_id/)
  assert.match(prepare, /verify_image_readable company-ai-foundation-agent-core:goal7-candidate-\$run_id \/app\/src\/server\.mjs/)
  assert.match(prepare, /verify_image_readable company-ai-foundation-knowledge-connector:goal7-candidate-\$run_id \/app\/src\/server\.mjs/)
  assert.match(prepare, /verify_image_readable company-ai-foundation-h-lite:goal7-candidate-\$run_id \/app\/company-qnap-lite\.mjs/)
  assert.match(migrate, /012-goal7-authority-runtime\.sql/)
  assert.match(migrate, /migration-012-evidence\.json/)
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
  assert.match(rollback, /compose up -d --no-deps --no-build "\$service"/)
  assert.match(rollback, /migration012_retained=true/)
  assert.doesNotMatch(rollback, /DROP TABLE|DROP SCHEMA|012-goal7-authority-runtime\.sql|compose (restart|down|stop)/)
})
