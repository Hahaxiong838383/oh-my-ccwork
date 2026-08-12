#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

import { validateGoal7DeploymentEvidence } from './goal7-deployment-lib.mjs'

const evidenceFile = process.env.SI_GOAL7_DEPLOYMENT_EVIDENCE_FILE || process.argv[2]
if (!evidenceFile) throw new Error('Goal 7 deployment evidence file is required')
const resolved = path.resolve(evidenceFile)
const evidence = JSON.parse(await fs.readFile(resolved, 'utf8'))
await validateGoal7DeploymentEvidence(path.dirname(resolved), evidence)
process.stdout.write(`${JSON.stringify({
  ok: true,
  sourceCommit: evidence.sourceCommit,
  hLiteSourceCommit: evidence.hLiteSourceCommit,
  routeBEnabled: evidence.routeBEnabled,
}, null, 2)}\n`)
