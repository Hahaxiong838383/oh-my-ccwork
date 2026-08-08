import http from 'node:http'
import { pathToFileURL } from 'node:url'

import { loadConfig } from './config.mjs'
import { parseTurnBody, sha256, verifySignedRequest } from './protocol.mjs'
import { createHEngineRuntime } from './runtime.mjs'
import { createPostgresStore } from './store.mjs'
import { createAdmissionController } from './admission.mjs'

export const AGENT_CORE_CONTRACT_VERSION = '2026-08-08.4'

function json(response, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  response.end(body)
}

async function readBody(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) {
      throw Object.assign(new Error('request body is too large'), { statusCode: 413, code: 'payload_too_large' })
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function replayStatus(payload) {
  return payload?.status === 'runtime_not_ready' ? 503 : payload?.ok === false ? 500 : 200
}

function parseJson(body) {
  try {
    return JSON.parse(body)
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400, code: 'invalid_request' })
  }
}

function authenticate({ request, body, config, now }) {
  const scope = verifySignedRequest({
    headers: request.headers,
    body,
    secret: config.hmacSecret,
    now: now(),
    maxClockSkewMs: config.maxClockSkewMs,
  })
  if (scope.tenantId !== config.tenantId) {
    throw Object.assign(new Error('tenant is not allowed'), { statusCode: 403, code: 'forbidden' })
  }
  return scope
}

function normalizeDirectoryPeople(input) {
  if (!Array.isArray(input?.people) || input.people.length > 1000) {
    throw Object.assign(new Error('people must be an array with at most 1000 entries'), { statusCode: 400, code: 'invalid_request' })
  }
  const seen = new Set()
  return input.people.map((person) => {
    const personId = String(person?.personId || '').trim()
    const displayName = String(person?.displayName || '').trim()
    const departmentKey = String(person?.departmentKey || '').trim() || null
    if (!/^feishu:[A-Za-z0-9_-]{1,100}$/.test(personId) || !displayName || displayName.length > 128) {
      throw Object.assign(new Error('invalid directory person'), { statusCode: 400, code: 'invalid_request' })
    }
    if (departmentKey && !/^[A-Za-z0-9_-]{1,128}$/.test(departmentKey)) {
      throw Object.assign(new Error('invalid department key'), { statusCode: 400, code: 'invalid_request' })
    }
    if (seen.has(personId)) throw Object.assign(new Error('duplicate directory person'), { statusCode: 400, code: 'invalid_request' })
    seen.add(personId)
    const departmentIds = Array.isArray(person?.attributes?.departmentIds)
      ? person.attributes.departmentIds.map(String).filter((value) => /^[A-Za-z0-9_-]{1,128}$/.test(value)).slice(0, 32)
      : []
    return {
      personId,
      displayName,
      departmentKey,
      attributes: { source: 'feishu-directory', departmentIds },
    }
  })
}

