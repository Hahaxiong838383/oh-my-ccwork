import { Pool } from 'pg'

export function createKnowledgeStore({ database, logger = () => {} } = {}) {
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
      await pool.query('SELECT 1 FROM knowledge.resources LIMIT 1')
      return { ready: true }
    } catch (error) {
      logger('knowledge database readiness failed', String(error?.message || error).slice(0, 160))
      return { ready: false, reason: 'knowledge_database_unavailable' }
    }
  }

  async function startRun({ tenantId }) {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO knowledge.sync_runs (tenant_id, status)
         VALUES ($1, 'running') RETURNING id`,
        [tenantId],
      )
      return result.rows[0].id
    })
  }

  async function finishRun({ tenantId, runId, status, stats, errorCode = null }) {
    return withTenant(tenantId, (client) => client.query(
      `UPDATE knowledge.sync_runs
          SET status = $3, stats = $4::jsonb, error_code = $5, finished_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, runId, status, JSON.stringify(stats || {}), errorCode],
    ))
  }

  async function replaceResource({ tenantId, resource, aclEntries, chunks }) {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO knowledge.resources (
           tenant_id, provider, resource_type, external_key, space_id, parent_external_key,
           title, source_url, classification, acl_status, status, content_hash, metadata,
           source_updated_at, synced_at
         ) VALUES ($1, 'feishu', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, now())
         ON CONFLICT (tenant_id, provider, external_key) DO UPDATE SET
           resource_type = EXCLUDED.resource_type,
           space_id = EXCLUDED.space_id,
           parent_external_key = EXCLUDED.parent_external_key,
           title = EXCLUDED.title,
           source_url = EXCLUDED.source_url,
           classification = EXCLUDED.classification,
           acl_status = EXCLUDED.acl_status,
           status = EXCLUDED.status,
           content_hash = EXCLUDED.content_hash,
           metadata = EXCLUDED.metadata,
           source_updated_at = EXCLUDED.source_updated_at,
           synced_at = now(),
           updated_at = now()
         RETURNING id`,
        [
          tenantId,
          resource.resourceType,
          resource.externalKey,
          resource.spaceId || null,
          resource.parentExternalKey || null,
          resource.title,
          resource.sourceUrl || null,
          resource.classification || 'internal',
          resource.aclStatus,
          resource.status,
          resource.contentHash || null,
          JSON.stringify(resource.metadata || {}),
          resource.sourceUpdatedAt || null,
        ],
      )
      const resourceId = result.rows[0].id
      await client.query('DELETE FROM knowledge.acl_entries WHERE tenant_id = $1 AND resource_id = $2', [tenantId, resourceId])
      await client.query('DELETE FROM knowledge.chunks WHERE tenant_id = $1 AND resource_id = $2', [tenantId, resourceId])
      for (const entry of aclEntries) {
        await client.query(
          `INSERT INTO knowledge.acl_entries
             (tenant_id, resource_id, subject_type, subject_key, permission, source)
           VALUES ($1, $2, $3, $4, 'read', $5)
           ON CONFLICT DO NOTHING`,
          [tenantId, resourceId, entry.subjectType, entry.subjectKey, entry.source || 'feishu_acl'],
        )
      }
      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO knowledge.chunks
             (tenant_id, resource_id, chunk_index, content, token_estimate)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, resourceId, chunk.index, chunk.content, chunk.tokenEstimate],
        )
      }
      return { resourceId, chunks: chunks.length, aclEntries: aclEntries.length }
    })
  }

  async function audit({ tenantId, eventType, resourceId, payload }) {
    return withTenant(tenantId, (client) => client.query(
      `INSERT INTO audit.events
         (tenant_id, actor_service, event_type, resource_type, resource_id, payload)
       VALUES ($1, 'company-knowledge-connector', $2, 'knowledge_sync', $3, $4::jsonb)`,
      [tenantId, eventType, resourceId || null, JSON.stringify(payload || {})],
    ))
  }

  return { ready, startRun, finishRun, replaceResource, audit, close: () => pool.end() }
}
