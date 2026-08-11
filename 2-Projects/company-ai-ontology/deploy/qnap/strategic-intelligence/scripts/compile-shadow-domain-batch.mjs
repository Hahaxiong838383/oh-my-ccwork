#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

const stdoutFile = argument('--collector-stdout')
const stateRoot = argument('--state-root')
const registryFile = argument('--registry')
const p003ReviewFile = argument('--p003-review')
const requestFile = argument('--request')
const outputFile = argument('--output')
const metricsOutputFile = argument('--metrics-output')
for (const [name, value] of Object.entries({ stdoutFile, stateRoot, registryFile, p003ReviewFile, requestFile, outputFile, metricsOutputFile })) {
  if (!value) throw new Error(`${name} is required`)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}

function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonicalize(value))).digest('hex')
}

function timestamp(value, label) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be a timestamp`)
  return parsed.toISOString()
}

function addDays(value, days) {
  return new Date(new Date(value).getTime() + days * 86400000).toISOString()
}

function localParts(value) {
  const entries = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(new Date(value))
  return Object.fromEntries(entries.filter((entry) => entry.type !== 'literal').map((entry) => [entry.type, entry.value]))
}

function shanghaiMidnight(year, month, day) {
  return new Date(Date.UTC(year, month, day) - 8 * 60 * 60 * 1000)
}

function reportWindows(completedAt) {
  const parts = localParts(completedAt)
  const year = Number(parts.year)
  const monthIndex = Number(parts.month) - 1
  const day = Number(parts.day)
  const currentMidnight = shanghaiMidnight(year, monthIndex, day)
  const daily = { periodStart: new Date(currentMidnight.getTime() - 86400000), periodEnd: currentMidnight }
  const windows = [
    ['daily', daily],
    ['company', daily],
    ['p003', daily],
  ]
  if (parts.weekday === 'Mon') windows.push(['weekly', { periodStart: new Date(currentMidnight.getTime() - 7 * 86400000), periodEnd: currentMidnight }])
  if (day === 1) {
    const monthEnd = currentMidnight
    windows.push(['monthly', { periodStart: shanghaiMidnight(year, monthIndex - 1, 1), periodEnd: monthEnd }])
    if ([0, 3, 6, 9].includes(monthIndex)) windows.push(['quarterly', { periodStart: shanghaiMidnight(year, monthIndex - 3, 1), periodEnd: monthEnd }])
    if ([0, 6].includes(monthIndex)) windows.push(['semiannual', { periodStart: shanghaiMidnight(year, monthIndex - 6, 1), periodEnd: monthEnd }])
    if (monthIndex === 0) windows.push(['annual', { periodStart: shanghaiMidnight(year - 1, 0, 1), periodEnd: monthEnd }])
  }
  return windows.map(([reportType, window]) => ({ reportType, periodStart: window.periodStart.toISOString(), periodEnd: window.periodEnd.toISOString() }))
}

const [cli, registry, p003Review, request] = await Promise.all([
  fs.readFile(path.resolve(stdoutFile), 'utf8').then(JSON.parse),
  fs.readFile(path.resolve(registryFile), 'utf8').then(JSON.parse),
  fs.readFile(path.resolve(p003ReviewFile), 'utf8').then(JSON.parse),
  fs.readFile(path.resolve(requestFile), 'utf8').then(JSON.parse),
])
if (cli.ok !== true || !cli.runId) throw new Error('collector must succeed before domain compilation')
if (request.publish !== false) throw new Error('request publish must remain false')
const runDir = path.resolve(stateRoot, 'runs', cli.runId)
const [run, items, decisions] = await Promise.all([
  fs.readFile(path.join(runDir, 'run.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(runDir, 'items.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(runDir, 'source-decisions.json'), 'utf8').then(JSON.parse),
])
if (run.status !== 'succeeded' || !Array.isArray(items) || items.length === 0) throw new Error('collector artifacts are incomplete')

const sourceEntries = []
const rawSnapshots = []
const snapshotBySource = new Map()
for (const name of (await fs.readdir(path.join(runDir, 'raw'))).sort()) {
  const snapshot = JSON.parse(await fs.readFile(path.join(runDir, 'raw', name), 'utf8'))
  const entry = registry.entries?.find((candidate) => candidate.sourceKey === snapshot.sourceKey)
  if (!entry) throw new Error(`source ${snapshot.sourceKey} is absent from registry`)
  if (snapshot.payloadRetention !== 'hash_only' || snapshot.bodyBase64 !== null) {
    throw new Error(`source ${snapshot.sourceKey} payload must remain hash-only in Shadow`)
  }
  const sourceEntryHash = hash(entry)
  sourceEntries.push({
    sourceKey: entry.sourceKey,
    registryVersion: registry.registryVersion,
    lifecycleStatus: entry.lifecycleStatus,
    licenseStatus: entry.license.status,
    complianceApprovalStatus: entry.governance.approvalStatus,
    storageLevel: entry.retention.storageLevel,
    retentionDays: entry.retention.retentionDays,
    definition: entry,
    validFrom: timestamp(run.startedAt, 'run startedAt'),
    contentHash: sourceEntryHash,
  })
  const snapshotKey = hash({ runId: run.runId, sourceKey: snapshot.sourceKey, contentHash: snapshot.contentHash })
  const raw = {
    snapshotKey,
    sourceKey: snapshot.sourceKey,
    sourceReference: snapshot.endpointOrigin,
    fetchedAt: timestamp(snapshot.fetchedAt, 'snapshot fetchedAt'),
    validFrom: timestamp(snapshot.fetchedAt, 'snapshot validFrom'),
    contentHash: snapshot.contentHash,
    dedupKey: hash({ sourceKey: snapshot.sourceKey, contentHash: snapshot.contentHash }),
    idempotencyKey: hash({ runId: run.runId, sourceKey: snapshot.sourceKey }),
    contentType: snapshot.contentType,
    byteLength: snapshot.contentLength,
    payloadRetention: snapshot.payloadRetention,
    storageTier: 'purged',
    retentionExpiresAt: addDays(snapshot.fetchedAt, entry.retention.retentionDays),
    classification: 'public',
    purpose: 'internal-strategic-intelligence',
    sanitizationStatus: 'untrusted',
    collectorVersion: run.collectorVersion,
    sourceRegistryVersion: run.sourceRegistryVersion,
  }
  rawSnapshots.push(raw)
  snapshotBySource.set(snapshot.sourceKey, raw)
}

const sourceDecisions = decisions.map((decision) => ({
  sourceKey: decision.sourceKey,
  registryVersion: decision.registryVersion,
  registryHash: run.sourceRegistryHash,
  policyVersion: decision.policyVersion,
  decision: decision.decision,
  reasonCode: decision.reasonCode,
  requestKey: `${request.requestKey}:${decision.sourceKey}`,
  evaluatedAt: timestamp(decision.evaluatedAt, 'source decision evaluatedAt'),
}))
if (sourceDecisions.some((decision) => decision.decision !== 'allow')) throw new Error('domain batch cannot compile denied sources')

const observations = items.map((item) => {
  const snapshot = snapshotBySource.get(item.sourceKey)
  if (!snapshot) throw new Error(`item source ${item.sourceKey} has no snapshot`)
  const observedAt = timestamp(item.publishedAt || item.fetchedAt, 'item observedAt')
  const ageSeconds = Math.max(0, Math.floor((Date.parse(run.completedAt) - Date.parse(observedAt)) / 1000))
  return {
    observationKey: item.itemKey,
    snapshotKey: snapshot.snapshotKey,
    sourceKey: item.sourceKey,
    sourceItemId: item.sourceItemId,
    title: item.title,
    url: item.url,
    summary: item.summary,
    observedAt,
    validFrom: observedAt,
    recordedAt: timestamp(run.completedAt, 'run completedAt'),
    parserVersion: 'collector-normalizer-0.1.0',
    payloadHash: item.contentHash,
    dataQualityStatus: 'valid',
    freshnessStatus: ageSeconds <= 86400 ? 'fresh' : ageSeconds <= 604800 ? 'aging' : 'stale',
    conflictStatus: 'none',
    classification: 'public',
    purpose: 'internal-strategic-intelligence',
    status: 'observed',
  }
})

const signals = observations.map((observation) => ({
  signalKey: hash({ sourceKey: observation.sourceKey, observationKey: observation.observationKey, type: 'single_observation_candidate' }),
  signalType: 'single_observation_candidate',
  title: observation.title,
  firstSeenAt: observation.observedAt,
  lastSeenAt: observation.observedAt,
  validFrom: observation.observedAt,
  recordedAt: observation.recordedAt,
  strength: 0,
  confidence: 0,
  signalStatus: 'candidate',
  dataQualityStatus: observation.dataQualityStatus,
  freshnessStatus: observation.freshnessStatus,
  conflictStatus: observation.conflictStatus,
  ontologyVersion: '3.7.0',
  causalGraphVersion: 'p003-shadow-inactive-v1',
  observationKeys: [observation.observationKey],
  classification: 'internal',
  purpose: 'internal-strategic-intelligence',
  payload: {},
}))
const signalByObservation = new Map(signals.map((signal) => [signal.observationKeys[0], signal]))
const evidence = observations.map((observation) => ({
  evidenceKey: hash({ observationKey: observation.observationKey, kind: 'context' }),
  observationKey: observation.observationKey,
  signalKey: signalByObservation.get(observation.observationKey).signalKey,
  snapshotKey: observation.snapshotKey,
  evidenceKind: 'context',
  summary: `${observation.title}${observation.summary ? `：${observation.summary}` : ''}`.slice(0, 4000),
  confidence: 0,
  validFrom: observation.validFrom,
  recordedAt: observation.recordedAt,
  status: 'candidate',
  classification: 'public',
  purpose: 'internal-strategic-intelligence',
  provenance: {
    collectorVersion: run.collectorVersion,
    parserVersion: observation.parserVersion,
    sourceRegistryVersion: run.sourceRegistryVersion,
    ontologyVersion: '3.7.0',
    causalGraphVersion: 'p003-shadow-inactive-v1',
  },
}))

const reviews = Array.isArray(p003Review.reviews) ? p003Review.reviews : p003Review.p003Samples
if (!Array.isArray(reviews)) throw new Error('P003 review records are required')
const categories = new Map()
for (const review of reviews) {
  if (review.activationStatus !== 'inactive') throw new Error('P003 relations must remain inactive')
  if (!categories.has(review.categoryKey)) categories.set(review.categoryKey, review)
}
if (categories.size !== 6) throw new Error('P003 review must cover exactly six categories')
const impactHypotheses = [...categories.entries()].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([categoryKey, review]) => ({
  hypothesisKey: review.candidateKey,
  categoryKey,
  externalFactorKey: `${review.primaryDimension || 'unknown'}:${review.secondaryDimension || 'unknown'}`,
  goalFacetKey: review.targetGoalFacetLabel || categoryKey,
  transmissionPath: review.semanticRewrite ? [review.semanticRewrite] : [],
  impactDirection: review.direction || 'unknown',
  impactStrength: review.strength ?? null,
  expectedLagDays: review.expectedLagUnit === 'day' ? review.expectedLagValue : null,
  generationStatus: 'generated_draft',
  verificationStatus: 'unverified',
  activationStatus: 'inactive',
  causalGraphVersion: 'p003-shadow-inactive-v1',
  validFrom: timestamp(run.startedAt, 'run startedAt'),
}))
const evidenceKeys = evidence.map((entry) => entry.evidenceKey).sort()
const impactAssessments = impactHypotheses.map((hypothesis) => ({
  assessmentKey: hash({ runId: run.runId, hypothesisKey: hypothesis.hypothesisKey }),
  hypothesisKey: hypothesis.hypothesisKey,
  categoryKey: hypothesis.categoryKey,
  windowStart: timestamp(run.startedAt, 'run startedAt'),
  windowEnd: timestamp(run.completedAt, 'run completedAt'),
  evidenceCutoffAt: timestamp(run.completedAt, 'run completedAt'),
  impactDirection: 'unknown',
  impactMagnitude: null,
  confidenceBand: 'insufficient',
  assessmentStatus: 'draft',
  reasonCode: 'MODEL_NOT_INVOKED_SHADOW',
  ontologyVersion: '3.7.0',
  causalGraphVersion: 'p003-shadow-inactive-v1',
  modelProvider: null,
  modelId: null,
  promptVersion: null,
  inputHash: hash({ hypothesisKey: hypothesis.hypothesisKey, evidenceKeys }),
  evidenceKeys,
  validFrom: timestamp(run.completedAt, 'run completedAt'),
  classification: 'internal',
  purpose: 'internal-strategic-intelligence',
}))

const structuredInputs = [
  ...rawSnapshots.map((entry) => ({ type: 'raw_snapshot', id: entry.snapshotKey, hash: hash(entry), sourceSnapshotIds: [entry.snapshotKey] })),
  ...observations.map((entry) => ({ type: 'observation', id: entry.observationKey, hash: hash(entry), sourceSnapshotIds: [entry.snapshotKey] })),
  ...signals.map((entry) => ({ type: 'signal', id: entry.signalKey, hash: hash(entry), sourceSnapshotIds: entry.observationKeys.map((key) => observations.find((observation) => observation.observationKey === key)?.snapshotKey).filter(Boolean) })),
  ...evidence.map((entry) => ({ type: 'evidence', id: entry.evidenceKey, hash: hash(entry), sourceSnapshotIds: [entry.snapshotKey] })),
  ...impactAssessments.map((entry) => ({ type: 'impact_assessment', id: entry.assessmentKey, hash: hash(entry), sourceSnapshotIds: rawSnapshots.map((snapshot) => snapshot.snapshotKey) })),
].sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`, 'en'))