export function createAgentCoreServer({ config, store, runtime, logger = () => {}, now = () => Date.now() } = {}) {
  const admission = createAdmissionController(config.admission || {})
  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        json(response, 200, {
          ok: true,
          status: 'live',
          component: 'company-agent-core',
          contractVersion: AGENT_CORE_CONTRACT_VERSION,
          admission: admission.snapshot(),
        })
        return
      }
      if (request.method === 'GET' && request.url === '/readyz') {
        const [database, engine] = await Promise.all([store.ready(), runtime.ready()])
        const ready = Boolean(database.ready && engine.ready)
        json(response, ready ? 200 : 503, {
          ok: ready,
          status: ready ? (engine.productionReady ? 'ready' : 'demo_ready') : 'runtime_not_ready',
          productionReady: Boolean(ready && engine.productionReady),
          database,
          runtime: engine,
          contractVersion: AGENT_CORE_CONTRACT_VERSION,
          admission: admission.snapshot(),
        })
        return
      }
      if (request.method === 'POST' && [
        '/v1/retrieve',
        '/v1/p2/compile',
        '/v1/tasks/transition',
        '/v1/delivery/demo-ack',
        '/v1/p2/tasks',
        '/v1/actions/propose',
        '/v1/privacy/my-data',
        '/v1/identity/sync',
      ].includes(request.url)) {
        const body = await readBody(request, config.maxBodyBytes)
        const scope = authenticate({ request, body, config, now })
        const input = parseJson(body)
        if (request.url === '/v1/identity/sync') {
          if (scope.personId !== 'company-directory-sync') {
            throw Object.assign(new Error('directory sync requires service identity'), { statusCode: 403, code: 'forbidden' })
          }
          const people = normalizeDirectoryPeople(input)
          const result = await store.syncPrincipals({ tenantId: scope.tenantId, people })
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'directory_principals_synced',
            payload: result,
          })
          json(response, 200, { ok: true, status: 'completed', requestId: scope.requestId, ...result })
          return
        }
        if (request.url === '/v1/retrieve') {
          const evidence = await store.permissionedSearch({
            tenantId: scope.tenantId,
            personId: scope.personId,
            query: input.query,
            limit: input.limit,
          })
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'permissioned_retrieval_completed',
            payload: { evidenceCount: evidence.length, classifications: [...new Set(evidence.map((item) => item.classification))] },
          })
          json(response, 200, {
            ok: true,
            status: 'completed',
            requestId: scope.requestId,
            permissionFiltered: true,
            evidence,
          })
          return
        }
        if (request.url === '/v1/p2/compile') {
          const tasks = await store.compileP2({
            tenantId: scope.tenantId,
            actorPersonId: scope.personId,
            p2ExternalKey: String(input.p2ExternalKey || 'demo-p2-2026-001'),
            assigneeCount: input.assigneeCount,
          })
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'p2_tasks_compiled',
            payload: { p2ExternalKey: input.p2ExternalKey || 'demo-p2-2026-001', taskCount: tasks.length, simulation: true },
          })
          json(response, 200, { ok: true, status: 'draft', requestId: scope.requestId, tasks })
          return
        }
        if (request.url === '/v1/tasks/transition') {
          const task = await store.transitionTask({
            tenantId: scope.tenantId,
            actorPersonId: scope.personId,
            taskExternalKey: String(input.taskExternalKey || ''),
            action: String(input.action || '').trim().toLowerCase(),
            resultText: input.resultText,
          })
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'task_transition_completed',
            payload: { taskExternalKey: task.external_key, status: task.status, simulation: true },
          })
          json(response, 200, { ok: true, status: task.status, requestId: scope.requestId, task })
          return
        }
        if (request.url === '/v1/delivery/demo-ack') {
          const deliveries = await store.ackDemoDeliveries({ tenantId: scope.tenantId })
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'demo_deliveries_acked',
            payload: { count: deliveries.length, simulation: true },
          })
          json(response, 200, { ok: true, status: 'acked', requestId: scope.requestId, deliveries })
          return
        }
        if (request.url === '/v1/actions/propose') {
          const action = await store.createActionIntent({
            tenantId: scope.tenantId,
            actorPersonId: scope.personId,
            targetSystem: String(input.targetSystem || ''),
            actionType: String(input.actionType || ''),
            payload: input.payload,
            riskLevel: String(input.riskLevel || 'low'),
            idempotencyKey: scope.idempotencyKey,
          })
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'action_intent_proposed',
            payload: { actionIntentId: action.id, targetSystem: action.target_system, actionType: action.action_type, simulation: true },
          })
          json(response, 200, { ok: true, status: action.status, requestId: scope.requestId, simulation: true, action })
          return
        }
        if (request.url === '/v1/privacy/my-data') {
          const data = await store.personDataSummary({ tenantId: scope.tenantId, personId: scope.personId })
          await store.audit({
            tenantId: scope.tenantId,
            requestId: scope.requestId,
            personId: scope.personId,
            eventType: 'personal_data_summary_viewed',
            payload: { simulation: Boolean(data.simulation) },
          })
          json(response, 200, { ok: true, status: 'completed', requestId: scope.requestId, data })
          return
        }
        const tasks = await store.listP2Tasks({
          tenantId: scope.tenantId,
          p2ExternalKey: String(input.p2ExternalKey || 'demo-p2-2026-001'),
        })
        json(response, 200, { ok: true, status: 'completed', requestId: scope.requestId, tasks })
        return
      }
      if (request.method !== 'POST' || request.url !== '/v1/turns') {
        json(response, 404, { ok: false, status: 'not_found' })
        return
      }

      const body = await readBody(request, config.maxBodyBytes)
      const scope = authenticate({ request, body, config, now })
      const turn = parseTurnBody(body)
      const requestHash = sha256(body)
      const namespace = 'agent-turn-v1'
      const claim = await store.claim({
        tenantId: scope.tenantId,
        namespace,
        idempotencyKey: scope.idempotencyKey,
        requestHash,
        expiresAt: new Date(now() + config.idempotencyTtlSeconds * 1000),
      })
      if (claim.kind === 'conflict') {
        json(response, 409, { ok: false, status: 'idempotency_conflict', requestId: scope.requestId })
        return
      }
      if (claim.kind === 'in_progress') {
        json(response, 409, { ok: false, status: 'request_in_progress', requestId: scope.requestId })
        return
      }
      if (claim.kind === 'replay') {
        json(response, replayStatus(claim.response), claim.response, { 'x-company-idempotent-replay': '1' })
        return
      }

      await store.audit({
        tenantId: scope.tenantId,
        requestId: scope.requestId,
        personId: scope.personId,
        eventType: 'agent_turn_received',
        payload: { intent: turn.intent, channel: turn.channel, requestHash },
      })

      const evidence = await store.permissionedSearch({
        tenantId: scope.tenantId,
        personId: scope.personId,
        query: turn.message,
        limit: 8,
      })

      const readiness = await runtime.ready()
      if (!readiness.ready) {
        const payload = {
          ok: false,
          status: 'runtime_not_ready',
          message: 'Company H Engine runtime is not ready',
          requestId: scope.requestId,
          runtime: readiness,
        }
        await store.finish({ tenantId: scope.tenantId, namespace, idempotencyKey: scope.idempotencyKey, status: 'failed', response: payload })
        await store.audit({
          tenantId: scope.tenantId,
          requestId: scope.requestId,
          personId: scope.personId,
          eventType: 'agent_turn_runtime_not_ready',
          payload: { reason: readiness.reason || 'unknown' },
        })
        json(response, 503, payload)
        return
      }

      try {
        const release = await admission.acquire()
        let result
        try {
          result = await runtime.run({ ...turn, evidence })
        } finally {
          release()
        }
        const payload = {
          ok: true,
          status: 'completed',
          requestId: scope.requestId,
          reply: String(result.reply || ''),
          permissionFiltered: true,
          evidence,
          runtime: result.runtime || readiness,
        }
        await store.finish({ tenantId: scope.tenantId, namespace, idempotencyKey: scope.idempotencyKey, status: 'completed', response: payload })
        await store.audit({
          tenantId: scope.tenantId,
          requestId: scope.requestId,
          personId: scope.personId,
          eventType: 'agent_turn_completed',
          payload: { provider: payload.runtime?.provider || 'unknown', evidenceCount: evidence.length },
        })
        json(response, 200, payload)
      } catch (error) {
        const payload = {
          ok: false,
          status: String(error?.code || 'runtime_failed'),
          message: 'Company H Engine runtime failed',
          requestId: scope.requestId,
        }
        await store.finish({ tenantId: scope.tenantId, namespace, idempotencyKey: scope.idempotencyKey, status: 'failed', response: payload })
        await store.audit({
          tenantId: scope.tenantId,
          requestId: scope.requestId,
          personId: scope.personId,
          eventType: 'agent_turn_failed',
          payload: { code: payload.status },
        })
        logger('agent turn failed', scope.requestId, payload.status)
        json(response, Number(error?.statusCode || 502), payload)
      }
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500)
      if (statusCode >= 500) logger('request failed', String(error?.message || error).slice(0, 160))
      json(response, statusCode, {
        ok: false,
        status: String(error?.code || 'internal_error'),
        message: statusCode >= 500 ? 'internal server error' : String(error?.message || error),
      })
    }
  })
}

export async function startAgentCore(env = process.env) {
  const config = loadConfig(env)
  const logger = (...args) => console.error(new Date().toISOString(), ...args)
  const store = createPostgresStore({ database: config.database, logger })
  const runtime = createHEngineRuntime({ config: config.runtime })
  const server = createAgentCoreServer({ config, store, runtime, logger })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, resolve)
  })
  logger('company-agent-core listening', `${config.host}:${config.port}`, AGENT_CORE_CONTRACT_VERSION)
  const shutdown = () => {
    server.close(() => store.close().finally(() => process.exit(0)))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return { server, store, runtime, config }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  startAgentCore().catch((error) => {
    console.error(new Date().toISOString(), 'company-agent-core startup failed', String(error?.message || error))
    process.exit(1)
  })
}
