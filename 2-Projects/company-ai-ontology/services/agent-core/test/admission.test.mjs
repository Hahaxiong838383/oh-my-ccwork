import test from 'node:test'
import assert from 'node:assert/strict'

import { createAdmissionController } from '../src/admission.mjs'

test('并发准入限制活动数、队列长度并在释放后继续', async () => {
  const admission = createAdmissionController({ maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 1000 })
  const releaseFirst = await admission.acquire()
  const second = admission.acquire()
  await assert.rejects(admission.acquire(), (error) => error.code === 'h_engine_overloaded' && error.statusCode === 429)
  assert.deepEqual(admission.snapshot(), { active: 1, queued: 1, maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 1000 })
  releaseFirst()
  const releaseSecond = await second
  assert.equal(admission.snapshot().active, 1)
  releaseSecond()
  assert.equal(admission.snapshot().active, 0)
})

test('排队超过上限时间返回可识别超时', async () => {
  const admission = createAdmissionController({ maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 20 })
  const release = await admission.acquire()
  await assert.rejects(admission.acquire(), (error) => error.code === 'h_engine_queue_timeout' && error.statusCode === 429)
  release()
})
