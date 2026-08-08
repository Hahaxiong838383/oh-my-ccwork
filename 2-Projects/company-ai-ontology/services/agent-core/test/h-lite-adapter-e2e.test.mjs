import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createCompanyAgentCoreAdapter,
  createCompanyAgentCoreClient,
} from '../../../../feishu-grok-bridge/lib/company-agent-core-client.mjs'
import { createAgentCoreServer } from '../src/server.mjs'
import { createMemoryStore } from '../src/store.mjs'

const tenantId = '11111111-1111-4111-8111-111111111111'
const secret = 's'.repeat(48)
const now = 1_800_000_000_000

test('H-Lite Adapter 到 Agent Core 完成签名 scope、幂等与标准结果闭环', async (t) => {
  const store = createMemoryStore()
  const server = createAgentCoreServer({
    config: {
      tenantId,
      hmacSecret: secret,
      maxBodyBytes: 262_144,
      maxClockSkewMs: 300_000,
      idempotencyTtlSeconds: 86_400,
    },
    store,
    runtime: {
      ready: async () => ({ ready: true, provider: 'test-runtime' }),
      run: async (turn) => ({ reply: `已处理:${turn.message}`, runtime: { provider: 'test-runtime' } }),
    },
    now: () => now,
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port
  const client = createCompanyAgentCoreClient({
    baseUrl: `http://127.0.0.1:${port}`,
    secret,
    now: () => now,
  })
  const adapter = createCompanyAgentCoreAdapter({ client, tenantId, personId: 'person-001' })
  const first = await adapter.runText('查询本周任务', {
    runnerTaskId: 'task-001',
    sessionKey: 'session-001',
    taskMode: { mode: 'short' },
  })
  const replay = await adapter.runText('查询本周任务', {
    runnerTaskId: 'task-001',
    sessionKey: 'session-001',
    taskMode: { mode: 'short' },
  })
  assert.equal(first.text, '已处理:查询本周任务')
  assert.deepEqual(replay, first)
  assert.deepEqual(store.events.map((event) => event.eventType), [
    'agent_turn_received',
    'agent_turn_completed',
  ])
})
