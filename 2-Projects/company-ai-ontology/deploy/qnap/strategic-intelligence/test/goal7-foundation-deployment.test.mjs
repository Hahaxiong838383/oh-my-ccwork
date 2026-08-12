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
const ROLLBACK = path.join(ROOT, 'scripts/rollback-goal7-foundation.sh')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function writeRuntimeRelease(root) {
  const sourceCommit = 'c'.repeat(40)
  const hLiteSourceCommit = 'f'.repeat(40)
  const bytes = {
    'postgres-validation.txt': Buffer.from('postgres verified\n'),
    'goal7-foundation-validation.txt': Buffer.from('foundation verified\n'),
    'source.tar.gz': Buffer.from('ontology source'),
    'h-lite-source.tar.gz': Buffer.from('h-lite source'),
    'collector-image.tar.gz': Buffer.from('collector image'),
  }
  const releaseManifest = {
    manifestVersion: '1.2.0',
    releaseType: 'P1-SI-F-shadow-candidate-gated',
    sourceCommit,
    sourceArchiveSha256: sha256(bytes['source.tar.gz']),
    collectorImageArchiveSha256: sha256(bytes['collector-image.tar.gz']),
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
    sourceArchiveSha256: sha256(bytes['source.tar.gz']),
    hLiteSourceArchiveSha256: sha256(bytes['h-lite-source.tar.gz']),
    collectorImageArchiveSha256: sha256(bytes['collector-image.tar.gz']),
    releaseManifestSha256: sha256(bytes['release-manifest.json']),
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
  return { sourceCommit, hLiteSourceCommit, verification }
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
  assert.match(deploy.stderr, /explicit GOAL7_DEPLOY_APPROVED=YES/)
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
  assert.equal(verified.checksumEntryCount, 7)

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
  const verificationFile = path.join(root, 'runtime-verification.json')
  await fs.writeFile(verificationFile, JSON.stringify({ ...fixture.verification, sourceCommit: 'invalid' }))
  await rewriteChecksums(root)
  await assert.rejects(validateGoal7RuntimeRelease(root, fixture), /sourceCommit invalid/)
})

test('Goal 7 Foundation 脚本只切换三个服务并保留可回滚链', async () => {
  const deploy = await fs.readFile(DEPLOY, 'utf8')
  const rollback = await fs.readFile(ROLLBACK, 'utf8')
  for (const marker of [
    'GOAL7_APPROVED_SOURCE_COMMIT',
    'GOAL7_APPROVED_H_LITE_SOURCE_COMMIT',
    'validate-goal7-runtime-release.mjs',
    'capture-goal7-deployment-state.sh" before',
    'capture-goal7-deployment-state.sh" after',
    'capture-shadow-side-effects.sh',
    'compile-goal7-deployment-evidence.mjs',
    'goal7-pre-$run_id',
    'rollback_on_error',
    'migration012_retained_on_rollback=true',
  ]) assert.ok(deploy.includes(marker), `deployment marker missing: ${marker}`)

  assert.match(deploy, /compose build agent-core knowledge-connector h-lite/)
  assert.equal((deploy.match(/compose up -d (agent-core|knowledge-connector|h-lite)/g) || []).length, 3)
  assert.doesNotMatch(deploy, /compose (restart|down|stop)|Collector|FORMAL_P2_ENABLED=1|ERP_WRITEBACK_ENABLED=1|SOCIAL_WRITEBACK_ENABLED=1/)
  assert.match(deploy, /KNOWLEDGE_SYNC_ON_START 0/)

  assert.match(rollback, /agent-core knowledge-connector h-lite/)
  assert.match(rollback, /migration012_retained=true/)
  assert.doesNotMatch(rollback, /DROP TABLE|DROP SCHEMA|012-goal7-authority-runtime\.sql|compose (restart|down|stop)/)
})
