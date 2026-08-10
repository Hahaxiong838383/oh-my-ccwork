#!/usr/bin/env node

import fs from 'node:fs/promises'

const policyFile = process.argv[2]
const evidenceFile = process.argv[3]
if (!policyFile || !evidenceFile) throw new Error('policy and evidence files are required')
const policy = JSON.parse(await fs.readFile(policyFile, 'utf8'))
const evidence = JSON.parse(await fs.readFile(evidenceFile, 'utf8'))
const threshold = policy.acceptanceThresholds
const attempts = evidence.sourceAttemptCount || 0
const sourceSuccessRate = attempts === 0 ? 0 : evidence.sourceSuccessCount / attempts
const totalItems = (evidence.normalizedItemCount || 0) + (evidence.duplicateCount || 0)
const duplicateRate = totalItems === 0 ? 0 : evidence.duplicateCount / totalItems
const violations = []

function maximum(name, actual, limit, critical = false) {
  if (actual > limit) violations.push({ name, actual, limit, critical })
}

function minimum(name, actual, limit) {
  if (actual < limit) violations.push({ name, actual, limit, critical: false })
}

if (attempts > 0) minimum('source_success_rate', sourceSuccessRate, threshold.sourceSuccessRateMin)
if (!evidence.coverage?.collectorMetricsCollected) violations.push({ name: 'collector_metrics_missing', actual: false, limit: true, critical: false })
if (!evidence.coverage?.resourceMetricsCollected) violations.push({ name: 'resource_metrics_missing', actual: false, limit: true, critical: false })
maximum('duplicate_rate', duplicateRate, threshold.duplicateRateMax)
maximum('freshness_p95_seconds', evidence.freshnessP95Seconds, threshold.freshnessP95SecondsMax)
maximum('raw_snapshot_bytes', evidence.rawSnapshotBytes, policy.resourceLimits.rawSnapshotBytesPerDayMax)
maximum('network_bytes', evidence.networkBytes, policy.resourceLimits.networkBytesPerDayMax)
maximum('daily_report_cost_usd', evidence.reportCostsUsd.daily, threshold.dailyReportCostUsdMax)
maximum('weekly_report_cost_usd', evidence.reportCostsUsd.weekly, threshold.weeklyReportCostUsdMax)
maximum('unredacted_sensitive_output', evidence.security.unredactedSensitiveOutputCount, threshold.unredactedSensitiveOutputCountMax, true)
maximum('source_revocation_effective_seconds', evidence.security.sourceRevocationEffectiveSeconds, threshold.sourceRevocationEffectiveSecondsMax, true)
maximum('post_revocation_network_request', evidence.security.postRevocationNetworkRequestCount, threshold.postRevocationNetworkRequestCountMax, true)
if (!evidence.security.lastGoodPreserved) violations.push({ name: 'last_good_not_preserved', actual: false, limit: true, critical: true })
maximum('formal_p2_created', evidence.sideEffects.formalP2Count, threshold.formalP2CountMax, true)
maximum('employee_delivery_created', evidence.sideEffects.employeeDeliveryCount, threshold.employeeDeliveryCountMax, true)
maximum('erp_writeback_created', evidence.sideEffects.erpWritebackCount, threshold.erpWritebackCountMax, true)
maximum('social_writeback_created', evidence.sideEffects.socialWritebackCount, threshold.socialWritebackCountMax, true)
maximum('causal_relation_activated', evidence.sideEffects.causalActivationCount, threshold.causalActivationCountMax, true)
maximum('container_restart_count', evidence.runtime.containerRestartCount, 0, true)
maximum('new_host_port_count', evidence.runtime.newHostPortCount, 0, true)

const result = {
  ok: violations.length === 0,
  critical: violations.some((entry) => entry.critical),
  requestKey: evidence.requestKey,
  sourceSuccessRate,
  duplicateRate,
  violations,
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (result.critical) process.exitCode = 42
else if (!result.ok) process.exitCode = 1
