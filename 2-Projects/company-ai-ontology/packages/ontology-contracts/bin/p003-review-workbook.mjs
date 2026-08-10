#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  compileP003HumanReviewResults,
  createP003ReviewWorkbook,
  loadP003ReviewContext,
  p003ReviewWorkbookFromCsv,
  p003ReviewWorkbookCsv,
  validateP003ReviewWorkbook,
} from '../src/p003-review-workbook.mjs'

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
  const { catalog } = await loadP003ReviewContext()
  const workbook = createP003ReviewWorkbook(catalog)
  const jsonFile = path.resolve(argument('--json') || path.join(PACKAGE_ROOT, 'templates/reviews/p003-impact-review-template-v1.json'))
  const csvFile = path.resolve(argument('--csv') || path.join(PACKAGE_ROOT, 'templates/reviews/p003-impact-review-template-v1.csv'))
  await writeFile(jsonFile, `${JSON.stringify(workbook, null, 2)}\n`)
  await writeFile(csvFile, p003ReviewWorkbookCsv(workbook))
  process.stdout.write(`${JSON.stringify({ ok: true, reviewCount: workbook.reviews.length, candidateCatalogHash: workbook.candidateCatalogHash, jsonFile, csvFile }, null, 2)}\n`)
} else if (command === 'import-csv') {
  const input = argument('--input')
  const output = argument('--output')
  if (!input || !output) throw new Error('--input and --output are required')
  const { catalog } = await loadP003ReviewContext()
  const workbook = p003ReviewWorkbookFromCsv(await fs.readFile(path.resolve(input), 'utf8'), catalog)
  await writeFile(path.resolve(output), `${JSON.stringify(workbook, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({
    ok: true,
    reviewCount: workbook.reviews.length,
    candidateCatalogHash: workbook.candidateCatalogHash,
    output: path.resolve(output),
    productionActivationAllowed: false,
    formalP2Allowed: false,
    employeeDeliveryAllowed: false,
  }, null, 2)}\n`)
} else if (command === 'validate') {
  const input = argument('--input')
  if (!input) throw new Error('--input is required')
  const { catalog, reviewContract } = await loadP003ReviewContext()
  const workbook = JSON.parse(await fs.readFile(path.resolve(input), 'utf8'))
  const validation = validateP003ReviewWorkbook(workbook, catalog, reviewContract, { requireFinal: process.argv.includes('--final') })
  process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`)
  if (!validation.ok) process.exitCode = 1
} else if (command === 'compile') {
  const input = argument('--input')
  const output = argument('--output')
  if (!input || !output) throw new Error('--input and --output are required')
  const { catalog, reviewContract } = await loadP003ReviewContext()
  const workbook = JSON.parse(await fs.readFile(path.resolve(input), 'utf8'))
  const compiled = compileP003HumanReviewResults(workbook, catalog, reviewContract)
  await writeFile(path.resolve(output), `${JSON.stringify(compiled.results, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({
    ok: true,
    resultsHash: compiled.resultsHash,
    approvalProposalCount: compiled.validation.approvalProposalCount,
    productionActivationAllowed: false,
    formalP2Allowed: false,
    employeeDeliveryAllowed: false,
  }, null, 2)}\n`)
} else {
  process.stderr.write('usage: p003-review-workbook.mjs generate|import-csv|validate|compile\n')
  process.exitCode = 2
}
