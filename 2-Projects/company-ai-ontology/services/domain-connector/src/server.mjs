import http from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { loadConfig } from './config.mjs'
import { createHttpReadSource } from './source-client.mjs'
import { createDomainStore } from './store.mjs'
import { createDomainSync } from './sync.mjs'

export const DOMAIN_CONNECTOR_VERSION = '2026-08-10.1'

function json(response, statusCode, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(body)
}

function authorized(request, token) {
  const provided = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '')
  return timingSafeEqual(createHash('sha256').update(provided).digest(), createHash('sha256').update(token).digest())
}

export function createDomainConnectorServer({ config, store, sync, state, logger = () => {} } = {}) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://domain-connector')
      if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { ok: true, status: 'live', component: 'company-domain-connector', version: DOMAIN_CONNECTOR_VERSION, running: sync.isRunning(), lastRuns: state.lastRuns })
      if (request.method === 'GET' && url.pathname === '/readyz') {
        const database = await store.ready()
        const enabledSources = Object.values(config.sources).filter((source) => source.enabled).map((source) => source.key)
        return json(response, database.ready ? 200 : 503, { ok: database.ready, status: database.ready ? 'ready' : 'not_ready', version: DOMAIN_CONNECTOR_VERSION, database, enabledSources, lastRuns: state.lastRuns })
      }
      if (request.method === 'GET' && url.pathname === '/status') {
        const database = await store.status({ tenantId: config.tenantId })
        return json(response, 200, { ok: true, status: 'read_only', version: DOMAIN_CONNECTOR_VERSION, sources: Object.values(config.sources).map((source) => ({ key: source.key, enabled: source.enabled, purpose: source.purpose })), database, lastRuns: state.lastRuns })
      }
      const match = url.pathname.match(/^\/v1\/(sync|replay)\/([a-z0-9-]+)$/)
      if (request.method === 'POST' && match) {
        if (!authorized(request, config.controlToken)) return json(response, 403, { ok: false, status: 'forbidden' })
        const [, operation, sourceKey] = match
        if (!config.sources[sourceKey]) return json(response, 404, { ok: false, status: 'unknown_source' })
        const result = await sync.run(sourceKey, { cursorOverride: operation === 'replay' ? url.searchParams.get('cursor') || '' : null, replay: operation === 'replay' })
        state.lastRuns[sourceKey] = { at: new Date().toISOString(), status: result.status, stats: result.stats || {} }
        return json(response, result.ok ? 200 : result.status === 'already_running' ? 409 : 503, result)
      }
      return json(response, 404, { ok: false, status: 'not_found' })
    } catch (error) {
      logger('domain connector request failed', String(error?.code || error?.message || error).slice(0, 160))
      return json(response, 500, { ok: false, status: String(error?.code || 'domain_connector_failed') })
    }
  })
}

export async function main() {
  const config = loadConfig()
  const logger = (...args) => console.error(new Date().toISOString(), ...args)
  const store = createDomainStore({ database: config.database, logger })
  const clients = Object.fromEntries(Object.entries(config.sources).map(([key, source]) => [key, createHttpReadSource({ source })]))
  const sync = createDomainSync({ config, clients, store, logger })
  const state = { lastRuns: {} }
  const server = createDomainConnectorServer({ config, store, sync, state, logger })
  server.listen(config.port, config.host, () => logger(`company domain connector listening on ${config.host}:${config.port}`))
  const trigger = () => Promise.all(Object.values(config.sources).filter((source) => source.enabled).map((source) => sync.run(source.key).then((result) => { state.lastRuns[source.key] = { at: new Date().toISOString(), status: result.status, stats: result.stats || {} } })))
  if (config.onStart) setTimeout(trigger, 1000).unref()
  const timer = setInterval(trigger, config.intervalMs); timer.unref()
  const shutdown = () => { clearInterval(timer); server.close(async () => { await store.close().catch(() => {}); process.exit(0) }) }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
