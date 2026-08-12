#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

const VERSION = /^\d{4}-\d{2}-\d{2}\.\d+$/
const COMMIT = /^[a-f0-9]{40}$/

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

async function extractVersion(file, exportName) {
  const source = await fs.readFile(file, 'utf8')
  const match = source.match(new RegExp(`export\\s+const\\s+${exportName}\\s*=\\s*['\"]([^'\"]+)['\"]`))
  requireValue(match && VERSION.test(match[1]), `${exportName} missing or invalid`)
  return match[1]
}

const [ontologyRootArg, hLiteRootArg, sourceCommit, hLiteSourceCommit, outputFileArg] = process.argv.slice(2)
requireValue(ontologyRootArg && hLiteRootArg && sourceCommit && hLiteSourceCommit && outputFileArg, 'ontology root, H-Lite root, two commits, and output file are required')
requireValue(COMMIT.test(sourceCommit), 'Ontology sourceCommit invalid')
requireValue(COMMIT.test(hLiteSourceCommit), 'H-Lite sourceCommit invalid')

const ontologyRoot = path.resolve(ontologyRootArg)
const hLiteRoot = path.resolve(hLiteRootArg)
const outputFile = path.resolve(outputFileArg)
const [agentCoreVersion, knowledgeConnectorVersion, hLiteVersion] = await Promise.all([
  extractVersion(path.join(ontologyRoot, 'services/agent-core/src/server.mjs'), 'AGENT_CORE_CONTRACT_VERSION'),
  extractVersion(path.join(ontologyRoot, 'services/knowledge-connector/src/server.mjs'), 'KNOWLEDGE_CONNECTOR_VERSION'),
  extractVersion(path.join(hLiteRoot, 'company-qnap-lite.mjs'), 'COMPANY_QNAP_LITE_SERVICE_VERSION'),
])

const evidence = {
  evidenceVersion: '1.0.0',
  evidenceType: 'goal7-runtime-component-versions',
  sourceCommit,
  hLiteSourceCommit,
  agentCoreVersion,
  knowledgeConnectorVersion,
  hLiteVersion,
}
await fs.mkdir(path.dirname(outputFile), { recursive: true })
await fs.writeFile(outputFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify(evidence)}\n`)
