import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export const GOAL7_WORKER_RAW_FILES = Object.freeze({
  http: 'worker-http-response.json',
  ledger: 'worker-ledger-row.json',
})

const COMMIT = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const MAX_BYTES = 256 * 1024
const SENSITIVE_KEYS = new Set([
  'prompt', 'promptText', 'requestBody', 'responseBody', 'reply', 'message',
  'employeeMessage', 'employeeQuestion', 'displayName', 'principalRef', 'requestId',
])

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function exactKeys(value, keys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  requireValue(isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()), `${label} fields mismatch`)
}

function timestamp(value, label) {
  const parsed = Date.parse(String(value || ''))
  requireValue(Number.isFinite(parsed), `${label} invalid`)
  return parsed
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function rejectSensitiveKeys(value, label) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    requireValue(!SENSITIVE_KEYS.has(key), `${label} contains forbidden sensitive field`)
    rejectSensitiveKeys(child, label)
  }
}

function validateUsage(usage, label) {
  exactKeys(usage, ['promptTokens', 'completionTokens', 'totalTokens', 'estimatedCostMicros'], label)
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'estimatedCostMicros']) {
    requireValue(Number.isInteger(usage[key]) && usage[key] >= 0, `${label}.${key} invalid`)
  }
  requireValue(usage.totalTokens === usage.promptTokens + usage.completionTokens, `${label}.totalTokens drift`)
}

function validateIdentity(value, label) {
  requireValue(COMMIT.test(String(value.sourceCommit || '')), `${label}.sourceCommit invalid`)
  requireValue(COMMIT.test(String(value.hLiteSourceCommit || '')), `${label}.hLiteSourceCommit invalid`)
  requireValue(HASH.test(String(value.requestIdHash || '')), `${label}.requestIdHash invalid`)
  requireValue(typeof value.provider === 'string' && value.provider.length >= 2, `${label}.provider missing`)
  requireValue(typeof value.model === 'string' && value.model.length >= 2, `${label}.model missing`)
  requireValue(typeof value.credentialModeTag === 'string' && value.credentialModeTag.length >= 2, `${label}.credentialModeTag missing`)
}

function validateHttp(value) {
  exactKeys(value, [
    'evidenceVersion', 'evidenceType', 'sourceCommit', 'hLiteSourceCommit', 'capturedAt',
    'httpStatus', 'responseStatus', 'requestIdHash', 'provider', 'model',
    'credentialModeTag', 'productionReady', 'usage', 'governance',
    'sensitivePayloadPersisted',
  ], 'workerHttp')
  requireValue(value.evidenceVersion === '1.0.0', 'workerHttp evidenceVersion mismatch')
  requireValue(value.evidenceType === 'goal7-h-worker-http-response', 'workerHttp evidenceType mismatch')
  validateIdentity(value, 'workerHttp')
  timestamp(value.capturedAt, 'workerHttp.capturedAt')
  requireValue(value.httpStatus === 200 && value.responseStatus === 'completed', 'workerHttp response was not successful')
  requireValue(value.productionReady === true, 'workerHttp runtime is not production ready')
  validateUsage(value.usage, 'workerHttp.usage')
  exactKeys(value.governance, ['routeKey', 'retryCount', 'ledgerRecorded', 'routeBEnabled'], 'workerHttp.governance')
  requireValue(value.governance.routeKey === 'route-a', 'workerHttp must use Route A')
  requireValue(Number.isInteger(value.governance.retryCount) && value.governance.retryCount >= 0, 'workerHttp retryCount invalid')
  requireValue(value.governance.ledgerRecorded === true, 'workerHttp ledger was not recorded')
  requireValue(value.governance.routeBEnabled === false, 'workerHttp Route B must remain disabled')
  requireValue(value.sensitivePayloadPersisted === false, 'workerHttp persisted sensitive payload')
  rejectSensitiveKeys(value, 'workerHttp')
}

