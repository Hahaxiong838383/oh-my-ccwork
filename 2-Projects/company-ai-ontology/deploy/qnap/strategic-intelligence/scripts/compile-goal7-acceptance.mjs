#!/usr/bin/env node

import path from 'node:path'

import { writeGoal7AcceptanceEvidence } from './goal7-evidence-lib.mjs'

const bundleRoot = process.env.SI_GOAL7_EVIDENCE_ROOT || process.argv[2]
const outputFile = process.env.SI_GOAL7_ACCEPTANCE_FILE || process.argv[3]
if (!bundleRoot) throw new Error('Goal 7 evidence root is required')

const resolvedRoot = path.resolve(bundleRoot)
const resolvedOutput = outputFile ? path.resolve(outputFile) : path.join(resolvedRoot, 'goal7-acceptance.json')
const evidence = await writeGoal7AcceptanceEvidence(resolvedRoot, resolvedOutput)
process.stdout.write(`${JSON.stringify({
  ok: true,
  goalKey: evidence.goalKey,
  sourceCommit: evidence.sourceCommit,
  hLiteSourceCommit: evidence.hLiteSourceCommit,
  ownerAccepted: evidence.ownerAccepted,
  evidenceFileCount: Object.keys(evidence.evidenceFiles).length,
}, null, 2)}\n`)
