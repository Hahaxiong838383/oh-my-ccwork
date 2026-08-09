function required(value, name) {
  const text = String(value || '').trim()
  if (!text) throw new Error(`${name} is required`)
  return text
}

function source(env, key, defaultPurpose) {
  const prefix = key.toUpperCase().replaceAll('-', '_')
  return {
    key,
    url: String(env[`${prefix}_READ_URL`] || '').trim(),
    authorization: String(env[`${prefix}_READ_AUTHORIZATION`] || '').trim(),
    purpose: String(env[`${prefix}_READ_PURPOSE`] || defaultPurpose).trim(),
    enabled: String(env[`${prefix}_READ_ENABLED`] || '0') === '1',
  }
}

export function loadConfig(env = process.env) {
  const controlToken = required(env.DOMAIN_CONNECTOR_CONTROL_TOKEN, 'DOMAIN_CONNECTOR_CONTROL_TOKEN')
  if (controlToken.length < 32) throw new Error('DOMAIN_CONNECTOR_CONTROL_TOKEN must contain at least 32 characters')
  return {
    host: String(env.DOMAIN_CONNECTOR_HOST || '0.0.0.0'),
    port: Math.max(1, Number(env.DOMAIN_CONNECTOR_PORT || 8085)),
    tenantId: required(env.FUTURUS_TENANT_ID, 'FUTURUS_TENANT_ID'),
    controlToken,
    pageLimit: Math.max(1, Math.min(500, Number(env.DOMAIN_CONNECTOR_PAGE_LIMIT || 100))),
    maxPages: Math.max(1, Math.min(1000, Number(env.DOMAIN_CONNECTOR_MAX_PAGES || 100))),
    intervalMs: Math.max(60_000, Number(env.DOMAIN_CONNECTOR_INTERVAL_MS || 900_000)),
    onStart: String(env.DOMAIN_CONNECTOR_SYNC_ON_START || '0') === '1',
    sources: {
      'aishike-erp-m3': source(env, 'aishike-erp-m3', 'operations-read-model'),
      'kidshub-market': source(env, 'kidshub-market', 'market-intelligence'),
    },
    database: {
      host: String(env.PGHOST || 'postgres'),
      port: Math.max(1, Number(env.PGPORT || 5432)),
      database: String(env.PGDATABASE || 'ontology'),
      user: String(env.PGUSER || 'domain_connector'),
      password: required(env.PGPASSWORD, 'PGPASSWORD'),
      max: Math.max(1, Number(env.PGPOOL_MAX || 4)),
      connectionTimeoutMillis: Math.max(1000, Number(env.PG_CONNECTION_TIMEOUT_MS || 5000)),
    },
  }
}
