import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXTRACTOR = path.join(ROOT, 'scripts/extract-runtime-component-versions.mjs')

async function writeSources(root, versions = {}) {
  const ontologyRoot = path.join(root, 'company-ai-ontology')
  const hLiteRoot = path.join(root, 'feishu-grok-bridge')
  await fs.mkdir(path.join(ontologyRoot, 'services/agent-core/src'), { recursive: true })
  await fs.mkdir(path.join(ontologyRoot, 'services/knowledge-connector/src'), { recursive: true })
  await fs.mkdir(hLiteRoot, { recursive: true })
  await fs.writeFile(path.join(ontologyRoot, 'services/agent-core/src/server.mjs'), `export const AGENT_CORE_CONTRACT_VERSION = '${versions.agentCore || '2026-08-12.2'}'\n`)
  await fs.writeFile(path.join(ontologyRoot, 'services/knowledge-connector/src/server.mjs'), `export const KNOWLEDGE_CONNECTOR_VERSION = '${versions.knowledgeConnector || '2026-08-11.1'}'\n`)
  await fs.writeFile(path.join(hLiteRoot, 'company-qnap-lite.mjs'), `export const COMPANY_QNAP_LITE_SERVICE_VERSION = '${versions.hLite || '2026-08-11.1'}'\n`)
  return { ontologyRoot, hLiteRoot }
}

test('Runtime component versions are extracted from immutable source exports', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-component-versions-'))
  const { ontologyRoot, hLiteRoot } = await writeSources(outputRoot)
  const outputFile = path.join(outputRoot, 'runtime-component-versions.json')
  const result = spawnSync(process.execPath, [EXTRACTOR, ontologyRoot, hLiteRoot, 'a'.repeat(40), 'b'.repeat(40), outputFile], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(await fs.readFile(outputFile, 'utf8'))
  assert.equal(evidence.agentCoreVersion, '2026-08-12.2')
  assert.equal(evidence.knowledgeConnectorVersion, '2026-08-11.1')
  assert.equal(evidence.hLiteVersion, '2026-08-11.1')
})

test('Runtime component version extraction fails closed on an invalid source version', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'goal7-component-version-invalid-'))
  const { ontologyRoot, hLiteRoot } = await writeSources(outputRoot, { agentCore: 'latest' })
  const result = spawnSync(process.execPath, [EXTRACTOR, ontologyRoot, hLiteRoot, 'a'.repeat(40), 'b'.repeat(40), path.join(outputRoot, 'output.json')], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /AGENT_CORE_CONTRACT_VERSION missing or invalid/)
})
