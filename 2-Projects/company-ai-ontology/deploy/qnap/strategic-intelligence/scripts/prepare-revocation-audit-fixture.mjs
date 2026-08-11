#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

const [configInputFile, registryInputFile, configOutputFile, registryOutputFile] = process.argv.slice(2)
if (!configInputFile || !registryInputFile || !configOutputFile || !registryOutputFile) {
  throw new Error('config input, registry input, config output and registry output are required')
}

const [config, registry] = await Promise.all([
  fs.readFile(path.resolve(configInputFile), 'utf8').then(JSON.parse),
  fs.readFile(path.resolve(registryInputFile), 'utf8').then(JSON.parse),
])
if (config.operationMode !== 'governed_shadow') throw new Error('revocation audit requires governed_shadow config')
const sourceKey = config.sourceKeys?.[0]
if (!sourceKey) throw new Error('revocation audit requires one configured source')
const entry = registry.entries?.find((candidate) => candidate.sourceKey === sourceKey)
if (!entry) throw new Error('configured source is absent from registry')

const fixtureConfig = {
  ...config,
  sourceKeys: [sourceKey],
  stateDir: '/var/lib/company-intelligence/audit-state',
  reportDir: '/var/lib/company-intelligence/audit-reports',
}
delete fixtureConfig.internalEngineeringPlanFile
const fixtureRegistry = structuredClone(registry)
fixtureRegistry.entries = fixtureRegistry.entries.map((candidate) => (
  candidate.sourceKey === sourceKey ? { ...candidate, lifecycleStatus: 'revoked' } : candidate
))

for (const [file, value] of [[configOutputFile, fixtureConfig], [registryOutputFile, fixtureRegistry]]) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true, mode: 0o750 })
  await fs.writeFile(path.resolve(file), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}
process.stdout.write(`${JSON.stringify({ ok: true, sourceKey })}\n`)
