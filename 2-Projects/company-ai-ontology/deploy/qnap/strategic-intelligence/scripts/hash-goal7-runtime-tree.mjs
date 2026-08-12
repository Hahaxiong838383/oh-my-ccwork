#!/usr/bin/env node

import { goal7RuntimeTreeSha256 } from './goal7-phase-evidence-lib.mjs'

const root = process.argv[2]
if (!root) throw new Error('Goal 7 runtime tree root is required')
process.stdout.write(`${await goal7RuntimeTreeSha256(root)}\n`)
