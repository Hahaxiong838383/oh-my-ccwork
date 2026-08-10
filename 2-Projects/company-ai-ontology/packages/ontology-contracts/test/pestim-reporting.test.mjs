import fs from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyPestimReportingContract,
  buildReportInputSet,
  compilePestimReportingProposal,
  computeReportWindow,
  loadPestimReportingContract,
  validateReportRun,
} from '../src/index.mjs'

const DATA_FOUNDATION_HASH = '2088f360866285a9f860107a91c3da32faefae6dc7c573ed9580603f9a4fea5d'

test('P1-SI-E compiles additively from the immutable P1-SI-D candidate', async () => {
  const proposal = await compilePestimReportingProposal()
  assert.equal(proposal.dataFoundation.candidate.schemaVersion, '3.6.0')
  assert.equal(proposal.dataFoundation.candidate.contentHash, DATA_FOUNDATION_HASH)
  assert.equal(proposal.baseline.schemaVersion, '3.6.0')
  assert.equal(proposal.baseline.contentHash, DATA_FOUNDATION_HASH)
  assert.equal(proposal.candidate.schemaVersion, '3.7.0')
  assert.equal(proposal.contract.status, 'contract_only')
  assert.equal(proposal.contract.deploymentAllowed, false)
  assert.equal(proposal.compatibility.classification, 'compatible')
  assert.equal(proposal.candidate.counts.object_type - proposal.baseline.counts.object_type, 3)
  assert.equal(proposal.candidate.counts.link_type - proposal.baseline.counts.link_type, 4)
  assert.equal(proposal.candidate.counts.function_type - proposal.baseline.counts.function_type, 3)
  assert.equal(proposal.candidate.counts.action_type - proposal.baseline.counts.action_type, 0)
  assert.equal(proposal.candidate.counts.policy_type - proposal.baseline.counts.policy_type, 4)
  assert.equal(proposal.candidate.counts.constraint_type - proposal.baseline.counts.constraint_type, 5)
})

test('completed report windows follow Asia/Shanghai calendar boundaries', () => {
  const anchor = '2026-08-10T08:00:00Z'
  assert.deepEqual(computeReportWindow('daily', anchor), {
    reportType: 'daily', timezone: 'Asia/Shanghai', periodStart: '2026-08-08T16:00:00.000Z', periodEnd: '2026-08-09T16:00:00.000Z',
  })
  assert.deepEqual(computeReportWindow('weekly', anchor), {
    reportType: 'weekly', timezone: 'Asia/Shanghai', periodStart: '2026-08-02T16:00:00.000Z', periodEnd: '2026-08-09T16:00:00.000Z',
  })
  assert.deepEqual(computeReportWindow('monthly', anchor), {
    reportType: 'monthly', timezone: 'Asia/Shanghai', periodStart: '2026-06-30T16:00:00.000Z', periodEnd: '2026-07-31T16:00:00.000Z',
  })
  assert.deepEqual(computeReportWindow('quarterly', anchor), {
    reportType: 'quarterly', timezone: 'Asia/Shanghai', periodStart: '2026-03-31T16:00:00.000Z', periodEnd: '2026-06-30T16:00:00.000Z',
  })
  assert.deepEqual(computeReportWindow('semiannual', anchor), {
    reportType: 'semiannual', timezone: 'Asia/Shanghai', periodStart: '2025-12-31T16:00:00.000Z', periodEnd: '2026-06-30T16:00:00.000Z',
  })
  assert.deepEqual(computeReportWindow('annual', anchor), {
    reportType: 'annual', timezone: 'Asia/Shanghai', periodStart: '2024-12-31T16:00:00.000Z', periodEnd: '2025-12-31T16:00:00.000Z',
  })
})

