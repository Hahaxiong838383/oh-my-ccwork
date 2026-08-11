import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import {
  loadPestimSourceRegistryCatalog,
  loadPestimSourceRegistryContract,
} from '../../../packages/ontology-contracts/src/index.mjs'

import { loadJsonFile, validateCollectorConfig } from '../src/config.mjs'
import { CollectorError, runCollector } from '../src/worker.mjs'

const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ROOT = path.resolve(SERVICE_ROOT, '../..')
const INTERNAL_PLAN_FILE = path.join(PROJECT_ROOT, 'deploy/qnap/strategic-intelligence/config/internal-engineering-shadow-plan.json')
const FIXED_TIME = new Date('2026-08-10T12:00:00Z')

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

async function testContext() {
  const collectorContract = await loadJsonFile(path.join(SERVICE_ROOT, 'contracts/company-intelligence-collector-v1.json'))
  const sourceRegistryContract = await loadPestimSourceRegistryContract()
  const { catalog } = await loadPestimSourceRegistryCatalog({ contract: sourceRegistryContract })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-intelligence-collector-'))
  const configInput = {
    ...(await loadJsonFile(path.join(SERVICE_ROOT, 'config.example.json'))),
    sourceRegistryFile: path.join(root, 'registry.json'),
    stateDir: path.join(root, 'state'),
    reportDir: path.join(root, 'reports'),
  }
  const validation = validateCollectorConfig(configInput, collectorContract)
  assert.equal(validation.ok, true, validation.errors.join('; '))
  return {
    collectorContract,
    sourceRegistryContract,
    registry: catalog,
    config: validation.config,
    root,
  }
}

function approveFirstSource(registry) {
  const approved = structuredClone(registry)
  const entry = approved.entries[0]
  entry.lifecycleStatus = 'enabled'
  entry.license.status = 'approved'
  entry.governance.approvalStatus = 'approved'
  entry.governance.approvedBy = 'company-compliance-dri:test-fixture'
  entry.governance.approvedAt = '2026-08-10T08:00:00Z'
  entry.endpointRefs = ['https://fixture.company.invalid/feed.xml']
  approved.entries = [entry]
  return approved
}

function rssResponse(status = 200) {
  const body = `<?xml version="1.0"?><rss><channel>
    <item><guid>a-1</guid><title>AI regulation update</title><link>https://evidence.example/a</link><description>First item</description><pubDate>Mon, 10 Aug 2026 08:00:00 GMT</pubDate></item>
    <item><guid>a-duplicate</guid><title>Duplicate URL</title><link>https://evidence.example/a</link><description>Duplicate</description><pubDate>Mon, 10 Aug 2026 08:05:00 GMT</pubDate></item>
    <item><guid>b-1</guid><title>New model capability</title><link>https://evidence.example/b</link><description>Second item</description><pubDate>Mon, 10 Aug 2026 09:00:00 GMT</pubDate></item>
  </channel></rss>`
  return new Response(body, { status, headers: { 'content-type': 'application/rss+xml' } })
}

test('collector config keeps company namespaces, independent paths and publish=false', async () => {
  const { collectorContract, config } = await testContext()
  assert.equal(config.publish, false)
  assert.equal(config.accountNamespace, collectorContract.identity.accountNamespace)
  assert.equal(config.credentialNamespace, collectorContract.identity.credentialNamespace)
  assert.notEqual(config.stateDir, config.reportDir)

  const unsafe = validateCollectorConfig({
    ...config,
    publish: true,
    stateDir: '/var/www/chenchuan-site/data/radar',
    personalWebhook: 'https://personal.invalid/hook',
  }, collectorContract)
  assert.equal(unsafe.ok, false)
  assert.ok(unsafe.errors.some((error) => error.includes('publish must remain false')))
  assert.ok(unsafe.errors.some((error) => error.includes('forbidden personal runtime path')))
  assert.ok(unsafe.errors.some((error) => error.includes('unsupported config field personalWebhook')))
})

