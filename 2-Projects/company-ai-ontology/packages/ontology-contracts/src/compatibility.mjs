import { canonicalJson } from './canonical.mjs'

const GROUPS = ['objectTypes', 'linkTypes', 'functionTypes', 'actionTypes', 'policyTypes', 'constraintTypes']

function mapByName(values) {
  return new Map((values || []).map((value) => [value.qualifiedName, value]))
}

function propertyMap(value) {
  return new Map((value || []).map((property) => [property.name, property]))
}

function change(changes, severity, path, message) {
  changes.push({ severity, path, message })
}

function compareProperties(previous, current, path, changes) {
  const before = propertyMap(previous)
  const after = propertyMap(current)
  for (const [name, property] of before) {
    const next = after.get(name)
    if (!next) change(changes, 'migration_required', `${path}.${name}`, 'property removed')
    else if (next.type !== property.type) change(changes, 'migration_required', `${path}.${name}`, `type changed from ${property.type} to ${next.type}`)
    else if (property.required === false && next.required === true) change(changes, 'migration_required', `${path}.${name}`, 'property became required')
  }
  for (const [name, property] of after) {
    if (!before.has(name)) change(changes, property.required ? 'migration_required' : 'compatible', `${path}.${name}`, property.required ? 'required property added' : 'property added')
  }
}

export function compareDefinitions(previous, current) {
  if (!previous) return { classification: 'bootstrap', changes: [] }
  const changes = []
  for (const group of GROUPS) {
    const before = mapByName(previous[group])
    const after = mapByName(current[group])
    for (const [name, element] of before) {
      const next = after.get(name)
      if (!next) {
        change(changes, 'migration_required', `${group}.${name}`, 'element removed')
        continue
      }
      if (group === 'objectTypes') {
        if (canonicalJson(element.extends || []) !== canonicalJson(next.extends || [])) change(changes, 'migration_required', `${group}.${name}.extends`, 'inheritance changed')
        compareProperties(element.properties, next.properties, `${group}.${name}.properties`, changes)
      } else if (group === 'linkTypes') {
        if (element.fromType !== next.fromType || element.toType !== next.toType || element.cardinality !== next.cardinality) {
          change(changes, 'migration_required', `${group}.${name}`, 'link endpoints or cardinality changed')
        }
      } else if (group === 'functionTypes') {
        if (canonicalJson(element.inputs) !== canonicalJson(next.inputs) || canonicalJson(element.outputs) !== canonicalJson(next.outputs)) {
          change(changes, 'migration_required', `${group}.${name}`, 'function signature changed')
        }
      } else if (group === 'actionTypes') {
        if (element.targetType !== next.targetType || canonicalJson(element.inputs) !== canonicalJson(next.inputs)) {
          change(changes, 'migration_required', `${group}.${name}`, 'action signature changed')
        }
      } else if (canonicalJson(element) !== canonicalJson(next)) {
        change(changes, 'migration_required', `${group}.${name}`, 'governed definition changed')
      }
    }
    for (const name of after.keys()) if (!before.has(name)) change(changes, 'compatible', `${group}.${name}`, 'element added')
  }
  const classification = changes.some((entry) => entry.severity === 'migration_required') ? 'migration_required' : 'compatible'
  return { classification, changes }
}
