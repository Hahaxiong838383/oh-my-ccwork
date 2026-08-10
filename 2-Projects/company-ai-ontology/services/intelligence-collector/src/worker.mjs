import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  evaluateSourceCollectionPolicy,
  validateSourceRegistryCatalog,
} from '../../../packages/ontology-contracts/src/index.mjs'

import { validateCollectorConfig } from './config.mjs'
import { applyItemRetention, deduplicateItems, hashBytes, parseFeed, parseJsonItems } from './normalizer.mjs'

export class CollectorError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CollectorError'
    this.code = code
  }
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temporary, file)
}

function sourceEndpoint(entry) {
  const endpoint = entry?.endpointRefs?.[0]
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:') throw new Error('not https')
    if (url.username || url.password) throw new Error('embedded credentials')
    return url.toString()
  } catch {
    throw new CollectorError('SOURCE_ENDPOINT_INVALID', `source ${entry?.sourceKey || 'unknown'} has no approved HTTPS endpoint`)
  }
}

async function responseBytes(response, maxResponseBytes) {
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (declaredLength > maxResponseBytes) throw new CollectorError('SOURCE_RESPONSE_TOO_LARGE', 'source response exceeds configured limit')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength > maxResponseBytes) throw new CollectorError('SOURCE_RESPONSE_TOO_LARGE', 'source response exceeds configured limit')
  return bytes
}

function payloadRetention(entry, retention, contentType) {
  if (retention.storageLevel === 'full_text') return 'retained_full_text'
  if (retention.storageLevel === 'structured_data' && (entry.collection.mode === 'api' || /application\/(?:json|.+\+json)/i.test(contentType))) {
    return 'retained_structured_data'
  }
  return 'hash_only'
}

