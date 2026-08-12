import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

const serverUrl = new URL('../src/server.mjs', import.meta.url)

test('Goal 7 ACL Principal mapping ships as a distinct undeployed candidate version', async () => {
  const source = await fs.readFile(serverUrl, 'utf8')
  assert.match(source, /KNOWLEDGE_CONNECTOR_VERSION = '2026-08-11\.1'/)
})

test('Knowledge Connector 健康读回绑定 Ontology Source Commit', async () => {
  const source = await fs.readFile(serverUrl, 'utf8')
  assert.match(source, /sourceCommit: config\.sourceCommit \|\| null/)
})
