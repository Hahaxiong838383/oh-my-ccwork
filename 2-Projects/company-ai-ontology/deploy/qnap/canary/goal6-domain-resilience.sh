#!/bin/sh
set -eu
exec </dev/null

docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}

cd "$project_root"
set -a
. ./.env
set +a

"$docker_path" compose exec -T domain-connector node --input-type=module - <<'NODE'
const { createDomainStore } = await import('file:///app/src/store.mjs')
const { createDomainSync } = await import('file:///app/src/sync.mjs')

const tenantId = process.env.FUTURUS_TENANT_ID
const database = {
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 2,
  connectionTimeoutMillis: 5000,
}
const store = createDomainStore({ database })
const timestamp = new Date().toISOString()
const record = (externalId, status, patch = {}) => ({
  externalId,
  objectType: 'domain.market.MarketSignal',
  sourceUpdatedAt: timestamp,
  validFrom: timestamp,
  validTo: ['expired', 'revoked', 'deleted'].includes(status) ? timestamp : null,
  status,
  epistemicType: 'source_fact',
  authority: 'goal6-acceptance-fixture',
  purpose: 'domain-resilience-validation',
  payload: { provider: 'goal6-validation', signalType: status, ...patch },
  provenance: { sourceRecordId: externalId, sourceVersion: 'goal6-validation-v1', collectedAt: timestamp, transformation: 'controlled-fixture' },
})

try {
  const lifecycleSource = { key: 'goal6-lifecycle-validation', enabled: true, purpose: 'domain-resilience-validation' }
  const lifecycleConfig = { tenantId, pageLimit: 100, maxPages: 2, sources: { [lifecycleSource.key]: lifecycleSource } }
  const lifecycleClient = { page: async () => ({
    items: [
      record('goal6-validation:active', 'active'),
      record('goal6-validation:expired', 'expired'),
      record('goal6-validation:revoked', 'revoked'),
      record('goal6-validation:deleted', 'deleted'),
      record('goal6-validation:unsafe', 'active', { apiToken: 'must-never-persist' }),
    ],
    nextCursor: 'lifecycle-complete',
    hasMore: false,
  }) }
  const lifecycleSync = createDomainSync({ config: lifecycleConfig, clients: { [lifecycleSource.key]: lifecycleClient }, store })
  const lifecycle = await lifecycleSync.run(lifecycleSource.key)
  if (!lifecycle.ok || lifecycle.stats.isolated !== 1) throw new Error('dead-letter isolation failed')

  const recoverySource = { key: 'goal6-recovery-validation', enabled: true, purpose: 'domain-recovery-validation' }
  const recoveryConfig = { tenantId, pageLimit: 100, maxPages: 2, sources: { [recoverySource.key]: recoverySource } }
  const failedSync = createDomainSync({
    config: recoveryConfig,
    clients: { [recoverySource.key]: { page: async () => { throw Object.assign(new Error('controlled outage'), { code: 'source_unavailable' }) } },
    store,
  })
  const failed = await failedSync.run(recoverySource.key)
  if (failed.ok || failed.status !== 'failed') throw new Error('controlled source failure was not recorded')

  const recoveryClient = { page: async () => ({ items: [record('goal6-validation:recovered', 'active')], nextCursor: 'live-recovery-cursor', hasMore: false }) }
  const recoveredSync = createDomainSync({ config: recoveryConfig, clients: { [recoverySource.key]: recoveryClient }, store })
  const recovered = await recoveredSync.run(recoverySource.key)
  if (!recovered.ok) throw new Error('source recovery failed')

  const replayClient = { page: async () => ({ items: [record('goal6-validation:recovered', 'active')], nextCursor: 'historical-replay-cursor', hasMore: false }) }
  const replaySync = createDomainSync({ config: recoveryConfig, clients: { [recoverySource.key]: replayClient }, store })
  const replay = await replaySync.run(recoverySource.key, { cursorOverride: 'historical-start', replay: true })
  const liveCursor = await store.cursor({ tenantId, sourceSystem: recoverySource.key })
  if (!replay.ok || liveCursor !== 'live-recovery-cursor') throw new Error('replay replaced the live cursor')

  console.log(JSON.stringify({
    lifecycle: lifecycle.stats,
    sourceFailure: failed.status,
    recovery: recovered.status,
    replay: replay.status,
    liveCursorPreserved: true,
  }))
} finally {
  await store.close()
}
NODE

lifecycle_statuses=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT string_agg(status || ':' || count, ',' ORDER BY status) FROM (SELECT status,count(*)::text AS count FROM domain_read.records WHERE source_system='goal6-lifecycle-validation' GROUP BY status) status_counts;")
dead_letters=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM domain_read.dead_letters WHERE source_system='goal6-lifecycle-validation' AND error_code='unsafe_source_payload';")
failed_runs=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM domain_read.sync_runs WHERE source_system='goal6-recovery-validation' AND status='failed' AND error_code='source_unavailable';")
recovered_runs=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM domain_read.sync_runs WHERE source_system='goal6-recovery-validation' AND status='completed';")
unsafe_persisted=$($docker_path compose exec -T postgres psql -U ontology_admin -d ontology -Atc \
  "SELECT count(*) FROM domain_read.records WHERE source_system='goal6-lifecycle-validation' AND payload::text ~* 'apiToken';")

printf 'lifecycle_statuses=%s dead_letters=%s failed_runs=%s recovered_runs=%s unsafe_persisted=%s\n' \
  "$lifecycle_statuses" "$dead_letters" "$failed_runs" "$recovered_runs" "$unsafe_persisted"
printf '%s' "$lifecycle_statuses" | grep -q 'active:'
printf '%s' "$lifecycle_statuses" | grep -q 'expired:'
printf '%s' "$lifecycle_statuses" | grep -q 'revoked:'
printf '%s' "$lifecycle_statuses" | grep -q 'deleted:'
[ "$dead_letters" -ge 1 ]
[ "$failed_runs" -ge 1 ]
[ "$recovered_runs" -ge 2 ]
[ "$unsafe_persisted" -eq 0 ]
