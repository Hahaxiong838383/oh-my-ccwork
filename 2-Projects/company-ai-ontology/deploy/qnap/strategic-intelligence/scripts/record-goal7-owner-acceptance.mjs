#!/usr/bin/env node

import path from 'node:path'

import { writeGoal7OwnerAcceptanceEvidence } from './goal7-evidence-lib.mjs'

if (process.env.GOAL7_OWNER_ACCEPTANCE_APPROVED !== 'YES') {
  throw new Error('Goal 7 owner acceptance requires GOAL7_OWNER_ACCEPTANCE_APPROVED=YES')
}

const bundleRoot = process.env.SI_GOAL7_EVIDENCE_ROOT || process.argv[2]
const outputFile = process.env.SI_GOAL7_OWNER_ACCEPTANCE_FILE || process.argv[3]
const ownerPrincipalRef = process.env.GOAL7_OWNER_PRINCIPAL_REF
const acceptanceRef = process.env.GOAL7_OWNER_ACCEPTANCE_REF
if (!bundleRoot) throw new Error('Goal 7 evidence root is required')

const resolvedRoot = path.resolve(bundleRoot)
const evidence = await writeGoal7OwnerAcceptanceEvidence(resolvedRoot, {
  ownerPrincipalRef,
  acceptanceRef,
  outputFile: outputFile ? path.resolve(outputFile) : path.join(resolvedRoot, 'owner-acceptance.json'),
})
process.stdout.write(`${JSON.stringify({
  ok: true,
  goalKey: evidence.goalKey,
  acceptedAt: evidence.acceptedAt,
  sourceCommit: evidence.sourceCommit,
  hLiteSourceCommit: evidence.hLiteSourceCommit,
  engineeringEvidenceFileCount: Object.keys(evidence.engineeringEvidenceFiles).length,
}, null, 2)}\n`)
