import { createHash } from 'node:crypto'
import { Pool } from 'pg'

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function createDomainStore({ database, logger = () => {} } = {}) {
  const pool = new Pool(database)
  async function withTenant(tenantId, operation) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId])
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally { client.release() }
  }
  async function ready() {
    try { await pool.query('SELECT 1 FROM domain_read.records LIMIT 1'); return { ready: true } }
    catch (error) { logger('domain database readiness failed', String(error?.message || error).slice(0, 160)); return { ready: false, reason: 'domain_database_unavailable' } }
  }
  async function cursor({ tenantId, sourceSystem }) {
    return withTenant(tenantId, async (client) => (await client.query('SELECT cursor_value FROM domain_read.source_cursors WHERE tenant_id=$1 AND source_system=$2', [tenantId, sourceSystem])).rows[0]?.cursor_value || '')
  }
  async function startRun({ tenantId, sourceSystem, cursorBefore, replay }) {
    return withTenant(tenantId, async (client) => (await client.query(`INSERT INTO domain_read.sync_runs(tenant_id,source_system,status,cursor_before,replay) VALUES($1,$2,'running',$3,$4) RETURNING id`, [tenantId, sourceSystem, cursorBefore || null, replay])).rows[0].id)
  }
  async function upsert({ tenantId, record }) {
    const contentHash = hash(record)
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO domain_read.records(tenant_id,source_system,external_id,object_type,source_updated_at,valid_from,valid_to,status,epistemic_type,confidence,authority,purpose,payload,provenance,content_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)
         ON CONFLICT(tenant_id,source_system,external_id) DO UPDATE SET object_type=EXCLUDED.object_type,source_updated_at=EXCLUDED.source_updated_at,valid_from=EXCLUDED.valid_from,valid_to=EXCLUDED.valid_to,status=EXCLUDED.status,epistemic_type=EXCLUDED.epistemic_type,confidence=EXCLUDED.confidence,authority=EXCLUDED.authority,purpose=EXCLUDED.purpose,payload=EXCLUDED.payload,provenance=EXCLUDED.provenance,content_hash=EXCLUDED.content_hash,recorded_at=now()
         WHERE domain_read.records.content_hash IS DISTINCT FROM EXCLUDED.content_hash
         RETURNING id,(xmax=0) AS inserted`,
        [tenantId, record.sourceSystem, record.externalId, record.objectType, record.sourceUpdatedAt, record.validFrom, record.validTo, record.status, record.epistemicType, record.confidence, record.authority, record.purpose, JSON.stringify(record.payload), JSON.stringify(record.provenance), contentHash],
      )
      return result.rows[0] || { unchanged: true }
    })
  }
  async function deadLetter({ tenantId, runId, sourceSystem, sourceReference, errorCode }) {
    return withTenant(tenantId, (client) => client.query(`INSERT INTO domain_read.dead_letters(tenant_id,run_id,source_system,source_reference,error_code) VALUES($1,$2,$3,$4,$5)`, [tenantId, runId, sourceSystem, sourceReference || null, errorCode]))
  }
  async function finishRun({ tenantId, runId, sourceSystem, status, cursorAfter, stats, errorCode = null }) {
    return withTenant(tenantId, async (client) => {
      await client.query(`UPDATE domain_read.sync_runs SET status=$3,cursor_after=$4,stats=$5::jsonb,error_code=$6,finished_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, runId, status, cursorAfter || null, JSON.stringify(stats), errorCode])
      if (status === 'completed') await client.query(`INSERT INTO domain_read.source_cursors(tenant_id,source_system,cursor_value,last_success_at,last_run_id) VALUES($1,$2,$3,now(),$4) ON CONFLICT(tenant_id,source_system) DO UPDATE SET cursor_value=EXCLUDED.cursor_value,last_success_at=now(),last_run_id=EXCLUDED.last_run_id,updated_at=now()`, [tenantId, sourceSystem, cursorAfter || '', runId])
      await client.query(`INSERT INTO audit.events(tenant_id,actor_service,event_type,resource_type,resource_id,payload) VALUES($1,'company-domain-connector',$2,'domain_sync',$3,$4::jsonb)`, [tenantId, `domain_sync_${status}`, runId, JSON.stringify({ sourceSystem, cursorAfter: cursorAfter || null, stats, errorCode })])
    })
  }
  async function status({ tenantId }) {
    return withTenant(tenantId, async (client) => {
      const rows = await client.query(`SELECT source_system,cursor_value,last_success_at FROM domain_read.source_cursors WHERE tenant_id=$1 ORDER BY source_system`, [tenantId])
      const counts = await client.query(`SELECT source_system,status,count(*)::int AS count FROM domain_read.records WHERE tenant_id=$1 GROUP BY source_system,status ORDER BY source_system,status`, [tenantId])
      return { sources: rows.rows, counts: counts.rows }
    })
  }
  return { ready, cursor, startRun, upsert, deadLetter, finishRun, status, close: () => pool.end() }
}

export function createMemoryDomainStore() {
  const state = { cursors: new Map(), records: new Map(), runs: [], deadLetters: [] }
  return {
    state,
    async ready() { return { ready: true } },
    async cursor({ sourceSystem }) { return state.cursors.get(sourceSystem) || '' },
    async startRun(input) { const id = `run-${state.runs.length + 1}`; state.runs.push({ id, ...input, status: 'running' }); return id },
    async upsert({ record }) { const key = `${record.sourceSystem}:${record.externalId}`, prior = state.records.get(key); state.records.set(key, structuredClone(record)); return prior && JSON.stringify(prior) === JSON.stringify(record) ? { unchanged: true } : { id: key, inserted: !prior } },
    async deadLetter(input) { state.deadLetters.push(structuredClone(input)) },
    async finishRun(input) { const run = state.runs.find((item) => item.id === input.runId); Object.assign(run, input); if (input.status === 'completed') state.cursors.set(input.sourceSystem, input.cursorAfter || '') },
    async status() { return { sources: [...state.cursors].map(([source_system, cursor_value]) => ({ source_system, cursor_value })), counts: [] } },
    async close() {},
  }
}
