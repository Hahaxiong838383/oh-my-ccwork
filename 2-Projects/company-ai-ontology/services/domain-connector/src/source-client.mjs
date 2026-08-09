const SAFE_TYPES = new Set([
  'domain.product.ProductLine', 'domain.product.Product', 'domain.product.ProductVersion', 'domain.product.SKU', 'domain.product.BOMReference', 'domain.product.Feature', 'domain.product.ProductConstraint',
  'domain.device.DeviceModel', 'domain.device.DeviceInstance', 'domain.device.SerialNumber', 'domain.device.FirmwareVersion', 'domain.device.DeviceState', 'domain.device.DeviceEvent',
  'domain.operations.Order', 'domain.operations.OrderLine', 'domain.operations.InventoryPosition', 'domain.operations.QualityInspection', 'domain.operations.Shipment', 'domain.operations.Activation', 'domain.operations.FulfillmentEvidence',
  'domain.market.MarketSignal', 'domain.market.ContentItem', 'domain.market.CommentSignal', 'domain.market.Topic', 'domain.market.Trend', 'domain.market.PainPoint', 'domain.market.Competitor', 'domain.market.Opportunity',
])
const EPISTEMIC_TYPES = new Set(['source_fact', 'derived_fact', 'prediction', 'human_judgment'])
const STATUS_TYPES = new Set(['active', 'expired', 'revoked', 'deleted', 'conflict'])
const FORBIDDEN_KEYS = /(token|cookie|password|secret|appsecret|apikey|rawpayload|recipient|customer|email|phone|mobile|personid|internalpath)/i
const REQUIRED_PAYLOAD_KEYS = new Map([
  ['domain.device.DeviceInstance', ['instanceKey', 'currentState', 'sourceUpdatedAt']],
  ['domain.device.SerialNumber', ['serialKey', 'serialStatus']],
  ['domain.operations.Order', ['orderKey', 'orderStatus']],
  ['domain.operations.OrderLine', ['lineKey', 'skuKey', 'quantity', 'lineStatus']],
  ['domain.operations.InventoryPosition', ['positionKey', 'warehouseKey', 'onHand', 'available']],
  ['domain.operations.QualityInspection', ['inspectionKey', 'result']],
  ['domain.operations.Shipment', ['shipmentKey', 'shipmentStatus']],
  ['domain.operations.Activation', ['activationKey', 'activationStatus', 'activatedAt']],
  ['domain.operations.FulfillmentEvidence', ['evidenceKey', 'evidenceType', 'readModelVersion']],
  ['domain.market.MarketSignal', ['provider', 'signalType']],
  ['domain.market.ContentItem', ['contentKey', 'platform', 'contentStatus']],
  ['domain.market.CommentSignal', ['commentKey', 'signalStatus']],
])

function inspectSafe(value, path = '$') {
  if (Array.isArray(value)) return value.forEach((item, index) => inspectSafe(item, `${path}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) throw Object.assign(new Error(`forbidden field at ${path}.${key}`), { code: 'unsafe_source_payload' })
    inspectSafe(child, `${path}.${key}`)
  }
}

function timestamp(value, field, required = true) {
  if (!value && !required) return null
  const parsed = new Date(value)
  if (!value || Number.isNaN(parsed.getTime())) throw Object.assign(new Error(`${field} is invalid`), { code: 'invalid_source_record' })
  return parsed.toISOString()
}

export function normalizeSourceRecord(input, source) {
  inspectSafe(input)
  const externalId = String(input?.externalId || '').trim()
  const objectType = String(input?.objectType || '').trim()
  const epistemicType = String(input?.epistemicType || 'source_fact').trim()
  const status = String(input?.status || 'active').trim()
  if (!/^[A-Za-z0-9:._-]{4,240}$/.test(externalId)) throw Object.assign(new Error('externalId is invalid'), { code: 'invalid_source_record' })
  if (!SAFE_TYPES.has(objectType)) throw Object.assign(new Error(`objectType is not allowed: ${objectType}`), { code: 'invalid_source_record' })
  if (!EPISTEMIC_TYPES.has(epistemicType)) throw Object.assign(new Error('epistemicType is invalid'), { code: 'invalid_source_record' })
  if (!STATUS_TYPES.has(status)) throw Object.assign(new Error('status is invalid'), { code: 'invalid_source_record' })
  const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {}
  for (const key of REQUIRED_PAYLOAD_KEYS.get(objectType) || []) {
    if (!(key in payload) || payload[key] == null || payload[key] === '') throw Object.assign(new Error(`${objectType}.${key} is required`), { code: 'invalid_source_record' })
  }
  const provenance = input.provenance && typeof input.provenance === 'object' && !Array.isArray(input.provenance) ? input.provenance : {}
  const confidence = input.confidence == null ? null : Number(input.confidence)
  if (confidence != null && !Number.isFinite(confidence)) throw Object.assign(new Error('confidence is invalid'), { code: 'invalid_source_record' })
  return {
    sourceSystem: source.key,
    externalId,
    objectType,
    sourceUpdatedAt: timestamp(input.sourceUpdatedAt, 'sourceUpdatedAt'),
    validFrom: timestamp(input.validFrom || input.sourceUpdatedAt, 'validFrom'),
    validTo: timestamp(input.validTo, 'validTo', false),
    status,
    epistemicType,
    confidence: confidence == null ? null : Math.max(0, Math.min(1, confidence)),
    authority: String(input.authority || 'source-system').slice(0, 160),
    purpose: String(input.purpose || source.purpose).slice(0, 160),
    payload,
    provenance: {
      sourceRecordId: String(provenance.sourceRecordId || externalId).slice(0, 240),
      sourceVersion: String(provenance.sourceVersion || 'unknown').slice(0, 80),
      collectedAt: timestamp(provenance.collectedAt || input.sourceUpdatedAt, 'provenance.collectedAt'),
      transformation: String(provenance.transformation || 'identity').slice(0, 160),
    },
  }
}

export function createHttpReadSource({ source, fetchImpl = fetch } = {}) {
  if (!source?.enabled) return null
  const base = new URL(source.url)
  if (base.protocol !== 'https:') throw new Error(`${source.key} read URL must use https`)
  return {
    async page({ cursor = '', limit = 100 } = {}) {
      const url = new URL(base)
      if (cursor) url.searchParams.set('cursor', cursor)
      url.searchParams.set('limit', String(limit))
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json', ...(source.authorization ? { authorization: source.authorization } : {}) },
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw Object.assign(new Error(`${source.key} returned ${response.status}`), { code: 'source_unavailable' })
      const raw = await response.json()
      const payload = raw?.message && typeof raw.message === 'object' ? raw.message : raw
      if (!Array.isArray(payload?.items)) throw Object.assign(new Error(`${source.key} response items missing`), { code: 'invalid_source_response' })
      inspectSafe(payload.items)
      return {
        items: payload.items,
        nextCursor: String(payload.nextCursor || ''),
        hasMore: Boolean(payload.hasMore),
        sourceVersion: String(payload.sourceVersion || 'unknown').slice(0, 80),
      }
    },
  }
}
