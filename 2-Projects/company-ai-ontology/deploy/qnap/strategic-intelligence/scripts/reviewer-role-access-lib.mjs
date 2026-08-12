import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'

export const REVIEWER_ROLE_SESSION_FILES = Object.freeze({
  product_user: 'reviewer-role-session-product-user.json',
  ai_rd: 'reviewer-role-session-ai-rd.json',
  brand: 'reviewer-role-session-brand.json',
  toc_offline_channel: 'reviewer-role-session-toc-offline-channel.json',
})
export const REVIEWER_ROLE_OWNER_FILE = 'reviewer-role-security-owner-acceptance.json'

const ROLE_SPECS = Object.freeze({
  product_user: { categories: ['ai_technology', 'channel_sales_competition', 'children_user_scenario', 'privacy_safety_compliance', 'product_definition'], editableRecordCount: 30, deniedRecordCount: 6 },
  ai_rd: { categories: ['ai_technology', 'children_user_scenario', 'product_definition'], editableRecordCount: 18, deniedRecordCount: 18 },
  brand: { categories: ['channel_sales_competition'], editableRecordCount: 6, deniedRecordCount: 30 },
  toc_offline_channel: { categories: ['channel_sales_competition'], editableRecordCount: 6, deniedRecordCount: 30 },
})
const RESULT_KEYS = Object.freeze([
  'authenticatedAsAssignedMember', 'assignedCategoryEditSucceeded', 'unassignedCategoryEditDenied',
  'sourceTableAccessDenied', 'recordCreateDenied', 'recordDeleteDenied', 'copyDenied',
  'downloadDenied', 'viewMutationDenied', 'temporaryEditReverted',
])
const HASH = /^[a-f0-9]{64}$/
const REFERENCE = /^(feishu:|ontology:|qnap:)\S+$/
const MAX_BYTES = 128 * 1024

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function exactKeys(value, keys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  requireValue(isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()), `${label} fields mismatch`)
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function timestamp(value, label) {
  const parsed = Date.parse(String(value || ''))
  requireValue(Number.isFinite(parsed), `${label} timestamp invalid`)
  return parsed
}

function principal(value, label) {
  exactKeys(value, ['role', 'displayName', 'principalRef', 'decision'], label)
  requireValue(typeof value.role === 'string' && value.role.length > 0, `${label}.role invalid`)
  requireValue(typeof value.displayName === 'string' && value.displayName.trim().length >= 2, `${label}.displayName invalid`)
  requireValue(/^company-directory:[A-Za-z0-9._-]+$/.test(String(value.principalRef || '')), `${label}.principalRef invalid`)
  requireValue(value.decision === 'approve', `${label}.decision invalid`)
}

async function readRaw(root, file) {
  const target = path.join(root, file)
  const stat = await fs.lstat(target).catch(() => null)
  requireValue(stat?.isFile() && !stat.isSymbolicLink(), `reviewer role raw evidence missing or unsafe: ${file}`)
  requireValue(stat.size <= MAX_BYTES, `reviewer role raw evidence too large: ${file}`)
  const bytes = await fs.readFile(target)
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(`reviewer role raw evidence is not valid JSON: ${file}`)
  }
  return { file, bytes, sha256: sha256(bytes), value }
}

function validateRoleSession(value, roleKey) {
  exactKeys(value, [
    'evidenceVersion', 'evidenceType', 'workbenchKey', 'roleKey', 'testedAt',
    'memberPrincipal', 'evidenceRef', 'expectedEditableCategories',
    'expectedEditableRecordCount', 'expectedDeniedRecordCount', 'results',
    'publicOutputContainsSensitiveData',
  ], `${roleKey}Session`)
  requireValue(value.evidenceVersion === '1.0.0', `${roleKey} evidenceVersion mismatch`)
  requireValue(value.evidenceType === 'reviewer-role-member-session', `${roleKey} evidenceType mismatch`)
  requireValue(value.workbenchKey === 'P1-SI-HUMAN-REVIEW', `${roleKey} workbenchKey mismatch`)
  requireValue(value.roleKey === roleKey, `${roleKey} roleKey mismatch`)
  timestamp(value.testedAt, `${roleKey}.testedAt`)
  principal(value.memberPrincipal, `${roleKey}.memberPrincipal`)
  requireValue(REFERENCE.test(String(value.evidenceRef || '')), `${roleKey}.evidenceRef invalid`)
  const spec = ROLE_SPECS[roleKey]
  requireValue(Array.isArray(value.expectedEditableCategories) && isDeepStrictEqual([...value.expectedEditableCategories].sort(), spec.categories), `${roleKey}.expectedEditableCategories mismatch`)
  requireValue(value.expectedEditableRecordCount === spec.editableRecordCount, `${roleKey}.expectedEditableRecordCount mismatch`)
  requireValue(value.expectedDeniedRecordCount === spec.deniedRecordCount, `${roleKey}.expectedDeniedRecordCount mismatch`)
  exactKeys(value.results, RESULT_KEYS, `${roleKey}.results`)
  for (const key of RESULT_KEYS) requireValue(value.results[key] === true, `${roleKey}.${key} must be true`)
  requireValue(value.publicOutputContainsSensitiveData === false, `${roleKey} public output contains sensitive data`)
}

