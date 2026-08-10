#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function integer(name, fallback = 0) {
  const value = Number.parseInt(argument(name, String(fallback)), 10)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

const requestFile = argument('--request')
const outputFile = argument('--output')
if (!requestFile || !outputFile) throw new Error('--request and --output are required')
const request = JSON.parse(await fs.readFile(requestFile, 'utf8'))
async function optionalMetrics(name) {
  const file = argument(name)
  if (!file) return {}
  return JSON.parse(await fs.readFile(file, 'utf8'))
}
const collectorMetrics = await optionalMetrics('--collector-metrics-file')
const runtimeMetrics = await optionalMetrics('--runtime-metrics-file')
const status = argument('--status')
if (!['succeeded', 'failed', 'timed_out'].includes(status)) throw new Error('invalid status')
const evidence = {
  evidenceVersion: '1.0.0',
  requestKey: request.requestKey,
  localDate: request.localDate,
  timezone: request.timezone,
  policyVersion: request.policyVersion,
  policyHash: request.policyHash,
  status,
  startedAt: argument('--started-at'),
  completedAt: argument('--completed-at'),
  durationSeconds: integer('--duration-seconds'),
  exitCode: integer('--exit-code'),
  timeoutCount: status === 'timed_out' ? 1 : 0,
  sourceAttemptCount: Number(collectorMetrics.sourceAttemptCount ?? integer('--source-attempt-count')),
  sourceSuccessCount: Number(collectorMetrics.sourceSuccessCount ?? integer('--source-success-count')),
  rawSnapshotCount: Number(collectorMetrics.rawSnapshotCount ?? integer('--raw-snapshot-count')),
  normalizedItemCount: Number(collectorMetrics.normalizedItemCount ?? integer('--normalized-item-count')),
  duplicateCount: Number(collectorMetrics.duplicateCount ?? integer('--duplicate-count')),
  freshnessP95Seconds: Number(collectorMetrics.freshnessP95Seconds ?? integer('--freshness-p95-seconds')),
  rawSnapshotBytes: Number(collectorMetrics.rawSnapshotBytes ?? integer('--raw-snapshot-bytes')),
  networkBytes: Number(runtimeMetrics.networkBytes ?? integer('--network-bytes')),
  peakCpuPermille: Number(runtimeMetrics.peakCpuPermille ?? integer('--peak-cpu-permille')),
  peakMemoryBytes: Number(runtimeMetrics.peakMemoryBytes ?? integer('--peak-memory-bytes')),
  reportCostsUsd: {
    daily: Number(argument('--daily-report-cost-usd', '0')),
    weekly: Number(argument('--weekly-report-cost-usd', '0')),
  },
  security: {
    unredactedSensitiveOutputCount: integer('--unredacted-sensitive-output-count'),
    sourceRevocationEffectiveSeconds: integer('--source-revocation-effective-seconds'),
    postRevocationNetworkRequestCount: integer('--post-revocation-network-request-count'),
    lastGoodPreserved: argument('--last-good-preserved', 'true') === 'true',
  },
  sideEffects: {
    formalP2Count: integer('--formal-p2-count'),
    employeeDeliveryCount: integer('--employee-delivery-count'),
    erpWritebackCount: integer('--erp-writeback-count'),
    socialWritebackCount: integer('--social-writeback-count'),
    causalActivationCount: integer('--causal-activation-count'),
  },
  runtime: {
    collectorImage: argument('--collector-image'),
    sourceCommit: argument('--source-commit'),
    containerRestartCount: integer('--container-restart-count'),
    newHostPortCount: integer('--new-host-port-count'),
  },
  coverage: {
    collectorMetricsCollected: collectorMetrics.collected === true,
    resourceMetricsCollected: runtimeMetrics.collected === true,
    sensitiveOutputAuditCompleted: argument('--sensitive-output-audit-completed', 'false') === 'true',
    sourceRevocationAuditCompleted: argument('--source-revocation-audit-completed', 'false') === 'true',
    businessSideEffectAuditCompleted: argument('--business-side-effect-audit-completed', 'false') === 'true',
  },
}
if (!Number.isFinite(evidence.reportCostsUsd.daily) || !Number.isFinite(evidence.reportCostsUsd.weekly)) throw new Error('invalid report cost')
await fs.mkdir(path.dirname(outputFile), { recursive: true, mode: 0o750 })
await fs.writeFile(outputFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
