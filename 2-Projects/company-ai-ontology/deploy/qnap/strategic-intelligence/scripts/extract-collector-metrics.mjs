#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

const stdoutFile = path.resolve(process.argv[2] || '')
const stateRoot = path.resolve(process.argv[3] || '')
if (!process.argv[2] || !process.argv[3]) throw new Error('collector stdout file and state root are required')

async function optionalJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

const cliPayload = await optionalJson(stdoutFile)
const runId = cliPayload?.runId
const runDir = runId ? path.join(stateRoot, 'runs', runId) : null
const run = runDir ? await optionalJson(path.join(runDir, 'run.json')) : null
const items = runDir ? (await optionalJson(path.join(runDir, 'items.json')) || []) : []
let rawSnapshotBytes = 0
if (runDir) {
  const rawDir = path.join(runDir, 'raw')
  for (const name of await fs.readdir(rawDir).catch(() => [])) {
    const snapshot = await optionalJson(path.join(rawDir, name))
    rawSnapshotBytes += Number(snapshot?.contentLength || 0)
  }
}

const completedAt = Date.parse(run?.completedAt || '')
const ages = items
  .map((item) => Date.parse(item.publishedAt || ''))
  .filter((publishedAt) => Number.isFinite(publishedAt) && Number.isFinite(completedAt) && completedAt >= publishedAt)
  .map((publishedAt) => Math.floor((completedAt - publishedAt) / 1000))
  .sort((left, right) => left - right)
const percentileIndex = ages.length === 0 ? -1 : Math.min(ages.length - 1, Math.ceil(ages.length * 0.95) - 1)
const sourceAttemptCount = Number(run?.sourceCount || 0)
const metrics = {
  collected: Boolean(run),
  runId: run?.runId || runId || null,
  sourceAttemptCount,
  sourceSuccessCount: run?.status === 'succeeded' ? sourceAttemptCount : 0,
  rawSnapshotCount: Number(run?.rawSnapshotCount || 0),
  normalizedItemCount: Number(run?.itemCount || 0),
  duplicateCount: Number(run?.duplicateCount || 0),
  freshnessP95Seconds: percentileIndex < 0 ? 0 : ages[percentileIndex],
  rawSnapshotBytes,
}
process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`)
