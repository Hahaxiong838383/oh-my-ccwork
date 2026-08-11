#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

const stdoutFile = argument('--collector-stdout')
const stderrFile = argument('--collector-stderr')
const stateRoot = argument('--state-root')
const reportRoot = argument('--report-root')
const preLastGoodFile = argument('--pre-last-good')
const revocationFile = argument('--revocation-evidence')
const sideEffectFile = argument('--side-effect-evidence')
const outputFile = argument('--output')
const domainBatchFile = argument('--domain-batch')
const domainStderrFile = argument('--domain-stderr')
for (const [name, value] of Object.entries({ stdoutFile, stderrFile, stateRoot, reportRoot, preLastGoodFile, revocationFile, sideEffectFile, outputFile, domainBatchFile, domainStderrFile })) {
  if (!value) throw new Error(`${name} is required`)
}

async function optionalBytes(file) {
  try {
    return await fs.readFile(path.resolve(file))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function requiredJson(file) {
  return JSON.parse(await fs.readFile(path.resolve(file), 'utf8'))
}

async function cliResult() {
  for (const file of [stdoutFile, stderrFile]) {
    const bytes = await optionalBytes(file)
    if (!bytes) continue
    for (const line of bytes.toString('utf8').trim().split(/\n/).filter(Boolean).reverse()) {
      try {
        const value = JSON.parse(line)
        if (typeof value.runId === 'string') return value
      } catch {}
    }
  }
  throw new Error('collector runId is unavailable')
}

const forbiddenKeys = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'password', 'passwd',
  'api_key', 'apikey', 'access_token', 'accesstoken', 'refresh_token', 'refreshtoken',
  'app_secret', 'appsecret', 'client_secret', 'clientsecret',
])
const secretValuePatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/,
  /\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{16,}/,
]

function sensitiveCount(value, key = '') {
  if (key === 'bodyBase64') return 0
  if (Array.isArray(value)) return value.reduce((total, entry) => total + sensitiveCount(entry), 0)
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((total, [childKey, childValue]) => {
      const normalized = childKey.toLowerCase().replace(/[^a-z0-9_-]/g, '')
      const keyHit = forbiddenKeys.has(normalized) && childValue !== null && String(childValue).length > 0 ? 1 : 0
      return total + keyHit + sensitiveCount(childValue, childKey)
    }, 0)
  }
  if (typeof value === 'string' && secretValuePatterns.some((pattern) => pattern.test(value))) return 1
  return 0
}

const cli = await cliResult()
const runId = cli.runId
const runDir = path.resolve(stateRoot, 'runs', runId)
const scanFiles = [
  stdoutFile,
  stderrFile,
  domainStderrFile,
  path.join(runDir, 'run.json'),
  path.join(runDir, 'items.json'),
  path.join(runDir, 'source-decisions.json'),
  path.resolve(reportRoot, `candidate-${runId}.json`),
  path.resolve(stateRoot, 'last-good.json'),
  domainBatchFile,
]
for (const name of await fs.readdir(path.join(runDir, 'raw')).catch(() => [])) scanFiles.push(path.join(runDir, 'raw', name))

let unredactedSensitiveOutputCount = 0
let filesScanned = 0
for (const file of scanFiles) {
  const bytes = await optionalBytes(file)
  if (!bytes) continue
  filesScanned += 1
  const text = bytes.toString('utf8')
  try {
    unredactedSensitiveOutputCount += sensitiveCount(JSON.parse(text))
  } catch {
    unredactedSensitiveOutputCount += secretValuePatterns.filter((pattern) => pattern.test(text)).length
  }
}

const [preLastGood, revocation, sideEffects] = await Promise.all([
  requiredJson(preLastGoodFile),
  requiredJson(revocationFile),
  requiredJson(sideEffectFile),
])
if (revocation.completed !== true || revocation.reasonCode !== 'SOURCE_POLICY_DENIED' || revocation.networkMode !== 'none') {
  throw new Error('source revocation audit is incomplete')
}
if (sideEffects.completed !== true) throw new Error('business side effect audit is incomplete')

const lastGoodBytes = await optionalBytes(path.resolve(stateRoot, 'last-good.json'))
let lastGoodPreserved = false
if (cli.ok === true) {
  const lastGood = lastGoodBytes ? JSON.parse(lastGoodBytes.toString('utf8')) : null
  lastGoodPreserved = lastGood?.runId === runId
} else if (preLastGood.present === true) {
  lastGoodPreserved = Boolean(lastGoodBytes) && createHash('sha256').update(lastGoodBytes).digest('hex') === preLastGood.sha256
} else {
  lastGoodPreserved = lastGoodBytes === null
}

const numericSideEffects = {}
for (const key of ['formalP2Count', 'employeeDeliveryCount', 'erpWritebackCount', 'socialWritebackCount', 'causalActivationCount']) {
  const value = Number(sideEffects[key])
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${key}`)
  numericSideEffects[key] = value
}
const effectiveSeconds = Number(revocation.effectiveSeconds)
const postRevocationNetworkRequestCount = Number(revocation.postRevocationNetworkRequestCount)
if (!Number.isSafeInteger(effectiveSeconds) || effectiveSeconds < 0) throw new Error('invalid source revocation effective seconds')
if (!Number.isSafeInteger(postRevocationNetworkRequestCount) || postRevocationNetworkRequestCount < 0) {
  throw new Error('invalid post-revocation request count')
}

const audit = {
  auditVersion: '1.0.0',
  runId,
  auditCompleted: true,
  filesScanned,
  unredactedSensitiveOutputCount,
  sensitiveOutputAuditCompleted: true,
  sourceRevocationEffectiveSeconds: effectiveSeconds,
  postRevocationNetworkRequestCount,
  sourceRevocationAuditCompleted: true,
  businessSideEffectAuditCompleted: true,
  lastGoodPreserved,
  sideEffects: numericSideEffects,
}
await fs.mkdir(path.dirname(path.resolve(outputFile)), { recursive: true, mode: 0o750 })
await fs.writeFile(path.resolve(outputFile), `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 })
