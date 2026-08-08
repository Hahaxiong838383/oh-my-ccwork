import fs from 'node:fs/promises'
import path from 'node:path'

function safeRelativeFile(value) {
  const text = String(value || '')
  if (!text || path.isAbsolute(text) || text.includes('..') || !/^[A-Za-z0-9._/-]+\.json$/.test(text)) {
    throw new Error(`invalid definition file path: ${text}`)
  }
  return text
}

export async function loadDefinitionDirectory(directory) {
  const root = path.resolve(directory)
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'))
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('manifest.files must be a non-empty array')
  const merged = {
    formatVersion: manifest.formatVersion,
    schemaVersion: manifest.schemaVersion,
    namespaces: [],
    objectTypes: [],
    linkTypes: [],
    functionTypes: [],
    actionTypes: [],
    policyTypes: [],
    constraintTypes: [],
    toolContracts: manifest.toolContracts,
    eventEnvelope: manifest.eventEnvelope,
  }
  for (const file of manifest.files) {
    const relative = safeRelativeFile(file)
    const payload = JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'))
    for (const key of ['namespaces', 'objectTypes', 'linkTypes', 'functionTypes', 'actionTypes', 'policyTypes', 'constraintTypes']) {
      if (payload[key] !== undefined && !Array.isArray(payload[key])) throw new Error(`${relative}.${key} must be an array`)
      merged[key].push(...(payload[key] || []))
    }
  }
  return merged
}
