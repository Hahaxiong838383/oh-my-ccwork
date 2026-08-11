#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const outputRoot = process.argv[2]
if (!outputRoot) throw new Error('output root is required')
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const projectRoot = path.resolve(packageRoot, '../../..')
const registry = JSON.parse(await fs.readFile(path.join(projectRoot, 'packages/ontology-contracts/catalogs/pestim-source-registry-candidate-v1.json'), 'utf8'))
const plan = JSON.parse(await fs.readFile(path.join(packageRoot, 'config/internal-engineering-shadow-plan.json'), 'utf8'))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const source = structuredClone(registry.entries[0])
source.lifecycleStatus = 'enabled'
source.license.status = 'approved'
source.governance.approvalStatus = 'approved'
source.governance.approvedBy = 'company-compliance-dri:runtime-fixture'
source.governance.approvedAt = '2026-08-11T00:00:00.000Z'
registry.entries = [source]

const stateRoot = path.join(path.resolve(outputRoot), 'state')
const runId = '2026-08-11T01-00-00-000Z-runtime-fixture'
const runDir = path.join(stateRoot, 'runs', runId)
await fs.mkdir(path.join(runDir, 'raw'), { recursive: true })
const startedAt = '2026-08-11T01:00:00.000Z'
const completedAt = '2026-08-11T01:01:00.000Z'
const registryFile = path.join(outputRoot, 'registry.json')
const reviewFile = path.join(outputRoot, 'p003-review.json')
const requestFile = path.join(outputRoot, 'request.json')
const stdoutFile = path.join(outputRoot, 'collector-stdout.json')
const outputFile = path.join(outputRoot, 'domain-batch.json')
const metricsFile = path.join(outputRoot, 'domain-metrics.json')
const run = {
  runId,
  collectorVersion: '0.1.0',
  startedAt,
  completedAt,
  publish: false,
  operationMode: 'internal_engineering_shadow',
  countsTowardProductionShadow: false,
  status: 'succeeded',
  sourceRegistryVersion: registry.registryVersion,
  sourceRegistryHash: sha256(JSON.stringify(registry)),
  sourceDecisionCount: 1,
  sourceCount: 1,
  rawSnapshotCount: 1,
  itemCount: 1,
  duplicateCount: 0,
  errorCode: null,
}
const item = {
  itemKey: sha256(`${source.sourceKey}:runtime-item-1`),
  sourceKey: source.sourceKey,
  sourceItemId: 'runtime-item-1',
  title: 'Runtime persistence fixture',
  url: 'https://evidence.example/runtime-item-1',
  summary: 'Public runtime validation evidence',
  publishedAt: '2026-08-11T00:30:00.000Z',
  fetchedAt: completedAt,
  contentHash: sha256('runtime-item-content'),
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
  contentHash: sha256('runtime-snapshot-content'),
  retentionStorageLevel: 'reference_only',
  payloadRetention: 'hash_only',
  bodyBase64: null,
}
await Promise.all([
  fs.writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`),
  fs.writeFile(reviewFile, `${JSON.stringify({ reviews: plan.p003Samples }, null, 2)}\n`),
  fs.writeFile(requestFile, JSON.stringify({ requestKey: 'daily-collection-shadow-2026-08-11', publish: false })),
  fs.writeFile(stdoutFile, JSON.stringify({ ok: true, runId })),
  fs.writeFile(path.join(runDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`),
  fs.writeFile(path.join(runDir, 'items.json'), `${JSON.stringify([item], null, 2)}\n`),
  fs.writeFile(path.join(runDir, 'source-decisions.json'), `${JSON.stringify([decision], null, 2)}\n`),
  fs.writeFile(path.join(runDir, 'raw', `${source.sourceKey}.snapshot.json`), `${JSON.stringify(snapshot, null, 2)}\n`),
])
const result = spawnSync(process.execPath, [
  path.join(packageRoot, 'scripts/compile-shadow-domain-batch.mjs'),
  '--collector-stdout', stdoutFile,
  '--state-root', stateRoot,
  '--registry', registryFile,
  '--p003-review', reviewFile,
  '--request', requestFile,
  '--output', outputFile,
  '--metrics-output', metricsFile,
], { encoding: 'utf8' })
if (result.status !== 0) throw new Error(result.stderr || 'runtime fixture compilation failed')
process.stdout.write(`${JSON.stringify({ outputFile, metricsFile })}\n`)
