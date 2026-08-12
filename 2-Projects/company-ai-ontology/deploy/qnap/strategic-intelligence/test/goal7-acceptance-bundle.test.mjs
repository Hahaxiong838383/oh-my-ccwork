import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createGoal7AcceptanceBundle } from './fixtures/readiness-fixtures.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPILER = path.join(ROOT, 'scripts/compile-goal7-acceptance.mjs')
const VALIDATOR = path.join(ROOT, 'scripts/validate-goal7-acceptance.mjs')

test('Goal 7 acceptance is compiler-derived from six bound evidence files', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-acceptance-bundle-'))
  const { bundleRoot, goal7File } = await createGoal7AcceptanceBundle(outputRoot)
  await fs.rm(goal7File)
  const compiled = spawnSync(process.execPath, [COMPILER, bundleRoot, goal7File], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  assert.equal(JSON.parse(compiled.stdout).evidenceFileCount, 6)

  const validated = spawnSync(process.execPath, [VALIDATOR, goal7File], { encoding: 'utf8' })
  assert.equal(validated.status, 0, validated.stderr)
  const output = JSON.parse(validated.stdout)
  assert.equal(output.ownerAccepted, true)
  assert.equal(output.hLiteSourceCommit, 'f'.repeat(40))
  assert.equal(output.routeBEnabled, false)
  assert.equal(output.evidenceFileCount, 6)
  assert.doesNotMatch(validated.stdout, /prompt|reply|displayName|principalRef/)
})

test('Goal 7 acceptance fails closed on raw evidence tampering, source drift, or early owner acceptance', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-acceptance-tamper-'))
  const { bundleRoot, goal7File } = await createGoal7AcceptanceBundle(outputRoot)
  const workerFile = path.join(bundleRoot, 'worker-readback.json')
  const worker = JSON.parse(await fs.readFile(workerFile, 'utf8'))
  await fs.writeFile(workerFile, JSON.stringify({ ...worker, model: 'unexpected-model' }))
  const tampered = spawnSync(process.execPath, [VALIDATOR, goal7File], { encoding: 'utf8' })
  assert.notEqual(tampered.status, 0)
  assert.match(tampered.stderr, /compiler-derived/)

  await createGoal7AcceptanceBundle(outputRoot)
  const authorityFile = path.join(bundleRoot, 'authority-canary.json')
  const authority = JSON.parse(await fs.readFile(authorityFile, 'utf8'))
  await fs.writeFile(authorityFile, JSON.stringify({ ...authority, sourceCommit: 'f'.repeat(40) }))
  const drift = spawnSync(process.execPath, [VALIDATOR, goal7File], { encoding: 'utf8' })
  assert.notEqual(drift.status, 0)
  assert.match(drift.stderr, /sourceCommit drift/)

  await createGoal7AcceptanceBundle(outputRoot)
  const hLiteAuthorityFile = path.join(bundleRoot, 'authority-canary.json')
  const hLiteAuthority = JSON.parse(await fs.readFile(hLiteAuthorityFile, 'utf8'))
  await fs.writeFile(hLiteAuthorityFile, JSON.stringify({ ...hLiteAuthority, hLiteSourceCommit: '8'.repeat(40) }))
  const hLiteDrift = spawnSync(process.execPath, [VALIDATOR, goal7File], { encoding: 'utf8' })
  assert.notEqual(hLiteDrift.status, 0)
  assert.match(hLiteDrift.stderr, /H-Lite sourceCommit drift/)

  await createGoal7AcceptanceBundle(outputRoot)
  const ownerFile = path.join(bundleRoot, 'owner-acceptance.json')
  const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'))
  await fs.writeFile(ownerFile, JSON.stringify({ ...owner, acceptedAt: '2026-08-11T08:00:00Z' }))
  const earlyOwner = spawnSync(process.execPath, [COMPILER, bundleRoot, goal7File], { encoding: 'utf8' })
  assert.notEqual(earlyOwner.status, 0)
  assert.match(earlyOwner.stderr, /predates engineering evidence/)
})
