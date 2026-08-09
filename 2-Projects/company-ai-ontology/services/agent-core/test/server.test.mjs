import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createAgentCoreServer } from '../src/server.mjs'
import { signatureFor } from '../src/protocol.mjs'
import { createMemoryStore } from '../src/store.mjs'

const tenantId = '11111111-1111-4111-8111-111111111111'
const secret = 's'.repeat(48)
const now = 1_800_000_000_000

function config() {
  return {
    tenantId,
    hmacSecret: secret,
    maxBodyBytes: 262_144,
    maxClockSkewMs: 300_000,
    idempotencyTtlSeconds: 86_400,
  }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

function request(port, { path = '/v1/turns', body = '', headers = {}, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function signed(body, overrides = {}) {
  const scope = {
    timestamp: String(now),
    requestId: 'request-001',
    tenantId,
    personId: 'person-001',
    idempotencyKey: 'idem-001',
    ...overrides,
  }
  return {
    'content-type': 'application/json',
    'x-company-timestamp': scope.timestamp,
    'x-company-request-id': scope.requestId,
    'x-company-tenant-id': scope.tenantId,
    'x-company-person-id': scope.personId,
    'x-company-idempotency-key': scope.idempotencyKey,
    'x-company-signature': signatureFor({ body, secret, ...scope }),
  }
}

test('readyz 在 H 引擎 Runtime 未配置时明确返回灰色未就绪', async (t) => {
  const server = createAgentCoreServer({
    config: config(),
    store: createMemoryStore(),
    runtime: { ready: async () => ({ ready: false, productionReady: false, reason: 'h_engine_credentials_missing' }) },
    now: () => now,
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = await listen(server)
  const result = await request(port, { method: 'GET', path: '/readyz' })
  assert.equal(result.status, 503)
  assert.equal(result.payload.status, 'runtime_not_ready')
  assert.equal(result.payload.runtime.reason, 'h_engine_credentials_missing')
})

test('readyz 在演示模式返回 demo_ready 且不冒充生产就绪', async (t) => {
  const server = createAgentCoreServer({
    config: config(),
    store: createMemoryStore(),
    runtime: { ready: async () => ({ ready: true, productionReady: false, provider: 'h-engine', mode: 'demo' }) },
    now: () => now,
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = await listen(server)
  const result = await request(port, { method: 'GET', path: '/readyz' })
  assert.equal(result.status, 200)
  assert.equal(result.payload.status, 'demo_ready')
  assert.equal(result.payload.productionReady, false)
})

test('turn 在 Runtime 未就绪时写幂等与审计但不伪装成功', async (t) => {
  const store = createMemoryStore()
  const server = createAgentCoreServer({
    config: config(),
    store,
    runtime: { ready: async () => ({ ready: false, productionReady: false, reason: 'h_engine_cli_missing' }) },
    now: () => now,
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = await listen(server)
  const body = JSON.stringify({ conversationId: 'conversation-001', message: '查询经营数据', intent: 'query', channel: 'h-lite-shadow' })
  const first = await request(port, { body, headers: signed(body) })
  const replay = await request(port, { body, headers: signed(body) })
  assert.equal(first.status, 503)
  assert.equal(first.payload.ok, false)
  assert.equal(first.payload.status, 'runtime_not_ready')
  assert.equal(replay.status, 503)
  assert.equal(replay.headers['x-company-idempotent-replay'], '1')
  assert.deepEqual(replay.payload, first.payload)
  assert.deepEqual(store.events.map((event) => event.eventType), [
    'agent_turn_received',
    'agent_turn_runtime_not_ready',
  ])
})

test('turn 拒绝错误签名和重复幂等键不同请求体', async (t) => {
  const store = createMemoryStore()
  const runtime = {
    ready: async () => ({ ready: true, provider: 'test-runtime' }),
    run: async () => ({ reply: '完成', runtime: { provider: 'test-runtime' } }),
  }
  const server = createAgentCoreServer({ config: config(), store, runtime, now: () => now })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = await listen(server)
  const firstBody = JSON.stringify({ conversationId: 'conversation-001', message: '请求一', intent: 'query', channel: 'h-lite-shadow' })
  const bad = await request(port, { body: firstBody, headers: { ...signed(firstBody), 'x-company-signature': 'v1=bad' } })
  assert.equal(bad.status, 401)
  const first = await request(port, { body: firstBody, headers: signed(firstBody) })
  assert.equal(first.status, 200)
  const secondBody = JSON.stringify({ conversationId: 'conversation-001', message: '请求二', intent: 'query', channel: 'h-lite-shadow' })
  const conflict = await request(port, { body: secondBody, headers: signed(secondBody) })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.payload.status, 'idempotency_conflict')
})

test('权限检索与 P2 路由只使用签名身份并返回标准结果', async (t) => {
  const store = createMemoryStore()
  const calls = []
  store.permissionedSearch = async (input) => {
    calls.push(['retrieve', input])
    return input.personId === 'demo-dri-01'
      ? [{ evidenceId: 'restricted-1', classification: 'restricted', title: '经营预算' }]
      : []
  }
  store.compileP2 = async (input) => {
    calls.push(['compile', input])
    if (input.actorPersonId !== 'demo-dri-01') {
      throw Object.assign(new Error('actor cannot compile P2 tasks'), { statusCode: 403, code: 'forbidden' })
    }
    return [{ external_key: 'demo-p2-2026-001:task:demo-person-01', status: 'draft' }]
  }
  store.transitionTask = async (input) => {
    calls.push(['transition', input])
    return { external_key: input.taskExternalKey, status: 'approved', version: 2 }
  }
  store.ackDemoDeliveries = async (input) => {
    calls.push(['ack', input])
    return [{ id: 'delivery-1', provider_message_id: 'demo:delivery-1' }]
  }
  store.listP2Tasks = async (input) => {
    calls.push(['list', input])
    return [{ external_key: 'demo-p2-2026-001:task:demo-person-01', status: 'approved' }]
  }
  store.createActionIntent = async (input) => {
    calls.push(['propose', input])
    return {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      target_system: input.targetSystem,
      action_type: input.actionType,
      status: 'proposed',
      payload: input.payload,
    }
  }
  const server = createAgentCoreServer({
    config: config(),
    store,
    runtime: { ready: async () => ({ ready: true, productionReady: false, mode: 'demo' }) },
    now: () => now,
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = await listen(server)

  const retrievalBody = JSON.stringify({ query: '经营预算', limit: 8 })
  const ordinary = await request(port, {
    path: '/v1/retrieve',
    body: retrievalBody,
    headers: signed(retrievalBody, { personId: 'demo-person-01', requestId: 'retrieve-ordinary', idempotencyKey: 'retrieve-ordinary' }),
  })
  const dri = await request(port, {
    path: '/v1/retrieve',
    body: retrievalBody,
    headers: signed(retrievalBody, { personId: 'demo-dri-01', requestId: 'retrieve-dri', idempotencyKey: 'retrieve-dri' }),
  })
  assert.equal(ordinary.status, 200)
  assert.equal(ordinary.payload.permissionFiltered, true)
  assert.deepEqual(ordinary.payload.evidence, [])
  assert.equal(dri.payload.evidence[0].classification, 'restricted')

  const compileBody = JSON.stringify({ p2ExternalKey: 'demo-p2-2026-001', assigneeCount: 10 })
  const forbidden = await request(port, {
    path: '/v1/p2/compile',
    body: compileBody,
    headers: signed(compileBody, { personId: 'demo-person-01', requestId: 'compile-forbidden', idempotencyKey: 'compile-forbidden' }),
  })
  const compiled = await request(port, {
    path: '/v1/p2/compile',
    body: compileBody,
    headers: signed(compileBody, { personId: 'demo-dri-01', requestId: 'compile-dri', idempotencyKey: 'compile-dri' }),
  })
  assert.equal(forbidden.status, 403)
  assert.equal(compiled.status, 200)
  assert.equal(compiled.payload.tasks.length, 1)
  assert.equal(calls.find(([name]) => name === 'compile')[1].actorPersonId, 'demo-person-01')

  const actionBody = JSON.stringify({
    targetSystem: 'feishu-demo',
    actionType: 'feishu_task_status_demo',
    payload: { taskExternalKey: 'demo-p2-2026-001:task:demo-person-01', desiredStatus: 'done' },
    riskLevel: 'low',
  })
  const proposed = await request(port, {
    path: '/v1/actions/propose',
    body: actionBody,
    headers: signed(actionBody, { personId: 'demo-dri-01', requestId: 'action-propose', idempotencyKey: 'action-propose' }),
  })
  assert.equal(proposed.status, 200)
  assert.equal(proposed.payload.status, 'proposed')
  assert.equal(calls.find(([name]) => name === 'propose')[1].actorPersonId, 'demo-dri-01')
})

test('通讯录同步只接受服务身份并最小化人员字段', async (t) => {
  const store = createMemoryStore()
  const calls = []
  const originalSync = store.syncPrincipals
  store.syncPrincipals = async (input) => {
    calls.push(input)
    return originalSync(input)
  }
  const server = createAgentCoreServer({
    config: config(),
    store,
    runtime: { ready: async () => ({ ready: true, productionReady: false, mode: 'demo' }) },
    now: () => now,
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = await listen(server)
  const body = JSON.stringify({
    people: [{
      personId: 'feishu:ou_test_user',
      displayName: '测试员工',
      departmentKey: 'od_test_dept',
      email: 'must-not-pass@example.com',
      mobile: '13800000000',
      attributes: { source: 'untrusted', departmentIds: ['od_test_dept'], privateText: 'must-not-pass' },
    }],
  })
  const forbidden = await request(port, {
    path: '/v1/identity/sync',
    body,
    headers: signed(body, { personId: 'person-001', requestId: 'directory-forbidden', idempotencyKey: 'directory-forbidden' }),
  })
  assert.equal(forbidden.status, 403)
  const synced = await request(port, {
    path: '/v1/identity/sync',
    body,
    headers: signed(body, { personId: 'company-directory-sync', requestId: 'directory-sync', idempotencyKey: 'directory-sync' }),
  })
  assert.equal(synced.status, 200)
  assert.equal(synced.payload.syncedPeople, 1)
  assert.deepEqual(calls[0].people, [{
    personId: 'feishu:ou_test_user',
    displayName: '测试员工',
    departmentKey: 'od_test_dept',
    attributes: { source: 'feishu-directory', departmentIds: ['od_test_dept'] },
  }])
  assert.equal(store.events.at(-1).eventType, 'directory_principals_synced')
})

test('Goal 4 active 模式完成 WorkCase、Evidence v2 与结构化回答闭环', async (t) => {
  const store = createMemoryStore({
    retrieval: {
      principalFound: true,
      evidence: [{
        evidenceId: 'erp-fixture:order-001',
        source: 'aishike-erp-fixture',
        objectType: 'order',
        title: '测试订单',
        excerpt: '测试订单已完成质检',
        classification: 'internal',
        updatedAt: '2026-08-08T10:00:00Z',
        validUntil: '2028-08-10T10:00:00Z',
        permissionSnapshot: true,
      }],
      excludedReasonCounts: {},
      policyDecisionReference: 'fixture-policy',
      limit: 8,
      truncated: false,
    },
  })
  const server = createAgentCoreServer({
    config: {
      ...config(),
      workProtocol: { mode: 'active', ontologyVersion: '3.1.0', evidenceMaxAgeDays: 180, recentCaseLimit: 8 },
    },
    store,
    runtime: {
      ready: async () => ({ ready: true, productionReady: true, provider: 'test-h-engine' }),
      run: async (turn) => ({
        reply: JSON.stringify({
          conclusion: '测试订单已完成质检。',
          factBasis: ['ERP fixture 显示订单已完成质检'],
          derivedSummary: '仅依据当前授权 fixture。',
          assumptions: [], contradictions: [], unknowns: [], confidenceLevel: 'medium',
          validityWindow: { validUntil: turn.workContext.evidencePackage.validUntil },
          recommendedNextAction: '由业务 DRI 复核真实订单。', approvalRequired: false,
          evidenceReferences: ['erp-fixture:order-001'],
        }),
        runtime: { provider: 'test-h-engine', productionReady: true },
      }),
    },
    now: () => now,
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = await listen(server)
  const body = JSON.stringify({ conversationId: 'conversation-goal4', message: '测试订单质检完成了吗', intent: 'query', channel: 'h-lite' })
  const result = await request(port, { body, headers: signed(body, { requestId: 'goal4-active', idempotencyKey: 'goal4-active' }) })
  assert.equal(result.status, 200)
  assert.equal(result.payload.workCase.status, 'completed')
  assert.equal(result.payload.workCase.processingMode, 'active')
  assert.equal(result.payload.evidencePackage.packageVersion, '2.0.0')
  assert.equal(result.payload.epistemicAssessment.deterministicConclusionAllowed, true)
  assert.equal(result.payload.answer.confidenceLevel, 'medium')
  assert.match(result.payload.reply, /测试订单已完成质检/)
  const protocolStatus = await request(port, { method: 'GET', path: '/status/work-protocol' })
  assert.equal(protocolStatus.status, 200)
  assert.equal(protocolStatus.payload.status, 'active')
  assert.equal(protocolStatus.payload.recentCases[0].status, 'completed')
  assert.equal(protocolStatus.payload.contractOnlyStages.includes('decision'), true)
})

test('Goal 4 无权限主体 Evidence 0 且不调用 H 引擎', async (t) => {
  const store = createMemoryStore({ retrieval: { principalFound: false, evidence: [], excludedReasonCounts: { principal_not_active: 1 } } })
  let runtimeCalls = 0
  const server = createAgentCoreServer({
    config: {
      ...config(),
      workProtocol: { mode: 'active', ontologyVersion: '3.1.0', evidenceMaxAgeDays: 180, recentCaseLimit: 8 },
    },
    store,
    runtime: {
      ready: async () => ({ ready: true, productionReady: true, provider: 'test-h-engine' }),
      run: async () => { runtimeCalls += 1; throw new Error('must not run') },
    },
    now: () => now,
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = await listen(server)
  const body = JSON.stringify({ conversationId: 'conversation-denied', message: '给我受限资料', intent: 'query', channel: 'h-lite' })
  const result = await request(port, { body, headers: signed(body, { requestId: 'goal4-denied', idempotencyKey: 'goal4-denied', personId: 'person-denied' }) })
  assert.equal(result.status, 200)
  assert.equal(runtimeCalls, 0)
  assert.equal(result.payload.workCase.status, 'permission_denied')
  assert.equal(result.payload.evidence.length, 0)
  assert.equal(result.payload.evidencePackage.facts.length, 0)
  assert.doesNotMatch(JSON.stringify(result.payload), /机密标题|https?:\/\//)
})
