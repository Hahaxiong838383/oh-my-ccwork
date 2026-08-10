const LOOPBACK_STATUS_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const STATUS_TARGETS = Object.freeze({
  registry: { host: 'ontology-registry', port: '8084', path: '/readyz' },
  domain: { host: 'domain-connector', port: '8085', path: '/status' },
})

function safeUrl(value, fallback, targetKind) {
  const url = new URL(String(value || fallback))
  const target = STATUS_TARGETS[targetKind]
  const loopback = LOOPBACK_STATUS_HOSTS.has(url.hostname)
  const fixedService = url.hostname === target.host && url.port === target.port
  if (
    url.protocol !== 'http:'
    || url.username
    || url.password
    || (!loopback && !fixedService)
    || url.pathname !== target.path
  ) throw new Error('system status URL is not allowed')
  url.search = ''
  url.hash = ''
  return url
}

function text(value, max = 80) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max)
}

function count(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(1_000_000, Math.trunc(number))) : 0
}

async function fetchStatus(fetchImpl, url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: controller.signal })
    const contentLength = Number(response.headers?.get?.('content-length') || 0)
    if (contentLength > 65_536) throw new Error('status payload too large')
    const body = await response.text()
    if (!response.ok || Buffer.byteLength(body, 'utf8') > 65_536) throw new Error(`status ${response.status}`)
    const payload = JSON.parse(body)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid status payload')
    return payload
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function createCompanySystemStatusProvider({ config, store, runtime, agentCoreVersion, fetchImpl = fetch, now = () => new Date() } = {}) {
  const registryUrl = safeUrl(config?.systemStatus?.registryUrl, 'http://ontology-registry:8084/readyz', 'registry')
  const domainUrl = safeUrl(config?.systemStatus?.domainUrl, 'http://domain-connector:8085/status', 'domain')
  const timeoutMs = Math.max(200, Number(config?.systemStatus?.timeoutMs || 2000))

  return async function companySystemStatus() {
    const [registry, domain, operationalResult, engineResult] = await Promise.all([
      fetchStatus(fetchImpl, registryUrl, timeoutMs),
      fetchStatus(fetchImpl, domainUrl, timeoutMs),
      Promise.resolve()
        .then(() => store?.operationalStatus ? store.operationalStatus({ tenantId: config?.tenantId }) : null)
        .catch(() => null),
      Promise.resolve()
        .then(() => runtime?.ready ? runtime.ready() : null)
        .catch(() => null),
    ])
    const operational = operationalResult && typeof operationalResult === 'object' ? operationalResult : {}
    const engine = engineResult && typeof engineResult === 'object' ? engineResult : {}
    const counts = Array.isArray(domain?.database?.counts) ? domain.database.counts : []
    const objectTypes = Array.isArray(domain?.database?.objectTypeCounts) ? domain.database.objectTypeCounts : []
    const sourceCount = (sourceSystem) => counts
      .filter((item) => String(item?.sourceSystem || item?.source_system || '') === sourceSystem)
      .reduce((total, item) => total + count(item?.count), 0)
    const typeCount = (prefix) => objectTypes
      .filter((item) => String(item?.objectType || item?.object_type || '').startsWith(prefix))
      .reduce((total, item) => total + count(item?.count), 0)
    const registryLocal = registry?.local && typeof registry.local === 'object' ? registry.local : {}
    const registryActive = registry?.active && typeof registry.active === 'object' ? registry.active : {}

    return {
      generatedAt: now().toISOString(),
      schemaVersion: text(registryActive.schemaVersion || registryLocal.schemaVersion || 'unknown', 40),
      registryStatus: text(registry?.status || 'unavailable', 40),
      registryVersion: text(registry?.version || 'unknown', 40),
      agentCoreVersion: text(agentCoreVersion || 'unknown', 40),
      agentCoreReady: engine?.ready === true,
      hEngineProductionReady: engine?.productionReady === true,
      domainConnectorVersion: text(domain?.version || 'unknown', 40),
      domainConnectorStatus: text(domain?.status || 'unavailable', 40),
      erpRecords: sourceCount('aishike-erp-m3'),
      marketRecords: sourceCount('kidshub-market'),
      operationsRecords: typeCount('domain.operations.'),
      deviceRecords: typeCount('domain.device.'),
      actionIntents: count(operational?.actionIntents),
      deliveryOutbox: count(operational?.deliveryOutbox),
    }
  }
}
