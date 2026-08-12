import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createGoal7AcceptanceBundle } from './fixtures/readiness-fixtures.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPILER = path.join(ROOT, 'scripts/compile-goal7-worker-readback.mjs')
const VALIDATOR = path.join(ROOT, 'scripts/validate-goal7-worker-readback.mjs')

async function bundle() {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-worker-readback-'))
  return createGoal7AcceptanceBundle(outputRoot)
}

async function rewrite(file, transform) {
  const value = JSON.parse(await fs.readFile(file, 'utf8'))
  await fs.writeFile(file, JSON.stringify(transform(value)))
}

test('Goal 7 worker readback compiles only from matching HTTP and Postgres ledger evidence', async () => {
  const { bundleRoot } = await bundle()
  const evidenceFile = path.join(bundleRoot, 'worker-readback.json')
  await fs.rm(evidenceFile)
  const compiled = spawnSync(process.execPath, [COMPILER, bundleRoot, evidenceFile], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  const summary = JSON.parse(compiled.stdout)
  assert.equal(summary.rawEvidenceFileCount, 2)
  assert.equal(summary.model, 'grok-4.5')

  const validated = spawnSync(process.execPath, [VALIDATOR, evidenceFile], { encoding: 'utf8' })
  assert.equal(validated.status, 0, validated.stderr)
  const evidence = JSON.parse(await fs.readFile(evidenceFile, 'utf8'))
  assert.equal(evidence.evidenceVersion, '2.0.0')
  assert.equal(evidence.governance.ledgerRecorded, true)
  assert.equal(evidence.governance.routeBEnabled, false)
  assert.deepEqual(Object.keys(evidence.rawEvidenceFiles).sort(), ['http', 'ledger'])
  assert.doesNotMatch(JSON.stringify(evidence), /"requestId"|"prompt"|"reply"|"employeeMessage"/)
})

test('Goal 7 worker readback accepts ledger capture immediately before HTTP response capture', async () => {
  const { bundleRoot } = await bundle()
  const httpFile = path.join(bundleRoot, 'worker-http-response.json')
  const ledgerFile = path.join(bundleRoot, 'worker-ledger-row.json')
  const http = JSON.parse(await fs.readFile(httpFile, 'utf8'))
  await rewrite(ledgerFile, (value) => ({
    ...value,
    capturedAt: new Date(Date.parse(http.capturedAt) - 999).toISOString(),
  }))
  const compiled = spawnSync(process.execPath, [COMPILER, bundleRoot], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
})

test('Goal 7 worker readback fails closed on missing or duplicate ledger evidence', async () => {
  const missing = await bundle()
  await fs.rm(path.join(missing.bundleRoot, 'worker-ledger-row.json'))
  const missingResult = spawnSync(process.execPath, [COMPILER, missing.bundleRoot], { encoding: 'utf8' })
  assert.notEqual(missingResult.status, 0)
  assert.match(missingResult.stderr, /raw file missing/)

  const duplicate = await bundle()
  const ledgerFile = path.join(duplicate.bundleRoot, 'worker-ledger-row.json')
  await rewrite(ledgerFile, (value) => ({ ...value, rowCount: 2 }))
  const duplicateResult = spawnSync(process.execPath, [COMPILER, duplicate.bundleRoot], { encoding: 'utf8' })
  assert.notEqual(duplicateResult.status, 0)
  assert.match(duplicateResult.stderr, /exactly one usage row/)
})

test('Goal 7 worker readback fails closed on provider, model, usage, credential, or route drift', async (context) => {
  const cases = [
    ['provider', (value) => ({ ...value, provider: 'unexpected-provider' }), /provider drift/],
    ['model', (value) => ({ ...value, model: 'unexpected-model' }), /model drift/],
    ['usage', (value) => ({ ...value, usage: { ...value.usage, completionTokens: 21, totalTokens: 121 } }), /usage drift/],
    ['credential', (value) => ({ ...value, credentialModeTag: 'unexpected-credential' }), /credential mode drift/],
    ['route-b', (value) => ({ ...value, routeKey: 'route-b' }), /must use Route A/],
  ]
  for (const [label, transform, expected] of cases) {
    await context.test(label, async () => {
      const { bundleRoot } = await bundle()
      await rewrite(path.join(bundleRoot, 'worker-ledger-row.json'), transform)
      const result = spawnSync(process.execPath, [COMPILER, bundleRoot], { encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, expected)
    })
  }
})

test('Goal 7 worker readback rejects sensitive fields and final evidence tampering', async () => {
  const sensitive = await bundle()
  const httpFile = path.join(sensitive.bundleRoot, 'worker-http-response.json')
  await rewrite(httpFile, (value) => ({ ...value, prompt: 'must-not-persist' }))
  const sensitiveResult = spawnSync(process.execPath, [COMPILER, sensitive.bundleRoot], { encoding: 'utf8' })
  assert.notEqual(sensitiveResult.status, 0)
  assert.match(sensitiveResult.stderr, /fields mismatch|forbidden sensitive field/)

  const tampered = await bundle()
  const finalFile = path.join(tampered.bundleRoot, 'worker-readback.json')
  await rewrite(finalFile, (value) => ({ ...value, model: 'tampered-model' }))
  const tamperedResult = spawnSync(process.execPath, [VALIDATOR, finalFile], { encoding: 'utf8' })
  assert.notEqual(tamperedResult.status, 0)
  assert.match(tamperedResult.stderr, /not compiler-derived/)
})

test('Goal 7 worker readback runner is separately authorized and preserves only sanitized evidence', async () => {
  const runner = await fs.readFile(path.resolve(ROOT, '..', 'scripts/run-goal7-worker-readback.sh'), 'utf8')
  assert.ok(runner.indexOf('GOAL7_WORKER_READBACK_APPROVED') < runner.indexOf('goal7-worker-readback-seed.sql'))
  assert.ok(runner.indexOf('GOAL7_WORKER_READBACK_APPROVED') < runner.indexOf('preflight-company-qnap.sh'))
  assert.match(runner, /h-lite node --input-type=module/)
  assert.match(runner, /createCompanyAgentCoreAdapter/)
  assert.match(runner, /control_root=\$\{GOAL7_CONTROL_ROOT:-\$project_root\}/)
  assert.match(runner, /\$control_root\/deploy\/qnap\/canary\/goal7-worker-readback-seed[.]sql/)
  assert.match(runner, /goal7-worker-readback-ledger[.]sql/)
  assert.match(runner, /request_id_hash/)
  assert.match(runner, /sensitivePayloadPersisted: false/)
  assert.doesNotMatch(runner, /process[.]stdout[.]write\([^\n]*(payload[.]reply|body)/)
})
