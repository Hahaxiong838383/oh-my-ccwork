#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

const outputRoot = path.resolve(process.argv[2] || './generated-seven-day-evidence')
const start = process.argv[3]
if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '')) throw new Error('start date must be YYYY-MM-DD')
const startDate = new Date(`${start}T00:00:00+08:00`)
if (Number.isNaN(startDate.getTime())) throw new Error('invalid start date')
await fs.mkdir(outputRoot, { recursive: true, mode: 0o750 })
for (let index = 0; index < 7; index += 1) {
  const date = new Date(startDate.getTime() + index * 86400000)
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
  const evidence = {
    evidenceVersion: '1.0.0',
    dayNumber: index + 1,
    localDate,
    timezone: 'Asia/Shanghai',
    status: 'pending_real_run',
    simulated: false,
    publish: false,
    evidenceFiles: [],
    ownerAcceptance: false,
  }
  await fs.writeFile(path.join(outputRoot, `day-${String(index + 1).padStart(2, '0')}-${localDate}.json`), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
}
