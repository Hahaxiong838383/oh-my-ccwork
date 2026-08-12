import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const COMMIT = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const VERSION = /^\d{4}-\d{2}-\d{2}\.\d+$/
const MAX_BYTES = 512 * 1024
const SERVICES = Object.freeze(['agentCore', 'knowledgeConnector', 'hLite'])
const CLOSED_CAPABILITIES = Object.freeze([
  'collectorStarted',
  'productionShadowStarted',
  'formalP2Creation',
  'employeeDelivery',
  'erpWriteback',
  'socialWriteback',
  'causalActivation',
])

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function exactKeys(value, keys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  requireValue(isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()), `${label} fields mismatch`)
}

function timestamp(value, label) {
  requireValue(Number.isFinite(Date.parse(String(value || ''))), `${label} timestamp invalid`)
}

function safeAbsolutePath(value, prefix, label) {
  requireValue(typeof value === 'string' && path.isAbsolute(value) && !value.includes('\n') && !value.includes('\r'), `${label} invalid`)
  requireValue(path.normalize(value) === value, `${label} is not normalized`)
  requireValue(value.startsWith(`${prefix}/`), `${label} outside controlled root`)
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

async function readRegular(file, maxBytes = MAX_BYTES) {
  const stat = await fs.lstat(file).catch(() => null)
  requireValue(stat?.isFile() && !stat.isSymbolicLink(), `${path.basename(file)} must be a regular file`)
  requireValue(stat.size > 0 && stat.size <= maxBytes, `${path.basename(file)} size invalid`)
  return fs.readFile(file)
}

async function writeJsonAtomic(outputFile, value) {
  const resolved = path.resolve(outputFile)
  const temporary = `${resolved}.partial-${process.pid}`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fs.chmod(temporary, 0o600)
  await fs.rename(temporary, resolved)
}

export async function goal7RuntimeTreeSha256(root) {
  const entries = []
  async function visit(directory) {
    const names = await fs.readdir(directory, { withFileTypes: true })
    names.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of names) {
      const file = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`runtime tree symlink rejected: ${path.relative(root, file)}`)
      if (entry.isDirectory()) {
        await visit(file)
        continue
      }
      requireValue(entry.isFile(), `runtime tree entry unsupported: ${path.relative(root, file)}`)
      const relative = path.relative(root, file).split(path.sep).join('/')
      entries.push(`${relative}\0${sha256(await fs.readFile(file))}`)
    }
  }
  await visit(root)
  requireValue(entries.length > 0, 'runtime tree is empty')
  return sha256(Buffer.from(entries.join('\n')))
}

function validateClosedCapabilities(value) {
  exactKeys(value, CLOSED_CAPABILITIES, 'closedCapabilities')
  for (const key of CLOSED_CAPABILITIES) requireValue(value[key] === false, `${key} must remain closed`)
}

function validateImage(value, label, runId) {
  exactKeys(value, ['previousTag', 'previousImageId', 'candidateTag', 'candidateImageId'], label)
  requireValue(value.previousTag === `company-ai-foundation-${label}:goal7-pre-${runId}`, `${label} previous tag mismatch`)
  requireValue(value.candidateTag === `company-ai-foundation-${label}:goal7-candidate-${runId}`, `${label} candidate tag mismatch`)
  requireValue(IMAGE_ID.test(value.previousImageId), `${label} previous image id invalid`)
  requireValue(IMAGE_ID.test(value.candidateImageId), `${label} candidate image id invalid`)
}

