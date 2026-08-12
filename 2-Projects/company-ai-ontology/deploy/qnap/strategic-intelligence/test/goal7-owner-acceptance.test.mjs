import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createGoal7AcceptanceBundle } from './fixtures/readiness-fixtures.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RECORDER = path.join(ROOT, 'scripts/record-goal7-owner-acceptance.mjs')
const ACCEPTANCE_COMPILER = path.join(ROOT, 'scripts/compile-goal7-acceptance.mjs')
const ACCEPTANCE_VALIDATOR = path.join(ROOT, 'scripts/validate-goal7-acceptance.mjs')

async function engineeringBundle() {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-owner-acceptance-'))
  const { bundleRoot, goal7File } = await createGoal7AcceptanceBundle(outputRoot)
  await fs.rm(path.join(bundleRoot, 'owner-acceptance.json'))
  await fs.rm(goal7File)
  return { bundleRoot, goal7File }
}

test('Goal 7 owner acceptance refuses before reading engineering evidence without explicit approval', async () => {
  const result = spawnSync(process.execPath, [RECORDER, '/path/that/must/not/be/read'], {
    encoding: 'utf8',
    env: {},
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /GOAL7_OWNER_ACCEPTANCE_APPROVED=YES/)
  assert.doesNotMatch(result.stderr, /ENOENT|must not be read/)
})

test('Goal 7 owner acceptance binds five validated engineering files and stores only principal hash', async () => {
  const { bundleRoot, goal7File } = await engineeringBundle()
  const ownerFile = path.join(bundleRoot, 'owner-acceptance.json')
  const principalRef = 'company-directory:goal7-owner'
  const recorded = spawnSync(process.execPath, [RECORDER, bundleRoot, ownerFile], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GOAL7_OWNER_ACCEPTANCE_APPROVED: 'YES',
      GOAL7_OWNER_PRINCIPAL_REF: principalRef,
      GOAL7_OWNER_ACCEPTANCE_REF: 'feishu:doc/goal7-owner-acceptance',
    },
  })
  assert.equal(recorded.status, 0, recorded.stderr)
  assert.equal(JSON.parse(recorded.stdout).engineeringEvidenceFileCount, 5)
  assert.doesNotMatch(recorded.stdout, /company-directory|goal7-owner/)

  const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'))
  assert.equal(owner.evidenceVersion, '3.0.0')
  assert.equal(owner.accepted, true)
  assert.match(owner.ownerPrincipalHash, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(owner), new RegExp(principalRef))
  assert.deepEqual(Object.keys(owner.engineeringEvidenceFiles).sort(), ['authorityCanary', 'deployment', 'rollbackDrill', 'runtimeVerification', 'workerReadback'])

  const compiled = spawnSync(process.execPath, [ACCEPTANCE_COMPILER, bundleRoot, goal7File], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  const validated = spawnSync(process.execPath, [ACCEPTANCE_VALIDATOR, goal7File], { encoding: 'utf8' })
  assert.equal(validated.status, 0, validated.stderr)
})

test('Goal 7 owner acceptance rejects missing owner identity or acceptance reference', async (context) => {
  for (const [label, env, expected] of [
    ['owner', { GOAL7_OWNER_ACCEPTANCE_REF: 'feishu:doc/goal7-owner-acceptance' }, /owner principal reference is required/],
    ['reference', { GOAL7_OWNER_PRINCIPAL_REF: 'company-directory:goal7-owner' }, /acceptanceRef invalid/],
  ]) {
    await context.test(label, async () => {
      const { bundleRoot } = await engineeringBundle()
      const result = spawnSync(process.execPath, [RECORDER, bundleRoot], {
        encoding: 'utf8',
        env: { ...process.env, GOAL7_OWNER_ACCEPTANCE_APPROVED: 'YES', ...env },
      })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, expected)
    })
  }
})

test('Goal 7 acceptance fails when engineering evidence changes after owner acceptance', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-owner-stale-'))
  const { bundleRoot, goal7File } = await createGoal7AcceptanceBundle(outputRoot)
  const deploymentFile = path.join(bundleRoot, 'deployment-evidence.json')
  const deployment = JSON.parse(await fs.readFile(deploymentFile, 'utf8'))
  await fs.writeFile(deploymentFile, JSON.stringify({ ...deployment, capturedAt: '2026-08-11T09:21:00Z' }))
  const result = spawnSync(process.execPath, [ACCEPTANCE_COMPILER, bundleRoot, goal7File], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /not compiler-derived|engineering hash drift/)
})