test('oneshot collector authorizes before network, writes snapshots and deduplicates', async () => {
  const context = await testContext()
  const registry = approveFirstSource(context.registry)
  context.config.sourceKeys = [registry.entries[0].sourceKey]
  let fetchCount = 0
  const result = await runCollector({
    ...context,
    registry,
    now: () => FIXED_TIME,
    idFactory: () => 'success-run',
    fetchImpl: async (url) => {
      fetchCount += 1
      assert.equal(url, 'https://fixture.company.invalid/feed.xml')
      return rssResponse()
    },
  })
  assert.equal(fetchCount, 1)
  assert.equal(result.summary.status, 'succeeded')
  assert.equal(result.summary.publish, false)
  assert.equal(result.summary.sourceCount, 1)
  assert.equal(result.summary.rawSnapshotCount, 1)
  assert.equal(result.summary.itemCount, 2)
  assert.equal(result.summary.duplicateCount, 1)
  assert.equal(result.decisions[0].reasonCode, 'SOURCE_APPROVED')

  const snapshot = JSON.parse(await fs.readFile(path.join(result.runDir, 'raw', `${registry.entries[0].sourceKey}.snapshot.json`), 'utf8'))
  assert.equal(snapshot.endpointOrigin, 'https://fixture.company.invalid')
  assert.match(snapshot.contentHash, /^[a-f0-9]{64}$/)
  assert.equal(snapshot.retentionStorageLevel, 'summary_metadata')
  assert.equal(snapshot.payloadRetention, 'hash_only')
  assert.equal(snapshot.bodyBase64, null)
  const lastGood = JSON.parse(await fs.readFile(path.join(context.config.stateDir, 'last-good.json'), 'utf8'))
  assert.equal(lastGood.runId, result.summary.runId)
  assert.equal(lastGood.items.length, 2)
})

