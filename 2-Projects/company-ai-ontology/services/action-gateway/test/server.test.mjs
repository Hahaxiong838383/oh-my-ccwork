import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createActionGatewayServer } from '../src/server.mjs'

const tenantId = '11111111-1111-4111-8111-111111111111'
const controlToken = 't'.repeat(48)
const actionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function request(port, path, body, token = controlToken) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'x-action-gateway-token': token },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

test('Action Gateway 强制令牌并按 dry-run 到 rollback 顺序执行', async (t) => {
  let status = 'proposed'
  const calls = []
  const store = {
    ready: async () => ({ ready: true }),
    dryRun: async () => { calls.push('dry-run'); status = 'dry_run_ready'; return { id: actionId, status } },
    approve: async ({ actorPersonId }) => { calls.push(`approve:${actorPersonId}`); status = 'approved'; return { id: actionId, status } },
    execute: async () => { calls.push('execute'); status = 'verified'; return { id: actionId, status, readback_receipt: { verified: true } } },
    verifyOutcome: async ({ actorPersonId, operationalSuccess, goalSuccess }) => {
      calls.push(`verify:${actorPersonId}:${operationalSuccess}:${goalSuccess}`)
      if (goalSuccess && !operationalSuccess) throw Object.assign(new Error('goal success requires operational success'), { statusCode: 409, code: 'invalid_outcome_levels' })
      return { id: 'verification-1', verification_status: 'completed', simulation: true }
    },
    rollback: async ({ actorPersonId }) => { calls.push(`rollback:${actorPersonId}`); status = 'rolled_back'; return { id: actionId, status, rollback_receipt: { verified: true } } },
    get: async () => ({ id: actionId, status }),
  }
  const server = createActionGatewayServer({ config: { tenantId, controlToken, maxBodyBytes: 131_072 }, store })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port
  const unauthorized = await request(port, '/v1/actions/dry-run', { intentId: actionId }, 'bad')
  assert.equal(unauthorized.status, 401)
  assert.equal((await request(port, '/v1/actions/dry-run', { intentId: actionId })).payload.status, 'dry_run_ready')
  assert.equal((await request(port, '/v1/actions/approve', { intentId: actionId, actorPersonId: 'demo-dri-01' })).payload.status, 'approved')
  assert.equal((await request(port, '/v1/actions/execute', { intentId: actionId })).payload.status, 'verified')
  const invalid = await request(port, '/v1/actions/verify-outcome', {
    intentId: actionId,
    actorPersonId: 'demo-dri-01',
    operationalSuccess: false,
    goalSuccess: true,
    evidenceReferences: ['evidence:invalid'],
  })
  assert.equal(invalid.status, 409)
  assert.equal(invalid.payload.status, 'invalid_outcome_levels')
  assert.equal((await request(port, '/v1/actions/verify-outcome', {
    intentId: actionId,
    actorPersonId: 'demo-dri-01',
    operationalSuccess: true,
    goalSuccess: true,
    evidenceReferences: ['evidence:goal5'],
  })).payload.status, 'completed')
  assert.equal((await request(port, '/v1/actions/rollback', { intentId: actionId, actorPersonId: 'demo-dri-01' })).payload.status, 'rolled_back')
  assert.deepEqual(calls, [
    'dry-run',
    'approve:demo-dri-01',
    'execute',
    'verify:demo-dri-01:false:true',
    'verify:demo-dri-01:true:true',
    'rollback:demo-dri-01',
  ])
})
