#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function localParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(parts.filter((entry) => entry.type !== 'literal').map((entry) => [entry.type, entry.value]))
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.partial`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temporary, file)
}

async function ensureDirectories(queueRoot) {
  for (const name of ['pending', 'running', 'done', 'failed', 'evidence']) {
    await fs.mkdir(path.join(queueRoot, name), { recursive: true, mode: 0o750 })
  }
}

function validatePolicy(policy) {
  if (policy.deploymentMode !== 'shadow' || policy.publish !== false) throw new Error('shadow policy must keep publish=false')
  if (policy.timezone !== 'Asia/Shanghai') throw new Error('shadow policy timezone must be Asia/Shanghai')
  if (!Number.isInteger(policy.dispatcherIntervalSeconds) || policy.dispatcherIntervalSeconds < 30) {
    throw new Error('dispatcher interval must be at least 30 seconds')
  }
  for (const schedule of policy.schedules || []) {
    if (schedule.jobType !== 'collector') throw new Error(`unsupported job type ${schedule.jobType}`)
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.localTime)) throw new Error(`invalid local time ${schedule.localTime}`)
  }
}

export async function tick({ policy, queueRoot, now = new Date() }) {
  validatePolicy(policy)
  await ensureDirectories(queueRoot)
  const local = localParts(now, policy.timezone)
  const localDate = `${local.year}-${local.month}-${local.day}`
  const localTime = `${local.hour}:${local.minute}`
  const created = []

  for (const schedule of policy.schedules.filter((entry) => entry.enabled)) {
    if (schedule.localTime !== localTime) continue
    const requestKey = `${schedule.scheduleKey}-${localDate}`
    const file = path.join(queueRoot, 'pending', `${requestKey}.json`)
    const request = {
      requestVersion: '1.0.0',
      requestKey,
      scheduleKey: schedule.scheduleKey,
      jobType: schedule.jobType,
      localDate,
      timezone: policy.timezone,
      requestedAt: now.toISOString(),
      policyVersion: policy.policyVersion,
      policyHash: stableHash(policy),
      publish: false,
      allowedOutputs: ['raw_snapshot', 'external_observation', 'strategic_signal', 'evidence', 'impact_assessment', 'report_run', 'report_draft'],
      forbiddenSideEffects: ['formal_p2', 'employee_delivery', 'erp_writeback', 'social_writeback', 'causal_activation'],
    }
    try {
      const handle = await fs.open(file, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(request, null, 2)}\n`)
      await handle.close()
      created.push(request)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }

  await atomicJson(path.join(queueRoot, 'heartbeat.json'), {
    status: 'ready',
    checkedAt: now.toISOString(),
    localDate,
    localTime,
    policyVersion: policy.policyVersion,
    policyHash: stableHash(policy),
    createdRequestKeys: created.map((entry) => entry.requestKey),
  })
  return created
}

async function main() {
  const policyFile = path.resolve(argument('--policy', '/etc/company-intelligence/shadow-policy.json'))
  const queueRoot = path.resolve(argument('--queue', '/var/lib/company-intelligence/queue'))
  const once = process.argv.includes('--once')
  if (process.env.PUBLISH !== 'false') throw new Error('PUBLISH must be exactly false')
  const policy = JSON.parse(await fs.readFile(policyFile, 'utf8'))
  do {
    await tick({ policy, queueRoot })
    if (once) break
    await new Promise((resolve) => setTimeout(resolve, policy.dispatcherIntervalSeconds * 1000))
  } while (true)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${String(error.message || error)}\n`)
    process.exitCode = 1
  })
}
