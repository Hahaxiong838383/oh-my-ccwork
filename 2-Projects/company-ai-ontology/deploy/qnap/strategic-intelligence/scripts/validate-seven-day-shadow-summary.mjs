#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

import { fileSha256, verifyAcceptedSummary } from './seven-day-shadow-lib.mjs'

const summaryFile = process.argv[2]
const evidenceRoot = process.argv[3]
if (!summaryFile || !evidenceRoot) throw new Error('summary file and evidence root are required')

const summaryBytes = await fs.readFile(path.resolve(summaryFile))
const summary = JSON.parse(summaryBytes.toString('utf8'))
await verifyAcceptedSummary(summary, path.resolve(evidenceRoot))
process.stdout.write(`${JSON.stringify({
  ok: true,
  engineeringVerified: true,
  ownerAccepted: true,
  completedNaturalDays: summary.completedNaturalDays,
  shadowStartDate: summary.shadowStartDate,
  shadowEndDate: summary.shadowEndDate,
  sourceCommit: summary.runtimeIdentity.sourceCommit,
  collectorImage: summary.runtimeIdentity.collectorImage,
  policyHash: summary.runtimeIdentity.policyHash,
  engineeringEvidenceHash: summary.engineeringEvidenceHash,
  ownerAcceptanceHash: summary.ownerAcceptance.ownerAcceptanceHash,
  summaryFileHash: fileSha256(summaryBytes),
}, null, 2)}\n`)
