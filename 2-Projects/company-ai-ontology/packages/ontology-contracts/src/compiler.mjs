import { contentHash, normalizeDefinition } from './canonical.mjs'

const NAMESPACE_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/
const QUALIFIED_NAME_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+\.[A-Za-z][A-Za-z0-9_]*$/
const PROPERTY_RE = /^[a-z][A-Za-z0-9]*$/
const PRIMITIVES = new Set(['string', 'boolean', 'integer', 'decimal', 'timestamp', 'uuid', 'json', 'string[]', 'uuid[]'])
const ELEMENT_GROUPS = [
  ['object_type', 'objectTypes'],
  ['link_type', 'linkTypes'],
  ['function_type', 'functionTypes'],
  ['action_type', 'actionTypes'],
  ['policy_type', 'policyTypes'],
  ['constraint_type', 'constraintTypes'],
]
const EVENT_FIELDS = [
  'eventId', 'eventType', 'occurredAt', 'receivedAt', 'producer', 'principal', 'purpose',
  'correlationId', 'causationId', 'idempotencyKey', 'payloadSchemaVersion', 'ontologyVersion', 'classification',
]

function pushError(errors, path, message) {
  errors.push({ path, message })
}

function namespaceOf(qualifiedName) {
  return String(qualifiedName || '').split('.').slice(0, -1).join('.')
}

function validateQualifiedName(value, path, namespaces, errors) {
  if (!QUALIFIED_NAME_RE.test(String(value || ''))) {
    pushError(errors, path, 'must be a qualified name such as core.work.Task')
    return false
  }
  if (!namespaces.has(namespaceOf(value))) {
    pushError(errors, path, `references undeclared namespace ${namespaceOf(value)}`)
    return false
  }
  return true
}

function validateValueType(type, path, objectNames, errors) {
  if (PRIMITIVES.has(type)) return
  if (!objectNames.has(type)) pushError(errors, path, `unknown value type ${type}`)
}

function validateProperties(properties, path, objectNames, errors) {
  const names = new Set()
  if (!Array.isArray(properties)) {
    pushError(errors, path, 'must be an array')
    return
  }
  properties.forEach((property, index) => {
    const propertyPath = `${path}[${index}]`
    if (!PROPERTY_RE.test(String(property?.name || ''))) pushError(errors, `${propertyPath}.name`, 'must be lower camel case')
    if (names.has(property?.name)) pushError(errors, `${propertyPath}.name`, `duplicate property ${property?.name}`)
    names.add(property?.name)
    validateValueType(property?.type, `${propertyPath}.type`, objectNames, errors)
    if (typeof property?.required !== 'boolean') pushError(errors, `${propertyPath}.required`, 'must be boolean')
  })
}

function validateInheritance(objectTypes, objectNames, errors) {
  const parents = new Map(objectTypes.map((objectType) => [objectType.qualifiedName, objectType.extends || []]))
  for (const [name, extended] of parents) {
    if (!Array.isArray(extended)) {
      pushError(errors, `${name}.extends`, 'must be an array')
      continue
    }
    for (const parent of extended) if (!objectNames.has(parent)) pushError(errors, `${name}.extends`, `unknown parent type ${parent}`)
  }
  const visiting = new Set()
  const visited = new Set()
  function visit(name, trail = []) {
    if (visiting.has(name)) {
      pushError(errors, `${name}.extends`, `inheritance cycle detected: ${[...trail, name].join(' -> ')}`)
      return
    }
    if (visited.has(name)) return
    visiting.add(name)
    for (const parent of parents.get(name) || []) visit(parent, [...trail, name])
    visiting.delete(name)
    visited.add(name)
  }
  for (const name of parents.keys()) visit(name)
}

function validateToolContracts(toolContracts, errors) {
  const expected = {
    data: ['permissioned-retrieval-gateway', false],
    logic: ['logic-function-gateway', false],
    action: ['mandatory-action-gateway', false],
  }
  for (const [kind, [gateway, directWrite]] of Object.entries(expected)) {
    const contract = toolContracts?.[kind]
    if (!contract || typeof contract !== 'object') {
      pushError(errors, `toolContracts.${kind}`, 'is required')
      continue
    }
    if (contract.gateway !== gateway) pushError(errors, `toolContracts.${kind}.gateway`, `must be ${gateway}`)
    if (Boolean(contract.directDatabaseAccess) !== directWrite) pushError(errors, `toolContracts.${kind}.directDatabaseAccess`, 'must be false')
  }
  if (toolContracts?.logic?.directWrite !== false) pushError(errors, 'toolContracts.logic.directWrite', 'must be false')
  if (toolContracts?.action?.directWrite !== false) pushError(errors, 'toolContracts.action.directWrite', 'must be false')
  if (toolContracts?.action?.approvalRequired !== true) pushError(errors, 'toolContracts.action.approvalRequired', 'must be true')
}

function validateEventEnvelope(eventEnvelope, errors) {
  if (!eventEnvelope || typeof eventEnvelope !== 'object') {
    pushError(errors, 'eventEnvelope', 'is required')
    return
  }
  const fields = new Set(eventEnvelope.requiredFields || [])
  for (const field of EVENT_FIELDS) if (!fields.has(field)) pushError(errors, 'eventEnvelope.requiredFields', `missing ${field}`)
  for (const field of fields) {
    if (!PROPERTY_RE.test(field)) pushError(errors, 'eventEnvelope.requiredFields', `invalid field ${field}`)
    if (!eventEnvelope.fieldTypes?.[field]) pushError(errors, `eventEnvelope.fieldTypes.${field}`, 'type is required')
  }
}

