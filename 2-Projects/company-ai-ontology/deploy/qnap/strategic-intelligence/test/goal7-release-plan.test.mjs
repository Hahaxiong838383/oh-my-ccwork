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
const PREPARE = path.join(ROOT, 'scripts/prepare-goal7-foundation.sh')
const MIGRATE = path.join(ROOT, 'scripts/reconcile-goal7-migration-012.sh')
const DEPLOY = path.join(ROOT, 'scripts/deploy-goal7-foundation.sh')
const WORKER_READBACK = path.resolve(ROOT, '..', 'scripts/run-goal7-worker-readback.sh')
const AUTHORITY_CANARY = path.resolve(ROOT, '..', 'scripts/run-goal7-authority-canary.sh')

async function inputs() {
  return {
    plan: JSON.parse(await fs.readFile(PLAN_FILE, 'utf8')),
    scripts: {
      prepare: await fs.readFile(PREPARE, 'utf8'),
      migrate: await fs.readFile(MIGRATE, 'utf8'),
      verifyMigration: await fs.readFile(path.join(ROOT, 'scripts/verify-goal7-migration-012-live.sh'), 'utf8'),
      deploy: await fs.readFile(DEPLOY, 'utf8'),
      workerReadback: await fs.readFile(WORKER_READBACK, 'utf8'),
      authorityCanary: await fs.readFile(AUTHORITY_CANARY, 'utf8'),
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
  assert.equal(output.explicitAuthorizationCount, 5)
  assert.deepEqual(output.expectedUserVisibleInterruptionSeconds, { min: 15, max: 120 })
  assert.deepEqual(output.expectedRollbackMinutes, { min: 2, max: 6 })
})

test('Goal 7 发布计划拒绝扩大服务范围、预授权和静默延长中断', async () => {
  const { plan, scripts } = await inputs()
  assert.throws(() => validateGoal7ReleasePlan({ ...plan, targetServices: [...plan.targetServices, 'postgres'] }, scripts), /targetServices mismatch/)
  assert.throws(() => validateGoal7ReleasePlan({ ...plan, migration012ReconciliationAuthorized: true }, scripts), /must remain false in Git/)
  assert.throws(() => validateGoal7ReleasePlan({ ...plan, workerReadbackAuthorityCanaryAuthorized: true }, scripts), /must remain false in Git/)
  assert.throws(() => validateGoal7ReleasePlan({
    ...plan,
    timing: { ...plan.timing, expectedUserVisibleInterruptionSeconds: { min: 15, max: 300 } },
  }, scripts), /changed without release review/)
})

test('Goal 7 发布计划拒绝缺少任一阶段独立授权的脚本', async () => {
  const { plan, scripts } = await inputs()
  assert.throws(() => validateGoal7ReleasePlan(plan, {
    ...scripts,
    prepare: scripts.prepare.replaceAll('GOAL7_DEPLOY_APPROVED', 'REMOVED_PREPARATION_GATE'),
  }), /missing authorization GOAL7_DEPLOY_APPROVED/)
  assert.throws(() => validateGoal7ReleasePlan(plan, {
    ...scripts,
    migrate: scripts.migrate.replaceAll('GOAL7_MIGRATION_012_RECONCILIATION_APPROVED', 'REMOVED_MIGRATION_GATE'),
  }), /missing authorization GOAL7_MIGRATION_012_RECONCILIATION_APPROVED/)
  assert.throws(() => validateGoal7ReleasePlan(plan, {
    ...scripts,
    deploy: scripts.deploy.replaceAll('GOAL7_SERVICE_RECREATION_APPROVED', 'REMOVED_SERVICE_GATE'),
  }), /missing authorization GOAL7_SERVICE_RECREATION_APPROVED/)
  assert.throws(() => validateGoal7ReleasePlan(plan, {
    ...scripts,
    workerReadback: scripts.workerReadback.replaceAll('GOAL7_WORKER_READBACK_APPROVED', 'REMOVED_WORKER_GATE'),
  }), /missing authorization GOAL7_WORKER_READBACK_APPROVED/)
  assert.throws(() => validateGoal7ReleasePlan(plan, {
    ...scripts,
    authorityCanary: scripts.authorityCanary.replaceAll('GOAL7_WORKER_READBACK_APPROVED', 'REMOVED_CANARY_GATE'),
  }), /missing shared D-stage authorization/)
})

test('Goal 7 A-D 阶段脚本各自在 QNAP 预检前拒绝缺失授权', () => {
  const first = spawnSync('sh', [PREPARE], { encoding: 'utf8' })
  assert.equal(first.status, 2)
  assert.match(first.stderr, /GOAL7_DEPLOY_APPROVED=YES/)
  assert.doesNotMatch(first.stderr, /QNAP|docker/i)

  const second = spawnSync('sh', [MIGRATE], { encoding: 'utf8' })
  assert.equal(second.status, 2)
  assert.match(second.stderr, /GOAL7_MIGRATION_012_RECONCILIATION_APPROVED=YES/)
  assert.doesNotMatch(second.stderr, /QNAP|docker/i)

  const third = spawnSync('sh', [DEPLOY], { encoding: 'utf8' })
  assert.equal(third.status, 2)
  assert.match(third.stderr, /GOAL7_SERVICE_RECREATION_APPROVED=YES/)
  assert.doesNotMatch(third.stderr, /QNAP|docker/i)

  const fourth = spawnSync('sh', [WORKER_READBACK], { encoding: 'utf8' })
  assert.notEqual(fourth.status, 0)
  assert.match(fourth.stderr, /GOAL7_WORKER_READBACK_APPROVED=YES/)
  assert.doesNotMatch(fourth.stderr, /QNAP|docker/i)

  const fifth = spawnSync('sh', [AUTHORITY_CANARY], { encoding: 'utf8' })
  assert.notEqual(fifth.status, 0)
  assert.match(fifth.stderr, /GOAL7_WORKER_READBACK_APPROVED=YES/)
  assert.doesNotMatch(fifth.stderr, /QNAP|docker/i)
})

test('Goal 7 分阶段脚本不越权执行后续动作', async () => {
  const { scripts } = await inputs()
  assert.doesNotMatch(scripts.prepare, /compose up|compose (restart|down|stop)/)
  assert.ok(!scripts.prepare.includes('compose exec -T postgres psql'))
  assert.doesNotMatch(scripts.migrate, /compose up|compose build|compose (restart|down|stop)/)
  assert.doesNotMatch(scripts.migrate, /compose exec -T postgres psql --set=ON_ERROR_STOP=1/)
  assert.match(scripts.migrate, /database_sql_executed=0/)
  assert.doesNotMatch(scripts.deploy, /compose build/)
  assert.ok(!scripts.deploy.includes('compose exec -T postgres psql'))
  assert.match(scripts.prepare, /preparation-evidence\.json/)
  assert.match(scripts.migrate, /validate-goal7-preparation\.mjs/)
  assert.match(scripts.deploy, /validate-goal7-migration\.mjs/)
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
