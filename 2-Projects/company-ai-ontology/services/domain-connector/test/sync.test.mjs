import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeSourceRecord } from '../src/source-client.mjs'
import { createMemoryDomainStore } from '../src/store.mjs'
import { createDomainSync } from '../src/sync.mjs'
import { createDomainConnectorServer } from '../src/server.mjs'

const source = { key: 'aishike-erp-m3', enabled: true, purpose: 'operations-read-model' }
const record = (patch = {}) => ({
  externalId: 'order:ASK-ORD-00015', objectType: 'domain.operations.Order', sourceUpdatedAt: '2026-08-09T01:00:00Z', validFrom: '2026-08-09T01:00:00Z', status: 'active', epistemicType: 'source_fact', authority: 'aishike-erp-m3', payload: { orderKey: 'ASK-ORD-00015', orderStatus: 'ACTIVATED' }, provenance: { sourceRecordId: 'ASK-ORD-00015', sourceVersion: 'm3-read-v1', collectedAt: '2026-08-09T01:00:01Z' }, ...patch,
})

test('source records reject credentials and unsupported object types', () => {
  assert.throws(() => normalizeSourceRecord(record({ payload: { apiToken: 'unsafe' } }), source), /forbidden field/)
  assert.throws(() => normalizeSourceRecord(record({ objectType: 'domain.operations.RMA' }), source), /not allowed/)
  assert.throws(() => normalizeSourceRecord(record({ payload: { orderStatus: 'ACTIVATED' } }), source), /orderKey is required/)
  assert.throws(() => normalizeSourceRecord(record({ confidence: 'not-a-number' }), source), /confidence is invalid/)
})

test('sync is idempotent, advances cursor and isolates invalid records', async () => {
  const store = createMemoryDomainStore()
  const pages = [
    { items: [record(), record({ externalId: 'order:invalid', payload: { customerRef: 'blocked' } })], nextCursor: 'cursor-1', hasMore: true },
    { items: [record({ externalId: 'activation:ASK-000020', objectType: 'domain.operations.Activation', payload: { activationKey: 'ASK-000020', activationStatus: 'ACTIVATED', activatedAt: '2026-08-09T01:00:00Z' } })], nextCursor: 'cursor-2', hasMore: false },
  ]
  const client = { page: async () => pages.shift() }
  const config = { tenantId: 'tenant-1', pageLimit: 100, maxPages: 10, sources: { 'aishike-erp-m3': source } }
  const sync = createDomainSync({ config, clients: { 'aishike-erp-m3': client }, store })
  const first = await sync.run('aishike-erp-m3')
  assert.equal(first.ok, true)
  assert.deepEqual(first.stats, { pages: 2, received: 3, inserted: 2, updated: 0, unchanged: 0, isolated: 1 })
  assert.equal(await store.cursor({ sourceSystem: 'aishike-erp-m3' }), 'cursor-2')
  assert.equal(store.state.deadLetters.length, 1)

  const replayClient = { page: async () => ({ items: [record()], nextCursor: 'cursor-2', hasMore: false }) }
  const replay = createDomainSync({ config, clients: { 'aishike-erp-m3': replayClient }, store })
  const second = await replay.run('aishike-erp-m3', { cursorOverride: '', replay: true })
  assert.equal(second.stats.unchanged, 1)
  assert.equal(store.state.records.size, 2)
  assert.equal(await store.cursor({ sourceSystem: 'aishike-erp-m3' }), 'cursor-2')
})

test('failed runs and partial replays never replace the live cursor', async () => {
  const store = createMemoryDomainStore()
  store.state.cursors.set('aishike-erp-m3', 'live-cursor')
  const config = { tenantId: 'tenant-1', pageLimit: 100, maxPages: 10, sources: { 'aishike-erp-m3': source } }
  const failed = createDomainSync({ config, clients: { 'aishike-erp-m3': { page: async () => { throw Object.assign(new Error('offline'), { code: 'source_unavailable' }) } } }, store })
  assert.equal((await failed.run('aishike-erp-m3')).status, 'failed')
  assert.equal(await store.cursor({ sourceSystem: 'aishike-erp-m3' }), 'live-cursor')

  const replay = createDomainSync({ config, clients: { 'aishike-erp-m3': { page: async () => ({ items: [record()], nextCursor: 'historical-cursor', hasMore: false }) } }, store })
  assert.equal((await replay.run('aishike-erp-m3', { cursorOverride: 'old-cursor', replay: true })).status, 'completed')
  assert.equal(await store.cursor({ sourceSystem: 'aishike-erp-m3' }), 'live-cursor')
})

test('control routes fail closed and never accept a wrong bearer token', async () => {
  const config = { tenantId: 'tenant-1', controlToken: 'x'.repeat(40), sources: { 'aishike-erp-m3': source } }
  const store = { ready: async () => ({ ready: true }), status: async () => ({ counts: [] }) }
  const sync = { isRunning: () => false, run: async () => ({ ok: true, status: 'completed', stats: {} }) }
  const server = createDomainConnectorServer({ config, store, sync, state: { lastRuns: {} } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    const base = `http://127.0.0.1:${address.port}`
    assert.equal((await fetch(`${base}/v1/sync/aishike-erp-m3`, { method: 'POST' })).status, 403)
    assert.equal((await fetch(`${base}/v1/sync/aishike-erp-m3`, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status, 403)
    assert.equal((await fetch(`${base}/v1/sync/aishike-erp-m3`, { method: 'POST', headers: { authorization: `Bearer ${config.controlToken}` } })).status, 200)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('status never exposes source cursors', async () => {
  const store = createMemoryDomainStore()
  store.state.cursors.set('aishike-erp-m3', 'opaque-live-cursor')
  const status = await store.status()
  assert.equal(status.sources[0].sourceSystem, 'aishike-erp-m3')
  assert.equal(status.sources[0].cursorPresent, true)
  assert.doesNotMatch(JSON.stringify(status), /opaque-live-cursor|cursorValue|cursor_value/)
})