test('storage level is enforced for raw payload and normalized summaries', async () => {
  const context = await testContext()
  const registry = structuredClone(context.registry)
  const metadataSource = registry.entries[1]
  metadataSource.lifecycleStatus = 'enabled'
  metadataSource.license.status = 'approved'
  metadataSource.governance.approvalStatus = 'approved'
  metadataSource.governance.approvedBy = 'company-compliance-fixture'
  metadataSource.governance.approvedAt = FIXED_TIME.toISOString()
  metadataSource.endpointRefs = ['https://fixture.company.invalid/items.json']
  context.config.sourceKeys = [metadataSource.sourceKey]
  const result = await runCollector({
    ...context,
    registry,
    now: () => FIXED_TIME,
    idFactory: () => 'metadata-only-run',
    fetchImpl: async () => new Response(JSON.stringify({ items: [{
      id: 'item-1',
      title: 'Metadata title',
      url: 'https://fixture.company.invalid/item-1',
      description: 'This summary must not be retained.',
      published_at: '2026-08-10T10:00:00Z',
    }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  const snapshot = JSON.parse(await fs.readFile(path.join(result.runDir, 'raw', `${metadataSource.sourceKey}.snapshot.json`), 'utf8'))
  assert.equal(snapshot.retentionStorageLevel, 'metadata_only')
  assert.equal(snapshot.payloadRetention, 'hash_only')
  assert.equal(snapshot.bodyBase64, null)
  assert.equal(result.items[0].summary, '')

  const structuredRegistry = structuredClone(context.registry)
  const structuredSource = structuredRegistry.entries[2]
  structuredSource.lifecycleStatus = 'enabled'
  structuredSource.license.status = 'approved'
  structuredSource.governance.approvalStatus = 'approved'
  structuredSource.governance.approvedBy = 'company-compliance-fixture'
  structuredSource.governance.approvedAt = FIXED_TIME.toISOString()
  structuredSource.endpointRefs = ['https://fixture.company.invalid/structured.json']
  context.config.sourceKeys = [structuredSource.sourceKey]
  const structuredResult = await runCollector({
    ...context,
    registry: structuredRegistry,
    now: () => new Date('2026-08-10T13:00:00Z'),
    idFactory: () => 'structured-data-run',
    fetchImpl: async () => new Response(JSON.stringify({ data: [{
      id: 'series-1',
      title: 'Structured series',
      url: 'https://fixture.company.invalid/series-1',
      description: 'Structured description',
      date: '2026-08-10T11:00:00Z',
    }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  const structuredSnapshot = JSON.parse(await fs.readFile(path.join(structuredResult.runDir, 'raw', `${structuredSource.sourceKey}.snapshot.json`), 'utf8'))
  assert.equal(structuredSnapshot.retentionStorageLevel, 'structured_data')
  assert.equal(structuredSnapshot.payloadRetention, 'retained_structured_data')
  assert.ok(structuredSnapshot.bodyBase64.length > 0)
})

test('paused or revoked sources fail closed before any network request', async () => {
  const context = await testContext()
  let fetchCount = 0
  await assert.rejects(
    runCollector({
      ...context,
      now: () => FIXED_TIME,
      idFactory: () => 'denied-run',
      fetchImpl: async () => {
        fetchCount += 1
        return rssResponse()
      },
    }),
    (error) => error instanceof CollectorError && error.code === 'SOURCE_POLICY_DENIED',
  )
  assert.equal(fetchCount, 0)
  const runDir = path.join(context.config.stateDir, 'runs', '2026-08-10T12-00-00-000Z-denied-run')
  const decisions = JSON.parse(await fs.readFile(path.join(runDir, 'source-decisions.json'), 'utf8'))
  assert.equal(decisions[0].reasonCode, 'SOURCE_PAUSED')
  const summary = JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8'))
  assert.equal(summary.status, 'failed')
  assert.equal(summary.errorCode, 'SOURCE_POLICY_DENIED')
})

test('internal engineering mode collects only provisional samples and cannot count as production Shadow', async () => {
  const context = await testContext()
  const internalEngineeringPlan = await loadJsonFile(INTERNAL_PLAN_FILE)
  context.config.operationMode = 'internal_engineering_shadow'
  context.config.internalEngineeringPlanFile = INTERNAL_PLAN_FILE
  context.config.sourceKeys = internalEngineeringPlan.selectedSources.map((source) => source.sourceKey)
  const registry = structuredClone(context.registry)
  const selected = new Set(context.config.sourceKeys)
  for (const entry of registry.entries) {
    if (!selected.has(entry.sourceKey)) continue
    const endpointRef = `https://fixture.company.invalid/${entry.sourceKey}`
    entry.endpointRefs = [endpointRef]
    const selection = internalEngineeringPlan.selectedSources.find((source) => source.sourceKey === entry.sourceKey)
    selection.endpointRef = endpointRef
  }
  let fetchCount = 0
  const result = await runCollector({
    ...context,
    registry,
    internalEngineeringPlan,
    now: () => FIXED_TIME,
    idFactory: () => 'internal-engineering-run',
    fetchImpl: async (url) => {
      fetchCount += 1
      if (url.includes('arxiv-official-rss-api')) return rssResponse()
      return new Response(JSON.stringify({ data: [{
        id: url,
        title: 'Internal engineering sample',
        url: 'https://evidence.example/internal-sample',
        description: 'Must not be retained in reference-only mode',
        date: FIXED_TIME.toISOString(),
      }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  assert.equal(fetchCount, 3)
  assert.equal(result.summary.status, 'succeeded')
  assert.equal(result.summary.operationMode, 'internal_engineering_shadow')
  assert.equal(result.summary.countsTowardProductionShadow, false)
  assert.ok(result.decisions.every((decision) => decision.reasonCode === 'INTERNAL_ENGINEERING_PROVISIONAL_ALLOW'))
  assert.ok(result.decisions.every((decision) => decision.productionApprovalSatisfied === false))
  assert.deepEqual(
    result.decisions.map((decision) => decision.collection.endpointRef),
    internalEngineeringPlan.selectedSources.map((source) => new URL(source.endpointRef).toString()),
  )
  for (const sourceKey of context.config.sourceKeys) {
    const snapshot = JSON.parse(await fs.readFile(path.join(result.runDir, 'raw', `${sourceKey}.snapshot.json`), 'utf8'))
    assert.equal(snapshot.retentionStorageLevel, 'reference_only')
    assert.equal(snapshot.payloadRetention, 'hash_only')
    assert.equal(snapshot.bodyBase64, null)
  }
})

test('internal engineering mode denies a source not selected by the bounded plan before network', async () => {
  const context = await testContext()
  const internalEngineeringPlan = await loadJsonFile(INTERNAL_PLAN_FILE)
  context.config.operationMode = 'internal_engineering_shadow'
  context.config.internalEngineeringPlanFile = INTERNAL_PLAN_FILE
  context.config.sourceKeys = ['world-bank-indicators-api']
  let fetchCount = 0
  await assert.rejects(
    runCollector({
      ...context,
      internalEngineeringPlan,
      now: () => FIXED_TIME,
      idFactory: () => 'internal-denied-run',
      fetchImpl: async () => {
        fetchCount += 1
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      },
    }),
    (error) => error instanceof CollectorError && error.code === 'SOURCE_POLICY_DENIED',
  )
  assert.equal(fetchCount, 0)
  const runDir = path.join(context.config.stateDir, 'runs', '2026-08-10T12-00-00-000Z-internal-denied-run')
  const decisions = JSON.parse(await fs.readFile(path.join(runDir, 'source-decisions.json'), 'utf8'))
  assert.equal(decisions[0].reasonCode, 'SOURCE_NOT_SELECTED_FOR_INTERNAL_ENGINEERING')
})

test('failed collection preserves the previous last-good artifact', async () => {
  const context = await testContext()
  const registry = approveFirstSource(context.registry)
  context.config.sourceKeys = [registry.entries[0].sourceKey]
  await runCollector({
    ...context,
    registry,
    now: () => FIXED_TIME,
    idFactory: () => 'first-good',
    fetchImpl: async () => rssResponse(),
  })
  const lastGoodFile = path.join(context.config.stateDir, 'last-good.json')
  const before = await fs.readFile(lastGoodFile, 'utf8')

  await assert.rejects(
    runCollector({
      ...context,
      registry,
      now: () => new Date('2026-08-10T13:00:00Z'),
      idFactory: () => 'second-failed',
      fetchImpl: async () => new Response('upstream unavailable', { status: 503 }),
    }),
    (error) => error instanceof CollectorError && error.code === 'SOURCE_HTTP_ERROR',
  )
  const after = await fs.readFile(lastGoodFile, 'utf8')
  assert.equal(after, before)
})

test('response-size and parse failures do not produce candidate reports', async () => {
  const context = await testContext()
  const registry = approveFirstSource(context.registry)
  context.config.sourceKeys = [registry.entries[0].sourceKey]
  context.config.maxResponseBytes = 1024
  await assert.rejects(
    runCollector({
      ...context,
      registry,
      now: () => FIXED_TIME,
      idFactory: () => 'large-run',
      fetchImpl: async () => new Response('x'.repeat(2048), { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
    }),
    (error) => error instanceof CollectorError && error.code === 'SOURCE_RESPONSE_TOO_LARGE',
  )
  const reports = await fs.readdir(context.config.reportDir).catch(() => [])
  assert.deepEqual(reports, [])
})

test('reuse lock pins Horizon and Theory Radar evidence without runtime dependency', async () => {
  const lock = await loadJsonFile(path.join(SERVICE_ROOT, 'contracts/reuse.lock.json'))
  const files = {
    runnerSha256: path.join(PROJECT_ROOT, '../chenchuan-site/ops/horizon-radar/runner.py'),
    adapterSha256: path.join(PROJECT_ROOT, '../chenchuan-site/ops/horizon-radar/adapter.py'),
    serviceSha256: path.join(PROJECT_ROOT, '../chenchuan-site/services/theory-radar/theory_radar.py'),
    dockerfileSha256: path.join(PROJECT_ROOT, '../chenchuan-site/services/theory-radar/Dockerfile'),
  }
  assert.equal(lock.copiedSourceCode, false)
  assert.equal(lock.personalRuntimeDependency, false)
  assert.equal(sha256(await fs.readFile(files.runnerSha256)), lock.horizon.runnerSha256)
  assert.equal(sha256(await fs.readFile(files.adapterSha256)), lock.horizon.adapterSha256)
  assert.equal(sha256(await fs.readFile(files.serviceSha256)), lock.theoryRadar.serviceSha256)
  assert.equal(sha256(await fs.readFile(files.dockerfileSha256)), lock.theoryRadar.dockerfileSha256)
  const dockerfile = await fs.readFile(path.join(SERVICE_ROOT, 'Dockerfile'), 'utf8')
  assert.match(dockerfile, /node:22\.14\.0-alpine3\.21@sha256:[a-f0-9]{64}/)
  assert.match(dockerfile, /USER intelligence/)
})
