import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'

import { assertWorkCaseTransition, stageContract } from './work-protocol.mjs'

const SEARCH_STOP_TERMS = new Set([
  '一下', '什么', '公司', '是否', '有关', '相关', '现在', '目前', '可以', '如何', '怎么', '请问', '告诉', '需要',
])

export function buildSearchTerms(query, limit = 24) {
  const normalized = String(query || '').normalize('NFKC').toLowerCase().slice(0, 200)
  const tokens = normalized.match(/[a-z0-9_:@.-]{2,}|\p{Script=Han}{2,}/gu) || []
  const output = new Set()
  for (const token of tokens.filter((value) => /^[a-z0-9_:@.-]+$/u.test(value))) {
    output.add(token)
    if (output.size >= limit) return [...output]
  }
  for (const token of tokens.filter((value) => !/^[a-z0-9_:@.-]+$/u.test(value))) {
    for (let size = 2; size <= 4; size += 1) {
      for (let offset = 0; offset + size <= token.length; offset += 1) {
        const term = token.slice(offset, offset + size)
        if (!SEARCH_STOP_TERMS.has(term)) output.add(term)
        if (output.size >= limit) return [...output]
      }
    }
  }
  return [...output].slice(0, limit)
}

export function mapKnowledgeEvidence(row) {
  const metadata = row?.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {}
  return {
    evidenceId: `knowledge:${row.id}`,
    resourceId: row.resource_id,
    source: String(metadata.sourceSystem || row.provider || 'feishu-knowledge'),
    objectType: row.resource_type,
    externalKey: row.external_key,
    title: row.title,
    classification: row.classification,
    updatedAt: row.source_updated_at || row.synced_at,
    validUntil: metadata.validUntil || null,
    sourceUrl: row.source_url,
    sourceReference: metadata.sourceReference || row.external_key,
    excerpt: String(row.content || '').slice(0, 1600),
    epistemicType: metadata.epistemicType || 'source_fact',
    supports: metadata.supports !== false,
    contradicts: metadata.contradicts === true,
    chunkIndex: row.chunk_index,
    permissionSnapshot: true,
    simulation: metadata.simulation === true,
  }
}

export function mapOntologyEvidence(row) {
  const attributes = row?.attributes && typeof row.attributes === 'object' && !Array.isArray(row.attributes) ? row.attributes : {}
  return {
    evidenceId: row.id,
    source: String(attributes.sourceSystem || 'ontology'),
    objectType: row.entity_type,
    externalKey: row.external_key,
    title: row.display_name,
    classification: row.classification,
    updatedAt: row.updated_at,
    validUntil: attributes.validUntil || null,
    sourceReference: attributes.sourceReference || row.external_key,
    summary: String(attributes.summary || ''),
    epistemicType: attributes.epistemicType || 'source_fact',
    supports: attributes.supports !== false,
    contradicts: attributes.contradicts === true,
    permissionSnapshot: true,
    simulation: attributes.simulation === true,
  }
}

