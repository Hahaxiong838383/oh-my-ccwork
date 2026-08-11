#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  compileShadowSourceRegistry,
  createSourceApprovalWorkbook,
  inspectSourceReviewAssignments,
  inspectSourceReviewProgress,
  loadPestimSourceApprovalContract,
  loadSourceApprovalContext,
  sourceApprovalWorkbookFromCsv,
  sourceApprovalWorkbookCsv,
  validateSourceApprovalWorkbook,
} from '../src/source-approval-workbook.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

async function writeFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, value, { mode: 0o600 })
}

const command = process.argv[2]
if (command === 'generate') {
  const { catalog } = await loadSourceApprovalContext()
  const workbook = createSourceApprovalWorkbook(catalog)
  const jsonFile = path.resolve(argument('--json') || path.join(PACKAGE_ROOT, 'templates/reviews/source-registry-review-template-v1.json'))
  const csvFile = path.resolve(argument('--csv') || path.join(PACKAGE_ROOT, 'templates/reviews/source-registry-review-template-v1.csv'))
  await writeFile(jsonFile, `${JSON.stringify(workbook, null, 2)}\n`)
  await writeFile(csvFile, sourceApprovalWorkbookCsv(workbook))
  process.stdout.write(`${JSON.stringify({ ok: true, reviewCount: workbook.reviews.length, sourceCatalogHash: workbook.sourceCatalogHash, jsonFile, csvFile }, null, 2)}\n`)
} else if (command === 'import-csv') {
  const input = argument('--input')
  const output = argument('--output')
  if (!input || !output) throw new Error('--input and --output are required')
  const { catalog } = await loadSourceApprovalContext()
  const workbook = sourceApprovalWorkbookFromCsv(await fs.readFile(path.resolve(input), 'utf8'), catalog)
  await writeFile(path.resolve(output), `${JSON.stringify(workbook, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({
    ok: true,
    reviewCount: workbook.reviews.length,
    sourceCatalogHash: workbook.sourceCatalogHash,
    output: path.resolve(output),
    productionCollectionAllowed: false,
    publishAllowed: false,
  }, null, 2)}\n`)
} else if (command === 'validate') {
  const input = argument('--input')
  if (!input) throw new Error('--input is required')
  const { catalog, approvalContract } = await loadSourceApprovalContext()
  const workbook = JSON.parse(await fs.readFile(path.resolve(input), 'utf8'))
  const validation = validateSourceApprovalWorkbook(workbook, catalog, approvalContract, { requireFinal: process.argv.includes('--final') })
  process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`)
  if (!validation.ok) process.exitCode = 1
} else if (command === 'inspect-assignments') {
  const input = argument('--input')
  if (!input) throw new Error('--input is required')
  const workbook = JSON.parse(await fs.readFile(path.resolve(input), 'utf8'))
  const inspection = inspectSourceReviewAssignments(workbook)
  process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`)
  if (!inspection.assignmentReady) process.exitCode = 1
} else if (command === 'inspect-progress') {
  const input = argument('--input')
  if (!input) throw new Error('--input is required')
  const { catalog, approvalContract } = await loadSourceApprovalContext()
  const workbook = JSON.parse(await fs.readFile(path.resolve(input), 'utf8'))
  const inspection = inspectSourceReviewProgress(workbook, catalog, approvalContract)
  process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`)
  if (!inspection.reviewReady) process.exitCode = 1
} else if (command === 'compile') {
  const input = argument('--input')
  const output = argument('--output')
  if (!input || !output) throw new Error('--input and --output are required')
  const { sourceContract, catalog, approvalContract } = await loadSourceApprovalContext()
  const workbook = JSON.parse(await fs.readFile(path.resolve(input), 'utf8'))
  const compiled = compileShadowSourceRegistry(workbook, catalog, sourceContract, approvalContract)
  await writeFile(path.resolve(output), `${JSON.stringify(compiled.registry, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({
    ok: true,
    registryHash: compiled.registryHash,
    enabledSources: compiled.policyDecisions.filter((decision) => decision.allowed).map((decision) => decision.sourceKey),
    deniedSources: compiled.policyDecisions.filter((decision) => !decision.allowed).map((decision) => ({ sourceKey: decision.sourceKey, reasonCode: decision.reasonCode })),
    productionCollectionAllowed: false,
    publishAllowed: false,
  }, null, 2)}\n`)
} else {
  const contract = await loadPestimSourceApprovalContract()
  process.stderr.write(`usage: source-approval-workbook.mjs generate|import-csv|inspect-assignments|inspect-progress|validate|compile\ncontract=${contract.contractVersion}\n`)
  process.exitCode = 2
}
