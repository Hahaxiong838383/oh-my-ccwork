#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  loadP003ReviewContext,
  validateP003ReviewWorkbook,
} from '../../../../packages/ontology-contracts/src/index.mjs'

const reviewFile = process.argv[2]
if (!reviewFile) throw new Error('approved P003 review workbook is required')

const { catalog, reviewContract } = await loadP003ReviewContext()
const workbook = JSON.parse(await fs.readFile(path.resolve(reviewFile), 'utf8'))
const validation = validateP003ReviewWorkbook(workbook, catalog, reviewContract, { requireFinal: true })
if (!validation.ok) throw new Error(`P003 review gate denied: ${validation.errors.join('; ')}`)
if (validation.finalDecisionCount !== validation.reviewCount) {
  throw new Error('P003 review gate denied: every candidate must have a final human decision')
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  productLineKey: workbook.productLineKey,
  candidateCatalogHash: workbook.candidateCatalogHash,
  reviewCount: validation.reviewCount,
  finalDecisionCount: validation.finalDecisionCount,
  approvalProposalCount: validation.approvalProposalCount,
  workbookHash: validation.workbookHash,
  productionActivationAllowed: false,
  formalP2Allowed: false,
  employeeDeliveryAllowed: false,
}, null, 2)}\n`)
