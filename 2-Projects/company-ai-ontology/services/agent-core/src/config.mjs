import path from 'node:path'

function required(value, name) {
  const text = String(value || '').trim()
  if (!text) throw new Error(`${name} is required`)
  return text
}

export function loadConfig(env = process.env) {
  const secret = required(env.AGENT_CORE_HMAC_SECRET, 'AGENT_CORE_HMAC_SECRET')
  if (secret.length < 32) throw new Error('AGENT_CORE_HMAC_SECRET must contain at least 32 characters')
  return {
    host: String(env.AGENT_CORE_HOST || '0.0.0.0'),
    port: Math.max(1, Number(env.AGENT_CORE_PORT || 8080)),
    tenantId: required(env.FUTURUS_TENANT_ID, 'FUTURUS_TENANT_ID'),
    hmacSecret: secret,
    maxBodyBytes: Math.max(1024, Number(env.AGENT_CORE_MAX_BODY_BYTES || 262_144)),
    maxClockSkewMs: Math.max(10_000, Number(env.AGENT_CORE_MAX_CLOCK_SKEW_MS || 300_000)),
    idempotencyTtlSeconds: Math.max(60, Number(env.AGENT_CORE_IDEMPOTENCY_TTL_SECONDS || 86_400)),
    workProtocol: {
      mode: ['off', 'shadow', 'active'].includes(String(env.WORK_PROTOCOL_MODE || 'shadow').trim().toLowerCase())
        ? String(env.WORK_PROTOCOL_MODE || 'shadow').trim().toLowerCase()
        : 'shadow',
      ontologyVersion: String(env.ONTOLOGY_SCHEMA_VERSION || '3.1.0').trim(),
      evidenceMaxAgeDays: Math.max(1, Number(env.EVIDENCE_MAX_AGE_DAYS || 180)),
      recentCaseLimit: Math.max(1, Math.min(20, Number(env.WORK_PROTOCOL_RECENT_CASE_LIMIT || 8))),
    },
    admission: {
      maxConcurrency: Math.max(1, Number(env.H_ENGINE_MAX_CONCURRENCY || 4)),
      maxQueue: Math.max(0, Number(env.H_ENGINE_QUEUE_LIMIT || 32)),
      queueTimeoutMs: Math.max(10, Number(env.H_ENGINE_QUEUE_TIMEOUT_MS || 10_000)),
    },
    database: {
      host: String(env.PGHOST || 'postgres'),
      port: Math.max(1, Number(env.PGPORT || 5432)),
      database: String(env.PGDATABASE || 'ontology'),
      user: String(env.PGUSER || 'ontology_app'),
      password: required(env.PGPASSWORD, 'PGPASSWORD'),
      max: Math.max(1, Number(env.PGPOOL_MAX || 8)),
      connectionTimeoutMillis: Math.max(1000, Number(env.PG_CONNECTION_TIMEOUT_MS || 5000)),
    },
    runtime: {
      provider: 'h-engine',
      mode: String(env.H_ENGINE_MODE || 'demo').trim().toLowerCase(),
      bin: String(env.H_ENGINE_BIN || '/app/node_modules/.bin/grok'),
      home: String(env.H_ENGINE_HOME || '/var/lib/company-agent/home'),
      grokHome: String(env.H_ENGINE_GROK_HOME || '/var/lib/company-agent/home/.grok'),
      workspace: String(env.H_ENGINE_WORKSPACE || '/var/lib/company-agent/workspace'),
      proxyUrl: String(env.H_ENGINE_PROXY_URL || '').trim(),
      apiKey: String(env.XAI_API_KEY || '').trim(),
      remoteUrl: String(env.H_ENGINE_REMOTE_URL || '').trim(),
      remoteSecret: String(env.H_ENGINE_REMOTE_SECRET || '').trim(),
      promptFile: String(env.COMPANY_AGENT_PROMPT_FILE || path.resolve('prompts/company-front-door.md')),
      timeoutMs: Math.max(10_000, Number(env.H_ENGINE_TIMEOUT_MS || 120_000)),
      maxOutputBytes: Math.max(4096, Number(env.H_ENGINE_MAX_OUTPUT_BYTES || 2_097_152)),
      demoDelayMs: Math.max(0, Number(env.H_ENGINE_DEMO_DELAY_MS || 0)),
    },
  }
}