function validateOwner(value, roleEntries) {
  exactKeys(value, [
    'evidenceVersion', 'evidenceType', 'workbenchKey', 'accepted', 'acceptedAt',
    'securityOwner', 'acceptanceRef', 'roleSessionHashes', 'publicOutputContainsSensitiveData',
  ], 'securityOwnerAcceptance')
  requireValue(value.evidenceVersion === '1.0.0', 'security owner evidenceVersion mismatch')
  requireValue(value.evidenceType === 'reviewer-role-security-owner-acceptance', 'security owner evidenceType mismatch')
  requireValue(value.workbenchKey === 'P1-SI-HUMAN-REVIEW', 'security owner workbenchKey mismatch')
  requireValue(value.accepted === true, 'security owner acceptance missing')
  const acceptedAt = timestamp(value.acceptedAt, 'securityOwner.acceptedAt')
  principal(value.securityOwner, 'securityOwner')
  requireValue(REFERENCE.test(String(value.acceptanceRef || '')), 'security owner acceptanceRef invalid')
  exactKeys(value.roleSessionHashes, Object.keys(REVIEWER_ROLE_SESSION_FILES), 'roleSessionHashes')
  for (const [roleKey, entry] of Object.entries(roleEntries)) {
    requireValue(HASH.test(String(value.roleSessionHashes[roleKey] || '')), `${roleKey} accepted hash invalid`)
    requireValue(value.roleSessionHashes[roleKey] === entry.sha256, `${roleKey} session hash was not accepted`)
    requireValue(acceptedAt >= timestamp(entry.value.testedAt, `${roleKey}.testedAt`), 'security owner acceptance predates member session')
  }
  requireValue(value.publicOutputContainsSensitiveData === false, 'security owner public output contains sensitive data')
}

export async function buildReviewerRoleAccessAcceptance(bundleRoot) {
  const roleEntries = {}
  for (const [roleKey, file] of Object.entries(REVIEWER_ROLE_SESSION_FILES)) {
    const entry = await readRaw(bundleRoot, file)
    validateRoleSession(entry.value, roleKey)
    roleEntries[roleKey] = entry
  }
  const principalRefs = Object.values(roleEntries).map((entry) => entry.value.memberPrincipal.principalRef)
  requireValue(new Set(principalRefs).size === principalRefs.length, 'reviewer role sessions must use four distinct members')
  const owner = await readRaw(bundleRoot, REVIEWER_ROLE_OWNER_FILE)
  validateOwner(owner.value, roleEntries)

  const roleTests = Object.entries(roleEntries).map(([roleKey, entry]) => ({
    roleKey,
    expectedEditableCategories: entry.value.expectedEditableCategories,
    expectedEditableRecordCount: entry.value.expectedEditableRecordCount,
    expectedDeniedRecordCount: entry.value.expectedDeniedRecordCount,
    memberPrincipal: entry.value.memberPrincipal,
    testedAt: entry.value.testedAt,
    evidenceRefs: [entry.value.evidenceRef],
    ...entry.value.results,
  }))
  return {
    evidenceVersion: '2.0.0',
    evidenceType: 'reviewer-role-access-acceptance',
    workbenchKey: 'P1-SI-HUMAN-REVIEW',
    status: 'complete',
    memberExperienceVerified: true,
    securityOwnerAccepted: true,
    acceptedAt: owner.value.acceptedAt,
    securityOwner: owner.value.securityOwner,
    ownerAcceptanceRef: owner.value.acceptanceRef,
    evidenceRefs: [...roleTests.map((entry) => entry.evidenceRefs[0]), owner.value.acceptanceRef],
    categoryFieldType: 'SingleSelect',
    allFiltersValid: true,
    legacyBroadRoleMemberCount: 0,
    publicOutputContainsSensitiveData: false,
    roleTests,
    rawEvidenceFiles: {
      ...Object.fromEntries(Object.entries(roleEntries).map(([roleKey, entry]) => [roleKey, { file: entry.file, sha256: entry.sha256 }])),
      owner: { file: owner.file, sha256: owner.sha256 },
    },
  }
}

export async function writeReviewerRoleAccessAcceptance(bundleRoot, outputFile = path.join(bundleRoot, 'reviewer-role-access-acceptance.json')) {
  const acceptance = await buildReviewerRoleAccessAcceptance(bundleRoot)
  await fs.writeFile(path.resolve(outputFile), `${JSON.stringify(acceptance, null, 2)}\n`, { mode: 0o600 })
  return acceptance
}

export async function validateReviewerRoleAccessAcceptance(acceptanceFile) {
  const resolved = path.resolve(acceptanceFile)
  const bytes = await fs.readFile(resolved)
  const acceptance = JSON.parse(bytes.toString('utf8'))
  const expected = await buildReviewerRoleAccessAcceptance(path.dirname(resolved))
  requireValue(isDeepStrictEqual(acceptance, expected), 'reviewer role access acceptance is not compiler-derived from bound member sessions')
  return { acceptance, evidenceHash: sha256(bytes) }
}
