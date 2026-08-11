import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const POLICY_FILE = path.join(ROOT, 'config/shadow-policy.json')
const EVALUATOR = path.join(ROOT, 'scripts/evaluate-shadow.mjs')
const COMPILER = path.join(ROOT, 'scripts/compile-seven-day-shadow-summary.mjs')
const ACCEPTANCE_RECORDER = path.join(ROOT, 'scripts/record-shadow-owner-acceptance.mjs')
const SUMMARY_VALIDATOR = path.join(ROOT, 'scripts/validate-seven-day-shadow-summary.mjs')
const policy = JSON.parse(await fs.readFile(POLICY_FILE, 'utf8'))
const policyHash = createHash('sha256').update(JSON.stringify(policy)).digest('hex')

function dates(start = '2026-08-01', count = 7) {
  const startTime = Date.parse(`${start}T00:00:00Z`)
  return Array.from({ length: count }, (_, index) => new Date(startTime + index * 86400000).toISOString().slice(0, 10))
}

function validEvidence(localDate) {
  return {
    evidenceVersion: '1.0.0',
    requestKey: `daily-collection-shadow-${localDate}`,
    localDate,
    timezone: 'Asia/Shanghai',
    requestedAt: `${localDate}T00:00:00.000Z`,
    recordedAt: `${localDate}T00:02:10.000Z`,
    policyVersion: policy.policyVersion,
    policyHash,
    simulated: false,
    publish: false,
    status: 'succeeded',
    startedAt: `${localDate}T00:01:00.000Z`,
    completedAt: `${localDate}T00:02:00.000Z`,
    durationSeconds: 60,
    exitCode: 0,
    timeoutCount: 0,
    sourceAttemptCount: 8,
    sourceSuccessCount: 8,
    rawSnapshotCount: 8,
    normalizedItemCount: 7,
    duplicateCount: 1,
    freshnessP95Seconds: 1800,
    rawSnapshotBytes: 1024,
    networkBytes: 2048,
    peakCpuPermille: 400,
    peakMemoryBytes: 256 * 1024 * 1024,
    reportCostsUsd: { daily: 0.25, weekly: 0 },
    security: {
      unredactedSensitiveOutputCount: 0,
      sourceRevocationEffectiveSeconds: 60,
      postRevocationNetworkRequestCount: 0,
      lastGoodPreserved: true,
    },
    sideEffects: {
      formalP2Count: 0,
      employeeDeliveryCount: 0,
      erpWritebackCount: 0,
      socialWritebackCount: 0,
      causalActivationCount: 0,
    },
    runtime: {
      collectorImage: `sha256:${'c'.repeat(64)}`,
      sourceCommit: 'a'.repeat(40),
      containerRestartCount: 0,
      newHostPortCount: 0,
    },
    coverage: {
      collectorMetricsCollected: true,
      resourceMetricsCollected: true,
      sensitiveOutputAuditCompleted: true,
      sourceRevocationAuditCompleted: true,
      businessSideEffectAuditCompleted: true,
    },
  }
}

async function writeDay(root, localDate, mutate = (value) => value) {
  const evidence = mutate(structuredClone(validEvidence(localDate)))
  const evidenceFile = path.join(root, `${evidence.requestKey}.json`)
  await fs.writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  const evaluation = spawnSync(process.execPath, [EVALUATOR, POLICY_FILE, evidenceFile], { encoding: 'utf8' })
  await fs.writeFile(`${evidenceFile}.evaluation.json`, evaluation.stdout, { mode: 0o600 })
  return { evidenceFile, evaluation }
}

async function writeSevenDays(root, { naturalDates = dates(), mutate } = {}) {
  await fs.mkdir(root, { recursive: true })
  const results = []
  for (let index = 0; index < naturalDates.length; index += 1) {
    results.push(await writeDay(root, naturalDates[index], (evidence) => mutate?.(evidence, index) || evidence))
  }
  return results
}

