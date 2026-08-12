#!/usr/bin/env node

import fs from 'node:fs/promises'

import { writeGoal7PreparationEvidence } from './goal7-phase-evidence-lib.mjs'

const inputFile = process.argv[2]
const outputFile = process.argv[3]
if (!inputFile || !outputFile) throw new Error('preparation evidence input and output files are required')

const input = JSON.parse(await fs.readFile(inputFile, 'utf8'))
const evidence = await writeGoal7PreparationEvidence(outputFile, input)
process.stdout.write(`run_id=${evidence.runId}\nsource_commit=${evidence.sourceCommit}\nh_lite_source_commit=${evidence.hLiteSourceCommit}\npreparation_evidence=${outputFile}\n`)