export function createPostgresStore({ database, logger = () => {} } = {}) {
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

  async function claim({ tenantId, namespace, idempotencyKey, requestHash, expiresAt }) {
    return withTenant(tenantId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO runtime.idempotency_keys
          (tenant_id, namespace, idempotency_key, request_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING
         RETURNING status`,
        [tenantId, namespace, idempotencyKey, requestHash, expiresAt],
      )
      if (inserted.rowCount === 1) return { kind: 'new' }
      const existing = await client.query(
        `SELECT request_hash, response, status
           FROM runtime.idempotency_keys
          WHERE tenant_id = $1 AND namespace = $2 AND idempotency_key = $3`,
        [tenantId, namespace, idempotencyKey],
      )
      const row = existing.rows[0]
      if (!row) throw new Error('idempotency record disappeared')
      if (row.request_hash !== requestHash) return { kind: 'conflict' }
      if (row.status === 'started') return { kind: 'in_progress' }
      return { kind: 'replay', response: row.response, status: row.status }
    })
  }

  async function finish({ tenantId, namespace, idempotencyKey, status, response }) {
    return withTenant(tenantId, (client) => client.query(
      `UPDATE runtime.idempotency_keys
          SET status = $4, response = $5::jsonb, updated_at = now()
        WHERE tenant_id = $1 AND namespace = $2 AND idempotency_key = $3`,
      [tenantId, namespace, idempotencyKey, status, JSON.stringify(response)],
    ))
  }

  async function audit({ tenantId, requestId, eventType, personId, payload = {} }) {
    return withTenant(tenantId, (client) => client.query(
      `INSERT INTO audit.events
        (tenant_id, actor_service, event_type, resource_type, resource_id, request_id, payload)
       VALUES ($1, 'company-agent-core', $2, 'agent_turn', $3, $4, $5::jsonb)`,
      [tenantId, eventType, personId, requestId, JSON.stringify(payload)],
    ))
  }

  async function ready() {
    try {
      await pool.query('SELECT 1')
      return { ready: true }
    } catch (error) {
      logger('database readiness failed', String(error?.message || error).slice(0, 160))
      return { ready: false, reason: 'database_unavailable' }
    }
  }

  async function permissionedSearch({ tenantId, personId, query, limit = 8 }) {
    return withTenant(tenantId, async (client) => {
      const principal = await client.query(
        `SELECT id, external_key, display_name, department_key, attributes
           FROM iam.principals
          WHERE tenant_id = $1 AND external_key = $2 AND status = 'active'
          LIMIT 1`,
        [tenantId, personId],
      )
      if (!principal.rows[0]) return []
      const normalizedQuery = String(query || '').trim().slice(0, 200)
      const normalizedLimit = Math.max(1, Math.min(20, Number(limit) || 8))
      const searchTerms = buildSearchTerms(normalizedQuery)
      const knowledge = await client.query(
        `SELECT c.id, c.content, c.chunk_index,
                r.id AS resource_id, r.provider, r.resource_type, r.external_key, r.title,
                r.source_url, r.classification, r.source_updated_at, r.synced_at,
                r.metadata,
                CASE WHEN $4 = '' THEN 0
                     ELSE ts_rank_cd(c.search_vector, plainto_tsquery('simple', $4)) END
                + COALESCE((
                    SELECT count(*)::real
                      FROM unnest($6::text[]) AS term
                     WHERE position(lower(term) in lower(r.title)) > 0
                        OR position(lower(term) in lower(c.content)) > 0
                  ), 0) AS rank
           FROM knowledge.chunks c
           JOIN knowledge.resources r
             ON r.tenant_id = c.tenant_id AND r.id = c.resource_id
          WHERE r.tenant_id = $1
            AND r.status = 'active'
            AND r.acl_status = 'known'
            AND (
              $4 = ''
              OR c.search_vector @@ plainto_tsquery('simple', $4)
              OR r.title ILIKE '%' || $4 || '%'
              OR c.content ILIKE '%' || $4 || '%'
              OR EXISTS (
                SELECT 1
                  FROM unnest($6::text[]) AS term
                 WHERE position(lower(term) in lower(r.title)) > 0
                    OR position(lower(term) in lower(c.content)) > 0
              )
            )
            AND EXISTS (
              SELECT 1
                FROM knowledge.acl_entries a
               WHERE a.tenant_id = r.tenant_id
                 AND a.resource_id = r.id
                 AND a.permission = 'read'
                 AND (
                   a.subject_type = 'tenant'
                   OR (a.subject_type = 'person' AND a.subject_key = $2)
                   OR (
                     a.subject_type = 'department'
                     AND (
                       a.subject_key = $3
                       OR COALESCE($5::jsonb->'departmentIds', '[]'::jsonb) ? a.subject_key
                     )
                   )
                 )
          )
          ORDER BY rank DESC, r.source_updated_at DESC NULLS LAST, r.synced_at DESC, c.chunk_index
          LIMIT $7`,
        [tenantId, personId, principal.rows[0].department_key, normalizedQuery, JSON.stringify(principal.rows[0].attributes || {}), searchTerms, normalizedLimit],
      )
      const knowledgeEvidence = knowledge.rows.map(mapKnowledgeEvidence)
      if (knowledgeEvidence.length >= normalizedLimit) return knowledgeEvidence
      const result = await client.query(
        `SELECT e.id, e.entity_type, e.external_key, e.display_name, e.classification,
                e.attributes, e.updated_at
           FROM ontology.entities e
          WHERE e.tenant_id = $1
            AND ($3 = '' OR e.display_name ILIKE '%' || $3 || '%' OR e.attributes::text ILIKE '%' || $3 || '%')
            AND (
              e.classification = 'public'
              OR EXISTS (
                SELECT 1
                  FROM iam.grants g
                 WHERE g.tenant_id = e.tenant_id
                   AND g.principal_id = $2
                   AND g.permission = 'read'
                   AND (
                     g.resource_scope = 'ontology:entity:' || e.id::text
                     OR g.resource_scope = 'ontology:department:' || COALESCE(e.attributes->>'department_key', '')
                     OR (
                       g.resource_scope LIKE 'ontology:classification:%'
                       AND CASE split_part(g.resource_scope, ':', 3)
                             WHEN 'restricted' THEN 4
                             WHEN 'confidential' THEN 3
                             WHEN 'internal' THEN 2
                             WHEN 'public' THEN 1
                             ELSE 0
                           END >= CASE e.classification
                             WHEN 'restricted' THEN 4
                             WHEN 'confidential' THEN 3
                             WHEN 'internal' THEN 2
                             WHEN 'public' THEN 1
                             ELSE 5
                           END
                     )
                   )
              )
            )
          ORDER BY CASE e.classification WHEN 'public' THEN 1 WHEN 'internal' THEN 2 WHEN 'confidential' THEN 3 ELSE 4 END,
                   e.updated_at DESC
          LIMIT $4`,
        [tenantId, principal.rows[0].id, normalizedQuery, normalizedLimit - knowledgeEvidence.length],
      )
      return [...knowledgeEvidence, ...result.rows.map(mapOntologyEvidence)]
    })
  }

  async function permissionedRetrieve({ tenantId, personId, query, limit = 8 }) {
    const principal = await withTenant(tenantId, (client) => client.query(
      `SELECT id FROM iam.principals
        WHERE tenant_id = $1 AND external_key = $2 AND status = 'active' LIMIT 1`,
      [tenantId, personId],
    ))
    if (!principal.rows[0]) {
      return {
        evidence: [],
        principalFound: false,
        policyDecisionReference: 'principal-not-active',
        excludedReasonCounts: { principal_not_active: 1 },
        limit: Math.max(1, Math.min(20, Number(limit) || 8)),
        truncated: false,
      }
    }
    const evidence = await permissionedSearch({ tenantId, personId, query, limit })
    return {
      evidence,
      principalFound: true,
      policyDecisionReference: 'permissioned-retrieval-gateway',
      excludedReasonCounts: {},
      limit: Math.max(1, Math.min(20, Number(limit) || 8)),
      truncated: false,
    }
  }

  async function createWorkCase({ tenantId, draft }) {
    return withTenant(tenantId, async (client) => {
      const [principal, ontologyVersion] = await Promise.all([
        client.query(
          `SELECT id FROM iam.principals
            WHERE tenant_id = $1 AND external_key = $2 AND status = 'active' LIMIT 1`,
          [tenantId, draft.principalExternalKey],
        ),
        client.query(
          `SELECT id FROM ontology_registry.versions
            WHERE tenant_id = $1 AND status = 'active' LIMIT 1`,
          [tenantId],
        ),
      ])
      const inserted = await client.query(
        `INSERT INTO work.brain_cases (
           tenant_id, external_case_id, principal_id, principal_external_key, purpose, work_mode,
           request_summary, request_fingerprint, requested_outcome, status, risk_level,
           policy_snapshot_id, policy_snapshot, ontology_version_id, protocol_version,
           processing_mode, conversation_reference_hash, started_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18)
         ON CONFLICT (tenant_id, external_case_id) DO UPDATE SET updated_at = now()
         RETURNING id, external_case_id, status, work_mode, processing_mode, started_at`,
        [
          tenantId, draft.externalCaseId, principal.rows[0]?.id || null, draft.principalExternalKey,
          draft.purpose, draft.workMode, draft.requestSummary, draft.requestFingerprint,
          draft.requestedOutcome, draft.status, draft.riskLevel, draft.policySnapshotId,
          JSON.stringify(draft.policySnapshot), ontologyVersion.rows[0]?.id || null,
          draft.protocolVersion, draft.processingMode, draft.conversationReferenceHash, draft.startedAt,
        ],
      )
      const workCase = inserted.rows[0]
      for (const stage of stageContract()) {
        const initialStatus = stage.stageType === 'intake' ? 'completed' : stage.status
        await client.query(
          `INSERT INTO work.brain_case_stages (
             tenant_id, case_id, sequence_no, stage_type, status, input_references, output_references,
             ontology_version_id, started_at, ended_at
           ) VALUES ($1,$2,$3,$4,$5,'[]'::jsonb,'[]'::jsonb,$6,$7,$8)
           ON CONFLICT (tenant_id, case_id, stage_type) DO NOTHING`,
          [
            tenantId, workCase.id, stage.sequenceNo, stage.stageType, initialStatus,
            ontologyVersion.rows[0]?.id || null,
            stage.stageType === 'intake' ? draft.startedAt : null,
            stage.stageType === 'intake' ? draft.startedAt : null,
          ],
        )
      }
      await client.query(
        `INSERT INTO work.brain_case_events (
           tenant_id, case_id, event_type, from_status, to_status, idempotency_key, payload, occurred_at
         ) VALUES ($1,$2,'work_case_received',NULL,'received',$3,$4::jsonb,$5)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
        [tenantId, workCase.id, `${draft.externalCaseId}:received`, JSON.stringify({ workMode: draft.workMode }), draft.startedAt],
      )
      return {
        caseId: workCase.id,
        externalCaseId: workCase.external_case_id,
        status: workCase.status,
        workMode: workCase.work_mode,
        processingMode: workCase.processing_mode,
        principalFound: Boolean(principal.rows[0]),
        startedAt: workCase.started_at,
      }
    })
  }

  async function recordWorkStage({ tenantId, caseId, stageType, status, inputReferences = [], outputReferences = [], policyDecisionReference = null, blockReasonCode = null }) {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE work.brain_case_stages
            SET status = $4,
                input_references = $5::jsonb,
                output_references = $6::jsonb,
                policy_decision_reference = $7,
                block_reason_code = $8,
                started_at = COALESCE(started_at, now()),
                ended_at = CASE WHEN $4 IN ('completed','blocked','skipped') THEN now() ELSE ended_at END,
                updated_at = now()
          WHERE tenant_id = $1 AND case_id = $2 AND stage_type = $3
          RETURNING id, stage_type, status, started_at, ended_at`,
        [tenantId, caseId, stageType, status, JSON.stringify(inputReferences), JSON.stringify(outputReferences), policyDecisionReference, blockReasonCode],
      )
      return result.rows[0] || null
    })
  }

  async function advanceWorkCase({ tenantId, caseId, toStatus, stageType, stageStatus = 'completed', inputReferences = [], outputReferences = [], policyDecisionReference = null, blockReasonCode = null }) {
    return withTenant(tenantId, async (client) => {
      const current = await client.query(
        `SELECT status FROM work.brain_cases WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, caseId],
      )
      if (!current.rows[0]) throw Object.assign(new Error('work case not found'), { statusCode: 404, code: 'not_found' })
      const fromStatus = current.rows[0].status
      assertWorkCaseTransition(fromStatus, toStatus)
      const stage = await client.query(
        `UPDATE work.brain_case_stages
            SET status = $4, input_references = $5::jsonb, output_references = $6::jsonb,
                policy_decision_reference = $7, block_reason_code = $8,
                started_at = COALESCE(started_at, now()),
                ended_at = CASE WHEN $4 IN ('completed','blocked','skipped') THEN now() ELSE ended_at END,
                updated_at = now()
          WHERE tenant_id = $1 AND case_id = $2 AND stage_type = $3
          RETURNING id`,
        [tenantId, caseId, stageType, stageStatus, JSON.stringify(inputReferences), JSON.stringify(outputReferences), policyDecisionReference, blockReasonCode],
      )
      await client.query(
        `UPDATE work.brain_cases
            SET status = $3, updated_at = now(),
                completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, caseId, toStatus],
      )
      await client.query(
        `INSERT INTO work.brain_case_events (
           tenant_id, case_id, stage_id, event_type, from_status, to_status, idempotency_key, payload
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          tenantId, caseId, stage.rows[0]?.id || null, `work_case_${toStatus}`, fromStatus, toStatus,
          `workcase:${caseId}:${toStatus}:${randomUUID()}`,
          JSON.stringify({ stageType, stageStatus, blockReasonCode, outputReferenceCount: outputReferences.length }),
        ],
      )
      return { caseId, fromStatus, status: toStatus }
    })
  }

  async function recordEpistemicAssessment({ tenantId, caseId, evidencePackage, assessment }) {
    return withTenant(tenantId, async (client) => {
      const ontologyVersion = await client.query(
        `SELECT id FROM ontology_registry.versions WHERE tenant_id = $1 AND status = 'active' LIMIT 1`,
        [tenantId],
      )
      await client.query(
        `INSERT INTO epistemic.assessments (
           tenant_id, case_id, evidence_package_id, completeness, freshness_status,
           contradiction_status, confidence_level, deterministic_conclusion_allowed,
           reasons, evidence_references, excluded_reason_counts, freshness_summary,
           truncation_summary, ontology_version_id, valid_until
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15)
         ON CONFLICT (tenant_id, case_id, evidence_package_id) DO NOTHING`,
        [
          tenantId, caseId, assessment.evidencePackageId, assessment.completeness, assessment.freshnessStatus,
          assessment.contradictionStatus, assessment.confidenceLevel, assessment.deterministicConclusionAllowed,
          JSON.stringify(assessment.reasons), JSON.stringify(assessment.evidenceReferences),
          JSON.stringify(assessment.excludedReasonCounts), JSON.stringify(assessment.freshnessSummary),
          JSON.stringify(assessment.truncationSummary), ontologyVersion.rows[0]?.id || null,
          assessment.validityWindow?.validUntil || null,
        ],
      )
      for (const assumption of evidencePackage.assumptions || []) {
        await client.query(
          `INSERT INTO epistemic.assumptions (
             tenant_id, case_id, statement_summary, impact, verification_status, ontology_version_id
           ) VALUES ($1,$2,$3,$4,'unverified',$5)`,
          [tenantId, caseId, String(assumption.statement || assumption.code || '').slice(0, 1000), String(assumption.impact || '影响待评估').slice(0, 500), ontologyVersion.rows[0]?.id || null],
        )
      }
      for (const unknown of evidencePackage.unknowns || []) {
        await client.query(
          `INSERT INTO epistemic.unknowns (
             tenant_id, case_id, description, impact, resolution_status, ontology_version_id
           ) VALUES ($1,$2,$3,$4,'open',$5)`,
          [tenantId, caseId, String(unknown.code || unknown.description || '').slice(0, 1000), String(unknown.impact || '影响待评估').slice(0, 500), ontologyVersion.rows[0]?.id || null],
        )
      }
    })
  }

  async function completeWorkCase({ tenantId, caseId, evidenceCount, confidenceLevel, deterministicConclusionAllowed, responseValidationStatus }) {
    await advanceWorkCase({ tenantId, caseId, toStatus: 'completed', stageType: 'response', stageStatus: 'completed', outputReferences: ['employee-answer'] })
    return withTenant(tenantId, (client) => client.query(
      `UPDATE work.brain_cases
          SET evidence_count = $3, confidence_level = $4,
              deterministic_conclusion_allowed = $5, response_validation_status = $6,
              completed_at = COALESCE(completed_at, now()), updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, caseId, evidenceCount, confidenceLevel, deterministicConclusionAllowed, responseValidationStatus],
    ))
  }

  async function finalizeWorkCase({ tenantId, caseId, evidenceCount, confidenceLevel, deterministicConclusionAllowed, responseValidationStatus }) {
    return withTenant(tenantId, (client) => client.query(
      `UPDATE work.brain_cases
          SET evidence_count = $3, confidence_level = $4,
              deterministic_conclusion_allowed = $5, response_validation_status = $6,
              completed_at = CASE
                WHEN status IN ('permission_denied','blocked','insufficient_evidence','review_required')
                THEN COALESCE(completed_at, now())
                ELSE completed_at
              END,
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, caseId, evidenceCount, confidenceLevel, deterministicConclusionAllowed, responseValidationStatus],
    ))
  }

  async function workProtocolStatus({ tenantId, limit = 8 }) {
    return withTenant(tenantId, async (client) => {
      const [counts, recent] = await Promise.all([
        client.query(
          `SELECT status, count(*)::integer AS count
             FROM work.brain_cases WHERE tenant_id = $1 GROUP BY status ORDER BY status`,
          [tenantId],
        ),
        client.query(
          `SELECT case_id, work_mode, status, processing_mode, evidence_count, confidence_level,
                  deterministic_conclusion_allowed, response_validation_status, started_at, completed_at,
                  stage_count, completed_stage_count, contract_only_stage_count
             FROM work.brain_case_status_v1
            WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT $2`,
          [tenantId, Math.max(1, Math.min(20, Number(limit) || 8))],
        ),
      ])
      const caseIds = recent.rows.map((row) => row.case_id)
      const stages = caseIds.length ? await client.query(
        `SELECT case_id, sequence_no, stage_type, status, block_reason_code, started_at, ended_at
           FROM work.brain_case_stages
          WHERE tenant_id = $1 AND case_id = ANY($2::uuid[])
          ORDER BY case_id, sequence_no`,
        [tenantId, caseIds],
      ) : { rows: [] }
      return {
        counts: Object.fromEntries(counts.rows.map((row) => [row.status, Number(row.count)])),
        recentCases: recent.rows.map((row) => ({
          caseId: row.case_id,
          workMode: row.work_mode,
          status: row.status,
          processingMode: row.processing_mode,
          evidenceCount: Number(row.evidence_count || 0),
          confidenceLevel: row.confidence_level,
          deterministicConclusionAllowed: row.deterministic_conclusion_allowed,
          responseValidationStatus: row.response_validation_status,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          stageCount: Number(row.stage_count || 0),
          completedStageCount: Number(row.completed_stage_count || 0),
          contractOnlyStageCount: Number(row.contract_only_stage_count || 0),
          stages: stages.rows.filter((stage) => stage.case_id === row.case_id).map((stage) => ({
            sequenceNo: stage.sequence_no,
            stageType: stage.stage_type,
            status: stage.status,
            blockReasonCode: stage.block_reason_code,
            startedAt: stage.started_at,
            endedAt: stage.ended_at,
          })),
        })),
      }
    })
  }

  async function compileP2({ tenantId, actorPersonId, p2ExternalKey, assigneeCount = 5 }) {
    return withTenant(tenantId, async (client) => {
      const actor = await client.query(
        `SELECT p.id
           FROM iam.principals p
          WHERE p.tenant_id = $1 AND p.external_key = $2 AND p.status = 'active'
            AND EXISTS (
              SELECT 1 FROM iam.grants g
              WHERE g.tenant_id = p.tenant_id AND g.principal_id = p.id
                AND g.resource_scope = 'workflow:p2' AND g.permission = 'approve'
            )`,
        [tenantId, actorPersonId],
      )
      if (!actor.rows[0]) throw Object.assign(new Error('actor cannot compile P2 tasks'), { statusCode: 403, code: 'forbidden' })
      const p2 = await client.query(
        `SELECT id, display_name FROM ontology.entities
          WHERE tenant_id = $1 AND entity_type = 'p2' AND external_key = $2 LIMIT 1`,
        [tenantId, p2ExternalKey],
      )
      if (!p2.rows[0]) throw Object.assign(new Error('P2 entity not found'), { statusCode: 404, code: 'not_found' })
      const assignees = await client.query(
        `SELECT id, external_key, display_name FROM iam.principals
          WHERE tenant_id = $1 AND external_key LIKE 'demo-person-%' AND status = 'active'
          ORDER BY external_key LIMIT $2`,
        [tenantId, Math.max(1, Math.min(10, Number(assigneeCount) || 5))],
      )
      const tasks = []
      for (const [index, assignee] of assignees.rows.entries()) {
        const externalKey = `${p2ExternalKey}:task:${assignee.external_key}`
        const result = await client.query(
          `INSERT INTO workflow.tasks (
             tenant_id, external_key, source_entity_id, assignee_id, dri_id,
             title, description, acceptance_criteria, status, priority
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'draft', 'P2')
           ON CONFLICT (tenant_id, external_key) WHERE external_key IS NOT NULL
           DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description,
             acceptance_criteria = EXCLUDED.acceptance_criteria, updated_at = now()
           RETURNING id, external_key, title, status`,
          [
            tenantId,
            externalKey,
            p2.rows[0].id,
            assignee.id,
            actor.rows[0].id,
            `任务 ${index + 1}：${assignee.display_name} 完成 Ontology 演示交付`,
            `[demo:${p2ExternalKey}] 使用公司级 Bot 完成任务解释、执行记录和成果提交。`,
            JSON.stringify(['通过公司级 Bot 确认任务', '提交一条可读成果', '由 DRI 完成验收']),
          ],
        )
        tasks.push(result.rows[0])
      }
      return tasks
    })
  }

  async function transitionTask({ tenantId, actorPersonId, taskExternalKey, action, resultText = '' }) {
    return withTenant(tenantId, async (client) => {
      const actorResult = await client.query(
        `SELECT id, external_key FROM iam.principals
          WHERE tenant_id = $1 AND external_key = $2 AND status = 'active' LIMIT 1`,
        [tenantId, actorPersonId],
      )
      const actor = actorResult.rows[0]
      if (!actor) throw Object.assign(new Error('actor not found'), { statusCode: 403, code: 'forbidden' })
      const taskResult = await client.query(
        `SELECT t.*, assignee.external_key AS assignee_external_key, dri.external_key AS dri_external_key
           FROM workflow.tasks t
           LEFT JOIN iam.principals assignee ON assignee.id = t.assignee_id
           LEFT JOIN iam.principals dri ON dri.id = t.dri_id
          WHERE t.tenant_id = $1 AND t.external_key = $2
          FOR UPDATE OF t`,
        [tenantId, taskExternalKey],
      )
      const task = taskResult.rows[0]
      if (!task) throw Object.assign(new Error('task not found'), { statusCode: 404, code: 'not_found' })
      const driAction = ['approve', 'assign', 'accept', 'reject'].includes(action)
      const assigneeAction = ['start', 'submit', 'block'].includes(action)
      if ((driAction && actor.external_key !== task.dri_external_key) || (assigneeAction && actor.external_key !== task.assignee_external_key)) {
        throw Object.assign(new Error('actor cannot transition task'), { statusCode: 403, code: 'forbidden' })
      }
      const transitions = {
        approve: { from: ['draft'], to: 'approved' },
        assign: { from: ['approved'], to: 'assigned' },
        start: { from: ['assigned'], to: 'in_progress' },
        block: { from: ['assigned', 'in_progress'], to: 'blocked' },
        submit: { from: ['in_progress', 'blocked'], to: 'submitted' },
        accept: { from: ['submitted'], to: 'accepted' },
        reject: { from: ['submitted'], to: 'rejected' },
      }
      const transition = transitions[action]
      if (!transition || !transition.from.includes(task.status)) {
        throw Object.assign(new Error(`invalid transition ${task.status} -> ${action}`), { statusCode: 409, code: 'invalid_transition' })
      }
      const update = await client.query(
        `UPDATE workflow.tasks
            SET status = $3,
                approved_by = CASE WHEN $4 = 'approve' THEN $5 ELSE approved_by END,
                approved_at = CASE WHEN $4 = 'approve' THEN now() ELSE approved_at END,
                version = version + 1,
                updated_at = now()
          WHERE tenant_id = $1 AND external_key = $2
          RETURNING id, external_key, title, status, version`,
        [tenantId, taskExternalKey, transition.to, action, actor.id],
      )
      await client.query(
        `INSERT INTO workflow.task_events (tenant_id, task_id, event_type, actor_id, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [tenantId, task.id, `task_${action}`, actor.id, JSON.stringify({ from: task.status, to: transition.to, simulation: true })],
      )
      if (action === 'assign') {
        await client.query(
          `INSERT INTO delivery.outbox (
             tenant_id, channel, recipient_key, event_type, payload, idempotency_key
           ) VALUES ($1, 'company-bot', $2, 'task_assigned', $3::jsonb, $4)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
          [tenantId, task.assignee_external_key, JSON.stringify({ taskExternalKey, title: task.title, simulation: true }), `task-assigned:${taskExternalKey}`],
        )
      }
      if (action === 'submit') {
        const text = String(resultText || '演示成果').trim().slice(0, 4000)
        await client.query(
          `INSERT INTO evidence.artifacts (
             tenant_id, task_id, source_system, object_uri, checksum_sha256,
             media_type, classification, metadata, submitted_by
           ) VALUES ($1, $2, 'company-bot-demo', $3, encode(digest($4, 'sha256'), 'hex'),
                     'text/plain', 'internal', $5::jsonb, $6)`,
          [tenantId, task.id, `demo://task/${taskExternalKey}/result`, text, JSON.stringify({ text, simulation: true }), actor.id],
        )
      }
      return update.rows[0]
    })
  }

  async function ackDemoDeliveries({ tenantId }) {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE delivery.outbox
            SET status = 'acked', provider_message_id = 'demo:' || id::text,
                attempt_count = attempt_count + 1, updated_at = now()
          WHERE tenant_id = $1 AND channel = 'company-bot' AND status = 'pending'
          RETURNING id, recipient_key, event_type, provider_message_id, payload`,
        [tenantId],
      )
      return result.rows
    })
  }

  async function listP2Tasks({ tenantId, p2ExternalKey }) {
    return withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT t.external_key, t.title, t.status, t.version,
                assignee.external_key AS assignee_person_id,
                dri.external_key AS dri_person_id
           FROM workflow.tasks t
           JOIN ontology.entities p2 ON p2.id = t.source_entity_id
           LEFT JOIN iam.principals assignee ON assignee.id = t.assignee_id
           LEFT JOIN iam.principals dri ON dri.id = t.dri_id
          WHERE t.tenant_id = $1 AND p2.external_key = $2
          ORDER BY t.external_key`,
        [tenantId, p2ExternalKey],
      )
      return result.rows
    })
  }

  async function createActionIntent({ tenantId, actorPersonId, targetSystem, actionType, payload, riskLevel = 'low', idempotencyKey }) {
    return withTenant(tenantId, async (client) => {
      if (targetSystem !== 'feishu-demo' || actionType !== 'feishu_task_status_demo') {
        throw Object.assign(new Error('unsupported action type'), { statusCode: 400, code: 'unsupported_action' })
      }
      if (riskLevel !== 'low') throw Object.assign(new Error('demo action must be low risk'), { statusCode: 400, code: 'invalid_risk' })
      const taskExternalKey = String(payload?.taskExternalKey || '').trim()
      const desiredStatus = String(payload?.desiredStatus || '').trim()
      if (!/^demo-p2-2026-001:task:demo-person-[0-9]{2}$/.test(taskExternalKey) || !['todo', 'in_progress', 'done'].includes(desiredStatus)) {
        throw Object.assign(new Error('invalid demo action payload'), { statusCode: 400, code: 'invalid_action_payload' })
      }
      const actor = await client.query(
        `SELECT id FROM iam.principals
          WHERE tenant_id = $1 AND external_key = $2 AND status = 'active' LIMIT 1`,
        [tenantId, actorPersonId],
      )
      if (!actor.rows[0]) throw Object.assign(new Error('actor not found'), { statusCode: 403, code: 'forbidden' })
      const normalizedPayload = { taskExternalKey, desiredStatus, simulation: true }
      const inserted = await client.query(
        `INSERT INTO actions.intents (
           tenant_id, requester_id, target_system, action_type, payload,
           risk_level, approval_required, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, true, $7)
         ON CONFLICT (tenant_id, target_system, idempotency_key) DO NOTHING
         RETURNING id, target_system, action_type, payload, risk_level, status,
                   approval_required, idempotency_key, created_at, updated_at`,
        [tenantId, actor.rows[0].id, targetSystem, actionType, JSON.stringify(normalizedPayload), riskLevel, idempotencyKey],
      )
      if (inserted.rows[0]) return inserted.rows[0]
      const existing = await client.query(
        `SELECT id, requester_id, target_system, action_type, payload, risk_level, status,
                approval_required, idempotency_key, created_at, updated_at,
                payload = $4::jsonb AS payload_matches
           FROM actions.intents
          WHERE tenant_id = $1 AND target_system = $2 AND idempotency_key = $3`,
        [tenantId, targetSystem, idempotencyKey, JSON.stringify(normalizedPayload)],
      )
      const row = existing.rows[0]
      if (!row || row.requester_id !== actor.rows[0].id || row.action_type !== actionType || !row.payload_matches) {
        throw Object.assign(new Error('action idempotency conflict'), { statusCode: 409, code: 'idempotency_conflict' })
      }
      delete row.payload_matches
      return row
    })
  }

  async function personDataSummary({ tenantId, personId }) {
    return withTenant(tenantId, async (client) => {
      const principal = await client.query(
        `SELECT id, external_key, display_name, department_key, status, attributes, created_at, updated_at
           FROM iam.principals
          WHERE tenant_id = $1 AND external_key = $2 AND status = 'active' LIMIT 1`,
        [tenantId, personId],
      )
      if (!principal.rows[0]) throw Object.assign(new Error('person not found'), { statusCode: 404, code: 'not_found' })
      const [tasks, artifacts] = await Promise.all([
        client.query(
          `SELECT status, count(*)::bigint AS count
             FROM workflow.tasks WHERE tenant_id = $1 AND assignee_id = $2
            GROUP BY status ORDER BY status`,
          [tenantId, principal.rows[0].id],
        ),
        client.query(
          `SELECT count(*)::bigint AS count
             FROM evidence.artifacts WHERE tenant_id = $1 AND submitted_by = $2`,
          [tenantId, principal.rows[0].id],
        ),
      ])
      return {
        person: {
          externalKey: principal.rows[0].external_key,
          displayName: principal.rows[0].display_name,
          departmentKey: principal.rows[0].department_key,
          status: principal.rows[0].status,
        },
        companyTaskCounts: Object.fromEntries(tasks.rows.map((row) => [row.status, Number(row.count)])),
        submittedArtifactCount: Number(artifacts.rows[0]?.count || 0),
        privateConversationStoredInOntology: false,
        managerCanReadPrivateConversation: false,
        simulation: Boolean(principal.rows[0].attributes?.simulation),
      }
    })
  }

  async function syncPrincipals({ tenantId, people }) {
    return withTenant(tenantId, async (client) => {
      const externalKeys = people.map((person) => person.personId)
      const existing = externalKeys.length
        ? await client.query(
            `SELECT external_key
               FROM iam.principals
              WHERE tenant_id = $1 AND principal_type = 'person' AND external_key = ANY($2::text[])`,
            [tenantId, externalKeys],
          )
        : { rows: [] }
      for (const person of people) {
        await client.query(
          `INSERT INTO iam.principals (
             tenant_id, principal_type, external_key, display_name, department_key, status, attributes
           ) VALUES ($1, 'person', $2, $3, $4, 'active', $5::jsonb)
           ON CONFLICT (tenant_id, principal_type, external_key) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             department_key = EXCLUDED.department_key,
             status = 'active',
             attributes = iam.principals.attributes || EXCLUDED.attributes,
             updated_at = now()`,
          [tenantId, person.personId, person.displayName, person.departmentKey, JSON.stringify(person.attributes)],
        )
      }
      const updatedPeople = existing.rows.length
      return {
        syncedPeople: people.length,
        createdPeople: Math.max(0, people.length - updatedPeople),
        updatedPeople,
      }
    })
  }

  return {
    claim,
    finish,
    audit,
    permissionedSearch,
    permissionedRetrieve,
    createWorkCase,
    recordWorkStage,
    advanceWorkCase,
    recordEpistemicAssessment,
    completeWorkCase,
    finalizeWorkCase,
    workProtocolStatus,
    compileP2,
    transitionTask,
    ackDemoDeliveries,
    listP2Tasks,
    createActionIntent,
    personDataSummary,
    syncPrincipals,
    ready,
    close: () => pool.end(),
  }
}

