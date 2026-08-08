import crypto from 'node:crypto'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

import { compareDefinitions, compileDefinition, loadDefinitionDirectory } from '@futurus/ontology-contracts'

import { loadRegistryConfig } from './config.mjs'
import { createPostgresRegistryStore } from './store.mjs'

export const ONTOLOGY_REGISTRY_VERSION = '2026-08-08.1'
const SAFE_ID_RE = /^[A-Za-z0-9_.:@-]{1,160}$/
const COMMIT_RE = /^[0-9a-f]{7,64}$/i

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

function safeId(value, name) {
  const text = String(value || '').trim()
  if (!SAFE_ID_RE.test(text)) throw Object.assign(new Error(`${name} is invalid`), { statusCode: 400, code: 'invalid_request' })
  return text
}

function summary(compiled) {
  return {
    ok: compiled.ok,
    schemaVersion: compiled.bundle?.schemaVersion || null,
    contentHash: compiled.bundle?.contentHash || null,
    counts: compiled.bundle?.counts || {},
    errors: compiled.errors,
    warnings: compiled.warnings,
  }
}

function publicActive(active) {
  if (!active) return null
  const { definition: _definition, elements: _elements, ...metadata } = active
  return metadata
}

export function createOntologyRegistryServer({
  config,
  store,
  definitionProvider = () => loadDefinitionDirectory(config.definitionsDir),
  logger = () => {},
} = {}) {
  async function compileLocal() {
    return compileDefinition(await definitionProvider())
  }

  async function reconciliation({ persist = false } = {}) {
    const compiled = await compileLocal()
    if (!compiled.ok) return { statusCode: 503, payload: { ok: false, status: 'definition_invalid', ...summary(compiled) } }
    const active = await store.active({ tenantId: config.tenantId })
    const status = !active ? 'bootstrap_required' : active.contentHash === compiled.bundle.contentHash ? 'in_sync' : 'drift'
    const payload = {
      ok: status === 'in_sync',
      status,
      local: summary(compiled),
      active: publicActive(active),
    }
    if (persist) await store.recordReconciliation({
      tenantId: config.tenantId,
      localHash: compiled.bundle.contentHash,
      activeHash: active?.contentHash || null,
      status,
      drift: status === 'drift' ? compareDefinitions(active.definition, compiled.bundle.definition) : {},
    })
    return { statusCode: status === 'in_sync' ? 200 : 503, payload }
  }

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/healthz') {
        json(response, 200, { ok: true, status: 'live', component: 'ontology-registry', version: ONTOLOGY_REGISTRY_VERSION })
        return
      }
      if (request.method === 'GET' && url.pathname === '/readyz') {
        const database = await store.ready()
        if (!database.ready) {
          json(response, 503, { ok: false, status: 'database_unavailable', database, version: ONTOLOGY_REGISTRY_VERSION })
          return
        }
        const result = await reconciliation()
        json(response, result.statusCode, { ...result.payload, database, version: ONTOLOGY_REGISTRY_VERSION })
        return
      }
      if (!url.pathname.startsWith('/v1/')) {
        json(response, 404, { ok: false, status: 'not_found' })
        return
      }
      if (!safeEqual(request.headers['x-ontology-registry-token'], config.controlToken)) {
        json(response, 401, { ok: false, status: 'unauthorized' })
        return
      }

      if (request.method === 'GET' && url.pathname === '/v1/registry/active') {
        const active = await store.active({ tenantId: config.tenantId })
        json(response, 200, { ok: true, status: active ? 'active' : 'bootstrap_required', active: publicActive(active) })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/reconcile') {
        const result = await reconciliation({ persist: true })
        json(response, result.statusCode, result.payload)
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/contracts') {
        const compiled = await compileLocal()
        if (!compiled.ok) {
          json(response, 503, { ok: false, status: 'definition_invalid', ...summary(compiled) })
          return
        }
        json(response, 200, {
          ok: true,
          status: 'compiled',
          schemaVersion: compiled.bundle.schemaVersion,
          contentHash: compiled.bundle.contentHash,
          toolContracts: compiled.bundle.definition.toolContracts,
          eventEnvelope: compiled.bundle.definition.eventEnvelope,
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/compile') {
        const input = await readJson(request, config.maxBodyBytes)
        const compiled = compileDefinition(input.definition || await definitionProvider())
        const active = await store.active({ tenantId: config.tenantId })
        const compatibility = compiled.ok ? compareDefinitions(active?.definition || null, compiled.bundle.definition) : { classification: 'rejected', changes: [] }
        json(response, compiled.ok ? 200 : 422, { ...summary(compiled), compatibility })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/deploy') {
        const input = await readJson(request, config.maxBodyBytes)
        const proposalId = safeId(input.proposalId, 'proposalId')
        const approvedBy = safeId(input.approvedBy, 'approvedBy')
        const sourceCommit = String(input.sourceCommit || '').trim()
        if (!COMMIT_RE.test(sourceCommit)) throw Object.assign(new Error('sourceCommit must be a Git commit hash'), { statusCode: 400, code: 'invalid_request' })
        const compiled = await compileLocal()
        if (!compiled.ok) {
          json(response, 422, { ok: false, status: 'definition_invalid', ...summary(compiled) })
          return
        }
        const active = await store.active({ tenantId: config.tenantId })
        if (active?.contentHash === compiled.bundle.contentHash) {
          json(response, 200, { ok: true, status: 'already_active', active: publicActive(active) })
          return
        }
        const compatibility = compareDefinitions(active?.definition || null, compiled.bundle.definition)
        const migrationPlan = input.migrationPlan && typeof input.migrationPlan === 'object' && !Array.isArray(input.migrationPlan) ? input.migrationPlan : {}
        if (compatibility.classification === 'migration_required') {
          if (input.allowMigration !== true) {
            json(response, 409, { ok: false, status: 'migration_approval_required', compatibility })
            return
          }
          if (!Array.isArray(migrationPlan.steps) || migrationPlan.steps.length === 0) {
            json(response, 400, { ok: false, status: 'migration_plan_required', compatibility })
            return
          }
        }
        const deployed = await store.deploy({
          tenantId: config.tenantId,
          bundle: compiled.bundle,
          sourceCommit,
          proposalId,
          approvedBy,
          compatibility: compatibility.classification,
          migrationPlan,
        })
        json(response, 200, {
          ok: true,
          status: deployed.alreadyActive ? 'already_active' : deployed.reactivated ? 'reactivated' : 'deployed',
          active: publicActive(deployed),
          compatibility,
        })
        return
      }
      json(response, 404, { ok: false, status: 'not_found' })
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500)
      if (statusCode >= 500) logger('ontology registry request failed', String(error?.message || error).slice(0, 200))
      json(response, statusCode, { ok: false, status: error?.code || 'internal_error', message: statusCode >= 500 ? 'internal error' : error.message })
    }
  })
}

async function main() {
  const config = loadRegistryConfig()
  const store = createPostgresRegistryStore({ database: config.database, logger: console.error })
  const server = createOntologyRegistryServer({ config, store, logger: console.error })
  const shutdown = () => server.close(() => store.close().finally(() => process.exit(0)))
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ event: 'ontology_registry_started', host: config.host, port: config.port, version: ONTOLOGY_REGISTRY_VERSION }))
  })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(String(error?.stack || error))
  process.exit(1)
})
