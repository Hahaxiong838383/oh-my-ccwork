import test from 'node:test'
import assert from 'node:assert/strict'

import { createRuntimeGovernor } from '../src/runtime-governance.mjs'

function failure(code) {
  return Object.assign(new Error(code), { code })
}

test('Runtime 只对可重试错误执行有上限退避并记录真实重试数', async () => {
  let attempts = 0
  const sleeps = []
  const governor = createRuntimeGovernor({
    policy: { maxRetries: 2, retryBaseMs: 10, failureThreshold: 5 },
    now: () => Date.parse('2026-08-11T04:00:00Z'),
    sleep: async (ms) => { sleeps.push(ms) },
  })
  const result = await governor.execute({
    estimatedPromptTokens: 20,
    operation: async () => {
      attempts += 1
      if (attempts < 3) throw failure('runtime_network_error')
      return { reply: 'ok', runtime: { provider: 'h-engine', model: 'grok-4.5', usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } } }
    },
  })
  assert.equal(attempts, 3)
  assert.deepEqual(sleeps, [10, 20])
  assert.equal(result.runtime.governance.retryCount, 2)
  assert.equal(result.runtime.usage.totalTokens, 25)
})

test('权限拒绝等非重试错误不会触发切路或重试', async () => {
  let attempts = 0
  const governor = createRuntimeGovernor({ policy: { maxRetries: 5 }, sleep: async () => {} })
  await assert.rejects(
    governor.execute({ operation: async () => { attempts += 1; throw failure('permission_denied') } }),
    (error) => error.code === 'permission_denied',
  )
  assert.equal(attempts, 1)
})

test('Route B 默认关闭且不能复用主路由伪装冗余', async () => {
  let called = false
  const governor = createRuntimeGovernor({ policy: { routeBEnabled: false } })
  await assert.rejects(
    governor.execute({ routeKey: 'route-b', operation: async () => { called = true } }),
    (error) => error.code === 'route_disabled',
  )
  assert.equal(called, false)
  assert.equal(governor.snapshot().routeB.enabled, false)
})

test('请求 Token 预算在模型调用前失败关闭', async () => {
  let called = false
  const governor = createRuntimeGovernor({ policy: { maxPromptTokensPerRequest: 100 } })
  await assert.rejects(
    governor.execute({ estimatedPromptTokens: 101, operation: async () => { called = true } }),
    (error) => error.code === 'budget_blocked' && error.budget === 'prompt_tokens_per_request',
  )
  assert.equal(called, false)
})

test('连续失败打开独立路由熔断器', async () => {
  let nowMs = Date.parse('2026-08-11T04:00:00Z')
  const governor = createRuntimeGovernor({
    policy: { maxRetries: 0, failureThreshold: 2, resetAfterMs: 60_000 },
    now: () => nowMs,
  })
  await assert.rejects(governor.execute({ operation: async () => { throw failure('runtime_network_error') } }))
  await assert.rejects(governor.execute({ operation: async () => { throw failure('runtime_network_error') } }))
  assert.equal(governor.snapshot().routeA.circuitState, 'open')
  await assert.rejects(
    governor.execute({ operation: async () => ({ reply: 'must not run' }) }),
    (error) => error.code === 'circuit_open',
  )
  nowMs += 61_000
  const recovered = await governor.execute({ operation: async () => ({ reply: 'ok', runtime: { usage: {} } }) })
  assert.equal(recovered.reply, 'ok')
})

test('响应费用超过单请求预算时返回明确 budget_blocked', async () => {
  const governor = createRuntimeGovernor({ policy: { maxCostMicrosPerRequest: 100 } })
  await assert.rejects(
    governor.execute({
      estimatedPromptTokens: 10,
      operation: async () => ({ reply: 'expensive', runtime: { usage: { totalTokens: 20, estimatedCostMicros: 101 } } }),
    }),
    (error) => error.code === 'budget_blocked' && error.budget === 'cost_per_request',
  )
})

test('远程 Runtime 缺 provider model 或 usage 读回时失败关闭', async () => {
  const governor = createRuntimeGovernor({ policy: { requireModelReadback: true, requireUsageReadback: true } })
  await assert.rejects(
    governor.execute({ operation: async () => ({ reply: 'missing', runtime: { provider: 'h-engine' } }) }),
    (error) => error.code === 'runtime_readback_missing',
  )
  const second = createRuntimeGovernor({ policy: { requireModelReadback: true, requireUsageReadback: true } })
  await assert.rejects(
    second.execute({ operation: async () => ({ reply: 'missing usage', runtime: { engineProvider: 'provider', model: 'model' } }) }),
    (error) => error.code === 'runtime_usage_readback_missing',
  )
  const third = createRuntimeGovernor({ policy: { requireModelReadback: true, requireUsageReadback: true } })
  await assert.rejects(
    third.execute({ operation: async () => ({ reply: 'empty usage', runtime: { engineProvider: 'provider', model: 'model', usage: {} } }) }),
    (error) => error.code === 'runtime_usage_readback_missing',
  )
})

test('模型已消耗后触发 Token 预算仍写入无正文账本', async () => {
  const records = []
  const governor = createRuntimeGovernor({
    policy: { maxTotalTokensPerRequest: 10 },
    ledger: {
      record: async (entry) => { records.push(entry) },
    },
  })
  await assert.rejects(
    governor.execute({
      context: { requestId: 'budget-overrun', personId: 'person-1', workType: 'query' },
      estimatedPromptTokens: 5,
      operation: async () => ({
        reply: 'must not be returned',
        runtime: { provider: 'h-engine', model: 'grok-4.5', usage: { promptTokens: 5, completionTokens: 6, totalTokens: 11 } },
      }),
    }),
    (error) => error.code === 'budget_blocked' && error.budget === 'total_tokens_per_request',
  )
  assert.equal(records.length, 1)
  assert.equal(records[0].outcome, 'budget_blocked')
  assert.equal(records[0].runtime.usage.totalTokens, 11)
  assert.equal(records[0].runtime.governance.ledgerRecorded, true)
  assert.equal('reply' in records[0].runtime, false)
})

test('单日预算从 Postgres 账本恢复且成功调用写回无正文用量事件', async () => {
  const records = []
  const governor = createRuntimeGovernor({
    policy: { maxRequestsPerDay: 2 },
    now: () => Date.parse('2026-08-11T16:30:00Z'),
    ledger: {
      readDaily: async ({ date, routeKey }) => {
        assert.equal(date, '2026-08-12')
        assert.equal(routeKey, 'route-a')
        return { requests: 1, retries: 0, tokens: 10, costMicros: 0 }
      },
      record: async (entry) => { records.push(entry) },
    },
  })
  const result = await governor.execute({
    context: { requestId: 'request-1', personId: 'person-1', workType: 'query' },
    estimatedPromptTokens: 5,
    operation: async () => ({ reply: 'ok', runtime: { usage: { totalTokens: 8 } } }),
  })
  assert.equal(result.runtime.governance.ledgerRecorded, true)
  assert.equal(records.length, 1)
  assert.equal(records[0].context.requestId, 'request-1')
  await assert.rejects(
    governor.execute({ context: { requestId: 'request-2' }, operation: async () => ({ reply: 'blocked' }) }),
    (error) => error.code === 'budget_blocked' && error.budget === 'requests_per_day',
  )
})