export function validateGoal7PreparationEvidence(evidence, expected = {}) {
  exactKeys(evidence, [
    'evidenceVersion', 'evidenceType', 'companyQnapIdentity', 'runId', 'preparedAt',
    'sourceCommit', 'hLiteSourceCommit', 'agentCoreVersion', 'knowledgeConnectorVersion',
    'hLiteVersion', 'runtimeRoot', 'runtimeEvidenceRoot', 'backupRoot',
    'runtimeReleaseSha256', 'runtimeComponentVersionsSha256', 'runtimeTreeSha256', 'baselineState',
    'backup', 'images', 'closedCapabilities',
  ], 'preparationEvidence')
  requireValue(evidence.evidenceVersion === '1.0.0', 'preparation evidence version mismatch')
  requireValue(evidence.evidenceType === 'goal7-foundation-preparation', 'preparation evidence type mismatch')
  requireValue(evidence.companyQnapIdentity === 'qnap:company/prnas/TS-X65', 'preparation QNAP identity mismatch')
  requireValue(RUN_ID.test(evidence.runId), 'preparation runId invalid')
  timestamp(evidence.preparedAt, 'preparation preparedAt')
  requireValue(COMMIT.test(evidence.sourceCommit), 'preparation sourceCommit invalid')
  requireValue(COMMIT.test(evidence.hLiteSourceCommit), 'preparation H-Lite sourceCommit invalid')
  if (expected.sourceCommit) requireValue(evidence.sourceCommit === expected.sourceCommit, 'preparation sourceCommit drift')
  if (expected.hLiteSourceCommit) requireValue(evidence.hLiteSourceCommit === expected.hLiteSourceCommit, 'preparation H-Lite sourceCommit drift')
  for (const key of ['agentCoreVersion', 'knowledgeConnectorVersion', 'hLiteVersion']) {
    requireValue(VERSION.test(evidence[key]), `preparation ${key} invalid`)
  }
  safeAbsolutePath(evidence.runtimeRoot, '/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence/foundation-releases', 'preparation runtimeRoot')
  safeAbsolutePath(evidence.runtimeEvidenceRoot, '/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence/release', 'preparation runtimeEvidenceRoot')
  safeAbsolutePath(evidence.backupRoot, '/share/CACHEDEV2_DATA/ai-ontology-backup/goal7', 'preparation backupRoot')
  requireValue(HASH.test(evidence.runtimeReleaseSha256), 'preparation runtime release hash invalid')
  requireValue(HASH.test(evidence.runtimeComponentVersionsSha256), 'preparation runtime component hash invalid')
  requireValue(HASH.test(evidence.runtimeTreeSha256), 'preparation runtime tree hash invalid')
  exactKeys(evidence.baselineState, ['file', 'sha256'], 'preparation baselineState')
  requireValue(evidence.baselineState.file === 'preparation-baseline-state.json', 'preparation baseline file mismatch')
  requireValue(HASH.test(evidence.baselineState.sha256), 'preparation baseline hash invalid')
  exactKeys(evidence.backup, ['envSha256', 'composeSha256'], 'preparation backup')
  requireValue(HASH.test(evidence.backup.envSha256), 'preparation env backup hash invalid')
  requireValue(HASH.test(evidence.backup.composeSha256), 'preparation compose backup hash invalid')
  exactKeys(evidence.images, SERVICES, 'preparation images')
  validateImage(evidence.images.agentCore, 'agent-core', evidence.runId)
  validateImage(evidence.images.knowledgeConnector, 'knowledge-connector', evidence.runId)
  validateImage(evidence.images.hLite, 'h-lite', evidence.runId)
  validateClosedCapabilities(evidence.closedCapabilities)
  return evidence
}

export async function validateGoal7PreparationBundle(root, expected = {}) {
  const resolvedRoot = path.resolve(root)
  const evidenceBytes = await readRegular(path.join(resolvedRoot, 'preparation-evidence.json'))
  const evidence = validateGoal7PreparationEvidence(JSON.parse(evidenceBytes.toString('utf8')), expected)
  const baselineBytes = await readRegular(path.join(resolvedRoot, evidence.baselineState.file))
  requireValue(sha256(baselineBytes) === evidence.baselineState.sha256, 'preparation baseline state drift')
  const releaseBytes = await readRegular(path.join(evidence.runtimeEvidenceRoot, 'SHA256SUMS'))
  requireValue(sha256(releaseBytes) === evidence.runtimeReleaseSha256, 'preparation runtime release drift')
  const versionsBytes = await readRegular(path.join(evidence.runtimeEvidenceRoot, 'runtime-component-versions.json'))
  requireValue(sha256(versionsBytes) === evidence.runtimeComponentVersionsSha256, 'preparation runtime component versions drift')
  requireValue(await goal7RuntimeTreeSha256(evidence.runtimeRoot) === evidence.runtimeTreeSha256, 'preparation runtime tree drift')
  return { evidence, evidenceSha256: sha256(evidenceBytes) }
}

export async function writeGoal7PreparationEvidence(outputFile, input) {
  const evidence = validateGoal7PreparationEvidence({
    evidenceVersion: '1.0.0',
    evidenceType: 'goal7-foundation-preparation',
    companyQnapIdentity: 'qnap:company/prnas/TS-X65',
    runId: input.runId,
    preparedAt: input.preparedAt || new Date().toISOString(),
    sourceCommit: input.sourceCommit,
    hLiteSourceCommit: input.hLiteSourceCommit,
    agentCoreVersion: input.agentCoreVersion,
    knowledgeConnectorVersion: input.knowledgeConnectorVersion,
    hLiteVersion: input.hLiteVersion,
    runtimeRoot: input.runtimeRoot,
    runtimeEvidenceRoot: input.runtimeEvidenceRoot,
    backupRoot: input.backupRoot,
    runtimeReleaseSha256: input.runtimeReleaseSha256,
    runtimeComponentVersionsSha256: input.runtimeComponentVersionsSha256,
    runtimeTreeSha256: input.runtimeTreeSha256 || await goal7RuntimeTreeSha256(input.runtimeRoot),
    baselineState: { file: 'preparation-baseline-state.json', sha256: input.baselineStateSha256 },
    backup: { envSha256: input.backupEnvSha256, composeSha256: input.backupComposeSha256 },
    images: input.images,
    closedCapabilities: Object.fromEntries(CLOSED_CAPABILITIES.map((key) => [key, false])),
  }, { sourceCommit: input.sourceCommit, hLiteSourceCommit: input.hLiteSourceCommit })
  await writeJsonAtomic(outputFile, evidence)
  return evidence
}

