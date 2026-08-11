#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const stateRoot = process.argv[2]
const outputFile = process.argv[3]
if (!stateRoot || !outputFile) throw new Error('state root and output file are required')

const lastGoodFile = path.resolve(stateRoot, 'last-good.json')
let snapshot
try {
  const bytes = await fs.readFile(lastGoodFile)
  const value = JSON.parse(bytes.toString('utf8'))
  snapshot = {
    snapshotVersion: '1.0.0',
    present: true,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    runId: typeof value.runId === 'string' ? value.runId : null,
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  snapshot = {
    snapshotVersion: '1.0.0',
    present: false,
    sha256: null,
    runId: null,
  }
}

await fs.mkdir(path.dirname(path.resolve(outputFile)), { recursive: true, mode: 0o750 })
await fs.writeFile(path.resolve(outputFile), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
