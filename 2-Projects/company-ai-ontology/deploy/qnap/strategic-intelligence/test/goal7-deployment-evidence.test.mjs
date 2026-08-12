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

async function writeExecutable(file, body) {
  await fs.writeFile(file, body)
  await fs.chmod(file, 0o700)
}

async function createCaptureSandbox() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-capture-state-'))
  const scripts = path.join(sandbox, 'scripts')
  const shadowRoot = path.join(sandbox, 'shadow')
  const foundationRoot = path.join(sandbox, 'foundation')
  const dockerLog = path.join(sandbox, 'docker.log')
  await fs.mkdir(scripts, { recursive: true })
  await fs.mkdir(shadowRoot, { recursive: true })
  await fs.mkdir(foundationRoot, { recursive: true })
  await fs.writeFile(path.join(foundationRoot, '.env'), '')
  await fs.copyFile(CAPTURE_SCRIPT, path.join(scripts, 'capture-goal7-deployment-state.sh'))
  await fs.chmod(path.join(scripts, 'capture-goal7-deployment-state.sh'), 0o700)
  await fs.writeFile(path.join(scripts, 'preflight-company-qnap.sh'), [
    `shadow_root=${JSON.stringify(shadowRoot)}`,
    `foundation_root=${JSON.stringify(foundationRoot)}`,
    `docker_path=${JSON.stringify(path.join(scripts, 'docker'))}`,
    '',
  ].join('\n'))
  await writeExecutable(path.join(scripts, 'docker'), `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(dockerLog)}
case "$*" in
  "compose exec -T agent-core node -e "*) printf '%s\n' '{"ok":true,"productionReady":true,"contractVersion":"2026-08-12.3","sourceCommit":"cccccccccccccccccccccccccccccccccccccccc","runtime":{"governance":{"routeA":{"enabled":true,"circuitState":"closed"},"routeB":{"enabled":false}}}}' ;;
  "compose exec -T knowledge-connector node -e "*) printf '%s\n' '{"ok":true,"version":"2026-08-11.1","sourceCommit":"cccccccccccccccccccccccccccccccccccccccc","database":{"ready":true}}' ;;
  "compose exec -T h-lite node -e "*) printf '%s\n' '{"health":{"serviceVersion":"2026-08-12.1","sourceCommit":"ffffffffffffffffffffffffffffffffffffffff","mode":"active","subscriptionEnabled":true},"ready":{"ok":true}}' ;;
  "compose exec -T ontology-registry node -e "*) printf '%s\n' '{"status":"in_sync","active":{"schemaVersion":"3.3.0"}}' ;;
  "compose exec -T postgres psql "*) printf '%s\n' 'true' ;;
  "ps -q --filter label=com.docker.compose.project=company-ai-foundation") printf '%s\n' 'container-1' ;;
  "inspect --format "*) printf '%s\n' '/agent-core|company-ai-foundation-agent-core:current|running|healthy|0|{}' ;;
  *) exit 91 ;;
esac
`)
  return { scripts, shadowRoot, dockerLog }
}

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
  assert.match(source, /if \[ "\$phase" = preparation \]; then\s+printf 'false\\n' > "\$migration_file"/s)
  assert.match(source, /else\s+"\$docker_path" compose exec -T postgres psql/s)
  assert.match(source, /candidateMigration012Applied:.*trim\(\)===\"true\"/)
  assert.doesNotMatch(source, /compose\s+(up|down|restart|stop)|migrate\.sh|Collector/)
})

test('Goal 7 A 阶段状态采集零 SQL，后续阶段保留迁移只读检查', async () => {
  const fixture = await createCaptureSandbox()
  const script = path.join(fixture.scripts, 'capture-goal7-deployment-state.sh')
  const preparationOutput = path.join(fixture.shadowRoot, 'preparation.json')
  const preparation = spawnSync('sh', [script, 'preparation', preparationOutput], {
    encoding: 'utf8',
    env: { ...process.env, NODE_BIN: process.execPath },
  })
  assert.equal(preparation.status, 0, preparation.stderr)
  assert.equal(JSON.parse(await fs.readFile(preparationOutput, 'utf8')).candidateMigration012Applied, false)
  assert.doesNotMatch(await fs.readFile(fixture.dockerLog, 'utf8'), /postgres|psql/)

  await fs.writeFile(fixture.dockerLog, '')
  const beforeOutput = path.join(fixture.shadowRoot, 'before.json')
  const before = spawnSync('sh', [script, 'before', beforeOutput], {
    encoding: 'utf8',
    env: { ...process.env, NODE_BIN: process.execPath },
  })
  assert.equal(before.status, 0, before.stderr)
  assert.equal(JSON.parse(await fs.readFile(beforeOutput, 'utf8')).candidateMigration012Applied, true)
  assert.match(await fs.readFile(fixture.dockerLog, 'utf8'), /compose exec -T postgres psql/)
})
