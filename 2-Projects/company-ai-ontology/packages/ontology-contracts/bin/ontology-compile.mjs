#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareDefinitions, compileDefinition, loadDefinitionDirectory } from '../src/index.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const definitionDirectory = path.resolve(args.find((value) => !value.startsWith('--')) || path.join(packageRoot, 'definitions'))
const previousIndex = args.indexOf('--previous')
const outIndex = args.indexOf('--out')

try {
  const definition = await loadDefinitionDirectory(definitionDirectory)
  const compiled = compileDefinition(definition)
  if (!compiled.ok) {
    process.stdout.write(`${JSON.stringify({ ok: false, errors: compiled.errors, warnings: compiled.warnings }, null, 2)}\n`)
    process.exitCode = 1
  } else {
    let compatibility = { classification: 'bootstrap', changes: [] }
    if (previousIndex >= 0) {
      const previousPath = args[previousIndex + 1]
      if (!previousPath) throw new Error('--previous requires a JSON file')
      const previous = JSON.parse(await fs.readFile(path.resolve(previousPath), 'utf8'))
      compatibility = compareDefinitions(previous.definition || previous, compiled.bundle.definition)
    }
    const output = {
      ok: true,
      schemaVersion: compiled.bundle.schemaVersion,
      contentHash: compiled.bundle.contentHash,
      counts: compiled.bundle.counts,
      compatibility,
      warnings: compiled.warnings,
    }
    if (outIndex >= 0) {
      const outPath = args[outIndex + 1]
      if (!outPath) throw new Error('--out requires a JSON file')
      await fs.writeFile(path.resolve(outPath), `${JSON.stringify(compiled.bundle, null, 2)}\n`, { mode: 0o600 })
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  }
} catch (error) {
  process.stderr.write(`${String(error?.stack || error)}\n`)
  process.exitCode = 1
}