test('single-day evaluation rejects zero-source success and incomplete audits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-zero-source-'))
  const { evaluation } = await writeDay(root, '2026-08-01', (evidence) => {
    evidence.sourceAttemptCount = 0
    evidence.sourceSuccessCount = 0
    delete evidence.peakMemoryBytes
    evidence.coverage.sourceRevocationAuditCompleted = false
    return evidence
  })
  assert.equal(evaluation.status, 1)
  const result = JSON.parse(evaluation.stdout)
  assert.ok(result.violations.some((entry) => entry.name === 'source_attempt_missing'))
  assert.ok(result.violations.some((entry) => entry.name === 'peak_memory_bytes_missing_or_invalid'))
  assert.ok(result.violations.some((entry) => entry.name === 'source_revocation_audit_missing'))
})

test('seven real days compile, require explicit owner acceptance and validate against source evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-seven-day-valid-'))
  const evidenceRoot = path.join(root, 'evidence')
  const summaryFile = path.join(root, 'seven-day-shadow-summary.json')
  const acceptedFile = path.join(root, 'seven-day-shadow-summary.accepted.json')
  await writeSevenDays(evidenceRoot)

  const compiled = spawnSync(process.execPath, [COMPILER, evidenceRoot, summaryFile], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr)
  const summary = JSON.parse(await fs.readFile(summaryFile, 'utf8'))
  assert.equal(summary.completedNaturalDays, 7)
  assert.equal(summary.engineeringVerified, true)
  assert.equal(summary.ownerAcceptance.ownerAccepted, false)
  assert.equal((await fs.stat(summaryFile)).mode & 0o777, 0o600)

  const unaccepted = spawnSync(process.execPath, [SUMMARY_VALIDATOR, summaryFile, evidenceRoot], { encoding: 'utf8' })
  assert.notEqual(unaccepted.status, 0)
  assert.match(unaccepted.stderr, /ownerAccepted must be true/)

  const unauthorized = spawnSync(process.execPath, [ACCEPTANCE_RECORDER, summaryFile, evidenceRoot, acceptedFile], { encoding: 'utf8' })
  assert.notEqual(unauthorized.status, 0)
  assert.match(unauthorized.stderr, /SHADOW_OWNER_ACCEPTANCE_APPROVED=YES is required/)

  const accepted = spawnSync(process.execPath, [ACCEPTANCE_RECORDER, summaryFile, evidenceRoot, acceptedFile], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SHADOW_OWNER_ACCEPTANCE_APPROVED: 'YES',
      SHADOW_OWNER_PRINCIPAL_REF: 'company-directory:owner',
      SHADOW_OWNER_ACCEPTANCE_REF: 'feishu:doc/p1-si-shadow-owner-acceptance',
      SHADOW_OWNER_ACCEPTED_AT: '2026-08-08T00:00:00.000Z',
    },
  })
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal((await fs.stat(acceptedFile)).mode & 0o777, 0o600)

  const validated = spawnSync(process.execPath, [SUMMARY_VALIDATOR, acceptedFile, evidenceRoot], { encoding: 'utf8' })
  assert.equal(validated.status, 0, validated.stderr)
  const validation = JSON.parse(validated.stdout)
  assert.equal(validation.completedNaturalDays, 7)
  assert.equal(validation.ownerAccepted, true)
  assert.match(validation.summaryFileHash, /^[0-9a-f]{64}$/)

  const firstEvidenceFile = path.join(evidenceRoot, 'daily-collection-shadow-2026-08-01.json')
  const tampered = JSON.parse(await fs.readFile(firstEvidenceFile, 'utf8'))
  tampered.rawSnapshotCount += 1
  await fs.writeFile(firstEvidenceFile, `${JSON.stringify(tampered, null, 2)}\n`)
  const staleAcceptance = spawnSync(process.execPath, [SUMMARY_VALIDATOR, acceptedFile, evidenceRoot], { encoding: 'utf8' })
  assert.notEqual(staleAcceptance.status, 0)
  assert.match(staleAcceptance.stderr, /evaluation evidenceHash mismatch/)
})

