function required(value, name) {
  const text = String(value || '').trim()
  if (!text) throw new Error(`${name} is required`)
  return text
}

export function loadActionGatewayConfig(env = process.env) {
  const controlToken = required(env.ACTION_GATEWAY_CONTROL_TOKEN, 'ACTION_GATEWAY_CONTROL_TOKEN')
  if (controlToken.length < 32) throw new Error('ACTION_GATEWAY_CONTROL_TOKEN must contain at least 32 characters')
  return {
    host: String(env.ACTION_GATEWAY_HOST || '0.0.0.0'),
    port: Math.max(1, Number(env.ACTION_GATEWAY_PORT || 8082)),
    tenantId: required(env.FUTURUS_TENANT_ID, 'FUTURUS_TENANT_ID'),
    controlToken,
    maxBodyBytes: Math.max(1024, Number(env.ACTION_GATEWAY_MAX_BODY_BYTES || 131_072)),
    database: {
      host: String(env.PGHOST || 'postgres'),
      port: Math.max(1, Number(env.PGPORT || 5432)),
      database: String(env.PGDATABASE || 'ontology'),
      user: String(env.PGUSER || 'action_gateway'),
      password: required(env.PGPASSWORD, 'PGPASSWORD'),
      max: Math.max(1, Number(env.PGPOOL_MAX || 4)),
      connectionTimeoutMillis: Math.max(1000, Number(env.PG_CONNECTION_TIMEOUT_MS || 5000)),
    },
  }
}
