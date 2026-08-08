import crypto from 'node:crypto'
import { Pool } from 'pg'

function publicVersion(row) {
  if (!row) return null
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    versionTag: row.version_tag,
    contentHash: row.content_hash,
    sourceCommit: row.source_commit,
    compatibility: row.compatibility,
    status: row.status,
    proposalId: row.proposal_id,
    approvedBy: row.approved_by_external_key,
    migrationPlan: row.migration_plan,
    definition: row.definition,
    deployedAt: row.deployed_at,
    createdAt: row.created_at,
  }
}

export function createMemoryRegistryStore() {
  const state = { versions: [], reconciliations: [], events: [] }
  return {
    state,
    ready: async () => ({ ready: true }),
    active: async () => state.versions.find((version) => version.status === 'active') || null,
    deploy: async ({ bundle, sourceCommit, proposalId, approvedBy, compatibility, migrationPlan }) => {
      const current = state.versions.find((version) => version.status === 'active')
      if (current?.contentHash === bundle.contentHash) return { ...current, alreadyActive: true }
      if (current) current.status = 'superseded'
      const deployedAt = new Date().toISOString()
      const previous = state.versions.find((version) => version.contentHash === bundle.contentHash)
      if (previous) {
        Object.assign(previous, { sourceCommit, proposalId, approvedBy, compatibility, migrationPlan, status: 'active', deployedAt })
        state.events.push({ eventType: 'ontology_version_deployed', contentHash: bundle.contentHash, proposalId, reactivated: true })
        return { ...previous, reactivated: true }
      }
      const version = {
        id: crypto.randomUUID(),
        schemaVersion: bundle.schemaVersion,
        versionTag: `${bundle.schemaVersion}+${bundle.contentHash.slice(0, 12)}`,
        contentHash: bundle.contentHash,
        sourceCommit,
        compatibility,
        status: 'active',
        proposalId,
        approvedBy,
        migrationPlan,
        definition: bundle.definition,
        elements: bundle.elements,
        deployedAt,
        createdAt: deployedAt,
      }
      state.versions.push(version)
      state.events.push({ eventType: 'ontology_version_deployed', contentHash: bundle.contentHash, proposalId })
      return version
    },
    recordReconciliation: async (input) => {
      state.reconciliations.push({ ...input, createdAt: new Date().toISOString() })
    },
    close: async () => {},
  }
}