test('owner acceptance cannot predate completion of the seventh real run', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-owner-time-'))
  const evidenceRoot = path.join(root, 'evidence')
  const summaryFile = path.join(root, 'summary.json')
  const acceptedFile = path.join(root, 'accepted.json')
  await writeSevenDays(evidenceRoot)
  assert.equal(spawnSync(process.execPath, [COMPILER, evidenceRoot, summaryFile]).status, 0)
  const premature = spawnSync(process.execPath, [ACCEPTANCE_RECORDER, summaryFile, evidenceRoot, acceptedFile], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SHADOW_OWNER_ACCEPTANCE_APPROVED: 'YES',
      SHADOW_OWNER_PRINCIPAL_REF: 'company-directory:owner',
      SHADOW_OWNER_ACCEPTANCE_REF: 'feishu:doc/p1-si-shadow-owner-acceptance',
      SHADOW_OWNER_ACCEPTED_AT: '2026-08-07T00:00:00.000Z',
    },
  })
  assert.notEqual(premature.status, 0)
  assert.match(premature.stderr, /after the seventh run/)
})

test('seven-day compiler fails closed on missing, discontinuous, simulated or unsafe evidence', async (context) => {
  const scenarios = [
    {
      name: 'missing natural day',
      naturalDates: dates('2026-08-01', 6),
      expected: /expected exactly 7 day evidence files/,
    },
    {
      name: 'date discontinuity',
      naturalDates: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'],
      expected: /dates are not consecutive/,
    },
    {
      name: 'simulated evidence',
      mutate: (evidence, index) => index === 3 ? { ...evidence, simulated: true } : evidence,
      expected: /simulated evidence is forbidden/,
    },
    {
      name: 'zero source attempts',
      mutate: (evidence, index) => index === 3 ? { ...evidence, sourceAttemptCount: 0, sourceSuccessCount: 0 } : evidence,
      expected: /sourceAttemptCount must be greater than zero/,
    },
    {
      name: 'coverage missing',
      mutate: (evidence, index) => {
        if (index === 3) evidence.coverage.businessSideEffectAuditCompleted = false
        return evidence
      },
      expected: /coverage businessSideEffectAuditCompleted missing/,
    },
    {
      name: 'business side effect',
      mutate: (evidence, index) => {
        if (index === 3) evidence.sideEffects.employeeDeliveryCount = 1
        return evidence
      },
      expected: /employeeDeliveryCount must remain zero/,
    },
    {
      name: 'source commit drift',
      mutate: (evidence, index) => {
        if (index === 6) evidence.runtime.sourceCommit = 'b'.repeat(40)
        return evidence
      },
      expected: /runtime identity drift detected/,
    },
    {
      name: 'collector image drift',
      mutate: (evidence, index) => {
        if (index === 6) evidence.runtime.collectorImage = `sha256:${'d'.repeat(64)}`
        return evidence
      },
      expected: /runtime identity drift detected/,
    },
    {
      name: 'policy drift',
      mutate: (evidence, index) => index === 6 ? { ...evidence, policyHash: 'e'.repeat(64) } : evidence,
      expected: /evaluation did not pass/,
    },
    {
      name: 'container restart',
      mutate: (evidence, index) => {
        if (index === 5) evidence.runtime.containerRestartCount = 1
        return evidence
      },
      expected: /containerRestartCount must remain zero/,
    },
  ]

  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-seven-day-negative-'))
      const evidenceRoot = path.join(root, 'evidence')
      const summaryFile = path.join(root, 'summary.json')
      await writeSevenDays(evidenceRoot, scenario)
      const result = spawnSync(process.execPath, [COMPILER, evidenceRoot, summaryFile], { encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, scenario.expected)
    })
  }
})
