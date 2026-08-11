#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  contentHash,
  loadPestimSourceRegistryContract,
  validateSourceRegistryCatalog,
} from '../../../../packages/ontology-contracts/src/index.mjs'
import { validateCollectorConfig } from '../../../../services/intelligence-collector/src/config.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = path.resolve(root, '../../..')
const runtimeRoot = path.resolve(process.argv[2] || '')
if (!process.argv[2]) throw new Error('internal engineering runtime root is required')

const files = {
  plan: path.join(runtimeRoot, 'internal-engineering-plan.json'),
  registry: path.join(runtimeRoot, 'source-registry.json'),
  config: path.join(runtimeRoot, 'collector.json'),
  manifest: path.join(runtimeRoot, 'runtime-manifest.json'),
}
const [plan, registry, config, manifest, collectorContract, sourceRegistryContract] = await Promise.all([
  fs.readFile(files.plan, 'utf8').then(JSON.parse),
  fs.readFile(files.registry, 'utf8').then(JSON.parse),
  fs.readFile(files.config, 'utf8').then(JSON.parse),
  fs.readFile(files.manifest, 'utf8').then(JSON.parse),
  fs.readFile(path.join(projectRoot, 'services/intelligence-collector/contracts/company-intelligence-collector-v1.json'), 'utf8').then(JSON.parse),
  loadPestimSourceRegistryContract(),
])
const errors = []
const planValidation = spawnSync(process.execPath, [path.join(root, 'scripts/validate-internal-engineering-shadow-plan.mjs'), files.plan], { encoding: 'utf8' })
if (planValidation.status !== 0) errors.push('internal engineering plan validation failed')

const registryValidation = validateSourceRegistryCatalog(registry, sourceRegistryContract, { allowedStatuses: ['candidate'] })
if (!registryValidation.ok) errors.push(`source registry invalid: ${registryValidation.errors.join('; ')}`)
if ((registry.entries || []).some((entry) => entry.lifecycleStatus !== 'paused')) errors.push('internal runtime source registry must keep every source paused')
if ((registry.entries || []).some((entry) => entry.license.status !== 'pending')) errors.push('internal runtime source licenses must remain pending')
if ((registry.entries || []).some((entry) => entry.governance.approvalStatus !== 'pending')) errors.push('internal runtime compliance approvals must remain pending')

const configValidation = validateCollectorConfig(config, collectorContract)
if (!configValidation.ok) errors.push(`collector config invalid: ${configValidation.errors.join('; ')}`)
const planSourceKeys = plan.selectedSources.map((source) => source.sourceKey)
if (contentHash(config.sourceKeys) !== contentHash(planSourceKeys)) errors.push('collector sourceKeys must match the internal engineering plan')
if (config.internalEngineeringPlanFile !== '/etc/company-intelligence/internal-engineering-plan.json') errors.push('collector internal plan path mismatch')
if (config.operationMode !== 'internal_engineering_shadow') errors.push('collector operationMode mismatch')

const expectedManifest = {
  runtimeVersion: '1.0.0',
  mode: 'internal_engineering_shadow',
  status: 'provisional_internal_test',
  planHash: contentHash(plan),
  sourceRegistryHash: contentHash(registry),
  collectorConfigHash: contentHash(config),
  selectedSourceCount: plan.selectedSources.length,
  p003SampleCount: plan.p003Samples.length,
  publish: false,
  countsTowardProductionShadow: false,
  productionApprovalSatisfied: false,
  deploymentAuthorized: false,
  formalP2Enabled: false,
  employeeDeliveryEnabled: false,
  erpWritebackEnabled: false,
  socialWritebackEnabled: false,
  causalActivationEnabled: false,
}
for (const [key, expected] of Object.entries(expectedManifest)) {
  if (manifest[key] !== expected) errors.push(`runtime manifest ${key} mismatch`)
}
if (!Number.isFinite(Date.parse(manifest.generatedAt))) errors.push('runtime manifest generatedAt invalid')

if (errors.length > 0) throw new Error(`invalid internal engineering runtime: ${errors.join('; ')}`)
process.stdout.write(`${JSON.stringify({
  ok: true,
  mode: manifest.mode,
  selectedSourceCount: manifest.selectedSourceCount,
  p003SampleCount: manifest.p003SampleCount,
  registrySourcesRemainingPaused: registry.entries.length,
  productionApprovalSatisfied: false,
  countsTowardProductionShadow: false,
  deploymentAuthorized: false,
}, null, 2)}\n`)
