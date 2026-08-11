import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ROOT = path.resolve(ROOT, '../../..')
const COMPILER = path.join(ROOT, 'scripts/compile-shadow-domain-batch.mjs')
const VALIDATOR = path.join(ROOT, 'scripts/validate-shadow-domain-batch.mjs')
const SQL_COMPILER = path.join(ROOT, 'scripts/compile-shadow-domain-sql.mjs')
const REGISTRY_FILE = path.join(PROJECT_ROOT, 'packages/ontology-contracts/catalogs/pestim-source-registry-candidate-v1.json')
const P003_PLAN_FILE = path.join(ROOT, 'config/internal-engineering-shadow-plan.json')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function createFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-domain-batch-'))
  const stateRoot = path.join(root, 'state')
  const runId = '2026-08-11T01-00-00-000Z-domain-run'
  const runDir = path.join(stateRoot, 'runs', runId)
  await fs.mkdir(path.join(runDir, 'raw'), { recursive: true })

  const registry = JSON.parse(await fs.readFile(REGISTRY_FILE, 'utf8'))
  const source = structuredClone(registry.entries[0])
  source.lifecycleStatus = 'enabled'
  source.license.status = 'approved'
  source.governance.approvalStatus = 'approved'
  source.governance.approvedBy = 'company-compliance-dri:test-fixture'
  source.governance.approvedAt = '2026-08-11T00:00:00.000Z'
  registry.entries = [source]
  const registryFile = path.join(root, 'registry.json')
  await fs.writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`)

  const plan = JSON.parse(await fs.readFile(P003_PLAN_FILE, 'utf8'))
  const p003Review = { reviews: structuredClone(plan.p003Samples) }
  if (options.activeP003) p003Review.reviews[0].activationStatus = 'active'
  if (options.missingP003Category) p003Review.reviews.pop()
  const p003ReviewFile = path.join(root, 'p003-review.json')
  await fs.writeFile(p003ReviewFile, `${JSON.stringify(p003Review, null, 2)}\n`)

  const startedAt = '2026-08-11T01:00:00.000Z'
  const completedAt = '2026-08-11T01:01:00.000Z'
  const run = {
    runId,
    collectorVersion: '0.1.0',
    startedAt,
    completedAt,
    publish: false,
    operationMode: 'internal_engineering_shadow',
    countsTowardProductionShadow: false,
    status: options.collectorFailure ? 'failed' : 'succeeded',
    sourceRegistryVersion: registry.registryVersion,
    sourceRegistryHash: sha256(JSON.stringify(registry)),
    sourceDecisionCount: 1,
    sourceCount: 1,
    rawSnapshotCount: options.collectorFailure ? 0 : 1,
    itemCount: options.collectorFailure ? 0 : 1,
    duplicateCount: 0,
    errorCode: options.collectorFailure ? 'COLLECTOR_FAILED' : null,
  }
  const itemSourceKey = options.itemWithoutSnapshot ? 'unmatched-source' : source.sourceKey
  const item = {
    itemKey: sha256(`${itemSourceKey}:item-1`),
    sourceKey: itemSourceKey,
    sourceItemId: 'item-1',
    title: 'AI regulation update',
    url: 'https://evidence.example/item-1',
    summary: 'Public evidence summary',
    publishedAt: '2026-08-11T00:30:00.000Z',
    fetchedAt: completedAt,
    contentHash: sha256('item-content'),
  }
  const decision = {
    allowed: true,
    decision: 'allow',
    reasonCode: 'INTERNAL_ENGINEERING_PROVISIONAL_ALLOW',
    sourceKey: source.sourceKey,
    evaluatedAt: startedAt,
    registryVersion: registry.registryVersion,
    policyVersion: '1.0.0+internal-engineering.1',
    lifecycleStatus: source.lifecycleStatus,
  }
  const snapshot = {
    sourceKey: source.sourceKey,
    fetchedAt: completedAt,
    endpointOrigin: 'https://evidence.example',
    contentType: 'application/rss+xml',
    contentLength: 128,
    contentHash: sha256('snapshot-content'),
    retentionStorageLevel: 'reference_only',
    payloadRetention: 'hash_only',
    bodyBase64: null,
  }
  await fs.writeFile(path.join(runDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`)
  await fs.writeFile(path.join(runDir, 'items.json'), `${JSON.stringify(options.collectorFailure ? [] : [item], null, 2)}\n`)
  await fs.writeFile(path.join(runDir, 'source-decisions.json'), `${JSON.stringify([decision], null, 2)}\n`)
  if (!options.collectorFailure) {
    await fs.writeFile(path.join(runDir, 'raw', `${source.sourceKey}.snapshot.json`), `${JSON.stringify(snapshot, null, 2)}\n`)
  }

  const stdoutFile = path.join(root, 'collector-stdout.json')
  await fs.writeFile(stdoutFile, JSON.stringify({ ok: !options.collectorFailure, runId }))
  const requestFile = path.join(root, 'request.json')
  await fs.writeFile(requestFile, JSON.stringify({ requestKey: 'daily-collection-shadow-2026-08-11', publish: false }))
  return {
    root,
    stateRoot,
    registryFile,
    p003ReviewFile,
    requestFile,
    stdoutFile,
    outputFile: path.join(root, 'domain-batch.json'),
    metricsFile: path.join(root, 'domain-metrics.json'),
  }
}

