import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const COMMIT = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const VERSION = /^\d{4}-\d{2}-\d{2}\.\d+$/
const MAX_JSON_BYTES = 1024 * 1024
const REQUIRED_FILES = Object.freeze([
  'runtime-verification.json',
  'postgres-validation.txt',
  'goal7-foundation-validation.txt',
  'release-manifest.json',
  'runtime-component-versions.json',
  'source.tar.gz',
  'h-lite-source.tar.gz',
  'collector-image.tar.gz',
])

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

async function readRegularFile(root, name, maxBytes = Number.POSITIVE_INFINITY) {
  requireValue(path.basename(name) === name, `runtime release path is unsafe: ${name}`)
  const file = path.join(root, name)
  const stat = await fs.lstat(file).catch(() => null)
  requireValue(stat?.isFile() && !stat.isSymbolicLink(), `runtime release file missing or unsafe: ${name}`)
  requireValue(stat.size <= maxBytes, `runtime release file too large: ${name}`)
  return fs.readFile(file)
}

function parseChecksums(bytes) {
  const entries = new Map()
  const lines = bytes.toString('utf8').trim().split('\n').filter(Boolean)
  requireValue(lines.length > 0, 'runtime release SHA256SUMS is empty')
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64}) [ *]([A-Za-z0-9._-]+)$/)
    requireValue(match, 'runtime release SHA256SUMS contains an invalid entry')
    requireValue(!entries.has(match[2]), `runtime release SHA256SUMS duplicates ${match[2]}`)
    entries.set(match[2], match[1])
  }
  return entries
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

