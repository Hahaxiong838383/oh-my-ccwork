import http from 'node:http'
import { pathToFileURL } from 'node:url'

import { loadConfig } from './config.mjs'
import { createFeishuKnowledgeClient } from './feishu-client.mjs'
import { createKnowledgeStore } from './store.mjs'
import { createKnowledgeSync } from './sync.mjs'

export const KNOWLEDGE_CONNECTOR_VERSION = '2026-08-11.1'

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

export function createKnowledgeConnectorServer({ config, store, sync, state, logger = () => {} } = {}) {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        json(response, 200, { ok: true, status: 'live', component: 'company-knowledge-connector', version: KNOWLEDGE_CONNECTOR_VERSION, sourceCommit: config.sourceCommit || null, running: sync.isRunning(), lastRun: state.lastRun })
        return
      }
      if (request.method === 'GET' && request.url === '/readyz') {
        const database = await store.ready()
        json(response, database.ready ? 200 : 503, { ok: database.ready, status: database.ready ? 'ready' : 'not_ready', version: KNOWLEDGE_CONNECTOR_VERSION, sourceCommit: config.sourceCommit || null, database, lastRun: state.lastRun })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/sync') {
        const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '')
        if (token !== config.controlToken) {
          json(response, 403, { ok: false, status: 'forbidden' })
          return
        }
        if (sync.isRunning()) {
          json(response, 409, { ok: false, status: 'already_running' })
          return
        }
        const result = await sync.run()
        state.lastRun = { at: new Date().toISOString(), ...result }
        json(response, 200, result)
        return
      }
      json(response, 404, { ok: false, status: 'not_found' })
    } catch (error) {
      logger('knowledge connector request failed', String(error?.code || error?.message || error).slice(0, 160))
      json(response, 500, { ok: false, status: String(error?.code || 'knowledge_connector_failed') })
    }
  })
}

export async function main() {
  const config = loadConfig()
  const logger = (...args) => console.error(new Date().toISOString(), ...args)
  const store = createKnowledgeStore({ database: config.database, logger })
  const client = createFeishuKnowledgeClient({ ...config.feishu })
  const sync = createKnowledgeSync({ config, client, store, logger })
  const state = { lastRun: null }
  const server = createKnowledgeConnectorServer({ config, store, sync, state, logger })
  server.listen(config.port, config.host, () => logger(`company knowledge connector listening on ${config.host}:${config.port}`))

  let timer = null
  const trigger = () => sync.run()
    .then((result) => { state.lastRun = { at: new Date().toISOString(), ...result } })
    .catch((error) => logger('knowledge sync failed', String(error?.code || error?.message || error).slice(0, 160)))
  if (config.sync.onStart) setTimeout(trigger, 1000).unref()
  timer = setInterval(trigger, config.sync.intervalMs)
  timer.unref()

  const shutdown = () => {
    if (timer) clearInterval(timer)
    server.close(async () => {
      await store.close().catch(() => {})
      process.exit(0)
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
