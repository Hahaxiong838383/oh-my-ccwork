#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const file = process.argv[2]
if (!file) throw new Error('domain batch file is required')
const bytes = await fs.readFile(path.resolve(file))
const batch = JSON.parse(bytes.toString('utf8'))
const errors = []
const requireValue = (condition, message) => { if (!condition) errors.push(message) }
requireValue(batch.batchVersion === '1.0.0', 'batchVersion invalid')
requireValue(batch.publish === false, 'publish must remain false')
requireValue(batch.persistenceState === 'json_candidate_pending_postgres', 'persistence state invalid')
requireValue(batch.ontologyVersion === '3.7.0', 'ontology version invalid')
requireValue(batch.ingestionRun?.runKey === batch.runId, 'ingestion run identity mismatch')
requireValue(batch.ingestionRun?.status === 'succeeded', 'ingestion run must be succeeded')
requireValue(batch.ingestionRun?.sourceRegistryVersion === batch.sourceRegistryVersion, 'ingestion registry version mismatch')
requireValue(batch.ingestionRun?.sourceRegistryHash === batch.sourceRegistryHash, 'ingestion registry hash mismatch')
for (const key of ['sourceEntries', 'sourceDecisions', 'rawSnapshots', 'observations', 'signals', 'evidence', 'impactHypotheses', 'impactAssessments', 'reportRuns', 'reportDrafts']) {
  requireValue(Array.isArray(batch[key]), `${key} must be an array`)
}
requireValue(batch.rawSnapshots?.length > 0, 'raw snapshots missing')
requireValue(batch.rawSnapshots?.every((entry) => entry.storageTier === 'purged' && entry.payloadRetention === 'hash_only' && entry.sanitizationStatus === 'untrusted'), 'raw snapshots must remain hash-only untrusted metadata')
requireValue(batch.observations?.length === batch.counts?.observationCount, 'observation count mismatch')
requireValue(batch.observations?.every((entry) => entry.dataQualityStatus === 'valid' && entry.conflictStatus === 'none' && entry.status === 'observed'), 'observation database states invalid')
requireValue(batch.signals?.length === batch.counts?.signalCount, 'signal count mismatch')
requireValue(batch.evidence?.length === batch.counts?.evidenceCount, 'evidence count mismatch')
requireValue(batch.impactHypotheses?.length === 6, 'exactly six P003 hypothesis categories are required')
requireValue(batch.impactAssessments?.length === 6, 'exactly six P003 assessments are required')
requireValue(batch.reportRuns?.length >= 3 && batch.reportRuns?.length === batch.reportDrafts?.length, 'report draft coverage invalid')
requireValue(batch.signals?.every((entry) => entry.signalStatus === 'candidate' && entry.confidence === 0), 'signals must remain zero-confidence candidates')
requireValue(batch.signals?.every((entry) => entry.dataQualityStatus === 'valid' && entry.conflictStatus === 'none'), 'signal database states invalid')
requireValue(batch.evidence?.every((entry) => entry.status === 'candidate' && entry.evidenceKind === 'context'), 'evidence must remain context candidates')
requireValue(batch.impactHypotheses?.every((entry) => entry.generationStatus === 'generated_draft' && entry.verificationStatus === 'unverified' && entry.activationStatus === 'inactive'), 'P003 hypotheses must remain unverified and inactive')
requireValue(batch.impactAssessments?.every((entry) => entry.assessmentStatus === 'draft' && entry.confidenceBand === 'insufficient' && entry.impactDirection === 'unknown' && entry.reasonCode === 'MODEL_NOT_INVOKED_SHADOW'), 'impact assessments must remain insufficient drafts')
requireValue(batch.reportRuns?.every((entry) => entry.modelProvider === 'policy-engine' && entry.modelId === 'deterministic-shadow-compiler' && entry.inputTokens === 0 && entry.outputTokens === 0 && entry.costMicrounits === 0), 'report runs must not claim model execution')
requireValue(batch.reportDrafts?.every((entry) => entry.reportStatus === 'draft' && entry.structuredBody?.confidenceBand === 'insufficient' && entry.structuredBody?.conclusions?.length === 0), 'reports must remain insufficient drafts')
for (const key of ['formalP2Count', 'employeeDeliveryCount', 'erpWritebackCount', 'socialWritebackCount', 'causalActivationCount']) {
  requireValue(batch.sideEffects?.[key] === 0, `${key} must remain zero`)
}
if (errors.length > 0) throw new Error(`domain batch denied: ${errors.join('; ')}`)
process.stdout.write(`${JSON.stringify({ ok: true, runId: batch.runId, batchHash: createHash('sha256').update(bytes).digest('hex'), counts: batch.counts }, null, 2)}\n`)
