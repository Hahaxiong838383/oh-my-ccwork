#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

import { recordOwnerAcceptance, verifyEngineeringSummary, writeJson600 } from './seven-day-shadow-lib.mjs'

const summaryFile = process.argv[2]
const evidenceRoot = process.argv[3]
const outputFile = process.argv[4]
if (!summaryFile || !evidenceRoot || !outputFile) throw new Error('summary file, evidence root and output file are required')
if (process.env.SHADOW_OWNER_ACCEPTANCE_APPROVED !== 'YES') {
  throw new Error('SHADOW_OWNER_ACCEPTANCE_APPROVED=YES is required')
}

const acceptedByPrincipalRef = process.env.SHADOW_OWNER_PRINCIPAL_REF
const acceptanceRef = process.env.SHADOW_OWNER_ACCEPTANCE_REF
const acceptedAt = process.env.SHADOW_OWNER_ACCEPTED_AT || new Date().toISOString()
const summary = JSON.parse(await fs.readFile(path.resolve(summaryFile), 'utf8'))
await verifyEngineeringSummary(summary, path.resolve(evidenceRoot))
const acceptedSummary = recordOwnerAcceptance(summary, { acceptedAt, acceptedByPrincipalRef, acceptanceRef })
await writeJson600(path.resolve(outputFile), acceptedSummary)
process.stdout.write(`${JSON.stringify({
  ok: true,
  ownerAccepted: true,
  acceptedAt: acceptedSummary.ownerAcceptance.acceptedAt,
  acceptanceRef: acceptedSummary.ownerAcceptance.acceptanceRef,
  engineeringEvidenceHash: acceptedSummary.engineeringEvidenceHash,
  ownerAcceptanceHash: acceptedSummary.ownerAcceptance.ownerAcceptanceHash,
}, null, 2)}\n`)
