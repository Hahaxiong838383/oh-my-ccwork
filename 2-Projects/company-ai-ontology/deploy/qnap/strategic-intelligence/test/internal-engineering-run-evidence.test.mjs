import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLAN_FILE = path.join(ROOT, 'config/internal-engineering-shadow-plan.json')
const COMPILER = path.join(ROOT, 'scripts/compile-internal-engineering-run-evidence.mjs')
const VALIDATOR = path.join(ROOT, 'scripts/validate-internal-engineering-run-evidence.mjs')

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function runtimeState(phase, foundationFingerprint = 'a'.repeat(64), overrides = {}) {
  return {
    snapshotVersion: '1.0.0',
    phase,
    capturedAt: phase === 'before' ? '2026-08-11T01:00:00.000Z' : '2026-08-11T01:02:00.000Z',
    foundation: {
      containerCount: 13,
      runningContainerCount: 13,
      unhealthyContainerCount: 0,
      restartCountTotal: 0,
      fingerprint: foundationFingerprint,
      ...overrides.foundation,
    },
    strategicIntelligence: {
      containerCount: 0,
      runningContainerCount: 0,
      networkCount: 0,
      publishedPortCount: 0,
      fingerprint: 'b'.repeat(64),
      ...overrides.strategicIntelligence,
    },
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function createEvidenceFixture(mutator = () => {}) {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-internal-run-evidence-'))
  const plan = JSON.parse(await fs.readFile(PLAN_FILE, 'utf8'))
  const config = {
    operationMode: 'internal_engineering_shadow',
    publish: false,
    maxItemsPerSource: 20,
    sourceKeys: plan.selectedSources.map((source) => source.sourceKey),
  }
  const runId = '2026-08-11T01-00-00-000Z-evidence-fixture'
  const stateRoot = path.join(outputRoot, 'state')
  const reportRoot = path.join(outputRoot, 'reports')
  const runDir = path.join(stateRoot, 'runs', runId)
  const items = plan.selectedSources.flatMap((source, sourceIndex) => [0, 1].map((itemIndex) => ({
    itemKey: sha256(`${source.sourceKey}:${itemIndex}`),
    sourceKey: source.sourceKey,
    sourceItemId: `${sourceIndex}-${itemIndex}`,
    title: `Evidence item ${sourceIndex}-${itemIndex}`,
    url: `https://evidence.example/${sourceIndex}/${itemIndex}`,
    summary: 'Public evidence metadata only',
    publishedAt: '2026-08-11T00:30:00.000Z',
    fetchedAt: '2026-08-11T01:01:00.000Z',
    contentHash: sha256(`content:${sourceIndex}:${itemIndex}`),
  })))
  const decisions = plan.selectedSources.map((source) => ({
    allowed: true,
    decision: 'allow',
    reasonCode: 'INTERNAL_ENGINEERING_PROVISIONAL_ALLOW',
    sourceKey: source.sourceKey,
    evaluatedAt: '2026-08-11T01:00:00.000Z',
    registryVersion: '3.5.0',
    policyVersion: '1.0.0+internal-engineering.1',
    lifecycleStatus: 'paused',
  }))
  const snapshots = Object.fromEntries(plan.selectedSources.map((source, index) => [source.sourceKey, {
    sourceKey: source.sourceKey,
    fetchedAt: '2026-08-11T01:01:00.000Z',
    endpointOrigin: `https://source-${index}.example`,
    contentType: index === 0 ? 'application/atom+xml' : 'application/json',
    contentLength: 128,
    contentHash: sha256(`snapshot:${source.sourceKey}`),
    retentionStorageLevel: source.storageLevel,
    payloadRetention: 'hash_only',
    bodyBase64: null,
  }]))
  const summary = {
    runId,
    collectorVersion: '0.1.0',
    startedAt: '2026-08-11T01:00:00.000Z',
    completedAt: '2026-08-11T01:01:00.000Z',
    publish: false,
    operationMode: 'internal_engineering_shadow',
    countsTowardProductionShadow: false,
    status: 'succeeded',
    sourceRegistryVersion: '3.5.0',
    sourceRegistryHash: sha256('registry'),
    sourceDecisionCount: 3,
    sourceCount: 3,
    rawSnapshotCount: 3,
    itemCount: items.length,
    duplicateCount: 0,
    errorCode: null,
  }
  const fixture = {
    outputRoot,
    plan,
    config,
    runId,
    stateRoot,
    reportRoot,
    runDir,
    items,
    decisions,
    snapshots,
    summary,
    runtimeBefore: runtimeState('before'),
    runtimeAfter: runtimeState('after'),
    sideEffects: {
      auditVersion: '1.0.0',
      completed: true,
      windowStart: '2026-08-11T01:00:00.000Z',
      windowEnd: '2026-08-11T01:02:00.000Z',
      formalP2Count: 0,
      employeeDeliveryCount: 0,
      erpWritebackCount: 0,
      socialWritebackCount: 0,
      causalActivationCount: 0,
    },
    exitCode: 0,
  }
  mutator(fixture)
  fixture.summary.itemCount = fixture.items.length
  const files = {
    plan: path.join(outputRoot, 'plan.json'),
    config: path.join(outputRoot, 'config.json'),
    stdout: path.join(outputRoot, 'stdout.json'),
    stderr: path.join(outputRoot, 'stderr.log'),
    runtimeBefore: path.join(outputRoot, 'runtime-before.json'),
    runtimeAfter: path.join(outputRoot, 'runtime-after.json'),
    sideEffects: path.join(outputRoot, 'side-effects.json'),
    evidence: path.join(outputRoot, 'evidence.json'),
  }
  await Promise.all([
    writeJson(files.plan, fixture.plan),
    writeJson(files.config, fixture.config),
    writeJson(files.stdout, { ok: true, ...fixture.summary }),
    fs.writeFile(files.stderr, ''),
    writeJson(path.join(runDir, 'run.json'), fixture.summary),
    writeJson(path.join(runDir, 'source-decisions.json'), fixture.decisions),
    writeJson(path.join(runDir, 'items.json'), fixture.items),
    ...Object.entries(fixture.snapshots).map(([sourceKey, snapshot]) => writeJson(path.join(runDir, 'raw', `${sourceKey}.snapshot.json`), snapshot)),
    writeJson(path.join(reportRoot, `candidate-${runId}.json`), { ...fixture.summary, items: fixture.items }),
    writeJson(files.runtimeBefore, fixture.runtimeBefore),
    writeJson(files.runtimeAfter, fixture.runtimeAfter),
    writeJson(files.sideEffects, fixture.sideEffects),
  ])
  return { fixture, files }
}

function compile({ fixture, files }) {
  return spawnSync(process.execPath, [
    COMPILER,
    '--collector-stdout', files.stdout,
    '--collector-stderr', files.stderr,
    '--plan', files.plan,
    '--config', files.config,
    '--state-root', fixture.stateRoot,
    '--report-root', fixture.reportRoot,
    '--runtime-before', files.runtimeBefore,
    '--runtime-after', files.runtimeAfter,
    '--side-effect-audit', files.sideEffects,
    '--started-at', '2026-08-11T01:00:00.000Z',
    '--completed-at', '2026-08-11T01:02:00.000Z',
    '--exit-code', String(fixture.exitCode),
    '--output', files.evidence,
  ], { encoding: 'utf8' })
}

test('internal run evidence accepts exactly three bounded hash-only sources with zero side effects', async () => {
  const context = await createEvidenceFixture()
  const compiled = compile(context)
  assert.equal(compiled.status, 0, compiled.stderr)
  const compileOutput = JSON.parse(compiled.stdout)
  assert.equal(compileOutput.acceptedForInternalEngineering, true)
  assert.equal(compileOutput.countsTowardProductionShadow, false)
  const validated = spawnSync(process.execPath, [VALIDATOR, context.files.evidence], { encoding: 'utf8' })
  assert.equal(validated.status, 0, validated.stderr)
  const output = JSON.parse(validated.stdout)
  assert.equal(output.status, 'succeeded')
  assert.equal(output.acceptedForInternalEngineering, true)
  assert.equal(output.eligibleForProductionShadow, false)
  const evidence = JSON.parse(await fs.readFile(context.files.evidence, 'utf8'))
  assert.equal(evidence.sourceVerification.successfulSourceCount, 3)
  assert.equal(evidence.sourceVerification.maximumObservedItemsPerSource, 2)
  assert.equal(evidence.retentionVerification.retainedBodyCount, 0)
  assert.equal(evidence.runtimeVerification.foundationStable, true)
  assert.equal(evidence.runtimeVerification.temporaryResourcesClean, true)
  assert.equal(evidence.sideEffects.allZero, true)
})

test('internal run evidence fails closed when a source exceeds twenty items', async () => {
  const context = await createEvidenceFixture((fixture) => {
    const sourceKey = fixture.plan.selectedSources[0].sourceKey
    fixture.items = Array.from({ length: 21 }, (_, index) => ({ ...fixture.items[0], itemKey: sha256(`overflow:${index}`), sourceItemId: `overflow-${index}`, sourceKey }))
      .concat(fixture.items.filter((item) => item.sourceKey !== sourceKey))
  })
  const compiled = compile(context)
  assert.equal(compiled.status, 0, compiled.stderr)
  const evidence = JSON.parse(await fs.readFile(context.files.evidence, 'utf8'))
  assert.equal(evidence.status, 'failed')
  assert.equal(evidence.sourceVerification.maximumObservedItemsPerSource, 21)
  assert.ok(evidence.failureCodes.includes('ITEM_LIMIT_EXCEEDED'))
  assert.equal(evidence.acceptance.acceptedForInternalEngineering, false)
  const validated = spawnSync(process.execPath, [VALIDATOR, context.files.evidence], { encoding: 'utf8' })
  assert.equal(validated.status, 0, validated.stderr)
})

test('internal run evidence rejects retained raw bodies', async () => {
  const context = await createEvidenceFixture((fixture) => {
    const sourceKey = fixture.plan.selectedSources[0].sourceKey
    fixture.snapshots[sourceKey].payloadRetention = 'retained_full_text'
    fixture.snapshots[sourceKey].bodyBase64 = Buffer.from('forbidden body').toString('base64')
  })
  const compiled = compile(context)
  assert.equal(compiled.status, 0, compiled.stderr)
  const evidence = JSON.parse(await fs.readFile(context.files.evidence, 'utf8'))
  assert.equal(evidence.retentionVerification.allPayloadHashOnly, false)
  assert.equal(evidence.retentionVerification.retainedBodyCount, 1)
  assert.ok(evidence.failureCodes.includes('RAW_RETENTION_UNSAFE'))
})

test('internal run evidence detects foundation drift and temporary resource leaks', async () => {
  const context = await createEvidenceFixture((fixture) => {
    fixture.runtimeAfter = runtimeState('after', 'c'.repeat(64), {
      strategicIntelligence: { containerCount: 1, runningContainerCount: 1, networkCount: 1 },
    })
  })
  const compiled = compile(context)
  assert.equal(compiled.status, 0, compiled.stderr)
  const evidence = JSON.parse(await fs.readFile(context.files.evidence, 'utf8'))
  assert.equal(evidence.runtimeVerification.foundationStable, false)
  assert.equal(evidence.runtimeVerification.temporaryResourcesClean, false)
  assert.ok(evidence.failureCodes.includes('FOUNDATION_RUNTIME_DRIFT'))
  assert.ok(evidence.failureCodes.includes('TEMPORARY_RESOURCE_LEAK'))
})

test('internal run evidence detects business side effects and cannot be promoted to production', async () => {
  const context = await createEvidenceFixture((fixture) => {
    fixture.sideEffects.employeeDeliveryCount = 1
  })
  const compiled = compile(context)
  assert.equal(compiled.status, 0, compiled.stderr)
  const evidence = JSON.parse(await fs.readFile(context.files.evidence, 'utf8'))
  assert.equal(evidence.sideEffects.allZero, false)
  assert.ok(evidence.failureCodes.includes('BUSINESS_SIDE_EFFECT_DETECTED'))
  evidence.acceptance.eligibleForProductionShadow = true
  await writeJson(context.files.evidence, evidence)
  const validated = spawnSync(process.execPath, [VALIDATOR, context.files.evidence], { encoding: 'utf8' })
  assert.notEqual(validated.status, 0)
  assert.match(validated.stderr, /can never be production-shadow eligible/)
})

test('internal run evidence is still created when the collector exits nonzero', async () => {
  const context = await createEvidenceFixture((fixture) => {
    fixture.exitCode = 17
  })
  const compiled = compile(context)
  assert.equal(compiled.status, 0, compiled.stderr)
  const evidence = JSON.parse(await fs.readFile(context.files.evidence, 'utf8'))
  assert.equal(evidence.status, 'failed')
  assert.equal(evidence.collector.exitCode, 17)
  assert.ok(evidence.failureCodes.includes('COLLECTOR_EXIT_NONZERO'))
  assert.equal(evidence.acceptance.acceptedForInternalEngineering, false)
  const validated = spawnSync(process.execPath, [VALIDATOR, context.files.evidence], { encoding: 'utf8' })
  assert.equal(validated.status, 0, validated.stderr)
})

test('internal run script preserves explicit approval and machine evidence gates', async () => {
  const source = await fs.readFile(path.join(ROOT, 'scripts/run-internal-engineering-once.sh'), 'utf8')
  for (const marker of [
    'INTERNAL_ENGINEERING_RUN_APPROVED',
    'capture-internal-engineering-runtime-state.sh',
    'capture-shadow-side-effects.sh',
    'compile-internal-engineering-run-evidence.mjs',
    'validate-internal-engineering-run-evidence.mjs',
    'evidence_created=1',
    'counts_toward_production_shadow=0',
  ]) assert.match(source, new RegExp(marker))
  assert.doesNotMatch(source, /SHADOW_DEPLOY_APPROVED=YES/)
})

test('runtime state capture records thirteen healthy foundation containers without strategic resources', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'company-si-runtime-capture-'))
  const scriptsRoot = path.join(outputRoot, 'scripts')
  const shadowRoot = path.join(outputRoot, 'shadow')
  const fakeDocker = path.join(outputRoot, 'docker')
  const formatLog = path.join(outputRoot, 'docker-formats.log')
  const outputFile = path.join(shadowRoot, 'runtime.json')
  await fs.mkdir(scriptsRoot, { recursive: true })
  await fs.mkdir(shadowRoot, { recursive: true })
  await fs.copyFile(path.join(ROOT, 'scripts/capture-internal-engineering-runtime-state.sh'), path.join(scriptsRoot, 'capture-internal-engineering-runtime-state.sh'))
  await fs.writeFile(path.join(scriptsRoot, 'preflight-company-qnap.sh'), `docker_path=${JSON.stringify(fakeDocker)}\nfoundation_root=${JSON.stringify(path.join(outputRoot, 'foundation'))}\nshadow_root=${JSON.stringify(shadowRoot)}\n`)
  await fs.writeFile(fakeDocker, `#!/bin/sh
set -eu
case "$1" in
  ps)
    case "$*" in
      *"ps -q --filter label=com.docker.compose.project=company-ai-foundation"*)
        index=1
        while [ "$index" -le 13 ]; do printf 'foundation-%s\\n' "$index"; index=$((index + 1)); done
        ;;
      *"ps -aq --filter label=com.docker.compose.project=company-ai-foundation"*)
        index=1
        while [ "$index" -le 14 ]; do printf 'foundation-%s\\n' "$index"; index=$((index + 1)); done
        ;;
    esac
    ;;
  inspect)
    format=
    previous=
    for value in "$@"; do
      if [ "$previous" = --format ]; then format=$value; fi
      previous=$value
    done
    printf '%s\n' "$format" >> ${JSON.stringify(formatLog)}
    last=
    for value in "$@"; do last=$value; done
    case "$format" in
      *'|'*) printf '/%s|image:%s|running|healthy|0|{}\\n' "$last" "$last" ;;
      *) printf '/%s\\\\timage:%s\\\\trunning\\\\thealthy\\\\t0\\\\t{}\\n' "$last" "$last" ;;
    esac
    ;;
  network)
    case "\${2:-}" in
      ls) ;;
      *) exit 81 ;;
    esac
    ;;
  *) exit 82 ;;
esac
`)
  await fs.chmod(fakeDocker, 0o700)
  const result = spawnSync('sh', [path.join(scriptsRoot, 'capture-internal-engineering-runtime-state.sh'), 'before', outputFile], {
    encoding: 'utf8',
    env: { ...process.env, NODE_BIN: process.execPath },
  })
  assert.equal(result.status, 0, result.stderr)
  const snapshot = JSON.parse(await fs.readFile(outputFile, 'utf8'))
  assert.equal(snapshot.phase, 'before')
  assert.equal(snapshot.foundation.containerCount, 13)
  assert.equal(snapshot.foundation.runningContainerCount, 13)
  assert.equal(snapshot.foundation.unhealthyContainerCount, 0)
  assert.equal(snapshot.foundation.restartCountTotal, 0)
  assert.match(snapshot.foundation.fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(snapshot.strategicIntelligence.containerCount, 0)
  assert.equal(snapshot.strategicIntelligence.networkCount, 0)
  assert.equal(snapshot.strategicIntelligence.publishedPortCount, 0)
  assert.equal((await fs.stat(outputFile)).mode & 0o777, 0o600)
  const formats = await fs.readFile(formatLog, 'utf8')
  assert.match(formats, /\|/)
  assert.doesNotMatch(formats, /\\t/)
})
