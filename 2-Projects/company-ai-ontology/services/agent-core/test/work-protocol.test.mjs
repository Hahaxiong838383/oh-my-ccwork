import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVE_STAGES,
  CONTRACT_ONLY_STAGES,
  assertWorkCaseTransition,
  createWorkCaseDraft,
  stageContract,
} from '../src/work-protocol.mjs'

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