export function createPostgresRegistryStore({ database, logger = () => {} } = {}) {
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
    } finally {
      client.release()
    }
  }

  async function ready() {
    try {
      await pool.query('SELECT 1')
      return { ready: true }
    } catch (error) {
      logger('ontology registry database readiness failed', String(error?.message || error).slice(0, 160))
      return { ready: false, reason: 'database_unavailable' }
    }
  }

  async function active({ tenantId }) {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM ontology_registry.versions
          WHERE tenant_id = $1 AND status = 'active'
          LIMIT 1`,
        [tenantId],
      )
      return publicVersion(result.rows[0])
    })
  }

  async function deploy({ tenantId, bundle, sourceCommit, proposalId, approvedBy, compatibility, migrationPlan }) {
    return withTenant(tenantId, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ontology-registry:${tenantId}`])
      const existing = await client.query(
        `SELECT * FROM ontology_registry.versions
          WHERE tenant_id = $1 AND status = 'active'
          FOR UPDATE`,
        [tenantId],
      )
      if (existing.rows[0]?.content_hash === bundle.contentHash) return { ...publicVersion(existing.rows[0]), alreadyActive: true }
      const reusable = await client.query(
        `SELECT * FROM ontology_registry.versions
          WHERE tenant_id = $1 AND content_hash = $2
          FOR UPDATE`,
        [tenantId, bundle.contentHash],
      )
      await client.query(
        `UPDATE ontology_registry.versions
            SET status = 'superseded'
          WHERE tenant_id = $1 AND status = 'active'`,
        [tenantId],
      )
      if (reusable.rows[0]) {
        const reactivated = await client.query(
          `UPDATE ontology_registry.versions
              SET source_commit = $3, compatibility = $4, status = 'active', proposal_id = $5,
                  approved_by_external_key = $6, migration_plan = $7::jsonb, deployed_at = now()
            WHERE tenant_id = $1 AND id = $2
            RETURNING *`,
          [tenantId, reusable.rows[0].id, sourceCommit, compatibility, proposalId, approvedBy, JSON.stringify(migrationPlan || {})],
        )
        await client.query(
          `INSERT INTO audit.domain_events
            (event_id, tenant_id, event_type, occurred_at, received_at, producer, actor_service,
             purpose, correlation_id, causation_id, idempotency_key, payload_schema_version,
             ontology_version_id, classification, payload)
           VALUES ($1, $2, 'ontology.version.deployed', now(), now(), 'ontology-registry',
                   'ontology-registry', 'ontology-governance', $3, NULL, $4, '1.0.0', $5,
                   'internal', $6::jsonb)`,
          [crypto.randomUUID(), tenantId, proposalId, `${bundle.contentHash}:${proposalId}`, reusable.rows[0].id, JSON.stringify({
            contentHash: bundle.contentHash, sourceCommit, compatibility, approvedBy, reactivated: true,
          })],
        )
        await client.query(
          `INSERT INTO audit.events
            (tenant_id, actor_service, event_type, resource_type, resource_id, request_id, payload)
           VALUES ($1, 'ontology-registry', 'ontology_version_deployed', 'ontology_version', $2, $3, $4::jsonb)`,
          [tenantId, reusable.rows[0].id, proposalId, JSON.stringify({
            contentHash: bundle.contentHash, sourceCommit, compatibility, approvedBy, reactivated: true,
          })],
        )
        return { ...publicVersion(reactivated.rows[0]), reactivated: true }
      }
      const versionTag = `${bundle.schemaVersion}+${bundle.contentHash.slice(0, 12)}`
      const inserted = await client.query(
        `INSERT INTO ontology_registry.versions
          (tenant_id, schema_version, version_tag, content_hash, source_commit, compatibility,
           status, proposal_id, approved_by_external_key, migration_plan, definition, deployed_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9::jsonb, $10::jsonb, now())
         RETURNING *`,
        [tenantId, bundle.schemaVersion, versionTag, bundle.contentHash, sourceCommit, compatibility,
          proposalId, approvedBy, JSON.stringify(migrationPlan || {}), JSON.stringify(bundle.definition)],
      )
      const version = inserted.rows[0]
      for (const element of bundle.elements) {
        await client.query(
          `INSERT INTO ontology_registry.elements
            (tenant_id, version_id, element_kind, qualified_name, definition_hash, definition)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [tenantId, version.id, element.kind, element.qualifiedName, element.definitionHash, JSON.stringify(element.definition)],
        )
      }
      const eventId = crypto.randomUUID()
      await client.query(
        `INSERT INTO audit.domain_events
          (event_id, tenant_id, event_type, occurred_at, received_at, producer, actor_service,
           purpose, correlation_id, causation_id, idempotency_key, payload_schema_version,
           ontology_version_id, classification, payload)
         VALUES ($1, $2, 'ontology.version.deployed', now(), now(), 'ontology-registry',
                 'ontology-registry', 'ontology-governance', $3, NULL, $4, '1.0.0', $5,
                 'internal', $6::jsonb)`,
        [eventId, tenantId, proposalId, `${bundle.contentHash}:${proposalId}`, version.id, JSON.stringify({
          contentHash: bundle.contentHash, sourceCommit, compatibility, approvedBy, versionTag,
        })],
      )
      await client.query(
        `INSERT INTO audit.events
          (tenant_id, actor_service, event_type, resource_type, resource_id, request_id, payload)
         VALUES ($1, 'ontology-registry', 'ontology_version_deployed', 'ontology_version', $2, $3, $4::jsonb)`,
        [tenantId, version.id, proposalId, JSON.stringify({ contentHash: bundle.contentHash, sourceCommit, compatibility, approvedBy })],
      )
      return publicVersion(version)
    })
  }

  async function recordReconciliation({ tenantId, localHash, activeHash, status, drift }) {
    return withTenant(tenantId, (client) => client.query(
      `INSERT INTO ontology_registry.reconciliation_runs
        (tenant_id, local_hash, active_hash, status, drift)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [tenantId, localHash, activeHash, status, JSON.stringify(drift || {})],
    ))
  }

  return { ready, active, deploy, recordReconciliation, close: () => pool.end() }
}
