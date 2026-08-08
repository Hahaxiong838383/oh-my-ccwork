function required(value, name, minLength = 1) {
  const text = String(value || '').trim()
  if (text.length < minLength) throw new Error(`${name} is required`)
  return text
}

function boolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase())
}

function jsonArray(value, name) {
  try {
    const parsed = JSON.parse(String(value || '[]'))
    if (!Array.isArray(parsed)) throw new Error('not array')
    return parsed
  } catch {
    throw new Error(`${name} must be a JSON array`)
  }
}

function base64JsonArray(value, name) {
  const encoded = String(value || '').trim()
  if (!encoded) return null
  try {
    return jsonArray(Buffer.from(encoded, 'base64').toString('utf8'), name)
  } catch {
    throw new Error(`${name} must be a Base64-encoded JSON array`)
  }
}

export function loadConfig(env = process.env) {
  const controlToken = required(env.KNOWLEDGE_CONNECTOR_CONTROL_TOKEN, 'KNOWLEDGE_CONNECTOR_CONTROL_TOKEN', 32)
  return {
    host: String(env.KNOWLEDGE_CONNECTOR_HOST || '0.0.0.0'),
    port: Math.max(1, Number(env.KNOWLEDGE_CONNECTOR_PORT || 8083)),
    tenantId: required(env.FUTURUS_TENANT_ID, 'FUTURUS_TENANT_ID'),
    controlToken,
    database: {
      host: String(env.PGHOST || 'postgres'),
      port: Math.max(1, Number(env.PGPORT || 5432)),
      database: String(env.PGDATABASE || 'ontology'),
      user: String(env.PGUSER || 'knowledge_connector'),
      password: required(env.PGPASSWORD, 'PGPASSWORD'),
      max: Math.max(1, Number(env.PGPOOL_MAX || 4)),
      connectionTimeoutMillis: Math.max(1000, Number(env.PG_CONNECTION_TIMEOUT_MS || 5000)),
    },
    feishu: {
      appId: required(env.FEISHU_APP_ID, 'FEISHU_APP_ID'),
      appSecret: required(env.FEISHU_APP_SECRET, 'FEISHU_APP_SECRET', 16),
      tenantHost: String(env.FEISHU_TENANT_HOST || 'futurus.feishu.cn').trim(),
      discoverPublicTeamSpaces: boolean(env.FEISHU_KNOWLEDGE_DISCOVER_PUBLIC_TEAM_SPACES, true),
      spaceIds: String(env.FEISHU_KNOWLEDGE_SPACE_IDS || '').split(',').map((value) => value.trim()).filter(Boolean),
      resources: base64JsonArray(env.FEISHU_KNOWLEDGE_RESOURCES_B64, 'FEISHU_KNOWLEDGE_RESOURCES_B64')
        ?? jsonArray(env.FEISHU_KNOWLEDGE_RESOURCES_JSON, 'FEISHU_KNOWLEDGE_RESOURCES_JSON'),
      timeoutMs: Math.max(1000, Number(env.FEISHU_TIMEOUT_MS || 15_000)),
    },
    sync: {
      onStart: boolean(env.KNOWLEDGE_SYNC_ON_START, true),
      intervalMs: Math.max(60_000, Number(env.KNOWLEDGE_SYNC_INTERVAL_MS || 900_000)),
      maxResources: Math.max(1, Math.min(5000, Number(env.KNOWLEDGE_MAX_RESOURCES || 500))),
      chunkChars: Math.max(500, Math.min(8000, Number(env.KNOWLEDGE_CHUNK_CHARS || 2800))),
      chunkOverlap: Math.max(0, Math.min(1000, Number(env.KNOWLEDGE_CHUNK_OVERLAP || 250))),
      maxSheetRows: Math.max(1, Math.min(2000, Number(env.KNOWLEDGE_MAX_SHEET_ROWS || 200))),
      maxSheetColumns: Math.max(1, Math.min(100, Number(env.KNOWLEDGE_MAX_SHEET_COLUMNS || 26))),
    },
  }
}
