#!/usr/bin/env node

import { validateGoal7AcceptanceEvidence } from './goal7-evidence-lib.mjs'

const evidenceFile = process.argv[2]
if (!evidenceFile) throw new Error('Goal 7 acceptance evidence file is required')

const { evidence, evidenceHash } = await validateGoal7AcceptanceEvidence(evidenceFile)
process.stdout.write(`${JSON.stringify({
  ok: true,
  goalKey: evidence.goalKey,
  sourceCommit: evidence.sourceCommit,
  hLiteSourceCommit: evidence.hLiteSourceCommit,
  acceptedAt: evidence.acceptedAt,
  ownerAccepted: true,
  routeBEnabled: false,
  evidenceFileCount: Object.keys(evidence.evidenceFiles).length,
  evidenceHash,
}, null, 2)}\n`)
