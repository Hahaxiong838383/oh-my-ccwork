import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createGoal7AcceptanceBundle } from './fixtures/readiness-fixtures.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPILER = path.join(ROOT, 'scripts/compile-goal7-deployment-evidence.mjs')
const ACCEPTANCE_VALIDATOR = path.join(ROOT, 'scripts/validate-goal7-acceptance.mjs')
const CAPTURE_SCRIPT = path.resolve(ROOT, 'scripts/capture-goal7-deployment-state.sh')

test('Goal 7 部署证据由前后机器状态与零副作用窗口编译', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-deployment-evidence-'))
  const { bundleRoot } = await createGoal7AcceptanceBundle(outputRoot)
  const deployment = JSON.parse(await fs.readFile(path.join(bundleRoot, 'deployment-evidence.json'), 'utf8'))
  assert.equal(deployment.sourceCommit, 'c'.repeat(40))
  assert.equal(deployment.hLiteSourceCommit, 'f'.repeat(40))
  assert.equal(deployment.newHostPortCount, 0)
  assert.deepEqual(Object.keys(deployment.rawEvidenceFiles).sort(), ['after', 'before', 'migration', 'preparation', 'runtimeIdentity', 'sideEffects'])
  const compiled = spawnSync(process.execPath, [COMPILER, bundleRoot, path.join(bundleRoot, 'deployment-evidence-recompiled.json')], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  assert.equal(JSON.parse(compiled.stdout).rawEvidenceFileCount, 6)
})

test('Goal 7 部署原始状态被替换或新增端口时 Acceptance 失败关闭', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-deployment-tamper-'))
  const { bundleRoot, goal7File } = await createGoal7AcceptanceBundle(outputRoot)
  const stateFile = path.join(bundleRoot, 'post-deployment-state.json')
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'))
  state.foundation.publishedPortCount += 1
  await fs.writeFile(stateFile, JSON.stringify(state))
  const result = spawnSync(process.execPath, [ACCEPTANCE_VALIDATOR, goal7File], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /opened new host ports|compiler-derived/)
})

test('Goal 7 部署证据拒绝 Runtime 组件版本漂移', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-deployment-version-drift-'))
  const { bundleRoot, goal7File } = await createGoal7AcceptanceBundle(outputRoot)
  const identityFile = path.join(bundleRoot, 'runtime-component-versions.json')
  const identity = JSON.parse(await fs.readFile(identityFile, 'utf8'))
  await fs.writeFile(identityFile, JSON.stringify({ ...identity, agentCoreVersion: '2026-08-11.1' }))
  const result = spawnSync(process.execPath, [ACCEPTANCE_VALIDATOR, goal7File], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Goal 7 preparation Agent Core version drift|Agent Core deployment state invalid|compiler-derived/)
})

test('Goal 7 部署状态采集只读且强制公司 QNAP 与隔离 Node Runtime', async () => {
  const source = await fs.readFile(CAPTURE_SCRIPT, 'utf8')
  assert.match(source, /preflight-company-qnap\.sh/)
  assert.match(source, /NODE_BIN/)
  assert.match(source, /agent-core.*readyz/s)
  assert.match(source, /knowledge-connector.*readyz/s)
  assert.match(source, /h-lite.*healthz/s)
  assert.match(source, /ontology-registry.*readyz/s)
  assert.match(source, /candidateMigration012Applied:.*trim\(\)===\"true\"/)
  assert.doesNotMatch(source, /compose\s+(up|down|restart|stop)|migrate\.sh|Collector/)
})
