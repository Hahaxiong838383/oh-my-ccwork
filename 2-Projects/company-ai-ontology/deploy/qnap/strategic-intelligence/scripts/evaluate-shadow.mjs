#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'

const policyFile = process.argv[2]
const evidenceFile = process.argv[3]
if (!policyFile || !evidenceFile) throw new Error('policy and evidence files are required')
const policy = JSON.parse(await fs.readFile(policyFile, 'utf8'))
const evidenceBytes = await fs.readFile(evidenceFile)
const evidence = JSON.parse(evidenceBytes.toString('utf8'))
const threshold = policy.acceptanceThresholds
const actualPolicyHash = createHash('sha256').update(JSON.stringify(policy)).digest('hex')
const attempts = evidence.sourceAttemptCount || 0
const sourceSuccessRate = attempts === 0 ? 0 : evidence.sourceSuccessCount / attempts
const totalItems = (evidence.normalizedItemCount || 0) + (evidence.duplicateCount || 0)
const duplicateRate = totalItems === 0 ? 0 : evidence.duplicateCount / totalItems
const violations = []

function maximum(name, actual, limit, critical = false) {
  if (!Number.isFinite(actual)) violations.push({ name: `${name}_missing_or_invalid`, actual: actual ?? null, limit, critical })
  else if (actual > limit) violations.push({ name, actual, limit, critical })
}

function minimum(name, actual, limit) {
  if (!Number.isFinite(actual)) violations.push({ name: `${name}_missing_or_invalid`, actual: actual ?? null, limit, critical: false })
  else if (actual < limit) violations.push({ name, actual, limit, critical: false })
}

if (evidence.simulated !== false) violations.push({ name: 'simulated_run_forbidden', actual: evidence.simulated, limit: false, critical: true })
if (evidence.publish !== false) violations.push({ name: 'publish_enabled', actual: evidence.publish, limit: false, critical: true })
if (evidence.policyVersion !== policy.policyVersion) violations.push({ name: 'policy_version_mismatch', actual: evidence.policyVersion, limit: policy.policyVersion, critical: true })
if (evidence.policyHash !== actualPolicyHash) violations.push({ name: 'policy_hash_mismatch', actual: evidence.policyHash, limit: actualPolicyHash, critical: true })
if (evidence.status !== 'succeeded') violations.push({ name: 'shadow_run_not_succeeded', actual: evidence.status, limit: 'succeeded', critical: false })
maximum('worker_exit_code', evidence.exitCode, 0)
maximum('worker_timeout_count', evidence.timeoutCount, 0)
if (attempts === 0) violations.push({ name: 'source_attempt_missing', actual: attempts, limit: 1, critical: false })
else minimum('source_success_rate', sourceSuccessRate, threshold.sourceSuccessRateMin)
if (evidence.sourceSuccessCount > attempts) violations.push({ name: 'source_success_exceeds_attempts', actual: evidence.sourceSuccessCount, limit: attempts, critical: false })
for (const [key, name] of [
  ['collectorMetricsCollected', 'collector_metrics_missing'],
  ['resourceMetricsCollected', 'resource_metrics_missing'],
  ['sensitiveOutputAuditCompleted', 'sensitive_output_audit_missing'],
  ['sourceRevocationAuditCompleted', 'source_revocation_audit_missing'],
  ['businessSideEffectAuditCompleted', 'business_side_effect_audit_missing'],
  ['domainCompilationCompleted', 'domain_compilation_missing'],
  ['domainPersistenceCompleted', 'domain_persistence_missing'],
]) {
  if (!evidence.coverage?.[key]) violations.push({ name, actual: false, limit: true, critical: false })
}
maximum('duplicate_rate', duplicateRate, threshold.duplicateRateMax)
maximum('freshness_p95_seconds', evidence.freshnessP95Seconds, threshold.freshnessP95SecondsMax)
maximum('peak_cpu_permille', evidence.peakCpuPermille, Math.round(policy.resourceLimits.collectorCpuCores * 1000))
maximum('peak_memory_bytes', evidence.peakMemoryBytes, policy.resourceLimits.collectorMemoryMiB * 1024 * 1024)
maximum('raw_snapshot_bytes', evidence.rawSnapshotBytes, policy.resourceLimits.rawSnapshotBytesPerDayMax)
maximum('network_bytes', evidence.networkBytes, policy.resourceLimits.networkBytesPerDayMax)
maximum('daily_report_cost_usd', evidence.reportCostsUsd?.daily, threshold.dailyReportCostUsdMax)
maximum('weekly_report_cost_usd', evidence.reportCostsUsd?.weekly, threshold.weeklyReportCostUsdMax)
minimum('domain_raw_snapshot_count', evidence.domainArtifacts?.rawSnapshotCount, evidence.rawSnapshotCount)
minimum('domain_observation_count', evidence.domainArtifacts?.observationCount, evidence.normalizedItemCount)
minimum('domain_signal_count', evidence.domainArtifacts?.signalCount, evidence.normalizedItemCount)
minimum('domain_evidence_count', evidence.domainArtifacts?.evidenceCount, evidence.normalizedItemCount)
minimum('domain_impact_assessment_count', evidence.domainArtifacts?.impactAssessmentCount, 6)
minimum('domain_report_run_count', evidence.domainArtifacts?.reportRunCount, 3)
minimum('domain_report_draft_count', evidence.domainArtifacts?.reportDraftCount, 3)
if (evidence.domainArtifacts?.persistenceState !== 'postgres_committed') {
  violations.push({ name: 'domain_persistence_state_invalid', actual: evidence.domainArtifacts?.persistenceState, limit: 'postgres_committed', critical: true })
}
maximum('unredacted_sensitive_output', evidence.security?.unredactedSensitiveOutputCount, threshold.unredactedSensitiveOutputCountMax, true)
maximum('source_revocation_effective_seconds', evidence.security?.sourceRevocationEffectiveSeconds, threshold.sourceRevocationEffectiveSecondsMax, true)
maximum('post_revocation_network_request', evidence.security?.postRevocationNetworkRequestCount, threshold.postRevocationNetworkRequestCountMax, true)
if (evidence.security?.lastGoodPreserved !== true) violations.push({ name: 'last_good_not_preserved', actual: evidence.security?.lastGoodPreserved ?? null, limit: true, critical: true })
maximum('formal_p2_created', evidence.sideEffects?.formalP2Count, threshold.formalP2CountMax, true)
maximum('employee_delivery_created', evidence.sideEffects?.employeeDeliveryCount, threshold.employeeDeliveryCountMax, true)
maximum('erp_writeback_created', evidence.sideEffects?.erpWritebackCount, threshold.erpWritebackCountMax, true)
maximum('social_writeback_created', evidence.sideEffects?.socialWritebackCount, threshold.socialWritebackCountMax, true)
maximum('causal_relation_activated', evidence.sideEffects?.causalActivationCount, threshold.causalActivationCountMax, true)
maximum('container_restart_count', evidence.runtime?.containerRestartCount, 0, true)
maximum('new_host_port_count', evidence.runtime?.newHostPortCount, 0, true)

const result = {
  ok: violations.length === 0,
  critical: violations.some((entry) => entry.critical),
  requestKey: evidence.requestKey,
  localDate: evidence.localDate,
  policyVersion: evidence.policyVersion,
  policyHash: evidence.policyHash,
  evaluatedPolicyHash: actualPolicyHash,
  evidenceHash: createHash('sha256').update(evidenceBytes).digest('hex'),
  sourceSuccessRate,
  duplicateRate,
  violations,
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (result.critical) process.exitCode = 42
else if (!result.ok) process.exitCode = 1
