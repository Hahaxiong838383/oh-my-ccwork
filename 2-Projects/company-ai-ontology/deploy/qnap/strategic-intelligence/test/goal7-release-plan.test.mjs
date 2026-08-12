import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateGoal7ReleasePlan } from '../scripts/goal7-release-plan-lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLAN_FILE = path.join(ROOT, 'config/goal7-foundation-release-plan.json')
const VALIDATOR = path.join(ROOT, 'scripts/validate-goal7-release-plan.mjs')
const DEPLOY = path.join(ROOT, 'scripts/deploy-goal7-foundation.sh')

async function inputs() {
  return {
    plan: JSON.parse(await fs.readFile(PLAN_FILE, 'utf8')),
    scripts: {
      deploy: await fs.readFile(DEPLOY, 'utf8'),
      rollback: await fs.readFile(path.join(ROOT, 'scripts/rollback-goal7-foundation.sh'), 'utf8'),
    },
  }
}

test('Goal 7 发布计划明确中断、影响、回滚时间和独立授权', async () => {
  const result = spawnSync(process.execPath, [VALIDATOR], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.status, 'WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH')
  assert.equal(output.targetServiceCount, 3)
  assert.equal(output.explicitAuthorizationCount, 4)
  assert.deepEqual(output.expectedUserVisibleInterruptionSeconds, { min: 15, max: 120 })
  assert.deepEqual(output.expectedRollbackMinutes, { min: 2, max: 6 })
})

test('Goal 7 发布计划拒绝扩大服务范围、预授权和静默延长中断', async () => {
  const { plan, scripts } = await inputs()
  assert.throws(() => validateGoal7ReleasePlan({ ...plan, targetServices: [...plan.targetServices, 'postgres'] }, scripts), /targetServices mismatch/)
  assert.throws(() => validateGoal7ReleasePlan({ ...plan, migration012Authorized: true }, scripts), /must remain false in Git/)
  assert.throws(() => validateGoal7ReleasePlan({
    ...plan,
    timing: { ...plan.timing, expectedUserVisibleInterruptionSeconds: { min: 15, max: 300 } },
  }, scripts), /changed without release review/)
})

test('Goal 7 发布计划拒绝缺少迁移或服务动作独立授权的脚本', async () => {
  const { plan, scripts } = await inputs()
  assert.throws(() => validateGoal7ReleasePlan(plan, {
    ...scripts,
    deploy: scripts.deploy.replaceAll('GOAL7_MIGRATION_012_APPROVED', 'REMOVED_MIGRATION_GATE'),
  }), /missing authorization GOAL7_MIGRATION_012_APPROVED/)
  assert.throws(() => validateGoal7ReleasePlan(plan, {
    ...scripts,
    deploy: scripts.deploy.replaceAll('GOAL7_SERVICE_RECREATION_APPROVED', 'REMOVED_SERVICE_GATE'),
  }), /missing authorization GOAL7_SERVICE_RECREATION_APPROVED/)
})

test('Goal 7 部署脚本在 QNAP 预检前依次拒绝缺失的三类授权', () => {
  const first = spawnSync('sh', [DEPLOY], { encoding: 'utf8' })
  assert.equal(first.status, 2)
  assert.match(first.stderr, /GOAL7_DEPLOY_APPROVED=YES/)

  const second = spawnSync('sh', [DEPLOY], {
    encoding: 'utf8',
    env: { GOAL7_DEPLOY_APPROVED: 'YES' },
  })
  assert.equal(second.status, 2)
  assert.match(second.stderr, /GOAL7_MIGRATION_012_APPROVED=YES/)
  assert.doesNotMatch(second.stderr, /QNAP|docker/i)

  const third = spawnSync('sh', [DEPLOY], {
    encoding: 'utf8',
    env: { GOAL7_DEPLOY_APPROVED: 'YES', GOAL7_MIGRATION_012_APPROVED: 'YES' },
  })
  assert.equal(third.status, 2)
  assert.match(third.stderr, /GOAL7_SERVICE_RECREATION_APPROVED=YES/)
  assert.doesNotMatch(third.stderr, /QNAP|docker/i)
})

test('Goal 7 发布计划文件被修改后 CLI 失败关闭', async () => {
  const { plan } = await inputs()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-release-plan-'))
  const file = path.join(root, 'plan.json')
  await fs.writeFile(file, JSON.stringify({ ...plan, rollbackDrillAuthorized: true }))
  const result = spawnSync(process.execPath, [VALIDATOR, file], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /rollbackDrillAuthorized must remain false in Git/)
})
