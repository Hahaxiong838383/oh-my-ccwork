#!/usr/bin/env node

import { compilePestimReportingProposal } from '../src/index.mjs'

try {
  const result = await compilePestimReportingProposal()
  process.stdout.write(`${JSON.stringify({
    ok: true,
    proposalKey: result.contract.proposalKey,
    status: result.contract.status,
    deploymentAllowed: result.contract.deploymentAllowed,
    baselineSchemaVersion: result.baseline.schemaVersion,
    baselineContentHash: result.baseline.contentHash,
    candidateSchemaVersion: result.candidate.schemaVersion,
    candidateContentHash: result.candidate.contentHash,
    reportTypes: result.contract.reportTypes,
    projectionChannels: result.contract.projectionChannels,
    candidateMigration: result.contract.candidateMigration,
    counts: result.candidate.counts,
    compatibility: result.compatibility,
  }, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${String(error?.stack || error)}\n`)
  process.exitCode = 1
}
