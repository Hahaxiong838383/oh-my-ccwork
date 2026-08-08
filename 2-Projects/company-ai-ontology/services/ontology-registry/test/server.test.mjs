import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadDefinitionDirectory } from '@futurus/ontology-contracts'

import { createOntologyRegistryServer } from '../src/server.mjs'
import { createMemoryRegistryStore } from '../src/store.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const definitionsDir = path.join(projectRoot, 'packages/ontology-contracts/definitions')
const token = 'registry-control-token-that-is-long-enough'

function config(overrides = {}) {
  return {
    tenantId: '00000000-0000-4000-8000-000000000001',
    controlToken: token,
    definitionsDir,
    maxBodyBytes: 1_048_576,
    ...overrides,
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function request(port, { method = 'GET', path: requestPath = '/', body = '', authorized = true } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers: {
        ...(authorized ? { 'x-ontology-registry-token': token } : {}),
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

test('registry bootstraps only with explicit proposal, approval and commit', async (t) => {
  const store = createMemoryRegistryStore()
  const server = createOntologyRegistryServer({ config: config(), store })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = await listen(server)

  const health = await request(port, { path: '/healthz', authorized: false })
  const readyBefore = await request(port, { path: '/readyz', authorized: false })
  const unauthorized = await request(port, { path: '/v1/registry/active', authorized: false })
  const invalidDeploy = await request(port, { method: 'POST', path: '/v1/deploy', body: '{}' })
  const deployed = await request(port, {
    method: 'POST',
    path: '/v1/deploy',
    body: JSON.stringify({ proposalId: 'ontology-p0-s-bootstrap', approvedBy: 'ontology-owner', sourceCommit: 'abcdef1' }),
  })
  const readyAfter = await request(port, { path: '/readyz', authorized: false })
  const reconciled = await request(port, { path: '/v1/reconcile' })

  assert.equal(health.status, 200)
  assert.equal(readyBefore.status, 503)
  assert.equal(readyBefore.payload.status, 'bootstrap_required')
  assert.equal(unauthorized.status, 401)
  assert.equal(invalidDeploy.status, 400)
  assert.equal(deployed.status, 200)
  assert.equal(deployed.payload.status, 'deployed')
  assert.equal(deployed.payload.compatibility.classification, 'bootstrap')
  assert.match(deployed.payload.active.contentHash, /^[0-9a-f]{64}$/)
  assert.equal(readyAfter.status, 200)
  assert.equal(readyAfter.payload.status, 'in_sync')
  assert.equal(reconciled.status, 200)
  assert.equal(store.state.events[0].eventType, 'ontology_version_deployed')
})

test('compile endpoint accepts candidates but deploy always uses bundled definition', async (t) => {
  const store = createMemoryRegistryStore()
  let localDefinition = await loadDefinitionDirectory(definitionsDir)
  const server = createOntologyRegistryServer({
    config: config(),
    store,
    definitionProvider: async () => structuredClone(localDefinition),
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = await listen(server)

  await request(port, {
    method: 'POST', path: '/v1/deploy',
    body: JSON.stringify({ proposalId: 'bootstrap-001', approvedBy: 'ontology-owner', sourceCommit: 'abcdef1' }),
  })
  const candidate = structuredClone(localDefinition)
  candidate.objectTypes.find((entry) => entry.qualifiedName === 'core.work.Task').properties.push({
    name: 'newRequiredField', type: 'string', required: true,
  })
  const compiled = await request(port, {
    method: 'POST', path: '/v1/compile', body: JSON.stringify({ definition: candidate }),
  })
  assert.equal(compiled.status, 200)
  assert.equal(compiled.payload.compatibility.classification, 'migration_required')

  localDefinition = candidate
  const blocked = await request(port, {
    method: 'POST', path: '/v1/deploy',
    body: JSON.stringify({ proposalId: 'migration-001', approvedBy: 'ontology-owner', sourceCommit: 'abcdef2' }),
  })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.payload.status, 'migration_approval_required')

  const missingPlan = await request(port, {
    method: 'POST', path: '/v1/deploy',
    body: JSON.stringify({ proposalId: 'migration-001', approvedBy: 'ontology-owner', sourceCommit: 'abcdef2', allowMigration: true }),
  })
  assert.equal(missingPlan.status, 400)
  assert.equal(missingPlan.payload.status, 'migration_plan_required')

  const deployed = await request(port, {
    method: 'POST', path: '/v1/deploy',
    body: JSON.stringify({
      proposalId: 'migration-001', approvedBy: 'ontology-owner', sourceCommit: 'abcdef2', allowMigration: true,
      migrationPlan: { steps: ['backfill newRequiredField', 'verify null count is zero'] },
    }),
  })
  assert.equal(deployed.status, 200)
  assert.equal(deployed.payload.compatibility.classification, 'migration_required')
})

test('contracts endpoint exposes only governed tool and event contracts', async (t) => {
  const server = createOntologyRegistryServer({ config: config(), store: createMemoryRegistryStore() })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = await listen(server)
  const response = await request(port, { path: '/v1/contracts' })
  assert.equal(response.status, 200)
  assert.equal(response.payload.toolContracts.data.gateway, 'permissioned-retrieval-gateway')
  assert.equal(response.payload.toolContracts.action.gateway, 'mandatory-action-gateway')
  assert.equal(response.payload.toolContracts.action.directWrite, false)
  assert.ok(response.payload.eventEnvelope.requiredFields.includes('ontologyVersion'))
})

test('registry reactivates a historical version without duplicating it', async (t) => {
  const store = createMemoryRegistryStore()
  const baseline = await loadDefinitionDirectory(definitionsDir)
  const candidate = structuredClone(baseline)
  candidate.objectTypes.find((entry) => entry.qualifiedName === 'core.work.Task').properties.push({
    name: 'optionalRolloutNote', type: 'string', required: false,
  })
  let localDefinition = baseline
  const server = createOntologyRegistryServer({
    config: config(),
    store,
    definitionProvider: async () => structuredClone(localDefinition),
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = await listen(server)

  const first = await request(port, {
    method: 'POST', path: '/v1/deploy',
    body: JSON.stringify({ proposalId: 'bootstrap-a', approvedBy: 'ontology-owner', sourceCommit: 'abcdef1' }),
  })
  localDefinition = candidate
  const second = await request(port, {
    method: 'POST', path: '/v1/deploy',
    body: JSON.stringify({ proposalId: 'deploy-b', approvedBy: 'ontology-owner', sourceCommit: 'abcdef2' }),
  })
  localDefinition = baseline
  const reactivated = await request(port, {
    method: 'POST', path: '/v1/deploy',
    body: JSON.stringify({
      proposalId: 'rollback-a', approvedBy: 'ontology-owner', sourceCommit: 'abcdef3', allowMigration: true,
      migrationPlan: { steps: ['confirm optional field is unused', 'reactivate previous definition'] },
    }),
  })

  assert.equal(first.payload.status, 'deployed')
  assert.equal(second.payload.status, 'deployed')
  assert.equal(reactivated.payload.status, 'reactivated')
  assert.equal(reactivated.payload.active.id, first.payload.active.id)
  assert.equal(store.state.versions.length, 2)
  assert.equal(store.state.versions.filter((version) => version.status === 'active').length, 1)
  assert.equal(store.state.events.at(-1).reactivated, true)
})

test('concurrent deploy requests converge on one active version', async (t) => {
  const store = createMemoryRegistryStore()
  const server = createOntologyRegistryServer({ config: config(), store })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = await listen(server)
  const payload = JSON.stringify({ proposalId: 'concurrent-bootstrap', approvedBy: 'ontology-owner', sourceCommit: 'abcdef1' })

  const responses = await Promise.all([
    request(port, { method: 'POST', path: '/v1/deploy', body: payload }),
    request(port, { method: 'POST', path: '/v1/deploy', body: payload }),
  ])

  assert.deepEqual(responses.map((response) => response.status), [200, 200])
  assert.deepEqual(new Set(responses.map((response) => response.payload.status)), new Set(['deployed', 'already_active']))
  assert.equal(store.state.versions.length, 1)
  assert.equal(store.state.versions.filter((version) => version.status === 'active').length, 1)
})

test('reconciliation records drift and oversized payloads fail closed', async (t) => {
  const store = createMemoryRegistryStore()
  const baseline = await loadDefinitionDirectory(definitionsDir)
  let localDefinition = baseline
  const server = createOntologyRegistryServer({
    config: config({ maxBodyBytes: 128 }),
    store,
    definitionProvider: async () => structuredClone(localDefinition),
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = await listen(server)

  await request(port, {
    method: 'POST', path: '/v1/deploy',
    body: JSON.stringify({ proposalId: 'bootstrap-drift', approvedBy: 'ontology-owner', sourceCommit: 'abcdef1' }),
  })
  localDefinition = structuredClone(baseline)
  localDefinition.objectTypes.find((entry) => entry.qualifiedName === 'core.work.Task').properties.push({
    name: 'driftMarker', type: 'string', required: false,
  })
  const drift = await request(port, { path: '/v1/reconcile' })
  const oversized = await request(port, {
    method: 'POST', path: '/v1/compile',
    body: JSON.stringify({ definition: { padding: 'x'.repeat(256) } }),
  })

  assert.equal(drift.status, 503)
  assert.equal(drift.payload.status, 'drift')
  assert.equal(store.state.reconciliations.at(-1).status, 'drift')
  assert.equal(oversized.status, 413)
  assert.equal(oversized.payload.status, 'payload_too_large')
})
