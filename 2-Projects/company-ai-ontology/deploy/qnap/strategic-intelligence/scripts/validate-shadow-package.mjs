#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const compose = JSON.parse(await fs.readFile(path.join(root, 'docker-compose.shadow.yml'), 'utf8'))
const policy = JSON.parse(await fs.readFile(path.join(root, 'config/shadow-policy.json'), 'utf8'))
const errors = []
const allowedServices = new Set(['intelligence-orchestrator', 'intelligence-collector'])
for (const name of Object.keys(compose.services || {})) {
  if (!allowedServices.has(name)) errors.push(`unexpected service ${name}`)
}
for (const [name, service] of Object.entries(compose.services || {})) {
  if (service.ports || service.expose) errors.push(`${name} publishes a port`)
  if (service.privileged) errors.push(`${name} is privileged`)
  if (!service.read_only) errors.push(`${name} root filesystem is writable`)
  if (!service.cap_drop?.includes('ALL')) errors.push(`${name} does not drop all capabilities`)
  if (!service.security_opt?.includes('no-new-privileges:true')) errors.push(`${name} lacks no-new-privileges`)
  if ((service.volumes || []).some((value) => value.includes('docker.sock'))) errors.push(`${name} mounts docker socket`)
  for (const [key, value] of Object.entries(service.environment || {})) {
    if (/(PUBLISH|FORMAL_P2_ENABLED|EMPLOYEE_DELIVERY_ENABLED|ERP_WRITEBACK_ENABLED|SOCIAL_WRITEBACK_ENABLED|CAUSAL_ACTIVATION_ENABLED)/.test(key) && value !== 'false') {
      errors.push(`${name} enables forbidden side effect ${key}`)
    }
  }
}
const collector = compose.services['intelligence-collector']
if (collector.cpus !== 0.5) errors.push('collector CPU limit must be 0.5')
if (collector.mem_limit !== '512m') errors.push('collector memory limit must be 512m')
if (collector.restart !== 'no') errors.push('collector restart must be no')
if (!collector.profiles?.includes('worker')) errors.push('collector must be an on-demand worker profile')
if (!String(collector.image).includes('sha256')) errors.push('collector image variable must require an immutable digest')
if (policy.publish !== false || policy.deploymentMode !== 'shadow') errors.push('policy must remain shadow publish=false')
if (policy.requiredConsecutiveNaturalDays !== 7) errors.push('shadow evidence must require seven natural days')
for (const key of ['formalP2CountMax', 'employeeDeliveryCountMax', 'erpWritebackCountMax', 'socialWritebackCountMax', 'causalActivationCountMax']) {
  if (policy.acceptanceThresholds[key] !== 0) errors.push(`${key} must remain zero`)
}
if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${JSON.stringify({ ok: true, serviceCount: Object.keys(compose.services).length, requiredConsecutiveNaturalDays: 7 }, null, 2)}\n`)
}
