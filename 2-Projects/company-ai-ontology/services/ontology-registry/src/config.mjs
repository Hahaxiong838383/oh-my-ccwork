import path from 'node:path'

function required(value, name) {
  const text = String(value || '').trim()
  if (!text) throw new Error(`${name} is required`)
  return text
}

export function loadRegistryConfig(env = process.env) {
  const controlToken = required(env.ONTOLOGY_REGISTRY_CONTROL_TOKEN, 'ONTOLOGY_REGISTRY_CONTROL_TOKEN')
  if (controlToken.length < 32) throw new Error('ONTOLOGY_REGISTRY_CONTROL_TOKEN must contain at least 32 characters')
  return {
    host: String(env.ONTOLOGY_REGISTRY_HOST || '0.0.0.0'),
    port: Math.max(1, Number(env.ONTOLOGY_REGISTRY_PORT || 8084)),
    tenantId: required(env.FUTURUS_TENANT_ID, 'FUTURUS_TENANT_ID'),
    controlToken,
    definitionsDir: path.resolve(env.ONTOLOGY_DEFINITIONS_DIR || '/app/packages/ontology-contracts/definitions'),
    maxBodyBytes: Math.max(4096, Number(env.ONTOLOGY_REGISTRY_MAX_BODY_BYTES || 1_048_576)),
    database: {
      host: String(env.PGHOST || 'postgres'),
      port: Math.max(1, Number(env.PGPORT || 5432)),
      database: String(env.PGDATABASE || 'ontology'),
      user: String(env.PGUSER || 'ontology_registry'),
      password: required(env.PGPASSWORD, 'PGPASSWORD'),
      max: Math.max(1, Number(env.PGPOOL_MAX || 4)),
      connectionTimeoutMillis: Math.max(1000, Number(env.PG_CONNECTION_TIMEOUT_MS || 5000)),
    },
  }
}
