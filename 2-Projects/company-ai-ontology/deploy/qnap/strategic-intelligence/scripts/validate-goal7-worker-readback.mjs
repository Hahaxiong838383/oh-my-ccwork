#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

import { validateGoal7WorkerReadbackEvidence } from './goal7-worker-readback-lib.mjs'

const evidenceFile = process.env.SI_GOAL7_WORKER_READBACK_FILE || process.argv[2]
if (!evidenceFile) throw new Error('Goal 7 worker readback evidence file is required')

const resolved = path.resolve(evidenceFile)
const evidence = JSON.parse(await fs.readFile(resolved, 'utf8'))
await validateGoal7WorkerReadbackEvidence(path.dirname(resolved), evidence)
process.stdout.write(`${JSON.stringify({
  ok: true,
  sourceCommit: evidence.sourceCommit,
  hLiteSourceCommit: evidence.hLiteSourceCommit,
  provider: evidence.provider,
  model: evidence.model,
  routeKey: evidence.governance.routeKey,
  ledgerRecorded: evidence.governance.ledgerRecorded,
  rawEvidenceFileCount: Object.keys(evidence.rawEvidenceFiles).length,
}, null, 2)}\n`)
