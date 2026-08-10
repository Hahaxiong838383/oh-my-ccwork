#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  evaluateSourceCollectionPolicy,
  loadPestimSourceRegistryContract,
  validateSourceRegistryCatalog,
} from '../../../../packages/ontology-contracts/src/index.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const registryFile = path.resolve(process.argv[2] || '')
const configFile = path.resolve(process.argv[3] || '')
if (!process.argv[2] || !process.argv[3]) throw new Error('registry and collector config files are required')
const contract = await loadPestimSourceRegistryContract()
const registry = JSON.parse(await fs.readFile(registryFile, 'utf8'))
const config = JSON.parse(await fs.readFile(configFile, 'utf8'))
const validation = validateSourceRegistryCatalog(registry, contract)
if (!validation.ok) throw new Error(`invalid source registry: ${validation.errors.join('; ')}`)
if (!Array.isArray(config.sourceKeys) || config.sourceKeys.length === 0) throw new Error('collector config must select at least one source')
const decisions = config.sourceKeys.map((sourceKey) => evaluateSourceCollectionPolicy(registry, contract, sourceKey, new Date()))
const denied = decisions.filter((decision) => !decision.allowed)
if (denied.length > 0) throw new Error(`source approval gate denied: ${denied.map((entry) => `${entry.sourceKey}:${entry.reasonCode}`).join(', ')}`)
process.stdout.write(`${JSON.stringify({
  ok: true,
  registryVersion: registry.registryVersion,
  registryHash: validation.contentHash,
  approvedSourceCount: decisions.length,
}, null, 2)}\n`)
