import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const QNAP_ROOT = path.resolve(ROOT, '..')
const BRIDGE_ROOT = path.resolve(ROOT, '../../../../feishu-grok-bridge')

test('Goal 7 权限 Canary 只执行合成数据读写且不触发部署、迁移、采集或重启', async () => {
  const runner = await fs.readFile(path.join(QNAP_ROOT, 'scripts/run-goal7-authority-canary.sh'), 'utf8')
  const seed = await fs.readFile(path.join(QNAP_ROOT, 'canary/goal7-authority-canary.sql'), 'utf8')
  const cleanup = await fs.readFile(path.join(QNAP_ROOT, 'canary/goal7-authority-canary-cleanup.sql'), 'utf8')
  assert.match(runner, /GOAL7_SOURCE_COMMIT/)
  assert.match(runner, /h-lite node \/app\/ops\/goal7-authority-canary\.mjs/)
  assert.doesNotMatch(runner, /compose\s+(up|down|restart|stop)|Collector|migrate\.sh/)
  assert.match(seed, /provider.*'goal7-canary'/s)
  assert.match(seed, /subject_type.*'chat'/s)
  assert.match(seed, /allowedPurposes.*decision_support/s)
  assert.match(cleanup, /DELETE FROM knowledge\.resources/)
  assert.match(cleanup, /DELETE FROM work\.conversation_authority_snapshots/)
})

test('H-Lite 候选镜像包含 Goal 7 Canary 且运行脚本输出编译证据', async () => {
  const dockerfile = await fs.readFile(path.join(BRIDGE_ROOT, 'deploy/company-qnap-lite/Dockerfile'), 'utf8')
  const canary = await fs.readFile(path.join(BRIDGE_ROOT, 'ops/goal7-authority-canary.mjs'), 'utf8')
  assert.match(dockerfile, /COPY ops\/goal7-authority-canary\.mjs \.\/ops\//)
  assert.match(dockerfile, /org\.opencontainers\.image\.revision=\$\{H_LITE_SOURCE_COMMIT\}/)
  assert.match(canary, /evidenceType: 'goal7-feishu-authority-canary'/)
  assert.match(canary, /hLiteSourceCommit/)
  assert.match(canary, /scenarioCount: 7/)
  assert.match(canary, /mentionsPreservedWithoutPrincipalExpansion/)
  assert.doesNotMatch(canary, /FEISHU_APP_SECRET\s*=|AGENT_CORE_HMAC_SECRET\s*=/)
})