function compileArgs(fixture) {
  return [
    COMPILER,
    '--collector-stdout', fixture.stdoutFile,
    '--state-root', fixture.stateRoot,
    '--registry', fixture.registryFile,
    '--p003-review', fixture.p003ReviewFile,
    '--request', fixture.requestFile,
    '--output', fixture.outputFile,
    '--metrics-output', fixture.metricsFile,
  ]
}

test('domain compiler produces replayable zero-confidence candidates and draft reports', async () => {
  const fixture = await createFixture()
  const compiled = spawnSync(process.execPath, compileArgs(fixture), { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  const validated = spawnSync(process.execPath, [VALIDATOR, fixture.outputFile], { encoding: 'utf8' })
  assert.equal(validated.status, 0, validated.stderr)

  const batch = JSON.parse(await fs.readFile(fixture.outputFile, 'utf8'))
  const metrics = JSON.parse(await fs.readFile(fixture.metricsFile, 'utf8'))
  assert.equal(batch.publish, false)
  assert.equal(batch.persistenceState, 'json_candidate_pending_postgres')
  assert.equal(batch.ingestionRun.runKey, batch.runId)
  assert.equal(batch.rawSnapshots.length, 1)
  assert.equal(batch.rawSnapshots[0].storageTier, 'purged')
  assert.equal(batch.rawSnapshots[0].payloadRetention, 'hash_only')
  assert.equal(batch.observations.length, 1)
  assert.equal(batch.observations[0].dataQualityStatus, 'valid')
  assert.equal(batch.observations[0].conflictStatus, 'none')
  assert.equal(batch.signals[0].confidence, 0)
  assert.equal(batch.evidence[0].evidenceKind, 'context')
  assert.equal(batch.impactHypotheses.length, 6)
  assert.equal(batch.impactAssessments.length, 6)
  assert.equal(batch.reportRuns.length, 3)
  assert.equal(batch.reportDrafts.length, 3)
  assert.ok(batch.reportRuns.every((entry) => entry.modelProvider === 'policy-engine' && entry.inputTokens === 0 && entry.outputTokens === 0))
  assert.ok(batch.reportDrafts.every((entry) => entry.reportStatus === 'draft' && entry.structuredBody.conclusions.length === 0))
  assert.deepEqual(batch.sideEffects, { formalP2Count: 0, employeeDeliveryCount: 0, erpWritebackCount: 0, socialWritebackCount: 0, causalActivationCount: 0 })
  assert.equal(metrics.compiled, true)
  assert.equal(metrics.reportDraftCount, 3)
})

for (const scenario of [
  { name: 'active P003 relation', options: { activeP003: true }, expected: /P003 relations must remain inactive/ },
  { name: 'missing P003 category', options: { missingP003Category: true }, expected: /exactly six categories/ },
  { name: 'failed collector run', options: { collectorFailure: true }, expected: /collector must succeed before domain compilation/ },
  { name: 'item without source snapshot', options: { itemWithoutSnapshot: true }, expected: /has no snapshot/ },
]) {
  test(`domain compiler rejects ${scenario.name}`, async () => {
    const fixture = await createFixture(scenario.options)
    const compiled = spawnSync(process.execPath, compileArgs(fixture), { encoding: 'utf8' })
    assert.notEqual(compiled.status, 0)
    assert.match(compiled.stderr, scenario.expected)
  })
}

test('domain validator rejects reports that claim model execution', async () => {
  const fixture = await createFixture()
  const compiled = spawnSync(process.execPath, compileArgs(fixture), { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  const batch = JSON.parse(await fs.readFile(fixture.outputFile, 'utf8'))
  batch.reportRuns[0].modelProvider = 'xai'
  batch.reportRuns[0].modelId = 'grok-production-model'
  batch.reportRuns[0].inputTokens = 100
  await fs.writeFile(fixture.outputFile, `${JSON.stringify(batch, null, 2)}\n`)
  const validated = spawnSync(process.execPath, [VALIDATOR, fixture.outputFile], { encoding: 'utf8' })
  assert.notEqual(validated.status, 0)
  assert.match(validated.stderr, /must not claim model execution/)
})

test('domain SQL compiler emits one tenant-scoped idempotent transaction', async () => {
  const fixture = await createFixture()
  const compiled = spawnSync(process.execPath, compileArgs(fixture), { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  const sqlFile = path.join(fixture.root, 'persist.sql')
  const sqlCompiled = spawnSync(process.execPath, [SQL_COMPILER, fixture.outputFile, sqlFile], { encoding: 'utf8' })
  assert.equal(sqlCompiled.status, 0, sqlCompiled.stderr)
  const sql = await fs.readFile(sqlFile, 'utf8')
  assert.equal((sql.match(/\bBEGIN;/g) || []).length, 1)
  assert.equal((sql.match(/\bCOMMIT;/g) || []).length, 1)
  assert.match(sql, /set_config\('app[.]tenant_id'/)
  assert.match(sql, /SET LOCAL row_security = on/)
  assert.match(sql, /ON CONFLICT DO NOTHING/)
  assert.match(sql, /strategic_intelligence[.]raw_snapshots/)
  assert.match(sql, /strategic_intelligence[.]external_observations/)
  assert.match(sql, /strategic_intelligence[.]strategic_signals/)
  assert.match(sql, /strategic_intelligence[.]impact_assessments/)
  assert.match(sql, /strategic_intelligence[.]report_runs/)
  assert.match(sql, /strategic_intelligence[.]reports/)
  assert.doesNotMatch(sql, /grok-production-model/)
  assert.equal((await fs.stat(sqlFile)).mode & 0o777, 0o600)
})

test('domain SQL compiler refuses an invalid or model-claiming batch', async () => {
  const fixture = await createFixture()
  const compiled = spawnSync(process.execPath, compileArgs(fixture), { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  const batch = JSON.parse(await fs.readFile(fixture.outputFile, 'utf8'))
  batch.reportRuns[0].inputTokens = 1
  await fs.writeFile(fixture.outputFile, `${JSON.stringify(batch, null, 2)}\n`)
  const result = spawnSync(process.execPath, [SQL_COMPILER, fixture.outputFile, path.join(fixture.root, 'denied.sql')], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  await assert.rejects(fs.access(path.join(fixture.root, 'denied.sql')))
})
