#!/usr/bin/env node

import { compilePestimSourceRegistryProposal } from '../src/index.mjs'

try {
  const result = await compilePestimSourceRegistryProposal()
  process.stdout.write(`${JSON.stringify({
    ok: true,
    proposalKey: result.contract.proposalKey,
    status: result.contract.status,
    deploymentAllowed: result.contract.deploymentAllowed,
    baselineSchemaVersion: result.baseline.schemaVersion,
    baselineContentHash: result.baseline.contentHash,
    candidateSchemaVersion: result.candidate.schemaVersion,
    candidateContentHash: result.candidate.contentHash,
    registryVersion: result.catalog.registryVersion,
    registryStatus: result.catalog.status,
    registryEntryCount: result.registryValidation.entryCount,
    registryContentHash: result.registryValidation.contentHash,
    counts: result.candidate.counts,
    compatibility: result.compatibility,
  }, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${String(error?.stack || error)}\n`)
  process.exitCode = 1
}