test('report input set is deterministic and rejects recursive report prose', async () => {
  const contract = await loadPestimReportingContract()
  const request = {
    reportType: 'weekly',
    periodStart: '2026-08-02T16:00:00Z',
    periodEnd: '2026-08-09T16:00:00Z',
    evidenceCutoffAt: '2026-08-10T00:00:00Z',
    sourceRegistryVersion: '1.0.0',
    ontologyVersion: '3.7.0',
    causalGraphVersion: 'p003-candidate-1',
    createdAt: '2026-08-10T08:00:00Z',
  }
  const inputs = [
    { type: 'impact_assessment', id: 'assessment-1', hash: 'c'.repeat(64), sourceSnapshotIds: ['snapshot-2'] },
    { type: 'raw_snapshot', id: 'snapshot-1', hash: 'a'.repeat(64) },
    { type: 'evidence', id: 'evidence-1', hash: 'b'.repeat(64), sourceSnapshotIds: ['snapshot-1'] },
  ]
  const first = buildReportInputSet(request, inputs, contract)
  const second = buildReportInputSet(request, [...inputs].reverse(), contract)
  assert.deepEqual(first, second)
  assert.match(first.inputHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(first.sourceSnapshotIds, ['snapshot-1', 'snapshot-2'])
  assert.throws(
    () => buildReportInputSet(request, [{ type: 'report_text', id: 'weekly-report', hash: 'd'.repeat(64) }], contract),
    /type is forbidden/,
  )
})

test('report run validation requires complete period, model, cost and retry lineage', async () => {
  const contract = await loadPestimReportingContract()
  const valid = validateReportRun({
    reportType: 'p003',
    periodStart: '2026-08-01T00:00:00Z',
    periodEnd: '2026-08-08T00:00:00Z',
    evidenceCutoffAt: '2026-08-08T01:00:00Z',
    inputHash: 'a'.repeat(64),
    sourceSnapshotIds: ['snapshot-1'],
    sourceRegistryVersion: '1.0.0',
    ontologyVersion: '3.7.0',
    causalGraphVersion: 'p003-candidate-1',
    modelProvider: 'h-engine',
    modelId: 'company-approved-model',
    promptVersion: 'p003-report-1.0.0',
    inputTokens: 1000,
    outputTokens: 500,
    costMicrounits: 2000,
    durationMs: 1500,
    retryCount: 0,
    status: 'succeeded',
  }, contract)
  assert.deepEqual(valid, { ok: true, errors: [] })

  const invalid = validateReportRun({ reportType: 'weekly', sourceSnapshotIds: [], status: 'published' }, contract)
  assert.equal(invalid.ok, false)
  assert.ok(invalid.errors.includes('inputHash must be SHA-256'))
  assert.ok(invalid.errors.includes('status is unsupported'))
  assert.ok(invalid.errors.includes('modelId is required'))
})

test('projection templates and candidate SQL remain read-only and ACL-gated', async () => {
  const proposal = await compilePestimReportingProposal()
  assert.equal(proposal.templates.feishuDocument.status, 'draft_only')
  assert.ok(proposal.templates.feishuDocument.forbiddenFields.includes('raw_body'))
  assert.equal(proposal.templates.feishuCard.allowedActions.includes('create_formal_p2'), false)
  assert.ok(proposal.templates.feishuCard.forbiddenActions.includes('assign_employee_task'))
  assert.equal(proposal.templates.hControlPlane.writeControls, false)
  assert.equal(proposal.templates.hControlPlane.sensitiveFields, 'server_side_allowlist_only')

  const sql = await fs.readFile(proposal.candidateMigrationFile, 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS strategic_intelligence\.report_input_sets/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS strategic_intelligence\.report_projections/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS strategic_intelligence\.alerts/)
  assert.match(sql, /current_principal_key\(\) IS NOT NULL/)
  assert.match(sql, /current_purpose\(\) IS NOT NULL/)
  assert.doesNotMatch(sql, /CREATE TABLE.*formal_p2/i)
})

test('P1-SI-E rejects collisions with the preceding candidate', async () => {
  const proposal = await compilePestimReportingProposal()
  const contract = await loadPestimReportingContract()
  const collision = structuredClone(contract)
  collision.additions.objectTypes[0].qualifiedName = 'domain.intelligence.StrategicSignal'
  assert.throws(
    () => applyPestimReportingContract(proposal.baseline.definition, collision),
    /proposal collides with existing objectTypes domain\.intelligence\.StrategicSignal/,
  )
})
