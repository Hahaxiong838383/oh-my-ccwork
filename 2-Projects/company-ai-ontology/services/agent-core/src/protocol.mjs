import crypto from 'node:crypto'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}
export function signatureFor({ body, timestamp, requestId, tenantId, personId, idempotencyKey, secret }) {
  const canonical = [timestamp, requestId, tenantId, personId, idempotencyKey, sha256(body)].join('\n')
  return `v1=${crypto.createHmac('sha256', secret).update(canonical).digest('hex')}`
}

function safeEqual(actual, expected) {
  const got = Buffer.from(String(actual || ''))
  const want = Buffer.from(String(expected || ''))
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

function requireHeader(headers, name) {
  const value = String(headers[name] || '').trim()
  if (!value) throw Object.assign(new Error(`${name} is required`), { statusCode: 401, code: 'unauthorized' })
  return value
}

export function verifySignedRequest({ headers, body, secret, now = Date.now(), maxClockSkewMs = 300_000 }) {
  const timestamp = requireHeader(headers, 'x-company-timestamp')
  const requestId = requireHeader(headers, 'x-company-request-id')
  const tenantId = requireHeader(headers, 'x-company-tenant-id')
  const personId = requireHeader(headers, 'x-company-person-id')
  const idempotencyKey = requireHeader(headers, 'x-company-idempotency-key')
  const signature = requireHeader(headers, 'x-company-signature')
  const numericTimestamp = Number(timestamp)

  if (!Number.isFinite(numericTimestamp) || Math.abs(now - numericTimestamp) > maxClockSkewMs) {
    throw Object.assign(new Error('request timestamp is outside the allowed window'), { statusCode: 401, code: 'stale_request' })
  }
  if (!UUID_RE.test(tenantId)) {
    throw Object.assign(new Error('invalid tenant scope'), { statusCode: 401, code: 'unauthorized' })
  }
  for (const [name, value] of [['requestId', requestId], ['personId', personId], ['idempotencyKey', idempotencyKey]]) {
    if (!SAFE_ID_RE.test(value)) {
      throw Object.assign(new Error(`invalid ${name}`), { statusCode: 400, code: 'invalid_request' })
    }
  }

  const expected = signatureFor({ body, timestamp, requestId, tenantId, personId, idempotencyKey, secret })
  if (!safeEqual(signature, expected)) {
    throw Object.assign(new Error('invalid request signature'), { statusCode: 401, code: 'unauthorized' })
  }
  return { timestamp: numericTimestamp, requestId, tenantId, personId, idempotencyKey }
}

export function parseTurnBody(body) {
  let input
  try {
    input = JSON.parse(body)
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400, code: 'invalid_request' })
  }
  const conversationId = String(input?.conversationId || '').trim()
  const message = String(input?.message || '').trim()
  const intent = String(input?.intent || 'query').trim().toLowerCase()
  const channel = String(input?.channel || 'h-lite').trim().toLowerCase()
  if (!SAFE_ID_RE.test(conversationId)) {
    throw Object.assign(new Error('invalid conversationId'), { statusCode: 400, code: 'invalid_request' })
  }
  if (!message || message.length > 120_000) {
    throw Object.assign(new Error('message is required and must not exceed 120000 characters'), { statusCode: 400, code: 'invalid_request' })
  }
  if (!['query', 'decision', 'task_assist'].includes(intent)) {
    throw Object.assign(new Error('unsupported intent'), { statusCode: 400, code: 'invalid_request' })
  }
  if (!/^[a-z0-9_.-]{1,64}$/.test(channel)) {
    throw Object.assign(new Error('invalid channel'), { statusCode: 400, code: 'invalid_request' })
  }
  return {
    conversationId,
    message,
    intent,
    channel,
    context: input?.context && typeof input.context === 'object' && !Array.isArray(input.context) ? input.context : {},
  }
}
