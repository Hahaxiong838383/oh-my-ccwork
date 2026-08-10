import assert from 'node:assert/strict'
import test from 'node:test'

import { createCompanySystemStatusProvider } from '../src/system-status.mjs'

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function baseConfig(overrides = {}) {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    workProtocol: { ontologyVersion: '3.3.0' },
    systemStatus: {
      registryUrl: 'http://ontology-registry:8084/readyz',
      domainUrl: 'http://domain-connector:8085/status',
      timeoutMs: 250,
      ...overrides,
    },
  }
}

test('系统状态提供器只读取白名单目标并聚合运行真值', async () => {
  const requests = []
  const provider = createCompanySystemStatusProvider({
    config: baseConfig(),
    store: { operationalStatus: async () => ({ actionIntents: 2, deliveryOutbox: 3 }) },
    runtime: { ready: async () => ({ ready: true, productionReady: true }) },
    agentCoreVersion: '2026-08-10.2',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options })
      if (new URL(url).pathname === '/readyz') {
        return jsonResponse({ status: 'in_sync', version: '2026-08-08.1', active: { schemaVersion: '3.3.0' } })
      }
      return jsonResponse({
        status: 'read_only',
        version: '2026-08-10.1',
        database: {
          counts: [
            { sourceSystem: 'aishike-erp-m3', count: 95 },
            { sourceSystem: 'kidshub-market', count: 369 },
          ],
          objectTypeCounts: [
            { objectType: 'domain.operations.Order', count: 38 },
            { objectType: 'domain.device.Device', count: 57 },
          ],
        },
      })
    },
    now: () => new Date('2026-08-10T08:00:00Z'),
  })
  const status = await provider()
  assert.equal(requests.length, 2)
  assert.ok(requests.every((item) => item.options.redirect === 'error'))
  assert.equal(status.schemaVersion, '3.3.0')
  assert.equal(status.registryStatus, 'in_sync')
  assert.equal(status.agentCoreReady, true)
  assert.equal(status.domainConnectorStatus, 'read_only')
  assert.equal(status.erpRecords, 95)
  assert.equal(status.operationsRecords, 38)
  assert.equal(status.deviceRecords, 57)
  assert.equal(status.marketRecords, 369)
  assert.equal(status.actionIntents, 2)
  assert.equal(status.deliveryOutbox, 3)
})

test('系统状态 URL 限定固定服务、路径、协议与无凭据', () => {
  for (const systemStatus of [
    { registryUrl: 'https://ontology-registry:8084/readyz' },
    { registryUrl: 'http://ontology-registry:8084/not-ready' },
    { registryUrl: 'http://user:pass@ontology-registry:8084/readyz' },
    { domainUrl: 'http://attacker.example/status' },
    { domainUrl: 'http://domain-connector:9999/status' },
  ]) {
    assert.throws(() => createCompanySystemStatusProvider({
      config: baseConfig(systemStatus),
      store: {},
      runtime: {},
    }), /not allowed/)
  }
})

test('单个状态源失败、重定向或超限时显式降级且不伪造 in_sync', async () => {
  const provider = createCompanySystemStatusProvider({
    config: baseConfig(),
    store: { operationalStatus: async () => { throw new Error('database unavailable') } },
    runtime: { ready: async () => { throw new Error('runtime unavailable') } },
    agentCoreVersion: '2026-08-10.2',
    fetchImpl: async (url) => {
      if (new URL(url).pathname === '/readyz') {
        return new Response('', { status: 302, headers: { location: 'http://attacker.example/status' } })
      }
      return jsonResponse({ status: 'read_only', version: '2026-08-10.1', padding: 'x'.repeat(70_000) })
    },
    now: () => new Date('2026-08-10T08:00:00Z'),
  })
  const status = await provider()
  assert.equal(status.schemaVersion, 'unknown')
  assert.equal(status.registryStatus, 'unavailable')
  assert.notEqual(status.registryStatus, 'in_sync')
  assert.equal(status.domainConnectorStatus, 'unavailable')
  assert.equal(status.agentCoreReady, false)
  assert.equal(status.hEngineProductionReady, false)
  assert.equal(status.actionIntents, 0)
  assert.equal(status.deliveryOutbox, 0)
})

test('状态源超时会在边界内降级返回', async () => {
  const provider = createCompanySystemStatusProvider({
    config: baseConfig({ timeoutMs: 200 }),
    store: {},
    runtime: {},
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    }),
  })
  const startedAt = Date.now()
  const status = await provider()
  assert.equal(status.registryStatus, 'unavailable')
  assert.equal(status.domainConnectorStatus, 'unavailable')
  assert.ok(Date.now() - startedAt < 1000)
})