async function fetchSource(entry, retention, config, fetchImpl, fetchedAt) {
  const endpoint = sourceEndpoint(entry)
  const timeoutSeconds = Math.min(entry.collection.timeoutSeconds, 60)
  let response
  try {
    response = await fetchImpl(endpoint, {
      headers: {
        accept: entry.collection.mode === 'rss_api' ? 'application/rss+xml, application/atom+xml, application/xml, text/xml' : 'application/json',
        'user-agent': 'Futurus-Company-Intelligence-Collector/0.1 (+internal-strategic-intelligence)',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    })
  } catch {
    throw new CollectorError('SOURCE_FETCH_FAILED', `source ${entry.sourceKey} fetch failed`)
  }
  if (!response?.ok) throw new CollectorError('SOURCE_HTTP_ERROR', `source ${entry.sourceKey} returned a non-success status`)
  const bytes = await responseBytes(response, config.maxResponseBytes)
  const body = bytes.toString('utf8')
  let items
  try {
    items = entry.collection.mode === 'rss_api'
      ? parseFeed(entry.sourceKey, body, fetchedAt)
      : parseJsonItems(entry.sourceKey, body, fetchedAt)
  } catch {
    throw new CollectorError('SOURCE_PARSE_FAILED', `source ${entry.sourceKey} response could not be parsed`)
  }
  if (items.length === 0) throw new CollectorError('SOURCE_NO_VALID_ITEMS', `source ${entry.sourceKey} produced no valid items`)
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  const retentionMode = payloadRetention(entry, retention, contentType)
  return {
    snapshot: {
      sourceKey: entry.sourceKey,
      fetchedAt,
      endpointOrigin: new URL(endpoint).origin,
      contentType,
      contentLength: bytes.byteLength,
      contentHash: hashBytes(bytes),
      retentionStorageLevel: retention.storageLevel,
      payloadRetention: retentionMode,
      bodyBase64: retentionMode === 'hash_only' ? null : bytes.toString('base64'),
    },
    items: applyItemRetention(items.slice(0, config.maxItemsPerSource), retention.storageLevel),
  }
}

function runSummary(input) {
  return {
    runId: input.runId,
    collectorVersion: '0.1.0',
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    publish: false,
    status: input.status,
    sourceRegistryVersion: input.sourceRegistryVersion,
    sourceRegistryHash: input.sourceRegistryHash,
    sourceDecisionCount: input.sourceDecisionCount,
    sourceCount: input.sourceCount,
    rawSnapshotCount: input.rawSnapshotCount,
    itemCount: input.itemCount,
    duplicateCount: input.duplicateCount,
    errorCode: input.errorCode,
  }
}

export async function runCollector(options) {
  const {
    config: configInput,
    collectorContract,
    sourceRegistryContract,
    registry,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    idFactory = () => crypto.randomUUID(),
  } = options
  const configValidation = validateCollectorConfig(configInput, collectorContract)
  if (!configValidation.ok) throw new CollectorError('CONFIG_INVALID', 'collector config is invalid')
  const config = configValidation.config
  if (collectorContract.productionDeploymentAllowed !== false || collectorContract.publishAllowed !== false || config.publish !== false) {
    throw new CollectorError('PUBLISH_GATE_OPEN', 'P1-SI-C package must remain publish=false')
  }
  const registryValidation = validateSourceRegistryCatalog(registry, sourceRegistryContract)
  if (!registryValidation.ok) throw new CollectorError('REGISTRY_INVALID', 'source registry snapshot is invalid')

  const runId = `${now().toISOString().replace(/[:.]/g, '-')}-${idFactory()}`
  const startedAt = now().toISOString()
  const runDir = path.join(config.stateDir, 'runs', runId)
  const rawDir = path.join(runDir, 'raw')
  const decisions = config.sourceKeys.map((sourceKey) => evaluateSourceCollectionPolicy(registry, sourceRegistryContract, sourceKey, startedAt))
  await atomicJson(path.join(runDir, 'source-decisions.json'), decisions)

  try {
    const denied = decisions.filter((decision) => !decision.allowed)
    if (denied.length > 0) throw new CollectorError('SOURCE_POLICY_DENIED', `source policy denied ${denied.length} requested source(s)`)
    const entries = config.sourceKeys.map((sourceKey) => registry.entries.find((entry) => entry.sourceKey === sourceKey))
    const decisionBySource = new Map(decisions.map((decision) => [decision.sourceKey, decision]))
    const fetchedAt = now().toISOString()
    const collected = []
    for (const entry of entries) {
      const result = await fetchSource(entry, decisionBySource.get(entry.sourceKey).retention, config, fetchImpl, fetchedAt)
      await atomicJson(path.join(rawDir, `${entry.sourceKey}.snapshot.json`), result.snapshot)
      collected.push(...result.items)
    }
    const deduplicated = deduplicateItems(collected)
    const items = deduplicated.items
    await atomicJson(path.join(runDir, 'items.json'), items)
    const completedAt = now().toISOString()
    const summary = runSummary({
      runId,
      startedAt,
      completedAt,
      status: 'succeeded',
      sourceRegistryVersion: registry.registryVersion,
      sourceRegistryHash: registryValidation.contentHash,
      sourceDecisionCount: decisions.length,
      sourceCount: entries.length,
      rawSnapshotCount: entries.length,
      itemCount: items.length,
      duplicateCount: deduplicated.duplicateCount,
      errorCode: null,
    })
    await atomicJson(path.join(runDir, 'run.json'), summary)
    const candidate = { ...summary, items }
    await atomicJson(path.join(config.reportDir, `candidate-${runId}.json`), candidate)
    await atomicJson(path.join(config.stateDir, 'last-good.json'), candidate)
    return { summary, items, decisions, runDir }
  } catch (error) {
    const completedAt = now().toISOString()
    const errorCode = error instanceof CollectorError ? error.code : 'COLLECTOR_FAILED'
    const summary = runSummary({
      runId,
      startedAt,
      completedAt,
      status: 'failed',
      sourceRegistryVersion: registry.registryVersion,
      sourceRegistryHash: registryValidation.contentHash,
      sourceDecisionCount: decisions.length,
      sourceCount: config.sourceKeys.length,
      rawSnapshotCount: 0,
      itemCount: 0,
      duplicateCount: 0,
      errorCode,
    })
    await atomicJson(path.join(runDir, 'run.json'), summary)
    const failure = error instanceof CollectorError ? error : new CollectorError(errorCode, 'collector run failed')
    failure.runId = runId
    failure.runDir = runDir
    throw failure
  }
}
