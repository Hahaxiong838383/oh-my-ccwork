import crypto from 'node:crypto'

function compareNamed(left, right) {
  return String(left?.qualifiedName || left?.name || '').localeCompare(String(right?.qualifiedName || right?.name || ''), 'en')
}

function sortNamed(values) {
  return [...(Array.isArray(values) ? values : [])].map((value) => normalizeValue(value)).sort(compareNamed)
}

function normalizeElement(element) {
  const normalized = normalizeValue(element)
  if (Array.isArray(normalized.extends)) normalized.extends = [...normalized.extends].sort()
  if (Array.isArray(normalized.properties)) normalized.properties = sortNamed(normalized.properties)
  if (Array.isArray(normalized.inputs)) normalized.inputs = sortNamed(normalized.inputs)
  if (Array.isArray(normalized.outputs)) normalized.outputs = sortNamed(normalized.outputs)
  if (Array.isArray(normalized.appliesTo)) normalized.appliesTo = [...normalized.appliesTo].sort()
  if (Array.isArray(normalized.requiredFields)) normalized.requiredFields = [...normalized.requiredFields].sort()
  return normalized
}

function normalizeValue(value) {
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeValue(value[key])]))
}

export function normalizeDefinition(definition) {
  return normalizeValue({
    ...definition,
    namespaces: sortNamed(definition?.namespaces),
    objectTypes: sortNamed(definition?.objectTypes).map(normalizeElement),
    linkTypes: sortNamed(definition?.linkTypes).map(normalizeElement),
    functionTypes: sortNamed(definition?.functionTypes).map(normalizeElement),
    actionTypes: sortNamed(definition?.actionTypes).map(normalizeElement),
    policyTypes: sortNamed(definition?.policyTypes).map(normalizeElement),
    constraintTypes: sortNamed(definition?.constraintTypes).map(normalizeElement),
  })
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeValue(value))
}

export function contentHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')
}