export function createMemoryStore({ retrieval = null } = {}) {
  const records = new Map()
  const events = []
  const principals = new Map()
  const workCases = new Map()
  const keyOf = ({ tenantId, namespace, idempotencyKey }) => `${tenantId}:${namespace}:${idempotencyKey}`
  return {
    events,
    async claim(input) {
      const key = keyOf(input)
      const existing = records.get(key)
      if (!existing) {
        records.set(key, { requestHash: input.requestHash, status: 'started', response: null })
        return { kind: 'new' }
      }
      if (existing.requestHash !== input.requestHash) return { kind: 'conflict' }
      if (existing.status === 'started') return { kind: 'in_progress' }
      return { kind: 'replay', status: existing.status, response: existing.response }
    },
    async finish(input) {
      const key = keyOf(input)
      const existing = records.get(key)
      records.set(key, { ...existing, status: input.status, response: input.response })
    },
    async audit(input) {
      events.push(input)
    },
    async ready() {
      return { ready: true }
    },
    async permissionedSearch() {
      return Array.isArray(retrieval) ? retrieval : retrieval?.evidence || []
    },
    async permissionedRetrieve() {
      return Array.isArray(retrieval)
        ? { evidence: retrieval, principalFound: true, excludedReasonCounts: {}, policyDecisionReference: 'memory', limit: 8, truncated: false }
        : retrieval || { evidence: [], principalFound: true, excludedReasonCounts: {}, policyDecisionReference: 'memory', limit: 8, truncated: false }
    },
    async createWorkCase({ draft }) {
      const caseId = randomUUID()
      const stages = stageContract().map((stage) => ({ ...stage, status: stage.stageType === 'intake' ? 'completed' : stage.status }))
      const workCase = { caseId, externalCaseId: draft.externalCaseId, status: 'received', workMode: draft.workMode, processingMode: draft.processingMode, principalFound: retrieval?.principalFound !== false, startedAt: draft.startedAt, stages }
      workCases.set(caseId, workCase)
      return structuredClone(workCase)
    },
    async recordWorkStage({ caseId, stageType, status, blockReasonCode = null }) {
      const workCase = workCases.get(caseId)
      const stage = workCase?.stages.find((item) => item.stageType === stageType)
      if (stage) Object.assign(stage, { status, blockReasonCode })
      return stage ? structuredClone(stage) : null
    },
    async advanceWorkCase({ caseId, toStatus, stageType, stageStatus = 'completed', blockReasonCode = null }) {
      const workCase = workCases.get(caseId)
      if (!workCase) throw new Error('work case not found')
      assertWorkCaseTransition(workCase.status, toStatus)
      const fromStatus = workCase.status
      workCase.status = toStatus
      const stage = workCase.stages.find((item) => item.stageType === stageType)
      if (stage) Object.assign(stage, { status: stageStatus, blockReasonCode })
      events.push({ eventType: `work_case_${toStatus}`, caseId, fromStatus, toStatus })
      return { caseId, fromStatus, status: toStatus }
    },
    async recordEpistemicAssessment({ caseId, assessment }) {
      const workCase = workCases.get(caseId)
      if (workCase) workCase.assessment = structuredClone(assessment)
    },
    async completeWorkCase({ caseId, evidenceCount, confidenceLevel, deterministicConclusionAllowed, responseValidationStatus }) {
      const workCase = workCases.get(caseId)
      assertWorkCaseTransition(workCase.status, 'completed')
      workCase.status = 'completed'
      const stage = workCase.stages.find((item) => item.stageType === 'response')
      if (stage) stage.status = 'completed'
      Object.assign(workCase, { evidenceCount, confidenceLevel, deterministicConclusionAllowed, responseValidationStatus, completedAt: new Date().toISOString() })
    },
    async finalizeWorkCase({ caseId, evidenceCount, confidenceLevel, deterministicConclusionAllowed, responseValidationStatus }) {
      const workCase = workCases.get(caseId)
      Object.assign(workCase, { evidenceCount, confidenceLevel, deterministicConclusionAllowed, responseValidationStatus })
    },
    async workProtocolStatus({ limit = 8 } = {}) {
      const recentCases = [...workCases.values()].slice(-limit).reverse().map((workCase) => structuredClone(workCase))
      const counts = {}
      for (const workCase of workCases.values()) counts[workCase.status] = (counts[workCase.status] || 0) + 1
      return { counts, recentCases }
    },
    async createActionIntent(input) {
      return { id: 'memory-action-intent', status: 'proposed', ...input }
    },
    async personDataSummary({ personId }) {
      return {
        person: { externalKey: personId },
        companyTaskCounts: {},
        submittedArtifactCount: 0,
        privateConversationStoredInOntology: false,
        managerCanReadPrivateConversation: false,
        simulation: true,
      }
    },
    async syncPrincipals({ people }) {
      let createdPeople = 0
      let updatedPeople = 0
      for (const person of people) {
        if (principals.has(person.personId)) updatedPeople += 1
        else createdPeople += 1
        principals.set(person.personId, person)
      }
      return { syncedPeople: people.length, createdPeople, updatedPeople }
    },
    async close() {},
  }
}
