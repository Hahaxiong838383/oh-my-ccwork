#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

import { validateGoal7RollbackDrillEvidence } from './goal7-rollback-drill-lib.mjs'

const evidenceFile = process.env.SI_GOAL7_ROLLBACK_EVIDENCE_FILE || process.argv[2]
if (!evidenceFile) throw new Error('Goal 7 rollback drill evidence file is required')
const resolved = path.resolve(evidenceFile)
const evidence = JSON.parse(await fs.readFile(resolved, 'utf8'))
await validateGoal7RollbackDrillEvidence(path.dirname(resolved), evidence)
process.stdout.write(`${JSON.stringify({ ok: true, sourceCommit: evidence.sourceCommit, candidateReleaseRestored: true }, null, 2)}\n`)
