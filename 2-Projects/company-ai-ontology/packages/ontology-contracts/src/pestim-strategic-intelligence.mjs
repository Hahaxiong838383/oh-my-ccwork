import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareDefinitions } from './compatibility.mjs'
import { compileDefinition } from './compiler.mjs'
import { loadDefinitionDirectory } from './loader.mjs'

const CONTRACT_URL = new URL('../contracts/pestim-strategic-intelligence-v1.json', import.meta.url)
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ELEMENT_GROUPS = ['namespaces', 'objectTypes', 'linkTypes', 'functionTypes', 'actionTypes', 'policyTypes', 'constraintTypes']
const REQUIRED_OBJECTS = new Set([
  'domain.intelligence.ExternalFactor',
  'core.work.GoalFacet',
  'domain.intelligence.ImpactHypothesis',
  'domain.intelligence.ImpactAssessment',
  'domain.intelligence.StrategicIntelligenceReport',
  'domain.intelligence.ReportRun',
])
const REQUIRED_FORBIDDEN_AUTONOMY = new Set([
  'create_formal_p2',
  'assign_employee_task',
  'write_erp',
  'write_social_system',
  'activate_impact_hypothesis',
])

function semanticVersion(value) {
  return /^\d+\.\d+\.\d+$/.test(String(value || ''))
}

function namedKey(group, value) {
  return group === 'namespaces' ? value?.name : value?.qualifiedName
}

function validateUniqueAdditions(additions, errors) {
  for (const group of ELEMENT_GROUPS) {
    if (!Array.isArray(additions?.[group])) {
      errors.push(`additions.${group} must be an array`)
      continue
    }
    const names = new Set()
    for (const item of additions[group]) {
      const name = namedKey(group, item)
      if (!name) errors.push(`additions.${group} contains an unnamed item`)
      else if (names.has(name)) errors.push(`additions.${group} duplicates ${name}`)
      names.add(name)
    }
  }
}

export async function loadPestimStrategicIntelligenceContract(file = CONTRACT_URL) {
  const contract = JSON.parse(await fs.readFile(file, 'utf8'))
  const errors = []
  if (!semanticVersion(contract.contractVersion)) errors.push('contractVersion must be semantic version')
  if (!semanticVersion(contract.baseSchemaVersion)) errors.push('baseSchemaVersion must be semantic version')
  if (!semanticVersion(contract.candidateSchemaVersion)) errors.push('candidateSchemaVersion must be semantic version')
  if (contract.status !== 'contract_only') errors.push('status must remain contract_only before production approval')
  if (contract.proposalKey !== 'P1-SI-A') errors.push('proposalKey must be P1-SI-A')
  if (contract.compatibilityExpectation !== 'compatible') errors.push('compatibilityExpectation must be compatible')
  if (contract.deploymentAllowed !== false) errors.push('deploymentAllowed must remain false')
  if (contract.activationDefaults?.generationStatus !== 'generated_draft') errors.push('generationStatus must default to generated_draft')
  if (contract.activationDefaults?.verificationStatus !== 'unverified') errors.push('verificationStatus must default to unverified')
  if (contract.activationDefaults?.activationStatus !== 'inactive') errors.push('activationStatus must default to inactive')
  const forbiddenAutonomy = new Set(contract.forbiddenAutonomy || [])
  for (const item of REQUIRED_FORBIDDEN_AUTONOMY) if (!forbiddenAutonomy.has(item)) errors.push(`missing forbidden autonomy ${item}`)
  if (!Array.isArray(contract.activationGates) || contract.activationGates.length === 0) errors.push('activationGates must be a non-empty array')
  validateUniqueAdditions(contract.additions, errors)
  const objectNames = new Set((contract.additions?.objectTypes || []).map((item) => item.qualifiedName))
  for (const name of REQUIRED_OBJECTS) if (!objectNames.has(name)) errors.push(`missing required object ${name}`)
  if ((contract.additions?.actionTypes || []).length !== 0) errors.push('P1-SI-A must not introduce action types')
  if (errors.length > 0) throw new Error(`invalid PESTIM strategic intelligence contract: ${errors.join('; ')}`)
  return contract
}

export function applyPestimStrategicIntelligenceContract(baseline, contract) {
  if (baseline.schemaVersion !== contract.baseSchemaVersion) {
    throw new Error(`baseline schema ${baseline.schemaVersion} does not match ${contract.baseSchemaVersion}`)
  }
  const candidate = structuredClone(baseline)
  candidate.schemaVersion = contract.candidateSchemaVersion
  for (const group of ELEMENT_GROUPS) {
    const existing = new Set((candidate[group] || []).map((item) => namedKey(group, item)))
    for (const item of contract.additions[group] || []) {
      const name = namedKey(group, item)
      if (existing.has(name)) throw new Error(`proposal collides with existing ${group} ${name}`)
      candidate[group].push(structuredClone(item))
      existing.add(name)
    }
  }
  return candidate
}

export async function compilePestimStrategicIntelligenceProposal(options = {}) {
  const contract = await loadPestimStrategicIntelligenceContract(options.contractFile)
  const definitionsDirectory = options.definitionsDirectory || path.join(PACKAGE_ROOT, 'definitions')
  const baseline = await loadDefinitionDirectory(definitionsDirectory)
  const baselineCompiled = compileDefinition(baseline)
  if (!baselineCompiled.ok) throw new Error(`baseline definition failed: ${JSON.stringify(baselineCompiled.errors)}`)
  const candidate = applyPestimStrategicIntelligenceContract(baselineCompiled.bundle.definition, contract)
  const candidateCompiled = compileDefinition(candidate)
  if (!candidateCompiled.ok) throw new Error(`candidate definition failed: ${JSON.stringify(candidateCompiled.errors)}`)
  const compatibility = compareDefinitions(baselineCompiled.bundle.definition, candidateCompiled.bundle.definition)
  if (compatibility.classification !== contract.compatibilityExpectation) {
    throw new Error(`compatibility ${compatibility.classification} does not match ${contract.compatibilityExpectation}`)
  }
  return {
    contract,
    baseline: baselineCompiled.bundle,
    candidate: candidateCompiled.bundle,
    compatibility,
  }
}
