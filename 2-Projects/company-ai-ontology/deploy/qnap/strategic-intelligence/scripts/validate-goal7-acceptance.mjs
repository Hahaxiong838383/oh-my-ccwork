#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const evidenceFile = process.argv[2]
if (!evidenceFile) throw new Error('Goal 7 acceptance evidence file is required')

const evidence = JSON.parse(await fs.readFile(path.resolve(evidenceFile), 'utf8'))
const errors = []
const referencePattern = /^(feishu:|git:|ontology:|qnap:|https:\/\/)\S+$/

function requireValue(condition, message) {
  if (!condition) errors.push(message)
}

function requireTrue(record, keys, prefix) {
  for (const key of keys) requireValue(record?.[key] === true, `${prefix}.${key} must be true`)
}

function requireFalse(record, keys, prefix) {
  for (const key of keys) requireValue(record?.[key] === false, `${prefix}.${key} must be false`)
}

requireValue(evidence.evidenceVersion === '1.0.0', 'evidenceVersion mismatch')
requireValue(evidence.goalKey === 'P1-PROD-READINESS', 'goalKey mismatch')
requireValue(evidence.status === 'complete', 'Goal 7 status must be complete')
requireValue(evidence.engineeringVerified === true, 'engineeringVerified must be true')
requireValue(evidence.ownerAccepted === true, 'ownerAccepted must be true')
requireValue(typeof evidence.acceptedAt === 'string' && Number.isFinite(Date.parse(evidence.acceptedAt)), 'acceptedAt invalid')
requireValue(/^[a-f0-9]{40}$/.test(String(evidence.sourceCommit || '')), 'sourceCommit invalid')
requireValue(referencePattern.test(String(evidence.ownerAcceptanceRef || '')), 'ownerAcceptanceRef invalid')
requireValue(Array.isArray(evidence.evidenceRefs) && evidence.evidenceRefs.length > 0, 'evidenceRefs missing')
for (const reference of evidence.evidenceRefs || []) requireValue(referencePattern.test(String(reference)), 'evidenceRefs contains invalid reference')
requireTrue(evidence.authorityEvidence, [
  'principalModelVerified',
  'senderPrincipalIsolationVerified',
  'purposeNarrowingVerified',
  'revocationFailClosedVerified',
  'readBeforeBodyAclVerified',
], 'authorityEvidence')
requireTrue(evidence.runtimeEvidence, [
  'circuitBreakerVerified',
  'retryBudgetVerified',
  'costBudgetVerified',
  'realModelReadbackVerified',
], 'runtimeEvidence')
requireValue(evidence.routeState?.routeAOperational === true, 'routeState.routeAOperational must be true')
requireValue(evidence.routeState?.routeBEnabled === false, 'routeState.routeBEnabled must remain false')
requireFalse(evidence.closedCapabilities, [
  'productResearchBulkImport',
  'realEmployeeCanary',
  'employeePrivateBotMigration',
  'erpWriteback',
  'socialWriteback',
], 'closedCapabilities')

if (errors.length > 0) throw new Error(`Goal 7 acceptance gate denied: ${errors.join('; ')}`)
const evidenceHash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
process.stdout.write(`${JSON.stringify({
  ok: true,
  goalKey: evidence.goalKey,
  sourceCommit: evidence.sourceCommit,
  acceptedAt: evidence.acceptedAt,
  ownerAccepted: true,
  routeBEnabled: false,
  evidenceHash,
}, null, 2)}\n`)