export async function validateGoal7RuntimeRelease(root, expected = {}) {
  const resolvedRoot = path.resolve(root)
  const checksumBytes = await readRegularFile(resolvedRoot, 'SHA256SUMS', MAX_JSON_BYTES)
  const checksums = parseChecksums(checksumBytes)
  for (const name of REQUIRED_FILES) requireValue(checksums.has(name), `runtime release checksum missing: ${name}`)

  const files = new Map()
  for (const [name, expectedHash] of checksums) {
    const bytes = await readRegularFile(resolvedRoot, name)
    requireValue(sha256(bytes) === expectedHash, `runtime release checksum mismatch: ${name}`)
    files.set(name, bytes)
  }

  const verification = parseJson(files.get('runtime-verification.json'), 'runtime verification')
  requireValue(verification.evidenceVersion === '1.0.0', 'runtime verification evidenceVersion mismatch')
  requireValue(verification.verificationType === 'P1-SI-F-linux-amd64-runtime', 'runtime verification type mismatch')
  requireValue(COMMIT.test(String(verification.sourceCommit || '')), 'runtime verification sourceCommit invalid')
  requireValue(COMMIT.test(String(verification.hLiteSourceCommit || '')), 'runtime verification hLiteSourceCommit invalid')
  requireValue(VERSION.test(String(verification.agentCoreVersion || '')), 'runtime verification agentCoreVersion invalid')
  requireValue(VERSION.test(String(verification.knowledgeConnectorVersion || '')), 'runtime verification knowledgeConnectorVersion invalid')
  requireValue(VERSION.test(String(verification.hLiteVersion || '')), 'runtime verification hLiteVersion invalid')
  requireValue(verification.immutableReleaseCandidateVerified === true, 'runtime release is not immutable-verified')
  requireValue(verification.companyQnapDeployed === false, 'runtime release incorrectly claims company QNAP deployment')
  requireValue(verification.publish === false, 'runtime release publish must remain false')
  requireValue(verification.routeBState === 'disabled', 'runtime release Route B must remain disabled')
  requireValue(verification.goal7AuthorityRuntimeFoundation === 'verified', 'runtime release Goal 7 foundation is not verified')

  if (expected.sourceCommit !== undefined) {
    requireValue(COMMIT.test(expected.sourceCommit), 'approved Ontology sourceCommit invalid')
    requireValue(verification.sourceCommit === expected.sourceCommit, 'approved Ontology sourceCommit drift')
  }
  if (expected.hLiteSourceCommit !== undefined) {
    requireValue(COMMIT.test(expected.hLiteSourceCommit), 'approved H-Lite sourceCommit invalid')
    requireValue(verification.hLiteSourceCommit === expected.hLiteSourceCommit, 'approved H-Lite sourceCommit drift')
  }

  const hashBindings = [
    ['source.tar.gz', 'sourceArchiveSha256'],
    ['h-lite-source.tar.gz', 'hLiteSourceArchiveSha256'],
    ['collector-image.tar.gz', 'collectorImageArchiveSha256'],
    ['release-manifest.json', 'releaseManifestSha256'],
    ['runtime-component-versions.json', 'runtimeComponentVersionsSha256'],
    ['postgres-validation.txt', 'postgresEvidenceSha256'],
    ['goal7-foundation-validation.txt', 'goal7FoundationEvidenceSha256'],
  ]
  for (const [name, field] of hashBindings) {
    requireValue(HASH.test(String(verification[field] || '')), `runtime verification ${field} invalid`)
    requireValue(sha256(files.get(name)) === verification[field], `runtime verification ${field} drift`)
  }

  const releaseManifest = parseJson(files.get('release-manifest.json'), 'release manifest')
  requireValue(releaseManifest.manifestVersion === '1.5.0', 'release manifest version mismatch')
  requireValue(releaseManifest.releaseType === 'P1-SI-F-shadow-candidate-gated', 'release manifest type mismatch')
  requireValue(releaseManifest.sourceCommit === verification.sourceCommit, 'release manifest sourceCommit drift')
  requireValue(releaseManifest.hLiteSourceCommit === verification.hLiteSourceCommit, 'release manifest hLiteSourceCommit drift')
  requireValue(releaseManifest.sourceArchiveSha256 === verification.sourceArchiveSha256, 'release manifest source archive drift')
  requireValue(releaseManifest.hLiteSourceArchiveSha256 === verification.hLiteSourceArchiveSha256, 'release manifest H-Lite source archive drift')
  requireValue(releaseManifest.collectorImageArchiveSha256 === verification.collectorImageArchiveSha256, 'release manifest collector archive drift')
  requireValue(releaseManifest.runtimeComponentVersionsSha256 === verification.runtimeComponentVersionsSha256, 'release manifest runtime component versions drift')
  for (const key of ['agentCoreVersion', 'knowledgeConnectorVersion', 'hLiteVersion']) {
    requireValue(releaseManifest[key] === verification[key], `release manifest ${key} drift`)
  }
  requireValue(releaseManifest.publish === false, 'release manifest publish must remain false')
  requireValue(releaseManifest.productionDeploymentAuthorized === false, 'release manifest must not self-authorize production')
  requireValue(releaseManifest.requiredGate === 'WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH', 'release manifest deployment gate mismatch')
  requireValue(releaseManifest.goal7Migration012Mode === 'pre_existing_reconciliation_only', 'release manifest migration 012 mode mismatch')
  requireValue(releaseManifest.goal7Migration012SqlReplayAllowed === false, 'release manifest must forbid migration 012 SQL replay')

  const versions = parseJson(files.get('runtime-component-versions.json'), 'runtime component versions')
  requireValue(versions.evidenceVersion === '1.0.0', 'runtime component versions evidenceVersion mismatch')
  requireValue(versions.evidenceType === 'goal7-runtime-component-versions', 'runtime component versions type mismatch')
  requireValue(versions.sourceCommit === verification.sourceCommit, 'runtime component versions sourceCommit drift')
  requireValue(versions.hLiteSourceCommit === verification.hLiteSourceCommit, 'runtime component versions hLiteSourceCommit drift')
  for (const key of ['agentCoreVersion', 'knowledgeConnectorVersion', 'hLiteVersion']) {
    requireValue(VERSION.test(String(versions[key] || '')), `runtime component versions ${key} invalid`)
    requireValue(versions[key] === verification[key], `runtime component versions ${key} drift`)
  }

  return {
    sourceCommit: verification.sourceCommit,
    hLiteSourceCommit: verification.hLiteSourceCommit,
    agentCoreVersion: verification.agentCoreVersion,
    knowledgeConnectorVersion: verification.knowledgeConnectorVersion,
    hLiteVersion: verification.hLiteVersion,
    hLiteSourceArchiveSha256: verification.hLiteSourceArchiveSha256,
    checksumEntryCount: checksums.size,
  }
}
