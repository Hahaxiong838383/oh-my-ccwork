import fs from 'node:fs/promises'
import path from 'node:path'

const ALLOWED_CONFIG_KEYS = new Set([
  'configVersion',
  'publish',
  'sourceRegistryFile',
  'stateDir',
  'reportDir',
  'databaseNamespace',
  'accountNamespace',
  'credentialNamespace',
  'feishuOutlet',
  'sourceKeys',
  'maxItemsPerSource',
  'maxResponseBytes',
])

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export async function loadJsonFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

export function validateCollectorConfig(config, contract, options = {}) {
  const errors = []
  for (const key of Object.keys(config || {})) if (!ALLOWED_CONFIG_KEYS.has(key)) errors.push(`unsupported config field ${key}`)
  if (config?.configVersion !== '1.0.0') errors.push('configVersion must be 1.0.0')
  if (config?.publish !== false) errors.push('publish must remain false in P1-SI-C')
  for (const field of ['sourceRegistryFile', 'stateDir', 'reportDir']) {
    if (!nonEmptyString(config?.[field])) errors.push(`${field} is required`)
    else if (!path.isAbsolute(config[field])) errors.push(`${field} must be absolute`)
    for (const fragment of contract?.forbiddenPathFragments || []) {
      if (String(config?.[field] || '').includes(fragment)) errors.push(`${field} references forbidden personal runtime path`)
    }
  }
  if (config?.stateDir && config?.reportDir && path.resolve(config.stateDir) === path.resolve(config.reportDir)) {
    errors.push('stateDir and reportDir must be independent directories')
  }
  for (const [field, expected] of Object.entries(contract?.identity || {})) {
    const configField = field === 'feishuOutletNamespace' ? config?.feishuOutlet?.namespace : config?.[field]
    if (field === 'stateNamespace' || field === 'reportNamespace') continue
    if (configField !== expected) errors.push(`${field} must be ${expected}`)
  }
  if (config?.feishuOutlet?.mode !== 'disabled') errors.push('feishuOutlet.mode must remain disabled in P1-SI-C')
  if (!Array.isArray(config?.sourceKeys) || config.sourceKeys.length === 0) errors.push('sourceKeys must be a non-empty array')
  if ((config?.sourceKeys?.length || 0) > contract.runtime.maxSourcesPerRun) errors.push('sourceKeys exceeds maxSourcesPerRun')
  if (new Set(config?.sourceKeys || []).size !== (config?.sourceKeys || []).length) errors.push('sourceKeys must be unique')
  for (const sourceKey of config?.sourceKeys || []) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(sourceKey))) errors.push(`invalid sourceKey ${sourceKey}`)
  }
  const maxItems = config?.maxItemsPerSource ?? contract.runtime.maxItemsPerSource
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > contract.runtime.maxItemsPerSource) {
    errors.push(`maxItemsPerSource must be between 1 and ${contract.runtime.maxItemsPerSource}`)
  }
  const maxBytes = config?.maxResponseBytes ?? contract.runtime.maxResponseBytes
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > contract.runtime.maxResponseBytes) {
    errors.push(`maxResponseBytes must be between 1024 and ${contract.runtime.maxResponseBytes}`)
  }
  if (options.sourceRegistryFileOverride && !path.isAbsolute(options.sourceRegistryFileOverride)) {
    errors.push('source registry override must be absolute')
  }
  return {
    ok: errors.length === 0,
    errors,
    config: errors.length === 0 ? {
      ...structuredClone(config),
      sourceRegistryFile: options.sourceRegistryFileOverride || config.sourceRegistryFile,
      maxItemsPerSource: maxItems,
      maxResponseBytes: maxBytes,
    } : null,
  }
}
