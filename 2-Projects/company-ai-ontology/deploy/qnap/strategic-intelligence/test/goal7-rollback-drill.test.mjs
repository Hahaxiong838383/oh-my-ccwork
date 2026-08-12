import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createGoal7AcceptanceBundle } from './fixtures/readiness-fixtures.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPILER = path.join(ROOT, 'scripts/compile-goal7-rollback-drill.mjs')
const VALIDATOR = path.join(ROOT, 'scripts/validate-goal7-rollback-drill.mjs')

test('Goal 7 rollback drill proves previous release and restores the approved candidate', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-rollback-drill-'))
  const { bundleRoot } = await createGoal7AcceptanceBundle(outputRoot)
  const evidenceFile = path.join(bundleRoot, 'rollback-drill-evidence.json')
  await fs.rm(evidenceFile)
  const compiled = spawnSync(process.execPath, [COMPILER, bundleRoot, evidenceFile], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  assert.equal(JSON.parse(compiled.stdout).rawEvidenceFileCount, 6)
  const validated = spawnSync(process.execPath, [VALIDATOR, evidenceFile], { encoding: 'utf8' })
  assert.equal(validated.status, 0, validated.stderr)
  const evidence = JSON.parse(await fs.readFile(evidenceFile, 'utf8'))
  assert.equal(evidence.previousReleaseVerified, true)
  assert.equal(evidence.candidateReleaseRestored, true)
  assert.equal(evidence.migration012Retained, true)
  assert.equal(evidence.foundationRestartCountTotal, 0)
})

test('Goal 7 rollback drill fails closed when the candidate is not restored', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-rollback-not-restored-'))
  const { bundleRoot } = await createGoal7AcceptanceBundle(outputRoot)
  const previous = JSON.parse(await fs.readFile(path.join(bundleRoot, 'rollback-previous-state.json'), 'utf8'))
  await fs.writeFile(path.join(bundleRoot, 'rollback-restored-state.json'), JSON.stringify({
    ...previous, phase: 'rollback_restored', capturedAt: '2026-08-11T09:35:00Z',
  }))
  const result = spawnSync(process.execPath, [COMPILER, bundleRoot], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /candidate mismatch|sourceCommit mismatch/)
})

test('Goal 7 rollback drill fails closed on migration loss, restart or business side effect', async (context) => {
  for (const [label, mutate, expected] of [
    ['migration', (value) => ({ ...value, candidateMigration012Applied: false }), /migration 012 was not retained/],
    ['restart', (value) => ({ ...value, foundation: { ...value.foundation, restartCountTotal: 1 } }), /restart count must remain zero/],
  ]) {
    await context.test(label, async () => {
      const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), `goal7-rollback-${label}-`))
      const { bundleRoot } = await createGoal7AcceptanceBundle(outputRoot)
      const restoredFile = path.join(bundleRoot, 'rollback-restored-state.json')
      const restored = JSON.parse(await fs.readFile(restoredFile, 'utf8'))
      await fs.writeFile(restoredFile, JSON.stringify(mutate(restored)))
      const result = spawnSync(process.execPath, [COMPILER, bundleRoot], { encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, expected)
    })
  }

  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-rollback-side-effect-'))
  const { bundleRoot } = await createGoal7AcceptanceBundle(outputRoot)
  const auditFile = path.join(bundleRoot, 'rollback-side-effects.json')
  const audit = JSON.parse(await fs.readFile(auditFile, 'utf8'))
  await fs.writeFile(auditFile, JSON.stringify({ ...audit, employeeDeliveryCount: 1 }))
  const result = spawnSync(process.execPath, [COMPILER, bundleRoot], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /employeeDeliveryCount must be zero/)
})
