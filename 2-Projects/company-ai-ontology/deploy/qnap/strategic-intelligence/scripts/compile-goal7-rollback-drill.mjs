#!/usr/bin/env node

import path from 'node:path'

import { writeGoal7RollbackDrillEvidence } from './goal7-rollback-drill-lib.mjs'

const bundleRoot = process.env.SI_GOAL7_EVIDENCE_ROOT || process.argv[2]
const outputFile = process.env.SI_GOAL7_ROLLBACK_EVIDENCE_FILE || process.argv[3]
if (!bundleRoot) throw new Error('Goal 7 rollback drill evidence root is required')
const resolvedRoot = path.resolve(bundleRoot)
const evidence = await writeGoal7RollbackDrillEvidence(
  resolvedRoot,
  outputFile ? path.resolve(outputFile) : path.join(resolvedRoot, 'rollback-drill-evidence.json'),
)
process.stdout.write(`${JSON.stringify({
  ok: true,
  sourceCommit: evidence.sourceCommit,
  hLiteSourceCommit: evidence.hLiteSourceCommit,
  rawEvidenceFileCount: Object.keys(evidence.rawEvidenceFiles).length,
}, null, 2)}\n`)
