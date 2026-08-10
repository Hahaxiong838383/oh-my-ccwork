#!/usr/bin/env node

import { compileP003ImpactReviewCandidate } from '../src/index.mjs'

try {
  const result = await compileP003ImpactReviewCandidate()
  process.stdout.write(`${JSON.stringify({
    ok: true,
    proposalKey: result.contract.proposalKey,
    status: result.contract.status,
    productionActivationAllowed: result.contract.productionActivationAllowed,
    candidateCount: result.validation.candidateCount,
    categoryCounts: result.validation.categoryCounts,
    driRoles: result.validation.driRoles,
    contentHash: result.validation.contentHash,
  }, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${String(error?.stack || error)}\n`)
  process.exitCode = 1
}
