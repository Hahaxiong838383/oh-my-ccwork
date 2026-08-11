#!/usr/bin/env node

import path from 'node:path'

import { compileSevenDayEngineeringSummary, writeJson600 } from './seven-day-shadow-lib.mjs'

const evidenceRoot = process.argv[2]
const outputFile = process.argv[3]
if (!evidenceRoot || !outputFile) throw new Error('evidence root and output file are required')

const summary = await compileSevenDayEngineeringSummary(path.resolve(evidenceRoot))
await writeJson600(path.resolve(outputFile), summary)
process.stdout.write(`${JSON.stringify({
  ok: true,
  engineeringVerified: true,
  ownerAccepted: false,
  shadowStartDate: summary.shadowStartDate,
  shadowEndDate: summary.shadowEndDate,
  engineeringEvidenceHash: summary.engineeringEvidenceHash,
}, null, 2)}\n`)
