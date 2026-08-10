import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  ACTIVE_STAGES,
  CONTRACT_ONLY_STAGES,
  assertWorkCaseTransition,
  createWorkCaseDraft,
  inferWorkMode,
  stageContract,
} from '../src/work-protocol.mjs'

test('治理意图映射到数据库既有 work_mode 枚举', () => {
  assert.equal(inferWorkMode({ message: '请告诉我公司智慧中枢当前运行状态。', intent: 'query' }), 'answer_query')
  assert.equal(inferWorkMode({ message: '说明公司大脑形成经营决策会经过哪些阶段。', intent: 'decision' }), 'situation_analysis')
  assert.equal(inferWorkMode({ message: '请用我的个人身份在飞书里新建任务。', intent: 'task_assist' }), 'answer_query')
})

test('工作协议定义完整实践阶段，知识问答显式跳过后续阶段', () => {
  const contract = stageContract()
  assert.deepEqual(ACTIVE_STAGES, contract.map((item) => item.stageType))
  assert.deepEqual(contract.filter((item) => item.status === 'contract_only').map((item) => item.stageType), CONTRACT_ONLY_STAGES)
  assert.equal(contract.find((item) => item.stageType === 'decision').status, 'skipped')
  assert.equal(stageContract('decision_execution').find((item) => item.stageType === 'decision').status, 'pending')
})

test('WorkCase 只保存脱敏摘要与会话哈希', () => {
  const draft = createWorkCaseDraft({
    requestId: 'request-001',
    personId: 'feishu:ou_user',
    processingMode: 'active',
    turn: {
      intent: 'query',
      conversationId: 'private-conversation',
      message: '读取 https://private.example/doc 联系 13800138000，token-secret_abcdefghijklmnopqrstuvwxyz',
    },
    now: () => new Date('2026-08-09T02:00:00Z'),
  })
  assert.equal(draft.processingMode, 'active')
  assert.doesNotMatch(draft.requestSummary, /private\.example|13800138000|abcdefghijklmnopqrstuvwxyz/)
  assert.match(draft.conversationReferenceHash, /^[0-9a-f]{64}$/)
  assert.equal(draft.policySnapshot.hiddenChainOfThoughtStorageAllowed, false)
})

test('状态机拒绝把 completed 冒充后续任务成功', () => {
  assert.equal(assertWorkCaseTransition('response_ready', 'completed'), true)
  assert.throws(() => assertWorkCaseTransition('completed', 'execution'), /invalid work case transition/)
})

test('数据库迁移允许工作协议的全部实践状态', async () => {
  const migration = await readFile(
    new URL('../../../deploy/qnap/migrations/008-decision-practice-loop.sql', import.meta.url),
    'utf8',
  )
  for (const status of [
    'decision_pending',
    'decision_approved',
    'planning',
    'plan_ready',
    'executing',
    'verification_pending',
    'verified',
    'learning',
  ]) {
    assert.match(migration, new RegExp(`'${status}'`), `migration is missing ${status}`)
  }
})

test('Decision 外键写入显式约束 PostgreSQL 参数类型', async () => {
  const store = await readFile(new URL('../src/store.mjs', import.meta.url), 'utf8')
  assert.match(
    store,
    /jsonb_build_object\('decision_case_external_key', \$3::text\)/,
    'decision case external key must be cast before jsonb polymorphic dispatch',
  )
})

test('Agent Core 不直接初始化 Action Gateway 目标状态', async () => {
  const store = await readFile(new URL('../src/store.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(store, /INSERT INTO actions\.demo_task_status/)
})

test('失败或撤销的 Decision Lineage 在状态视图中明确退役', async () => {
  const migration = await readFile(
    new URL('../../../deploy/qnap/migrations/008-decision-practice-loop.sql', import.meta.url),
    'utf8',
  )
  assert.match(migration, /decision_case_status IN \('rejected', 'superseded', 'closed'\) THEN 'retired'/)
  assert.match(migration, /decision_status IN \('superseded', 'revoked'\) THEN 'retired'/)
})
