import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const contractPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../contracts/company-brain-operating-model-v1.json')

export async function loadCompanyBrainOperatingModel(file = contractPath) {
  const model = JSON.parse(await fs.readFile(file, 'utf8'))
  const roleKeys = new Set()
  for (const role of model.roles || []) {
    if (!role.key || roleKeys.has(role.key)) throw new Error(`invalid or duplicate operating role: ${role.key || ''}`)
    roleKeys.add(role.key)
    for (const field of ['read', 'propose', 'approve', 'execute', 'verify', 'humanIntervention', 'deniedData']) {
      if (!Array.isArray(role[field])) throw new Error(`operating role ${role.key}.${field} must be an array`)
    }
  }
  for (const [name, lifecycle] of Object.entries(model.lifecycles || {})) {
    if (!Array.isArray(lifecycle.states) || lifecycle.states.length < 2) throw new Error(`lifecycle ${name} requires states`)
    if (!roleKeys.has(lifecycle.owner)) throw new Error(`lifecycle ${name} references unknown owner ${lifecycle.owner}`)
    if (!lifecycle.exit) throw new Error(`lifecycle ${name} requires an exit condition`)
  }
  if (!model.invariants?.some((item) => item.includes('Learning is created as proposed'))) throw new Error('Learning proposed invariant is required')
  return model
}

export function operatingRole(model, key) {
  return model.roles.find((role) => role.key === key) || null
}

export function operatingTransition(model, objectType, currentState, targetState) {
  const lifecycle = model.lifecycles?.[objectType]
  if (!lifecycle) return { ok: false, reason: 'unknown_lifecycle' }
  const currentIndex = lifecycle.states.indexOf(currentState)
  const targetIndex = lifecycle.states.indexOf(targetState)
  if (currentIndex < 0 || targetIndex < 0) return { ok: false, reason: 'unknown_state' }
  if (targetIndex < currentIndex && !['superseded', 'rejected', 'retired', 'rolled_back', 'failed', 'invalidated'].includes(targetState)) {
    return { ok: false, reason: 'backward_transition_requires_terminal_state' }
  }
  return { ok: true, owner: lifecycle.owner, exitCondition: lifecycle.exit }
}
