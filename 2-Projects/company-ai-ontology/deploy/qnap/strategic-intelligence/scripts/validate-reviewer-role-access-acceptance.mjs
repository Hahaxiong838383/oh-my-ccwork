#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const acceptanceFile = process.argv[2]
if (!acceptanceFile) throw new Error('reviewer role access acceptance file is required')

const acceptance = JSON.parse(await fs.readFile(path.resolve(acceptanceFile), 'utf8'))
const errors = []
const referencePattern = /^(feishu:|git:|ontology:|qnap:|https:\/\/)\S+$/
const expectedRoles = new Map([
  ['product_user', {
    categories: ['ai_technology', 'channel_sales_competition', 'children_user_scenario', 'privacy_safety_compliance', 'product_definition'],
    editableRecordCount: 30,
    deniedRecordCount: 6,
  }],
  ['ai_rd', {
    categories: ['ai_technology', 'children_user_scenario', 'product_definition'],
    editableRecordCount: 18,
    deniedRecordCount: 18,
  }],
  ['brand', {
    categories: ['channel_sales_competition'],
    editableRecordCount: 6,
    deniedRecordCount: 30,
  }],
  ['toc_offline_channel', {
    categories: ['channel_sales_competition'],
    editableRecordCount: 6,
    deniedRecordCount: 30,
  }],
])

function requireValue(condition, message) {
  if (!condition) errors.push(message)
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validPrincipal(value) {
  return Boolean(
    value
    && typeof value.displayName === 'string'
    && value.displayName.trim().length >= 2
    && typeof value.principalRef === 'string'
    && /^company-directory:[A-Za-z0-9._-]+$/.test(value.principalRef),
  )
}

function validReferences(values) {
  return Array.isArray(values) && values.length > 0 && values.every((value) => referencePattern.test(String(value)))
}

requireValue(acceptance.evidenceVersion === '1.0.0', 'evidenceVersion mismatch')
requireValue(acceptance.workbenchKey === 'P1-SI-HUMAN-REVIEW', 'workbenchKey mismatch')
requireValue(acceptance.status === 'complete', 'status must be complete')
requireValue(acceptance.memberExperienceVerified === true, 'memberExperienceVerified must be true')
requireValue(acceptance.securityOwnerAccepted === true, 'securityOwnerAccepted must be true')
requireValue(validTimestamp(acceptance.acceptedAt), 'acceptedAt invalid')
requireValue(validPrincipal(acceptance.securityOwner), 'securityOwner invalid')
requireValue(referencePattern.test(String(acceptance.ownerAcceptanceRef || '')), 'ownerAcceptanceRef invalid')
requireValue(validReferences(acceptance.evidenceRefs), 'evidenceRefs invalid')
requireValue(acceptance.categoryFieldType === 'SingleSelect', 'categoryFieldType must be SingleSelect')
requireValue(acceptance.allFiltersValid === true, 'allFiltersValid must be true')
requireValue(acceptance.legacyBroadRoleMemberCount === 0, 'legacyBroadRoleMemberCount must be zero')
requireValue(acceptance.publicOutputContainsSensitiveData === false, 'publicOutputContainsSensitiveData must be false')

const roleTests = Array.isArray(acceptance.roleTests) ? acceptance.roleTests : []
requireValue(roleTests.length === expectedRoles.size, 'roleTests must cover every scoped role')
const seenRoleKeys = new Set()
for (const test of roleTests) {
  const roleKey = test?.roleKey
  requireValue(expectedRoles.has(roleKey), 'roleTests contains unknown role')
  requireValue(!seenRoleKeys.has(roleKey), 'roleTests contains duplicate role')
  seenRoleKeys.add(roleKey)
  const expected = expectedRoles.get(roleKey)
  if (!expected) continue
  const actualCategories = Array.isArray(test.expectedEditableCategories)
    ? [...test.expectedEditableCategories].sort()
    : []
  requireValue(JSON.stringify(actualCategories) === JSON.stringify(expected.categories), `${roleKey}.expectedEditableCategories mismatch`)
  requireValue(test.expectedEditableRecordCount === expected.editableRecordCount, `${roleKey}.expectedEditableRecordCount mismatch`)
  requireValue(test.expectedDeniedRecordCount === expected.deniedRecordCount, `${roleKey}.expectedDeniedRecordCount mismatch`)
  requireValue(validPrincipal(test.memberPrincipal), `${roleKey}.memberPrincipal invalid`)
  requireValue(validTimestamp(test.testedAt), `${roleKey}.testedAt invalid`)
  requireValue(validReferences(test.evidenceRefs), `${roleKey}.evidenceRefs invalid`)
  for (const key of [
    'authenticatedAsAssignedMember',
    'assignedCategoryEditSucceeded',
    'unassignedCategoryEditDenied',
    'sourceTableAccessDenied',
    'recordCreateDenied',
    'recordDeleteDenied',
    'copyDenied',
    'downloadDenied',
    'viewMutationDenied',
    'temporaryEditReverted',
  ]) {
    requireValue(test[key] === true, `${roleKey}.${key} must be true`)
  }
}
for (const roleKey of expectedRoles.keys()) requireValue(seenRoleKeys.has(roleKey), `roleTests missing ${roleKey}`)

if (errors.length > 0) throw new Error(`reviewer role access gate denied: ${errors.join('; ')}`)
const evidenceHash = createHash('sha256').update(JSON.stringify(acceptance)).digest('hex')
process.stdout.write(`${JSON.stringify({
  ok: true,
  workbenchKey: acceptance.workbenchKey,
  acceptedAt: acceptance.acceptedAt,
  scopedRoleCount: roleTests.length,
  memberExperienceVerified: true,
  legacyBroadRoleMemberCount: 0,
  evidenceHash,
}, null, 2)}\n`)