function flattenElements(definition) {
  return ELEMENT_GROUPS.flatMap(([kind, key]) => (definition[key] || []).map((element) => ({
    kind,
    qualifiedName: element.qualifiedName,
    definition: element,
    definitionHash: contentHash(element),
  })))
}

export function compileDefinition(input) {
  const errors = []
  const warnings = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ path: '$', message: 'definition must be an object' }], warnings, bundle: null }
  }
  if (input.formatVersion !== '1') pushError(errors, 'formatVersion', 'must equal 1')
  if (!/^\d+\.\d+\.\d+$/.test(String(input.schemaVersion || ''))) pushError(errors, 'schemaVersion', 'must be semantic version x.y.z')

  const namespaces = new Set()
  if (!Array.isArray(input.namespaces) || input.namespaces.length === 0) pushError(errors, 'namespaces', 'must be a non-empty array')
  for (const [index, namespace] of (input.namespaces || []).entries()) {
    if (!NAMESPACE_RE.test(String(namespace?.name || ''))) pushError(errors, `namespaces[${index}].name`, 'must contain at least two lowercase segments')
    if (namespaces.has(namespace?.name)) pushError(errors, `namespaces[${index}].name`, `duplicate namespace ${namespace?.name}`)
    namespaces.add(namespace?.name)
  }

  const allNames = new Map()
  for (const [kind, key] of ELEMENT_GROUPS) {
    if (!Array.isArray(input[key])) {
      pushError(errors, key, 'must be an array')
      continue
    }
    input[key].forEach((element, index) => {
      const path = `${key}[${index}].qualifiedName`
      if (!validateQualifiedName(element?.qualifiedName, path, namespaces, errors)) return
      if (allNames.has(element.qualifiedName)) pushError(errors, path, `duplicate element also used by ${allNames.get(element.qualifiedName)}`)
      allNames.set(element.qualifiedName, kind)
    })
  }

  const objectTypes = input.objectTypes || []
  const objectNames = new Set(objectTypes.map((entry) => entry.qualifiedName))
  objectTypes.forEach((objectType, index) => validateProperties(objectType.properties, `objectTypes[${index}].properties`, objectNames, errors))
  validateInheritance(objectTypes, objectNames, errors)

  ;(input.linkTypes || []).forEach((link, index) => {
    if (!objectNames.has(link.fromType)) pushError(errors, `linkTypes[${index}].fromType`, `unknown object type ${link.fromType}`)
    if (!objectNames.has(link.toType)) pushError(errors, `linkTypes[${index}].toType`, `unknown object type ${link.toType}`)
    if (!['one_to_one', 'one_to_many', 'many_to_many'].includes(link.cardinality)) pushError(errors, `linkTypes[${index}].cardinality`, 'unsupported cardinality')
  })

  for (const [key, elements] of [['functionTypes', input.functionTypes || []]]) {
    elements.forEach((element, index) => {
      validateProperties(element.inputs, `${key}[${index}].inputs`, objectNames, errors)
      validateProperties(element.outputs, `${key}[${index}].outputs`, objectNames, errors)
      if (element.deterministic !== true) warnings.push({ path: `${key}[${index}].deterministic`, message: 'non-deterministic logic must not be treated as a source of truth' })
    })
  }

  ;(input.actionTypes || []).forEach((action, index) => {
    if (!objectNames.has(action.targetType)) pushError(errors, `actionTypes[${index}].targetType`, `unknown object type ${action.targetType}`)
    if (action.effect !== 'write') pushError(errors, `actionTypes[${index}].effect`, 'must equal write')
    if (action.gateway !== 'mandatory-action-gateway') pushError(errors, `actionTypes[${index}].gateway`, 'must use mandatory-action-gateway')
    if (action.approval !== 'required') pushError(errors, `actionTypes[${index}].approval`, 'must require approval')
    validateProperties(action.inputs, `actionTypes[${index}].inputs`, objectNames, errors)
  })

  ;(input.policyTypes || []).forEach((policy, index) => {
    if (!Array.isArray(policy.appliesTo) || policy.appliesTo.length === 0) pushError(errors, `policyTypes[${index}].appliesTo`, 'must be a non-empty array')
    for (const target of policy.appliesTo || []) if (!objectNames.has(target)) pushError(errors, `policyTypes[${index}].appliesTo`, `unknown object type ${target}`)
    if (!['allow', 'deny', 'filter'].includes(policy.effect)) pushError(errors, `policyTypes[${index}].effect`, 'unsupported policy effect')
  })

  ;(input.constraintTypes || []).forEach((constraint, index) => {
    if (!objectNames.has(constraint.targetType)) pushError(errors, `constraintTypes[${index}].targetType`, `unknown object type ${constraint.targetType}`)
    if (!['error', 'warning'].includes(constraint.severity)) pushError(errors, `constraintTypes[${index}].severity`, 'must be error or warning')
    if (!String(constraint.rule || '').trim()) pushError(errors, `constraintTypes[${index}].rule`, 'is required')
  })

  validateToolContracts(input.toolContracts, errors)
  validateEventEnvelope(input.eventEnvelope, errors)
  if (errors.length > 0) return { ok: false, errors, warnings, bundle: null }

  const definition = normalizeDefinition(input)
  const elements = flattenElements(definition)
  return {
    ok: true,
    errors,
    warnings,
    bundle: {
      schemaVersion: definition.schemaVersion,
      contentHash: contentHash(definition),
      definition,
      elements,
      counts: Object.fromEntries(ELEMENT_GROUPS.map(([kind, key]) => [kind, definition[key].length])),
    },
  }
}

export const ontologyPrimitives = Object.freeze([...PRIMITIVES])