const reportRuns = []
const reportDrafts = []
for (const window of reportWindows(run.completedAt)) {
  const inputManifest = {
    reportType: window.reportType,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    evidenceCutoffAt: timestamp(run.completedAt, 'run completedAt'),
    sourceRegistryVersion: run.sourceRegistryVersion,
    ontologyVersion: '3.7.0',
    causalGraphVersion: 'p003-shadow-inactive-v1',
    inputs: structuredInputs,
  }
  const inputHash = hash(inputManifest)
  const reportRunKey = hash({ requestKey: request.requestKey, reportType: window.reportType, inputHash })
  reportRuns.push({
    reportRunKey,
    reportType: window.reportType,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    evidenceCutoffAt: inputManifest.evidenceCutoffAt,
    inputHash,
    sourceSnapshotIds: rawSnapshots.map((snapshot) => snapshot.snapshotKey).sort(),
    sourceRegistryVersion: run.sourceRegistryVersion,
    ontologyVersionUsed: '3.7.0',
    causalGraphVersion: 'p003-shadow-inactive-v1',
    modelProvider: 'policy-engine',
    modelId: 'deterministic-shadow-compiler',
    promptVersion: 'shadow-structured-draft-1.0.0',
    inputTokens: 0,
    outputTokens: 0,
    costMicrounits: 0,
    durationMs: 0,
    status: 'succeeded',
    errorCode: null,
    retryCount: 0,
    startedAt: timestamp(run.completedAt, 'run completedAt'),
    completedAt: timestamp(run.completedAt, 'run completedAt'),
    inputManifest,
  })
  reportDrafts.push({
    reportKey: hash({ reportRunKey, projectionVersion: 'shadow-draft-1.0.0' }),
    reportRunKey,
    reportType: window.reportType,
    audienceScope: window.reportType === 'p003' ? 'p003-reviewers' : 'strategic-intelligence-reviewers',
    reportStatus: 'draft',
    projectionVersion: 'shadow-draft-1.0.0',
    classification: 'internal',
    purpose: 'internal-strategic-intelligence',
    structuredBody: {
      confidenceBand: 'insufficient',
      conclusions: [],
      unknowns: ['H 引擎模型尚未调用，当前只形成结构化 Shadow 草稿。', 'P003 因果关系保持 unverified / inactive，不能形成正式经营决策。'],
      sourceCoverage: { sourceCount: sourceEntries.length, rawSnapshotCount: rawSnapshots.length, observationCount: observations.length },
      candidateSignals: signals.length,
      candidateEvidence: evidence.length,
      impactAssessments: impactAssessments.map((assessment) => ({ categoryKey: assessment.categoryKey, confidenceBand: assessment.confidenceBand, impactDirection: assessment.impactDirection })),
      forbiddenActions: ['formal_p2', 'employee_delivery', 'erp_writeback', 'social_writeback', 'causal_activation'],
    },
  })
}

