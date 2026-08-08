import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  compareDefinitions,
  compileDefinition,
  createEventEnvelope,
  loadDefinitionDirectory,
} from '../src/index.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function baseline() {
  return loadDefinitionDirectory(path.join(packageRoot, 'definitions'))
}

test('foundation definition compiles with stable governed contracts', async () => {
  const definition = await baseline()
  const compiled = compileDefinition(definition)
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors))
  assert.match(compiled.bundle.contentHash, /^[0-9a-f]{64}$/)
  assert.ok(compiled.bundle.counts.object_type >= 30)
  assert.equal(compiled.bundle.counts.action_type, 2)
  assert.equal(compiled.bundle.definition.toolContracts.action.gateway, 'mandatory-action-gateway')
})

test('content hash is stable when named definitions and properties are reordered', async () => {
  const definition = await baseline()
  const reordered = structuredClone(definition)
  reordered.objectTypes.reverse()
  reordered.linkTypes.reverse()
  reordered.objectTypes[0].properties.reverse()
  const first = compileDefinition(definition)
  const second = compileDefinition(reordered)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.bundle.contentHash, second.bundle.contentHash)
})

test('compiler rejects dangling links and inheritance cycles', async () => {
  const definition = await baseline()
  definition.linkTypes[0].toType = 'core.identity.MissingDepartment'
  definition.objectTypes.find((entry) => entry.qualifiedName === 'system.ontology.BaseObject').extends = ['core.work.Task']
  const compiled = compileDefinition(definition)
  assert.equal(compiled.ok, false)
  assert.ok(compiled.errors.some((entry) => entry.message.includes('unknown object type core.identity.MissingDepartment')))
  assert.ok(compiled.errors.some((entry) => entry.message.includes('inheritance cycle detected')))
})

test('compiler rejects action and tool paths that bypass mandatory gateways', async () => {
  const definition = await baseline()
  definition.actionTypes[0].gateway = 'direct-erp-client'
  definition.toolContracts.action.directWrite = true
  const compiled = compileDefinition(definition)
  assert.equal(compiled.ok, false)
  assert.ok(compiled.errors.some((entry) => entry.path.endsWith('.gateway')))
  assert.ok(compiled.errors.some((entry) => entry.path === 'toolContracts.action.directWrite'))
})

test('compatibility requires migration for removals and new required properties', async () => {
  const previous = await baseline()
  const current = structuredClone(previous)
  current.objectTypes.find((entry) => entry.qualifiedName === 'core.work.Task').properties.push({
    name: 'mandatoryResultFormat', type: 'string', required: true,
  })
  current.linkTypes = current.linkTypes.filter((entry) => entry.qualifiedName !== 'core.work.PRODUCES')
  const before = compileDefinition(previous)
  const after = compileDefinition(current)
  assert.equal(after.ok, true)
  const compatibility = compareDefinitions(before.bundle.definition, after.bundle.definition)
  assert.equal(compatibility.classification, 'migration_required')
  assert.ok(compatibility.changes.some((entry) => entry.message === 'required property added'))
  assert.ok(compatibility.changes.some((entry) => entry.message === 'element removed'))
})

test('event envelope normalizes time and rejects unsafe identifiers', () => {
  const envelope = createEventEnvelope({
    eventId: 'event-001',
    eventType: 'ontology.version.deployed',
    occurredAt: '2026-08-08T10:00:00+08:00',
    producer: 'ontology-registry',
    principal: 'service:ontology-registry',
    purpose: 'ontology-governance',
    correlationId: 'proposal-001',
    causationId: null,
    idempotencyKey: 'ontology-version-hash',
    payloadSchemaVersion: '1.0.0',
    ontologyVersion: '3.0.0+abcdef123456',
    classification: 'internal',
    payload: { contentHash: 'abcdef' },
  }, { now: () => new Date('2026-08-08T10:00:01+08:00') })
  assert.equal(envelope.occurredAt, '2026-08-08T02:00:00.000Z')
  assert.equal(envelope.receivedAt, '2026-08-08T02:00:01.000Z')
  assert.throws(() => createEventEnvelope({ ...envelope, eventId: '../unsafe' }), /unsupported characters/)
})
