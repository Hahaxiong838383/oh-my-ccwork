import fs from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyPestimDataFoundationContract,
  compilePestimDataFoundationProposal,
  deriveRawSnapshotIdentity,
  loadPestimDataFoundationContract,
  validateDualTimeRecord,
  validateReplayLineage,
} from '../src/index.mjs'

const SOURCE_REGISTRY_HASH = '082c4eec516ecc8a08fbd24ce21f3e97a34500dc5a010a715b108ef0137c6154'

test('P1-SI-D compiles additively from the immutable P1-SI-B candidate', async () => {
  const proposal = await compilePestimDataFoundationProposal()
  assert.equal(proposal.sourceRegistry.candidate.schemaVersion, '3.5.0')
  assert.equal(proposal.sourceRegistry.candidate.contentHash, SOURCE_REGISTRY_HASH)
  assert.equal(proposal.baseline.schemaVersion, '3.5.0')
  assert.equal(proposal.baseline.contentHash, SOURCE_REGISTRY_HASH)
  assert.equal(proposal.candidate.schemaVersion, '3.6.0')
  assert.equal(proposal.contract.status, 'contract_only')
  assert.equal(proposal.contract.deploymentAllowed, false)
  assert.equal(proposal.contract.structuredTruthStore, 'postgres')
  assert.equal(proposal.contract.vectorStoreRole, 'rebuildable_retrieval_derivative')
  assert.equal(proposal.compatibility.classification, 'compatible')
  assert.equal(proposal.candidate.counts.object_type - proposal.baseline.counts.object_type, 3)
  assert.equal(proposal.candidate.counts.link_type - proposal.baseline.counts.link_type, 5)
  assert.equal(proposal.candidate.counts.function_type - proposal.baseline.counts.function_type, 3)
  assert.equal(proposal.candidate.counts.action_type - proposal.baseline.counts.action_type, 0)
  assert.equal(proposal.candidate.counts.policy_type - proposal.baseline.counts.policy_type, 4)
  assert.equal(proposal.candidate.counts.constraint_type - proposal.baseline.counts.constraint_type, 5)
  assert.ok(proposal.compatibility.changes.every((change) => change.severity === 'compatible'))
})

test('raw snapshot identity is deterministic across retries and distinct across runs', () => {
  const input = {
    tenantKey: 'futurus',
    sourceKey: 'arxiv-official-rss-api',
    contentHash: 'a'.repeat(64),
    runKey: 'run-2026-08-10',
  }
  const first = deriveRawSnapshotIdentity(input)
  const second = deriveRawSnapshotIdentity(input)
  const replay = deriveRawSnapshotIdentity({ ...input, runKey: 'replay-2026-08-10' })
  assert.deepEqual(first, second)
  assert.equal(first.snapshotKey, replay.snapshotKey)
  assert.equal(first.dedupKey, replay.dedupKey)
  assert.notEqual(first.idempotencyKey, replay.idempotencyKey)
  for (const value of Object.values(first)) assert.match(value, /^[a-f0-9]{64}$/)
})

test('dual-time validation accepts complete raw, observation and signal records', () => {
  const raw = validateDualTimeRecord('raw_snapshot', {
    snapshotKey: 'a'.repeat(64),
    sourceKey: 'arxiv-official-rss-api',
    sourceReference: 'https://export.arxiv.org/rss/cs.AI',
    fetchedAt: '2026-08-10T08:00:00Z',
    validFrom: '2026-08-10T08:00:00Z',
    validTo: null,
    recordedAt: '2026-08-10T08:00:01Z',
    contentHash: 'b'.repeat(64),
    dedupKey: 'c'.repeat(64),
    contentType: 'application/rss+xml',
    byteLength: 1024,
    retentionExpiresAt: '2027-08-10T08:00:00Z',
    sourceRegistryVersion: '1.0.0',
    collectorVersion: '0.1.0',
  })
  assert.deepEqual(raw, { ok: true, errors: [] })

  const observation = validateDualTimeRecord('external_observation', {
    observationKey: 'observation-1',
    observedAt: '2026-08-10T08:00:00Z',
    validFrom: '2026-08-10T08:00:00Z',
    validTo: null,
    recordedAt: '2026-08-10T08:01:00Z',
    parserVersion: 'rss-parser-1.0.0',
    payloadHash: 'd'.repeat(64),
    dataQualityStatus: 'valid',
    freshnessStatus: 'fresh',
    conflictStatus: 'none',
    purpose: 'internal-strategic-intelligence',
  })
  assert.deepEqual(observation, { ok: true, errors: [] })

  const signal = validateDualTimeRecord('strategic_signal', {
    signalKey: 'signal-1',
    signalType: 'regulatory-change',
    title: 'AI product regulation changed',
    firstSeenAt: '2026-08-10T08:00:00Z',
    lastSeenAt: '2026-08-10T09:00:00Z',
    validFrom: '2026-08-10T08:00:00Z',
    validTo: null,
    recordedAt: '2026-08-10T09:01:00Z',
    strength: 0.8,
    confidence: 0.7,
    signalStatus: 'candidate',
    dataQualityStatus: 'valid',
    freshnessStatus: 'fresh',
    conflictStatus: 'none',
    ontologyVersion: '3.6.0',
    causalGraphVersion: 'p003-candidate-1',
  })
  assert.deepEqual(signal, { ok: true, errors: [] })
})

