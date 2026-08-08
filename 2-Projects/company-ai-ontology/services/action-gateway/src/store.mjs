import { Pool } from 'pg'

function gatewayError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code })
}

function actionPayload(intent) {
  const taskExternalKey = String(intent?.payload?.taskExternalKey || '').trim()
  const desiredStatus = String(intent?.payload?.desiredStatus || '').trim()
  if (!/^demo-p2-2026-001:task:demo-person-[0-9]{2}$/.test(taskExternalKey)) {
    throw gatewayError('unsupported demo task target', 400, 'unsupported_target')
  }
  if (!['todo', 'in_progress', 'done'].includes(desiredStatus)) {
    throw gatewayError('unsupported demo task status', 400, 'unsupported_status')
  }
  return { taskExternalKey, desiredStatus }
}

export function createActionGatewayStore({ database, logger = () => {} } = {}) {
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
      logger('action gateway database readiness failed', String(error?.message || error).slice(0, 160))
      return { ready: false, reason: 'database_unavailable' }
    }
  }

  async function audit(client, { tenantId, intentId, eventType, actorId = null, payload = {} }) {
    await client.query(
      `INSERT INTO audit.events
        (tenant_id, actor_id, actor_service, event_type, resource_type, resource_id, payload)
       VALUES ($1, $2, 'action-gateway', $3, 'action_intent', $4, $5::jsonb)`,
      [tenantId, actorId, eventType, intentId, JSON.stringify(payload)],
    )
  }

  async function getIntent(client, tenantId, intentId, lock = false) {
    const result = await client.query(
      `SELECT i.*, requester.external_key AS requester_external_key
         FROM actions.intents i
         LEFT JOIN iam.principals requester ON requester.id = i.requester_id
        WHERE i.tenant_id = $1 AND i.id = $2
        ${lock ? 'FOR UPDATE OF i' : ''}`,
      [tenantId, intentId],
    )
    if (!result.rows[0]) throw gatewayError('action intent not found', 404, 'not_found')
    return result.rows[0]
  }

  async function approver(client, tenantId, personId) {
    const result = await client.query(
      `SELECT p.id, p.external_key
         FROM iam.principals p
        WHERE p.tenant_id = $1 AND p.external_key = $2 AND p.status = 'active'
          AND EXISTS (
            SELECT 1 FROM iam.grants g
            WHERE g.tenant_id = p.tenant_id AND g.principal_id = p.id
              AND g.resource_scope = 'workflow:p2' AND g.permission = 'approve'
          )`,
      [tenantId, personId],
    )
    if (!result.rows[0]) throw gatewayError('actor cannot approve action', 403, 'forbidden')
    return result.rows[0]
  }

  async function dryRun({ tenantId, intentId }) {
    return withTenant(tenantId, async (client) => {
      const intent = await getIntent(client, tenantId, intentId, true)
      if (intent.status !== 'proposed') throw gatewayError(`cannot dry-run action in ${intent.status}`, 409, 'invalid_transition')
      if (intent.target_system !== 'feishu-demo' || intent.action_type !== 'feishu_task_status_demo') {
        throw gatewayError('unsupported action type', 400, 'unsupported_action')
      }
      const { taskExternalKey, desiredStatus } = actionPayload(intent)
      const target = await client.query(
        `SELECT remote_status, version FROM actions.demo_task_status
          WHERE tenant_id = $1 AND task_external_key = $2`,
        [tenantId, taskExternalKey],
      )
      if (!target.rows[0]) throw gatewayError('demo target not found', 404, 'target_not_found')
      const receipt = {
        simulation: true,
        targetSystem: 'feishu-demo',
        taskExternalKey,
        previousStatus: target.rows[0].remote_status,
        desiredStatus,
        targetVersion: Number(target.rows[0].version),
      }
      const updated = await client.query(
        `UPDATE actions.intents
            SET status = 'dry_run_ready', dry_run_receipt = $3::jsonb, updated_at = now()
          WHERE tenant_id = $1 AND id = $2
          RETURNING *`,
        [tenantId, intentId, JSON.stringify(receipt)],
      )
      await audit(client, { tenantId, intentId, eventType: 'action_dry_run_ready', payload: receipt })
      return updated.rows[0]
    })
  }

  async function approve({ tenantId, intentId, actorPersonId }) {
    return withTenant(tenantId, async (client) => {
      const actor = await approver(client, tenantId, actorPersonId)
      const intent = await getIntent(client, tenantId, intentId, true)
      if (intent.status !== 'dry_run_ready') throw gatewayError(`cannot approve action in ${intent.status}`, 409, 'invalid_transition')
      const updated = await client.query(
        `UPDATE actions.intents
            SET status = 'approved', approved_by = $3, approved_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND id = $2
          RETURNING *`,
        [tenantId, intentId, actor.id],
      )
      await audit(client, { tenantId, intentId, actorId: actor.id, eventType: 'action_approved', payload: { actorPersonId } })
      return updated.rows[0]
    })
  }

  async function execute({ tenantId, intentId }) {
    return withTenant(tenantId, async (client) => {
      const intent = await getIntent(client, tenantId, intentId, true)
      if (intent.status !== 'approved') throw gatewayError(`cannot execute action in ${intent.status}`, 409, 'invalid_transition')
      const { taskExternalKey, desiredStatus } = actionPayload(intent)
      await client.query(
        `UPDATE actions.intents SET status = 'executing', updated_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, intentId],
      )
      const target = await client.query(
        `UPDATE actions.demo_task_status
            SET remote_status = $3, version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND task_external_key = $2
          RETURNING remote_status, version, updated_at`,
        [tenantId, taskExternalKey, desiredStatus],
      )
      if (!target.rows[0]) throw gatewayError('demo target not found', 404, 'target_not_found')
      const executionReceipt = { simulation: true, taskExternalKey, requestedStatus: desiredStatus, targetVersion: Number(target.rows[0].version) }
      const readbackReceipt = { simulation: true, taskExternalKey, observedStatus: target.rows[0].remote_status, verified: target.rows[0].remote_status === desiredStatus }
      const status = readbackReceipt.verified ? 'verified' : 'failed'
      const updated = await client.query(
        `UPDATE actions.intents
            SET status = $3, execution_receipt = $4::jsonb, readback_receipt = $5::jsonb,
                last_error = CASE WHEN $3 = 'failed' THEN 'readback_mismatch' ELSE NULL END,
                updated_at = now()
          WHERE tenant_id = $1 AND id = $2
          RETURNING *`,
        [tenantId, intentId, status, JSON.stringify(executionReceipt), JSON.stringify(readbackReceipt)],
      )
      await audit(client, { tenantId, intentId, eventType: `action_${status}`, payload: { executionReceipt, readbackReceipt } })
      return updated.rows[0]
    })
  }

  async function rollback({ tenantId, intentId, actorPersonId }) {
    return withTenant(tenantId, async (client) => {
      const actor = await approver(client, tenantId, actorPersonId)
      const intent = await getIntent(client, tenantId, intentId, true)
      if (intent.status !== 'verified') throw gatewayError(`cannot rollback action in ${intent.status}`, 409, 'invalid_transition')
      const { taskExternalKey } = actionPayload(intent)
      const previousStatus = String(intent.dry_run_receipt?.previousStatus || '')
      if (!['todo', 'in_progress', 'done'].includes(previousStatus)) throw gatewayError('rollback receipt is invalid', 409, 'rollback_unavailable')
      const target = await client.query(
        `UPDATE actions.demo_task_status
            SET remote_status = $3, version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND task_external_key = $2
          RETURNING remote_status, version`,
        [tenantId, taskExternalKey, previousStatus],
      )
      const receipt = {
        simulation: true,
        taskExternalKey,
        restoredStatus: target.rows[0]?.remote_status || null,
        verified: target.rows[0]?.remote_status === previousStatus,
        targetVersion: Number(target.rows[0]?.version || 0),
      }
      if (!receipt.verified) throw gatewayError('rollback readback failed', 502, 'rollback_failed')
      const updated = await client.query(
        `UPDATE actions.intents
            SET status = 'rolled_back', rollback_receipt = $3::jsonb, updated_at = now()
          WHERE tenant_id = $1 AND id = $2
          RETURNING *`,
        [tenantId, intentId, JSON.stringify(receipt)],
      )
      await audit(client, { tenantId, intentId, actorId: actor.id, eventType: 'action_rolled_back', payload: receipt })
      return updated.rows[0]
    })
  }

  async function get({ tenantId, intentId }) {
    return withTenant(tenantId, (client) => getIntent(client, tenantId, intentId, false))
  }

  return { ready, dryRun, approve, execute, rollback, get, close: () => pool.end() }
}