const counts = {
  sourceEntryCount: sourceEntries.length,
  sourceDecisionCount: sourceDecisions.length,
  rawSnapshotCount: rawSnapshots.length,
  observationCount: observations.length,
  signalCount: signals.length,
  evidenceCount: evidence.length,
  impactHypothesisCount: impactHypotheses.length,
  impactAssessmentCount: impactAssessments.length,
  reportRunCount: reportRuns.length,
  reportDraftCount: reportDrafts.length,
}
const batch = {
  batchVersion: '1.0.0',
  runId: run.runId,
  requestKey: request.requestKey,
  compiledAt: timestamp(run.completedAt, 'run completedAt'),
  publish: false,
  persistenceState: 'json_candidate_pending_postgres',
  sourceRegistryVersion: run.sourceRegistryVersion,
  sourceRegistryHash: run.sourceRegistryHash,
  ontologyVersion: '3.7.0',
  causalGraphVersion: 'p003-shadow-inactive-v1',
  ingestionRun: {
    runKey: run.runId,
    collectorVersion: run.collectorVersion,
    sourceRegistryVersion: run.sourceRegistryVersion,
    sourceRegistryHash: run.sourceRegistryHash,
    configHash: hash(request),
    status: run.status,
    stats: {
      sourceDecisionCount: run.sourceDecisionCount,
      sourceCount: run.sourceCount,
      rawSnapshotCount: run.rawSnapshotCount,
      itemCount: run.itemCount,
      duplicateCount: run.duplicateCount,
    },
    errorCode: run.errorCode,
    startedAt: timestamp(run.startedAt, 'run startedAt'),
    completedAt: timestamp(run.completedAt, 'run completedAt'),
  },
  sourceEntries,
  sourceDecisions,
  rawSnapshots,
  observations,
  signals,
  evidence,
  impactHypotheses,
  impactAssessments,
  reportRuns,
  reportDrafts,
  sideEffects: { formalP2Count: 0, employeeDeliveryCount: 0, erpWritebackCount: 0, socialWritebackCount: 0, causalActivationCount: 0 },
  counts,
}
await fs.mkdir(path.dirname(path.resolve(outputFile)), { recursive: true, mode: 0o750 })
await fs.writeFile(path.resolve(outputFile), `${JSON.stringify(batch, null, 2)}\n`, { mode: 0o600 })
await fs.mkdir(path.dirname(path.resolve(metricsOutputFile)), { recursive: true, mode: 0o750 })
await fs.writeFile(path.resolve(metricsOutputFile), `${JSON.stringify({ compiled: true, batchHash: hash(batch), ...counts }, null, 2)}\n`, { mode: 0o600 })