test('dual-time and replay validation fail on impossible time, weak hashes and changed input', () => {
  const invalid = validateDualTimeRecord('raw_snapshot', {
    snapshotKey: 'weak',
    sourceKey: 'source',
    sourceReference: 'reference',
    fetchedAt: '2026-08-10T09:00:00Z',
    validFrom: '2026-08-10T09:00:00Z',
    validTo: '2026-08-10T08:00:00Z',
    recordedAt: '2026-08-10T08:00:00Z',
    contentHash: 'weak',
    dedupKey: 'weak',
    contentType: 'text/plain',
    byteLength: -1,
    retentionExpiresAt: 'not-a-time',
    sourceRegistryVersion: '1.0.0',
    collectorVersion: '0.1.0',
  })
  assert.equal(invalid.ok, false)
  assert.ok(invalid.errors.includes('validTo must be after validFrom'))
  assert.ok(invalid.errors.includes('recordedAt must not precede fetchedAt'))
  assert.ok(invalid.errors.includes('contentHash must be a lowercase SHA-256 hash'))

  const replay = validateReplayLineage(
    { runKey: 'original', sourceRegistryVersion: '1', sourceSnapshotHash: 'a', inputHash: 'b' },
    { runKey: 'replay', replayOfRunKey: 'other', sourceRegistryVersion: '2', sourceSnapshotHash: 'x', inputHash: 'y', parserVersion: '' },
  )
  assert.equal(replay.ok, false)
  assert.equal(replay.errors.length, 5)
})

test('candidate SQL keeps Postgres authoritative, raw immutable and retrieval ACL fail-closed', async () => {
  const proposal = await compilePestimDataFoundationProposal()
  const sql = await fs.readFile(proposal.candidateMigrationFile, 'utf8')
  for (const table of [
    'source_registry_entries', 'source_registry_decisions', 'ingestion_runs', 'raw_snapshots',
    'external_observations', 'strategic_signals', 'evidence', 'impact_hypotheses',
    'impact_assessments', 'report_runs', 'report_run_inputs', 'reports', 'acl_entries',
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS strategic_intelligence\\.${table}`))
  assert.match(sql, /FORCE ROW LEVEL SECURITY/)
  assert.match(sql, /current_principal_key\(\) IS NOT NULL/)
  assert.match(sql, /current_purpose\(\) IS NOT NULL/)
  assert.match(sql, /raw snapshots are append-only outside an approved retention job/)
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA strategic_intelligence FROM PUBLIC/)
  assert.match(sql, /status = 'failed'.*NULLIF\(BTRIM\(error_code\), ''\) IS NOT NULL/s)
  assert.match(sql, /status = 'succeeded'.*error_code IS NULL/s)
  assert.doesNotMatch(sql, /GRANT SELECT ON strategic_intelligence\.raw_snapshots TO intelligence_retrieval/)
  assert.doesNotMatch(sql, /qdrant/i)
})

test('P1-SI-D rejects collisions with the preceding candidate', async () => {
  const proposal = await compilePestimDataFoundationProposal()
  const contract = await loadPestimDataFoundationContract()
  const collision = structuredClone(contract)
  collision.additions.objectTypes[0].qualifiedName = 'domain.intelligence.SourceRegistryEntry'
  assert.throws(
    () => applyPestimDataFoundationContract(proposal.baseline.definition, collision),
    /proposal collides with existing objectTypes domain\.intelligence\.SourceRegistryEntry/,
  )
})
