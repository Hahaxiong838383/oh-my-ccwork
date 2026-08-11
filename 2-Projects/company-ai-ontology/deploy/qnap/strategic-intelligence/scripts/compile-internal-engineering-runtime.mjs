#!/usr/bin/env node

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { contentHash } from '../../../../packages/ontology-contracts/src/index.mjs'
import { validateCollectorConfig } from '../../../../services/intelligence-collector/src/config.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = path.resolve(root, '../../..')
const planFile = path.resolve(process.argv[2] || path.join(root, 'config/internal-engineering-shadow-plan.json'))
const outputRoot = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'company-si-internal-engineering-runtime'))
const planValidator = path.join(root, 'scripts/validate-internal-engineering-shadow-plan.mjs')
const planValidation = spawnSync(process.execPath, [planValidator, planFile], { encoding: 'utf8' })
if (planValidation.status !== 0) throw new Error(`internal engineering plan invalid: ${planValidation.stderr.trim()}`)

const [plan, sourceRegistry, collectorContract] = await Promise.all([
  fs.readFile(planFile, 'utf8').then(JSON.parse),
  fs.readFile(path.join(projectRoot, 'packages/ontology-contracts/catalogs/pestim-source-registry-candidate-v1.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(projectRoot, 'services/intelligence-collector/contracts/company-intelligence-collector-v1.json'), 'utf8').then(JSON.parse),
])

const collectorConfig = {
  configVersion: '1.0.0',
  operationMode: 'internal_engineering_shadow',
  publish: false,
  internalEngineeringPlanFile: '/etc/company-intelligence/internal-engineering-plan.json',
  sourceRegistryFile: '/etc/company-intelligence/source-registry.json',
  stateDir: '/var/lib/company-intelligence/state',
  reportDir: '/var/lib/company-intelligence/reports',
  databaseNamespace: 'company_strategic_intelligence',
  accountNamespace: 'company-ai-ontology-strategic-intelligence',
  credentialNamespace: 'company-intelligence',
  feishuOutlet: {
    mode: 'disabled',
    namespace: 'company-intelligence-feishu-outlet',
  },
  sourceKeys: plan.selectedSources.map((source) => source.sourceKey),
  maxItemsPerSource: 20,
  maxResponseBytes: 1048576,
}
const configValidation = validateCollectorConfig(collectorConfig, collectorContract)
if (!configValidation.ok) throw new Error(`compiled internal collector config invalid: ${configValidation.errors.join('; ')}`)

const runtimeManifest = {
  runtimeVersion: '1.0.0',
  mode: 'internal_engineering_shadow',
  status: 'provisional_internal_test',
  generatedAt: new Date().toISOString(),
  planHash: contentHash(plan),
  sourceRegistryHash: contentHash(sourceRegistry),
  collectorConfigHash: contentHash(collectorConfig),
  selectedSourceCount: collectorConfig.sourceKeys.length,
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

await fs.rm(outputRoot, { recursive: true, force: true })
await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 })
await Promise.all([
  fs.writeFile(path.join(outputRoot, 'internal-engineering-plan.json'), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 }),
  fs.writeFile(path.join(outputRoot, 'source-registry.json'), `${JSON.stringify(sourceRegistry, null, 2)}\n`, { mode: 0o600 }),
  fs.writeFile(path.join(outputRoot, 'collector.json'), `${JSON.stringify(collectorConfig, null, 2)}\n`, { mode: 0o600 }),
  fs.writeFile(path.join(outputRoot, 'runtime-manifest.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`, { mode: 0o600 }),
])

process.stdout.write(`${JSON.stringify({
  ok: true,
  outputRoot,
  selectedSourceCount: runtimeManifest.selectedSourceCount,
  p003SampleCount: runtimeManifest.p003SampleCount,
  publish: false,
  countsTowardProductionShadow: false,
  deploymentAuthorized: false,
}, null, 2)}\n`)