export function validateGoal7MigrationEvidence(evidence, expected = {}) {
  exactKeys(evidence, [
    'evidenceVersion', 'evidenceType', 'companyQnapIdentity', 'runId', 'appliedAt',
    'sourceCommit', 'hLiteSourceCommit', 'preparationEvidence', 'migrationFileSha256',
    'checks', 'closedCapabilities',
  ], 'migrationEvidence')
  requireValue(evidence.evidenceVersion === '1.0.0', 'migration evidence version mismatch')
  requireValue(evidence.evidenceType === 'goal7-migration-012', 'migration evidence type mismatch')
  requireValue(evidence.companyQnapIdentity === 'qnap:company/prnas/TS-X65', 'migration QNAP identity mismatch')
  requireValue(RUN_ID.test(evidence.runId), 'migration runId invalid')
  timestamp(evidence.appliedAt, 'migration appliedAt')
  requireValue(COMMIT.test(evidence.sourceCommit), 'migration sourceCommit invalid')
  requireValue(COMMIT.test(evidence.hLiteSourceCommit), 'migration H-Lite sourceCommit invalid')
  if (expected.sourceCommit) requireValue(evidence.sourceCommit === expected.sourceCommit, 'migration sourceCommit drift')
  if (expected.hLiteSourceCommit) requireValue(evidence.hLiteSourceCommit === expected.hLiteSourceCommit, 'migration H-Lite sourceCommit drift')
  exactKeys(evidence.preparationEvidence, ['file', 'sha256'], 'migration preparationEvidence')
  requireValue(evidence.preparationEvidence.file === 'preparation-evidence.json', 'migration preparation file mismatch')
  requireValue(HASH.test(evidence.preparationEvidence.sha256), 'migration preparation hash invalid')
  if (expected.preparationEvidenceSha256) requireValue(evidence.preparationEvidence.sha256 === expected.preparationEvidenceSha256, 'migration preparation evidence drift')
  requireValue(HASH.test(evidence.migrationFileSha256), 'migration file hash invalid')
  exactKeys(evidence.checks, [
    'tableCount', 'forcedRlsCount', 'tenantPolicyCount', 'appPrivilegeCount',
    'deletePrivilegeCount', 'bannedColumnCount', 'appRoleReadVerified',
  ], 'migration checks')
  requireValue(evidence.checks.tableCount === 4, 'migration table count mismatch')
  requireValue(evidence.checks.forcedRlsCount === 4, 'migration forced RLS count mismatch')
  requireValue(evidence.checks.tenantPolicyCount === 4, 'migration tenant policy count mismatch')
  requireValue(evidence.checks.appPrivilegeCount === 10, 'migration application privilege count mismatch')
  requireValue(evidence.checks.deletePrivilegeCount === 0, 'migration DELETE privilege must remain zero')
  requireValue(evidence.checks.bannedColumnCount === 0, 'migration banned columns detected')
  requireValue(evidence.checks.appRoleReadVerified === true, 'migration ontology_app read verification missing')
  validateClosedCapabilities(evidence.closedCapabilities)
  return evidence
}

export async function validateGoal7MigrationBundle(root, expected = {}) {
  const resolvedRoot = path.resolve(root)
  const preparation = await validateGoal7PreparationBundle(resolvedRoot, expected)
  const evidenceBytes = await readRegular(path.join(resolvedRoot, 'migration-012-evidence.json'))
  const evidence = validateGoal7MigrationEvidence(JSON.parse(evidenceBytes.toString('utf8')), {
    ...expected,
    preparationEvidenceSha256: preparation.evidenceSha256,
  })
  const migrationBytes = await readRegular(path.join(preparation.evidence.runtimeRoot, 'company-ai-ontology/deploy/qnap/candidate-migrations/012-goal7-authority-runtime.sql'), 2 * 1024 * 1024)
  requireValue(sha256(migrationBytes) === evidence.migrationFileSha256, 'migration SQL drift')
  return { preparation, evidence, evidenceSha256: sha256(evidenceBytes) }
}

export async function writeGoal7MigrationEvidence(outputFile, input) {
  const evidence = validateGoal7MigrationEvidence({
    evidenceVersion: '1.0.0',
    evidenceType: 'goal7-migration-012',
    companyQnapIdentity: 'qnap:company/prnas/TS-X65',
    runId: input.runId,
    appliedAt: input.appliedAt || new Date().toISOString(),
    sourceCommit: input.sourceCommit,
    hLiteSourceCommit: input.hLiteSourceCommit,
    preparationEvidence: { file: 'preparation-evidence.json', sha256: input.preparationEvidenceSha256 },
    migrationFileSha256: input.migrationFileSha256,
    checks: input.checks,
    closedCapabilities: Object.fromEntries(CLOSED_CAPABILITIES.map((key) => [key, false])),
  }, {
    sourceCommit: input.sourceCommit,
    hLiteSourceCommit: input.hLiteSourceCommit,
    preparationEvidenceSha256: input.preparationEvidenceSha256,
  })
  await writeJsonAtomic(outputFile, evidence)
  return evidence
}
