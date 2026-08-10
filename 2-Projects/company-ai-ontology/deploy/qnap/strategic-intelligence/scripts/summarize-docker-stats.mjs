#!/usr/bin/env node

import fs from 'node:fs/promises'

const file = process.argv[2]
if (!file) throw new Error('docker stats file is required')

function bytes(value) {
  const match = String(value || '').trim().match(/^([0-9.]+)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i)
  if (!match) return 0
  const number = Number(match[1])
  const units = {
    b: 1,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    tb: 1000 ** 4,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  }
  return Math.round(number * units[match[2].toLowerCase()])
}

const lines = (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean)
let peakCpuPermille = 0
let peakMemoryBytes = 0
let networkBytes = 0
let samples = 0
for (const line of lines) {
  let sample
  try {
    sample = JSON.parse(line)
  } catch {
    continue
  }
  const cpuPercent = Number.parseFloat(String(sample.cpu || '').replace('%', ''))
  if (Number.isFinite(cpuPercent)) peakCpuPermille = Math.max(peakCpuPermille, Math.round(cpuPercent * 10))
  const memoryUsage = String(sample.mem || '').split('/')[0].trim()
  peakMemoryBytes = Math.max(peakMemoryBytes, bytes(memoryUsage))
  const [received, sent] = String(sample.net || '').split('/').map((value) => value.trim())
  networkBytes = Math.max(networkBytes, bytes(received) + bytes(sent))
  samples += 1
}
process.stdout.write(`${JSON.stringify({ collected: samples > 0, samples, peakCpuPermille, peakMemoryBytes, networkBytes }, null, 2)}\n`)