function validateLedger(value) {
  exactKeys(value, [
    'evidenceVersion', 'evidenceType', 'sourceCommit', 'hLiteSourceCommit', 'capturedAt',
    'rowCount', 'requestIdHash', 'routeKey', 'provider', 'model', 'credentialModeTag',
    'retryCount', 'outcome', 'usage', 'sensitivePayloadPersisted',
  ], 'workerLedger')
  requireValue(value.evidenceVersion === '1.0.0', 'workerLedger evidenceVersion mismatch')
  requireValue(value.evidenceType === 'goal7-h-worker-ledger-row', 'workerLedger evidenceType mismatch')
  validateIdentity(value, 'workerLedger')
  timestamp(value.capturedAt, 'workerLedger.capturedAt')
  requireValue(value.rowCount === 1, 'workerLedger must contain exactly one usage row')
  requireValue(value.routeKey === 'route-a', 'workerLedger must use Route A')
  requireValue(Number.isInteger(value.retryCount) && value.retryCount >= 0, 'workerLedger retryCount invalid')
  requireValue(value.outcome === 'succeeded', 'workerLedger outcome must be succeeded')
  validateUsage(value.usage, 'workerLedger.usage')
  requireValue(value.sensitivePayloadPersisted === false, 'workerLedger persisted sensitive payload')
  rejectSensitiveKeys(value, 'workerLedger')
}

async function readRaw(root, fileName) {
  requireValue(path.basename(fileName) === fileName, 'worker readback raw filename is unsafe')
  const file = path.join(root, fileName)
  const stat = await fs.lstat(file).catch(() => null)
  requireValue(stat?.isFile() && !stat.isSymbolicLink(), `worker readback raw file missing or unsafe: ${fileName}`)
  requireValue(stat.size > 0 && stat.size <= MAX_BYTES, `worker readback raw file size invalid: ${fileName}`)
  const bytes = await fs.readFile(file)
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) }
}

export async function buildGoal7WorkerReadbackEvidence(bundleRoot) {
  const root = path.resolve(bundleRoot)
  const entries = Object.fromEntries(await Promise.all(Object.entries(GOAL7_WORKER_RAW_FILES).map(async ([key, file]) => [key, await readRaw(root, file)])))
  const http = entries.http.value
  const ledger = entries.ledger.value
  validateHttp(http)
  validateLedger(ledger)

  requireValue(http.sourceCommit === ledger.sourceCommit, 'worker readback sourceCommit drift')
  requireValue(http.hLiteSourceCommit === ledger.hLiteSourceCommit, 'worker readback H-Lite sourceCommit drift')
  requireValue(http.requestIdHash === ledger.requestIdHash, 'worker readback requestIdHash drift')
  requireValue(http.provider === ledger.provider, 'worker readback provider drift')
  requireValue(http.model === ledger.model, 'worker readback model drift')
  requireValue(http.credentialModeTag === ledger.credentialModeTag, 'worker readback credential mode drift')
  requireValue(http.governance.routeKey === ledger.routeKey, 'worker readback route drift')
  requireValue(http.governance.retryCount === ledger.retryCount, 'worker readback retry count drift')
  requireValue(isDeepStrictEqual(http.usage, ledger.usage), 'worker readback usage drift')
  const httpAt = timestamp(http.capturedAt, 'workerHttp.capturedAt')
  const ledgerAt = timestamp(ledger.capturedAt, 'workerLedger.capturedAt')
  requireValue(Math.abs(ledgerAt - httpAt) <= 120_000, 'worker ledger capture is outside the allowed readback window')

  return {
    evidenceVersion: '2.0.0',
    evidenceType: 'goal7-h-worker-readback',
    sourceCommit: http.sourceCommit,
    hLiteSourceCommit: http.hLiteSourceCommit,
    capturedAt: new Date(ledgerAt).toISOString(),
    evidenceRef: 'qnap:acceptance/goal7-worker-readback',
    requestIdHash: http.requestIdHash,
    provider: http.provider,
    model: http.model,
    credentialModeTag: http.credentialModeTag,
    productionReady: true,
    usage: http.usage,
    governance: {
      routeKey: http.governance.routeKey,
      retryCount: http.governance.retryCount,
      ledgerRecorded: true,
      routeBEnabled: false,
    },
    rawEvidenceFiles: Object.fromEntries(Object.entries(GOAL7_WORKER_RAW_FILES).map(([key, file]) => [key, { file, sha256: entries[key].sha256 }])),
    publicOutputContainsSensitiveData: false,
  }
}

export async function writeGoal7WorkerReadbackEvidence(bundleRoot, outputFile = path.join(bundleRoot, 'worker-readback.json')) {
  const evidence = await buildGoal7WorkerReadbackEvidence(bundleRoot)
  await fs.writeFile(path.resolve(outputFile), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  return evidence
}

export async function validateGoal7WorkerReadbackEvidence(bundleRoot, evidence) {
  const expected = await buildGoal7WorkerReadbackEvidence(bundleRoot)
  requireValue(isDeepStrictEqual(evidence, expected), 'Goal 7 worker readback is not compiler-derived from bound HTTP and ledger evidence')
  return expected
}
