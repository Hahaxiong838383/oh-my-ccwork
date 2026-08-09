import { Pool } from 'pg'

function gatewayError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code })
}

function actionPayload(intent) {
  const taskExternalKey = String(intent?.payload?.taskExternalKey || '').trim()
  const desiredStatus = String(intent?.payload?.desiredStatus || '').trim()
  if (!/^[A-Za-z0-9:_-]{8,240}$/.test(taskExternalKey)) {
    throw gatewayError('unsupported task target', 400, 'unsupported_target')
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
      const supported = (
        (intent.target_system === 'feishu-demo' && intent.action_type === 'feishu_task_status_demo') ||
        (intent.target_system === 'ontology-internal' && intent.action_type === 'record_task_status')
      )
      if (!supported) {
        throw gatewayError('unsupported action type', 400, 'unsupported_action')
      }
      const { taskExternalKey, desiredStatus } = actionPayload(intent)
      await client.query(
        `INSERT INTO actions.demo_task_status (tenant_id, task_external_key, remote_status)
         VALUES ($1,$2,'todo') ON CONFLICT (tenant_id, task_external_key) DO NOTHING`,
        [tenantId, taskExternalKey],
      )
      const target = await client.query(
        `SELECT remote_status, version FROM actions.demo_task_status
          WHERE tenant_id = $1 AND task_external_key = $2`,
        [tenantId, taskExternalKey],
      )
      if (!target.rows[0]) throw gatewayError('demo target not found', 404, 'target_not_found')
      const receipt = {
        simulation: intent.target_system === 'feishu-demo',
        targetSystem: intent.target_system,
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
      const simulation = intent.target_system === 'feishu-demo'
      const executionReceipt = { simulation, taskExternalKey, requestedStatus: desiredStatus, targetVersion: Number(target.rows[0].version) }
      const readbackReceipt = { simulation, taskExternalKey, observedStatus: target.rows[0].remote_status, verified: target.rows[0].remote_status === desiredStatus }
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

  async function verifyOutcome({
    tenantId,
    intentId,
    actorPersonId,
    operationalSuccess,
    goalSuccess,
    evidenceReferences,
    sourceSystem,
    sourceReference,
    observedValue,
    observedText,
    confidenceLevel,
    notes,
  }) {
    return withTenant(tenantId, async (client) => {
      const actor = await approver(client, tenantId, actorPersonId)
      const intent = await getIntent(client, tenantId, intentId, true)
      if (!['verified', 'rolled_back'].includes(intent.status)) throw gatewayError(`cannot verify outcome in ${intent.status}`, 409, 'invalid_transition')
      if (!intent.decision_id || !intent.expected_outcome_id) throw gatewayError('action is not linked to decision outcome', 409, 'decision_outcome_required')
      const references = [...new Set(evidenceReferences.map((item) => String(item || '').trim()).filter(Boolean))]
      if (!references.length || references.length > 50 || references.some((item) => item.length > 500)) {
        throw gatewayError('verification evidence references are required', 400, 'invalid_evidence')
      }
      if (goalSuccess && !operationalSuccess) throw gatewayError('goal success requires operational success', 409, 'invalid_outcome_levels')
      if (!['high', 'medium', 'low', 'insufficient'].includes(confidenceLevel)) throw gatewayError('invalid confidence level', 400, 'invalid_confidence')
      const executionSuccess = intent.readback_receipt?.verified === true
      const observedStatus = goalSuccess ? 'met' : operationalSuccess ? 'partial' : 'not_met'
      const existing = await client.query(
        `SELECT * FROM decision.verifications
          WHERE tenant_id=$1 AND action_intent_id=$2 AND expected_outcome_id=$3`,
        [tenantId, intent.id, intent.expected_outcome_id],
      )
      if (existing.rows[0]) return { ...existing.rows[0], simulation: intent.target_system === 'feishu-demo' }
      const ontologyVersion = await client.query(
        `SELECT id FROM ontology_registry.versions WHERE tenant_id=$1 AND status='active' LIMIT 1`,
        [tenantId],
      )
      const observed = await client.query(
        `INSERT INTO decision.observed_outcomes (
           tenant_id, expected_outcome_id, source_system, source_reference,
           observed_value, observed_text, observed_status, evidence_references,
           confidence_level, observed_at, ontology_version_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,now(),$10)
         RETURNING *`,
        [
          tenantId,
          intent.expected_outcome_id,
          String(sourceSystem || 'human-verification').slice(0, 128),
          String(sourceReference || '').slice(0, 500) || null,
          Number.isFinite(Number(observedValue)) ? Number(observedValue) : null,
          String(observedText || '').slice(0, 1000) || null,
          observedStatus,
          JSON.stringify(references),
          confidenceLevel,
          ontologyVersion.rows[0]?.id || null,
        ],
      )
      const verification = await client.query(
        `INSERT INTO decision.verifications (
           tenant_id, decision_id, task_id, action_intent_id, expected_outcome_id, observed_outcome_id,
           execution_success, operational_success, goal_success,
           execution_status, operational_status, goal_status,
           evidence_references, verification_status, verified_by, notes, ontology_version_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'completed',$14,$15,$16)
         ON CONFLICT (tenant_id, action_intent_id, expected_outcome_id) DO NOTHING
         RETURNING *`,
        [
          tenantId,
          intent.decision_id,
          intent.task_id,
          intent.id,
          intent.expected_outcome_id,
          observed.rows[0].id,
          executionSuccess,
          operationalSuccess,
          goalSuccess,
          executionSuccess ? 'success' : 'failure',
          operationalSuccess ? 'success' : 'failure',
          goalSuccess ? 'achieved' : 'missed',
          JSON.stringify(references),
          actor.id,
          String(notes || '').slice(0, 2000) || null,
          ontologyVersion.rows[0]?.id || null,
        ],
      )
      if (!verification.rows[0]) {
        const concurrent = await client.query(
          `SELECT * FROM decision.verifications
            WHERE tenant_id=$1 AND action_intent_id=$2 AND expected_outcome_id=$3`,
          [tenantId, intent.id, intent.expected_outcome_id],
        )
        return { ...concurrent.rows[0], simulation: intent.target_system === 'feishu-demo' }
      }
      await client.query(
        `UPDATE decision.expected_outcomes SET status=$3, updated_at=now()
          WHERE tenant_id=$1 AND id=$2`,
        [tenantId, intent.expected_outcome_id, goalSuccess ? 'achieved' : 'missed'],
      )
      await client.query(
        `UPDATE actions.intents SET observed_outcome_id=$3, verification_id=$4, updated_at=now()
          WHERE tenant_id=$1 AND id=$2`,
        [tenantId, intent.id, observed.rows[0].id, verification.rows[0].id],
      )
      await audit(client, {
        tenantId,
        intentId,
        actorId: actor.id,
        eventType: 'action_outcome_verified',
        payload: { executionSuccess, operationalSuccess, goalSuccess, verificationId: verification.rows[0].id },
      })
      return { ...verification.rows[0], simulation: intent.target_system === 'feishu-demo' }
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

  return { ready, dryRun, approve, execute, verifyOutcome, rollback, get, close: () => pool.end() }
}
