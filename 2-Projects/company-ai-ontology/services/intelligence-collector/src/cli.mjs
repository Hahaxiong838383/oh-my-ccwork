#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  loadPestimSourceRegistryCatalog,
  loadPestimSourceRegistryContract,
} from '../../../packages/ontology-contracts/src/index.mjs'

import { loadJsonFile, validateCollectorConfig } from './config.mjs'
import { runCollector } from './worker.mjs'

const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

function absolute(value) {
  return path.resolve(process.cwd(), value)
}

async function context() {
  const collectorContract = await loadJsonFile(path.join(SERVICE_ROOT, 'contracts/company-intelligence-collector-v1.json'))
  const sourceRegistryContract = await loadPestimSourceRegistryContract()
  const configFile = absolute(argument('--config') || 'config.example.json')
  const configInput = await loadJsonFile(configFile)
  const registryOverride = argument('--registry') ? absolute(argument('--registry')) : null
  const configValidation = validateCollectorConfig(configInput, collectorContract, { sourceRegistryFileOverride: registryOverride })
  if (!configValidation.ok) throw new Error(`invalid collector config: ${configValidation.errors.join('; ')}`)
  const config = configValidation.config
  const internalEngineeringPlan = config.operationMode === 'internal_engineering_shadow'
    ? await loadJsonFile(config.internalEngineeringPlanFile)
    : null
  const { catalog: registry, validation: registryValidation } = await loadPestimSourceRegistryCatalog({
    contract: sourceRegistryContract,
    catalogFile: config.sourceRegistryFile,
  })
  return { collectorContract, sourceRegistryContract, config, registry, registryValidation, internalEngineeringPlan }
}

async function main() {
  const command = process.argv[2] || 'run'
  const loaded = await context()
  if (command === 'validate') {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      serviceKey: loaded.collectorContract.serviceKey,
      status: loaded.collectorContract.status,
      productionDeploymentAllowed: loaded.collectorContract.productionDeploymentAllowed,
      publishAllowed: loaded.collectorContract.publishAllowed,
      registryVersion: loaded.registry.registryVersion,
      registryStatus: loaded.registry.status,
      registryEntryCount: loaded.registryValidation.entryCount,
      registryContentHash: loaded.registryValidation.contentHash,
      configuredSources: loaded.config.sourceKeys,
      operationMode: loaded.config.operationMode,
      countsTowardProductionShadow: loaded.config.operationMode !== 'internal_engineering_shadow',
    }, null, 2)}\n`)
    return
  }
  if (command !== 'run') throw new Error(`unsupported command ${command}`)
  const result = await runCollector(loaded)
  process.stdout.write(`${JSON.stringify({ ok: true, ...result.summary }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    errorCode: error?.code || 'COLLECTOR_CLI_FAILED',
    runId: error?.runId || null,
    message: String(error?.message || 'collector failed').slice(0, 500),
  })}\n`)
  process.exitCode = 1
})
