#!/usr/bin/env node

import path from 'node:path'

import { writeGoal7DeploymentEvidence } from './goal7-deployment-lib.mjs'

const bundleRoot = process.env.SI_GOAL7_EVIDENCE_ROOT || process.argv[2]
const outputFile = process.env.SI_GOAL7_DEPLOYMENT_EVIDENCE_FILE || process.argv[3]
if (!bundleRoot) throw new Error('Goal 7 evidence root is required')
const resolvedRoot = path.resolve(bundleRoot)
const evidence = await writeGoal7DeploymentEvidence(resolvedRoot, outputFile ? path.resolve(outputFile) : path.join(resolvedRoot, 'deployment-evidence.json'))
process.stdout.write(`${JSON.stringify({
  ok: true,
  sourceCommit: evidence.sourceCommit,
  hLiteSourceCommit: evidence.hLiteSourceCommit,
  rawEvidenceFileCount: Object.keys(evidence.rawEvidenceFiles).length,
}, null, 2)}\n`)
