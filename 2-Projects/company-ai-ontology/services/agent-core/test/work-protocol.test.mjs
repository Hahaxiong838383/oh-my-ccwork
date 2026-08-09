import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVE_STAGES,
  CONTRACT_ONLY_STAGES,
  assertWorkCaseTransition,
  createWorkCaseDraft,
  stageContract,
} from '../src/work-protocol.mjs'

test('工作协议只激活可解释回答，后续阶段保持契约灰色', () => {
  const contract = stageContract()
  assert.deepEqual(contract.filter((item) => item.status === 'pending').map((item) => item.stageType), ACTIVE_STAGES)
  assert.deepEqual(contract.filter((item) => item.status === 'contract_only').map((item) => item.stageType), CONTRACT_ONLY_STAGES)
  assert.equal(contract.find((item) => item.stageType === 'decision').status, 'contract_only')
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
