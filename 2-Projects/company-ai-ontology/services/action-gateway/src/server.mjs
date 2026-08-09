import crypto from 'node:crypto'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

import { loadActionGatewayConfig } from './config.mjs'
import { createActionGatewayStore } from './store.mjs'

export const ACTION_GATEWAY_VERSION = '2026-08-09.2'

function json(response, statusCode, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

function safeEqual(actual, expected) {
  const got = Buffer.from(String(actual || ''))
  const want = Buffer.from(String(expected || ''))
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

async function readJson(request, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error('payload too large'), { statusCode: 413, code: 'payload_too_large' })
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw Object.assign(new Error('invalid JSON'), { statusCode: 400, code: 'invalid_request' })
  }
}

function intentId(value) {
  const text = String(value || '').trim()
  if (!/^[0-9a-f-]{36}$/i.test(text)) throw Object.assign(new Error('invalid intentId'), { statusCode: 400, code: 'invalid_request' })
  return text
}

export function createActionGatewayServer({ config, store, logger = () => {} } = {}) {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        json(response, 200, { ok: true, status: 'live', component: 'mandatory-action-gateway', version: ACTION_GATEWAY_VERSION })
        return
      }
      if (request.method === 'GET' && request.url === '/readyz') {
        const database = await store.ready()
        json(response, database.ready ? 200 : 503, { ok: database.ready, status: database.ready ? 'ready' : 'not_ready', database, version: ACTION_GATEWAY_VERSION })
        return
      }
      if (request.method !== 'POST' || !['/v1/actions/dry-run', '/v1/actions/approve', '/v1/actions/execute', '/v1/actions/verify-outcome', '/v1/actions/rollback', '/v1/actions/get'].includes(request.url)) {
        json(response, 404, { ok: false, status: 'not_found' })
        return
      }
      if (!safeEqual(request.headers['x-action-gateway-token'], config.controlToken)) {
        json(response, 401, { ok: false, status: 'unauthorized' })
        return
      }
      const input = await readJson(request, config.maxBodyBytes)
      const common = { tenantId: config.tenantId, intentId: intentId(input.intentId) }
      let action
      if (request.url === '/v1/actions/dry-run') action = await store.dryRun(common)
      if (request.url === '/v1/actions/approve') action = await store.approve({ ...common, actorPersonId: String(input.actorPersonId || '') })
      if (request.url === '/v1/actions/execute') action = await store.execute(common)
      if (request.url === '/v1/actions/verify-outcome') action = await store.verifyOutcome({
        ...common,
        actorPersonId: String(input.actorPersonId || ''),
        operationalSuccess: input.operationalSuccess === true,
        goalSuccess: input.goalSuccess === true,
        evidenceReferences: Array.isArray(input.evidenceReferences) ? input.evidenceReferences.map(String) : [],
        sourceSystem: String(input.sourceSystem || 'human-verification'),
        sourceReference: String(input.sourceReference || ''),
        observedValue: input.observedValue,
        observedText: String(input.observedText || ''),
        confidenceLevel: String(input.confidenceLevel || 'medium'),
        notes: String(input.notes || ''),
      })
      if (request.url === '/v1/actions/rollback') action = await store.rollback({ ...common, actorPersonId: String(input.actorPersonId || '') })
      if (request.url === '/v1/actions/get') action = await store.get(common)
      json(response, 200, { ok: true, status: action.status || action.verification_status, simulation: action.simulation === true, action })
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500)
      if (statusCode >= 500) logger('action gateway request failed', String(error?.message || error).slice(0, 160))
      json(response, statusCode, {
        ok: false,
        status: String(error?.code || 'internal_error'),
        message: statusCode >= 500 ? 'internal server error' : String(error?.message || error),
      })
    }
  })
}

export async function startActionGateway(env = process.env) {
  const config = loadActionGatewayConfig(env)
  const logger = (...args) => console.error(new Date().toISOString(), ...args)
  const store = createActionGatewayStore({ database: config.database, logger })
  const server = createActionGatewayServer({ config, store, logger })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, resolve)
  })
  logger('mandatory-action-gateway listening', `${config.host}:${config.port}`, ACTION_GATEWAY_VERSION)
  const shutdown = () => server.close(() => store.close().finally(() => process.exit(0)))
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return { server, store, config }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  startActionGateway().catch((error) => {
    console.error(new Date().toISOString(), 'mandatory-action-gateway startup failed', String(error?.message || error))
    process.exit(1)
  })
}
