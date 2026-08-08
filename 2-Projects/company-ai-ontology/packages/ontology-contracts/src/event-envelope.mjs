const SAFE_ID_RE = /^[A-Za-z0-9_.:@-]{1,160}$/
const CLASSIFICATIONS = new Set(['public', 'internal', 'confidential', 'restricted'])

function requiredText(value, name, max = 160) {
  const text = String(value || '').trim()
  if (!text || text.length > max) throw new Error(`${name} is required and must not exceed ${max} characters`)
  return text
}

function safeId(value, name) {
  const text = requiredText(value, name)
  if (!SAFE_ID_RE.test(text)) throw new Error(`${name} contains unsupported characters`)
  return text
}

function timestamp(value, name) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new Error(`${name} must be a valid timestamp`)
  return parsed.toISOString()
}

export function createEventEnvelope(input, { now = () => new Date() } = {}) {
  const classification = String(input?.classification || 'internal')
  if (!CLASSIFICATIONS.has(classification)) throw new Error('classification is invalid')
  const payload = input?.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {}
  return Object.freeze({
    eventId: safeId(input?.eventId, 'eventId'),
    eventType: safeId(input?.eventType, 'eventType'),
    occurredAt: timestamp(input?.occurredAt, 'occurredAt'),
    receivedAt: timestamp(input?.receivedAt || now(), 'receivedAt'),
    producer: safeId(input?.producer, 'producer'),
    principal: safeId(input?.principal, 'principal'),
    purpose: safeId(input?.purpose, 'purpose'),
    correlationId: safeId(input?.correlationId, 'correlationId'),
    causationId: input?.causationId ? safeId(input.causationId, 'causationId') : null,
    idempotencyKey: safeId(input?.idempotencyKey, 'idempotencyKey'),
    payloadSchemaVersion: requiredText(input?.payloadSchemaVersion, 'payloadSchemaVersion', 32),
    ontologyVersion: requiredText(input?.ontologyVersion, 'ontologyVersion', 96),
    classification,
    payload,
  })
}
